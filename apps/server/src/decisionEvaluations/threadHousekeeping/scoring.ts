export interface Interval {
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

/** Wilson 95% interval. Copied from the semantic-lint pilot so changes there cannot move this pilot's figures. */
export const wilson = (successes: number, total: number): Interval => {
  if (total === 0) return { value: null, low: null, high: null };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { value: p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
};

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly interval: Interval;
}
export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  interval: wilson(numerator, denominator),
});

export interface ProjectRow {
  readonly caseId: string;
  /** The agreed label: a listed choice id or `none`. */
  readonly label: string;
  /** The system's route: a listed choice id, `unlisted`, or `none` (which includes abstaining). */
  readonly pred: string;
  /** The system moved the chat to a project (an answer above the floor other than `none`). */
  readonly moved: boolean;
}

/**
 * `matched`: the route equals the label, where abstaining and `none` both leave the chat in place.
 * `wrongWhenMoved`: of the answers that picked a project above the floor, how many picked the wrong one.
 * `noneRecall` / `nonePrecision`: how often "none of these" was right, from the label side and the answer side.
 */
export const summarizeProject = (rows: ReadonlyArray<ProjectRow>) => {
  const moved = rows.filter((r) => r.moved);
  const labelNone = rows.filter((r) => r.label === "none");
  const predNone = rows.filter((r) => r.pred === "none");
  return {
    cases: rows.length,
    matched: rate(rows.filter((r) => r.pred === r.label).length, rows.length),
    wrongWhenMoved: rate(moved.filter((r) => r.pred !== r.label).length, moved.length),
    moves: moved.length,
    noneRecall: rate(labelNone.filter((r) => r.pred === "none").length, labelNone.length),
    nonePrecision: rate(predNone.filter((r) => r.label === "none").length, predNone.length),
    wrongCases: rows.filter((r) => r.pred !== r.label).map((r) => r.caseId),
  };
};

export interface WakeRow {
  readonly caseId: string;
  readonly label: "nothing_new" | "something_new";
  readonly caught: boolean;
}

/** `recall`: nothing-new wakes caught. `falseCatch`: wakes that carried something but were caught. `precision`: caught wakes that really were nothing new. */
export const summarizeWake = (rows: ReadonlyArray<WakeRow>) => {
  const nothing = rows.filter((r) => r.label === "nothing_new");
  const something = rows.filter((r) => r.label === "something_new");
  const caught = rows.filter((r) => r.caught);
  return {
    cases: rows.length,
    nothingNew: nothing.length,
    somethingNew: something.length,
    recall: rate(nothing.filter((r) => r.caught).length, nothing.length),
    falseCatch: rate(something.filter((r) => r.caught).length, something.length),
    precision: rate(caught.filter((r) => r.label === "nothing_new").length, caught.length),
    caught: caught.length,
    wronglyCaught: something.filter((r) => r.caught).map((r) => r.caseId),
  };
};

export interface UsageRow {
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

/** Sums only what the service reported; any unknown component keeps a total unknown, never zero. */
export const summarizeCost = (rows: ReadonlyArray<UsageRow>, unobserved: number) => {
  const sorted = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const costKnown = rows.filter((r) => r.costUsd !== null);
  return {
    calls: rows.length + unobserved,
    observedCalls: rows.length,
    unobservedCalls: unobserved,
    latencyMs: {
      mean: rows.length === 0 ? null : sorted.reduce((n, v) => n + v, 0) / rows.length,
      p50: rows.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!,
      max: rows.length === 0 ? null : sorted[sorted.length - 1]!,
    },
    inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
    outputTokensReported: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
    costUsd:
      unobserved === 0 && rows.length > 0 && costKnown.length === rows.length
        ? costKnown.reduce((n, r) => n + r.costUsd!, 0)
        : null,
    knownCostUsd: costKnown.reduce((n, r) => n + r.costUsd!, 0),
    costKnownCalls: costKnown.length,
  };
};
