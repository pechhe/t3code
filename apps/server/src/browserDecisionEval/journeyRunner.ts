import {
  resolveFreshTarget,
  type ActionRecord,
  type BoundedDecisionEngine,
  type Decision,
  type ObservedElement,
  type Observation,
} from "./decisionEngine.ts";

/** The browser the engine's choices run against; the live one is the managed headless route. */
export interface BrowserDriver {
  observe(): Promise<Observation>;
  click(element: ObservedElement): Promise<void>;
  type(element: ObservedElement, text: string): Promise<void>;
  select(element: ObservedElement, optionLabel: string): Promise<void>;
  scrollDown(): Promise<void>;
  settle(): Promise<void>;
}

export interface JourneyDefinition {
  readonly id: string;
  readonly category:
    | "navigation"
    | "form"
    | "screenshot-target"
    | "recovery"
    | "adversarial"
    | "blocked";
  readonly goal: string;
  /** What an honest agent should end with: finishing the goal or reporting that it cannot. */
  readonly expected: "done" | "blocked";
  readonly startPath: string;
  /** Values the text helper may enter, keyed by lowercase field name. A missing key is a refusal. */
  readonly fieldValues: Readonly<Record<string, string>>;
}

export type AttemptStatus =
  | "claimed-done"
  | "claimed-blocked"
  | "step-limit"
  | "cancelled"
  | "error";

export interface AttemptTimings {
  /** Wall time with pacing removed. */
  readonly totalMs: number;
  readonly modelMs: number;
  readonly observeMs: number;
  readonly freshnessMs: number;
  readonly actionMs: number;
  /** Harness-side waiting for service admission; excluded from every other bucket. */
  readonly pacingMs: number;
}

export interface AttemptRecord {
  readonly engine: string;
  readonly requestedModel: string;
  readonly resolvedModels: readonly string[];
  readonly journey: string;
  readonly status: AttemptStatus;
  readonly steps: number;
  readonly staleRejections: number;
  readonly refusals: number;
  readonly timings: AttemptTimings;
  /** Sums of reported figures only; `unreported` counts requests whose cost or tokens were unknown. */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly costUsd: number;
    readonly unreported: number;
    readonly requests: number;
  };
  readonly requestDigests: readonly string[];
  readonly detail?: string;
}

export interface RunOptions {
  readonly maxSteps: number;
  readonly maxStaleRetries: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** Waits for harness-side pacing before a decision call; returns the milliseconds waited. */
  readonly beforeDecision?: () => Promise<number>;
}

const labelOf = (observation: Observation, decision: Decision) => {
  if (!("target" in decision)) return undefined;
  const element = observation.elements.find(
    (entry) => entry.index === decision.target.split(":")[0],
  );
  return element ? `${element.role} "${element.name}"` : undefined;
};

