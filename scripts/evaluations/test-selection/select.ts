import { estimateSeconds, type Durations, type LandingTest } from "../../test-landing.ts";

/** Relevance of one candidate: a probability, or undefined when the engine abstained or failed. */
export type Scores = ReadonlyMap<string, number | undefined>;

export interface BudgetInput {
  readonly candidates: ReadonlyArray<LandingTest>;
  /** The gate's own order (selected, then deferred): the first `mandatory` run whatever they cost. */
  readonly gateOrder: ReadonlyArray<LandingTest>;
  readonly mandatory: number;
  readonly durations: Durations;
  readonly budgetSeconds: number;
}

export interface Selection {
  readonly selected: ReadonlyArray<LandingTest>;
  readonly deferred: ReadonlyArray<LandingTest>;
  readonly seconds: number;
}

/** Fills the budget in the given order; mandatory ranks always run, as the gate does. */
function fill(
  { gateOrder, mandatory: count, durations, budgetSeconds }: BudgetInput,
  optional: ReadonlyArray<LandingTest>,
): Selection {
  const mandatory = gateOrder.slice(0, count);
  const selected = [...mandatory];
  const deferred: LandingTest[] = [];
  for (const test of optional) {
    if (estimateSeconds([...selected, test], durations) <= budgetSeconds) selected.push(test);
    else deferred.push(test);
  }
  return { selected, deferred, seconds: estimateSeconds(selected, durations) };
}

const optionalOf = ({ gateOrder, mandatory }: BudgetInput) => gateOrder.slice(mandatory);

const baselineOrder = ({ gateOrder }: BudgetInput) => {
  const position = new Map(gateOrder.map((test, index) => [test.file, index]));
  return (a: LandingTest, b: LandingTest) => position.get(a.file)! - position.get(b.file)!;
};

/** The gate's order for the discretionary ranks. */
export function baselineSelection(input: BudgetInput): Selection {
  return fill(input, optionalOf(input).toSorted(baselineOrder(input)));
}

/**
 * Semantic ordering of the discretionary ranks only: scored >= 0.5 first by probability, then
 * unscored candidates in baseline order, then scored < 0.5. An abstention never demotes a test below
 * a test the engine called irrelevant, and never promotes it above one it called relevant.
 */
export function semanticSelection(input: BudgetInput, scores: Scores): Selection {
  const group = (test: LandingTest) => {
    const score = scores.get(test.file);
    return score === undefined ? 1 : score >= 0.5 ? 0 : 2;
  };
  const base = baselineOrder(input);
  return fill(
    input,
    optionalOf(input).toSorted(
      (a, b) =>
        group(a) - group(b) ||
        (group(a) === 1 ? 0 : (scores.get(b.file) ?? 0) - (scores.get(a.file) ?? 0)) ||
        base(a, b),
    ),
  );
}

/** Deterministic xorshift so the control arm reproduces from a seed. */
export function seededRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** The discretionary ranks in a seeded random order: the control for any ordering signal. */
export function randomSelection(input: BudgetInput, seed: number): Selection {
  const random = seededRandom(seed);
  const keyed = optionalOf(input).map((test) => ({ test, key: random() }));
  return fill(
    input,
    keyed.toSorted((a, b) => a.key - b.key).map((entry) => entry.test),
  );
}

/** Upper bound: known failing tests first. Not achievable without the labels. */
export function oracleSelection(input: BudgetInput, failing: ReadonlySet<string>): Selection {
  const base = baselineOrder(input);
  return fill(
    input,
    optionalOf(input).toSorted(
      (a, b) => Number(failing.has(b.file)) - Number(failing.has(a.file)) || base(a, b),
    ),
  );
}

export interface ArmMetrics {
  readonly selected: number;
  readonly deferred: number;
  readonly seconds: number;
  readonly caught: number;
  readonly missed: ReadonlyArray<string>;
  /** Discretionary tests run that did not fail (a verified-pass label is required). */
  readonly spentOnPassing: number;
  /** Discretionary tests run whose outcome under the mutation is unknown (uncertain or never reported). */
  readonly spentOnUnknown: number;
  readonly optionalSelected: number;
}

/** Failing tests are the verified positives; every other labelled candidate ran green. */
export function measure(
  selection: Selection,
  input: BudgetInput,
  failing: ReadonlySet<string>,
  passing: ReadonlySet<string>,
): ArmMetrics {
  const chosen = new Set(selection.selected.map((test) => test.file));
  const mandatory = new Set(input.gateOrder.slice(0, input.mandatory).map((test) => test.file));
  const optional = selection.selected.filter((test) => !mandatory.has(test.file));
  return {
    selected: selection.selected.length,
    deferred: selection.deferred.length,
    seconds: selection.seconds,
    caught: [...failing].filter((file) => chosen.has(file)).length,
    missed: [...failing].filter((file) => !chosen.has(file)).toSorted(),
    spentOnPassing: optional.filter((test) => passing.has(test.file)).length,
    spentOnUnknown: optional.filter((test) => !passing.has(test.file) && !failing.has(test.file))
      .length,
    optionalSelected: optional.length,
  };
}

/** Duration-only control: the discretionary tests cheapest first, ignoring the gate's rank. */
export function cheapestFirstSelection(input: BudgetInput): Selection {
  const base = baselineOrder(input);
  const cost = (test: LandingTest) => input.durations[test.file] ?? 2;
  return fill(
    input,
    optionalOf(input).toSorted((a, b) => cost(a) - cost(b) || base(a, b)),
  );
}
