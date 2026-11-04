/**
 * Bounded decision engines choose one operation and one observed target from a closed set; they
 * never produce free-form browser actions. A decision engine is separate from the browser backend
 * that executes the choice.
 */

export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";
export type ControlOperation = "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";
export type Operation = TargetOperation | ControlOperation;

export interface SelectOption {
  readonly index: string;
  readonly label: string;
}

export interface ObservedElement {
  /** The label (`e1`) the engine sees; the only handle an engine can name. Select options are `e1_2`. */
  readonly index: string;
  /** The browser's own locator, kept out of every engine request. */
  readonly locator: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly operations: readonly TargetOperation[];
  readonly options?: readonly SelectOption[];
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly ObservedElement[];
}

export interface ActionRecord {
  readonly operation: Operation;
  readonly target?: string;
  readonly label?: string;
  readonly text?: string;
  readonly pageChanged: boolean;
}

export interface DecisionRequest {
  readonly goal: string;
  readonly observation: Observation;
  readonly history: readonly ActionRecord[];
}

export type Decision =
  | { readonly operation: TargetOperation; readonly target: string }
  | { readonly operation: ControlOperation };

/** Counts are null when the provider did not report them; null is never summed as zero. */
export interface EngineUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: "estimated" | "upper-bound" | "unknown";
  readonly requests: number;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly confidence: number;
  /** The model identity the provider reports having served, not the alias requested. */
  readonly resolvedModel: string;
  readonly latencyMs: number;
  readonly usage: EngineUsage;
  /** Hash of the exact request body, so a run is tied to its prompt and observation. */
  readonly requestDigest: string;
  readonly adapterVersion: string;
}

export interface BoundedDecisionEngine {
  readonly id: string;
  readonly requestedModel: string;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
}

export class EngineRefusal extends Error {
  override readonly name = "EngineRefusal";
}

export const targetsFor = (observation: Observation) => {
  const targets: Record<TargetOperation, Map<string, string>> = {
    CLICK: new Map(),
    TYPE_TEXT: new Map(),
    SELECT: new Map(),
  };
  for (const element of observation.elements) {
    for (const operation of element.operations) {
      if (operation === "SELECT") {
        for (const option of element.options ?? []) {
          targets.SELECT.set(option.index, `${element.name} → ${option.label}`);
        }
      } else {
        targets[operation].set(element.index, `${element.role} "${element.name}"`);
      }
    }
  }
  return targets;
};

/** The operations that can currently be chosen: only those with at least one valid target. */
export const availableOperations = (observation: Observation): readonly Operation[] => {
  const targets = targetsFor(observation);
  return [
    ...(["CLICK", "TYPE_TEXT", "SELECT"] as const).filter((op) => targets[op].size > 0),
    "SCROLL_DOWN",
    "WAIT",
    "DONE",
    "BLOCKED",
  ];
};

export const assembleDecision = (
  observation: Observation,
  operation: string,
  targetFor: (operation: TargetOperation) => string,
): Decision => {
  if (operation === "CLICK" || operation === "TYPE_TEXT" || operation === "SELECT") {
    const target = targetFor(operation);
    if (!targetsFor(observation)[operation].has(target))
      throw new EngineRefusal("Chosen target is not an offered element.");
    return { operation, target };
  }
  if (
    operation === "SCROLL_DOWN" ||
    operation === "WAIT" ||
    operation === "DONE" ||
    operation === "BLOCKED"
  )
    return { operation };
  throw new EngineRefusal("Chosen operation was not offered.");
};

/**
 * Freshness: the chosen element must still exist, with the same index, role and name, in a newer
 * observation, or the decision was made about a page that is gone. Locators die with each
 * snapshot, so the element returned here carries the one to execute.
 */
export const resolveFreshTarget = (
  decision: Decision,
  decidedOn: Observation,
  current: Observation,
): ObservedElement | undefined => {
  if (!("target" in decision)) return undefined;
  const index = decision.target.split("_")[0];
  const find = (observation: Observation) =>
    observation.elements.find(
      (element) =>
        element.index === index &&
        (decision.operation !== "SELECT" ||
          element.options?.some((option) => option.index === decision.target)),
    );
  const before = find(decidedOn);
  const now = find(current);
  const label = (element: ObservedElement | undefined) =>
    element?.options?.find((option) => option.index === decision.target)?.label;
  return before !== undefined &&
    now !== undefined &&
    current.url === decidedOn.url &&
    before.role === now.role &&
    before.name === now.name &&
    (decision.operation !== "SELECT" || label(before) === label(now))
    ? now
    : undefined;
};