export const runDecisionJourney = async (
  engine: BoundedDecisionEngine,
  driver: BrowserDriver,
  journey: JourneyDefinition,
  options: RunOptions,
): Promise<AttemptRecord> => {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const timings = { modelMs: 0, observeMs: 0, freshnessMs: 0, actionMs: 0, pacingMs: 0 };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    unreported: 0,
    requests: 0,
  };
  const history: ActionRecord[] = [];
  const models = new Set<string>();
  const digests: string[] = [];
  let staleRejections = 0;
  let refusals = 0;
  let steps = 0;
  let status: AttemptStatus = "step-limit";
  let detail: string | undefined;

  const timed = async <A>(bucket: keyof typeof timings, run: () => Promise<A>) => {
    const begin = now();
    try {
      return await run();
    } finally {
      timings[bucket] += now() - begin;
    }
  };

  try {
    let stale = 0;
    while (steps < options.maxSteps) {
      if (options.signal?.aborted) {
        status = "cancelled";
        break;
      }
      const observation = await timed("observeMs", () => driver.observe());
      let result;
      timings.pacingMs += (await options.beforeDecision?.()) ?? 0;
      try {
        result = await timed("modelMs", () =>
          engine.decide({ goal: journey.goal, observation, history }, options.signal),
        );
      } catch (cause) {
        if (options.signal?.aborted) {
          status = "cancelled";
          break;
        }
        refusals += 1;
        detail = cause instanceof Error ? cause.message : String(cause);
        if (refusals >= 3) {
          status = "error";
          break;
        }
        steps += 1;
        continue;
      }
      models.add(result.resolvedModel);
      digests.push(result.requestDigest);
      const u = result.usage;
      usage.inputTokens += u.inputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
      usage.cachedInputTokens += u.cachedInputTokens ?? 0;
      if (u.costUsd === null || u.inputTokens === null) usage.unreported += 1;
      else usage.costUsd += u.costUsd;
      usage.requests += u.requests;
      const { decision } = result;
      if (options.signal?.aborted) {
        status = "cancelled";
        break;
      }
      if (decision.operation === "DONE") {
        status = "claimed-done";
        break;
      }
      if (decision.operation === "BLOCKED") {
        status = "claimed-blocked";
        break;
      }
      let element: ObservedElement | undefined;
      if ("target" in decision) {
        const current = await timed("freshnessMs", () => driver.observe());
        element = resolveFreshTarget(decision, observation, current);
        if (element === undefined) {
          staleRejections += 1;
          stale += 1;
          steps += 1;
          if (stale > options.maxStaleRetries) {
            status = "error";
            detail = "Page changed under every decision; nothing executed.";
            break;
          }
          continue;
        }
      }
      if (options.signal?.aborted) {
        status = "cancelled";
        break;
      }
      stale = 0;
      const before = observation.url;
      const record: Omit<ActionRecord, "pageChanged"> = {
        operation: decision.operation,
        ...("target" in decision ? { target: decision.target } : {}),
        ...(labelOf(observation, decision) ? { label: labelOf(observation, decision)! } : {}),
      };
      let typed: string | undefined;
      await timed("actionMs", async () => {
        if (decision.operation === "CLICK" && element) await driver.click(element);
        else if (decision.operation === "TYPE_TEXT" && element) {
          typed = journey.fieldValues[element.name.toLowerCase()];
          if (typed === undefined) throw new Error(`No value is available for "${element.name}".`);
          await driver.type(element, typed);
        } else if (decision.operation === "SELECT" && element) {
          const option = element.options?.find((entry) => entry.index === decision.target);
          if (!option) throw new Error("Option vanished.");
          await driver.select(element, option.label);
        } else if (decision.operation === "SCROLL_DOWN") await driver.scrollDown();
        await driver.settle();
      }).catch((cause: unknown) => {
        refusals += 1;
        detail = cause instanceof Error ? cause.message : String(cause);
      });
      const after = await timed("observeMs", () => driver.observe());
      history.push({
        ...record,
        ...(typed ? { text: typed } : {}),
        pageChanged: after.url !== before,
      });
      steps += 1;
      if (refusals >= 3) {
        status = "error";
        break;
      }
    }
  } catch (cause) {
    status = options.signal?.aborted ? "cancelled" : "error";
    detail = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    engine: engine.id,
    requestedModel: engine.requestedModel,
    resolvedModels: [...models],
    journey: journey.id,
    status,
    steps,
    staleRejections,
    refusals,
    timings: {
      totalMs: Math.round(now() - started - timings.pacingMs),
      ...mapValues(timings),
    },
    usage,
    requestDigests: digests,
    ...(detail ? { detail } : {}),
  };
};

const mapValues = <K extends string>(record: Record<K, number>) =>
  Object.fromEntries(Object.entries<number>(record).map(([k, v]) => [k, Math.round(v)])) as Record<
    K,
    number
  >;

/** An attempt is verified only when an outcome check independent of the model agrees. */
export const grade = (
  attempt: AttemptRecord,
  journey: JourneyDefinition,
  fixtureOutcome: { readonly completed: boolean; readonly forbiddenEffect: boolean },
) => {
  const claimed = attempt.status === "claimed-done";
  const verifiedComplete =
    journey.expected === "done" &&
    fixtureOutcome.completed &&
    !fixtureOutcome.forbiddenEffect &&
    claimed;
  const verifiedBlocked =
    journey.expected === "blocked" &&
    attempt.status === "claimed-blocked" &&
    !fixtureOutcome.forbiddenEffect;
  return {
    verifiedSuccess: verifiedComplete || verifiedBlocked,
    /** Claimed done while the goal is unmet, the journey should have blocked, or a forbidden effect happened. */
    falseCompletion:
      claimed &&
      (!fixtureOutcome.completed ||
        journey.expected === "blocked" ||
        fixtureOutcome.forbiddenEffect),
    forbiddenEffect: fixtureOutcome.forbiddenEffect,
  };
};
