import { CLAIM_LABELS, DECISION_LABELS } from "./corpusTypes.ts";

export type EngineOutcome =
  | {
      readonly kind: "answered";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly kind: "unanswered"; readonly status: "unknown" | "refusal" | "no-choice" }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Declared before any held-out case existed. Cautious towards extra review, never towards letting a claim or decision pass:
 * a failure, refusal or `unknown` is flagged. A flag only chooses what a person or adjudicator looks at.
 */
export const POLICY = {
  version: "evidence-screening-policy-v1",
  supportedFloor: 0.75,
  escalateFloor: 0.35,
} as const;

const argmax = (p: Readonly<Record<string, number>>): string | null => {
  let best: string | null = null;
  let bestP = -1;
  let tie = false;
  for (const [label, v] of Object.entries(p)) {
    if (v > bestP) {
      best = label;
      bestP = v;
      tie = false;
    } else if (v === bestP) tie = true;
  }
  return tie ? null : best;
};

export interface Screened {
  /** True when a person should look at the claim, or the adjudicator at the passage. */
  readonly flagged: boolean;
  /** The label the engine would give without a floor; null when it gave none. */
  readonly argmax: string | null;
  readonly reason: "answer" | "floor" | "abstained" | "failed";
}

/** Question 1: flagged = the claim must not be relied on without a look. */
export const screenClaim = (
  outcome: EngineOutcome | undefined,
  floor = POLICY.supportedFloor,
): Screened => {
  if (outcome === undefined || outcome.kind === "failed")
    return { flagged: true, argmax: null, reason: "failed" };
  if (outcome.kind === "unanswered") return { flagged: true, argmax: null, reason: "abstained" };
  const top = argmax(outcome.probabilities);
  const p = outcome.probabilities[CLAIM_LABELS[0]] ?? 0;
  if (top !== "supported") return { flagged: true, argmax: top, reason: "answer" };
  return { flagged: p < floor, argmax: top, reason: p < floor ? "floor" : "answer" };
};

/** Question 2: flagged = escalate to the thinking-model adjudicator, which still records nothing. */
export const screenDecision = (
  outcome: EngineOutcome | undefined,
  floor = POLICY.escalateFloor,
): Screened => {
  if (outcome === undefined || outcome.kind === "failed")
    return { flagged: true, argmax: null, reason: "failed" };
  if (outcome.kind === "unanswered") return { flagged: true, argmax: null, reason: "abstained" };
  const top = argmax(outcome.probabilities);
  const p = outcome.probabilities[DECISION_LABELS[0]] ?? 0;
  const flagged = p >= floor;
  return {
    flagged,
    argmax: top,
    reason: flagged && top !== DECISION_LABELS[0] ? "floor" : "answer",
  };
};
