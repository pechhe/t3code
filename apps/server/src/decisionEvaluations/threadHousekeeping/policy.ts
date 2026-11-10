export type EngineOutcome =
  | {
      readonly kind: "answered";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly kind: "unanswered"; readonly status: "unknown" | "refusal" | "no-choice" }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Declared before any held-out call; the held-out run never moves them.
 * A project answer counts only when its chosen label has at least `projectFloor`; anything else leaves the chat where it is.
 * A wake counts as caught only when `nothing_new` has at least `catchFloor`. It is higher because wrongly catching a wake that carries
 * something costs a missed result, while missing a catch only costs a turn.
 */
export const POLICY = {
  version: "thread-housekeeping-policy-v1",
  projectFloor: 0.6,
  catchFloor: 0.8,
  /** Sensitivity only, reported beside the declared floors and never a headline. */
  sensitivityFloors: [0.6, 0.7, 0.9],
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

export interface ProjectRoute {
  /** A listed choice id, `none` (leave it), or `abstain` (no usable answer: leave it). */
  readonly value: string;
  readonly answered: boolean;
}

export const routeProject = (
  outcome: EngineOutcome | undefined,
  floor: number = POLICY.projectFloor,
): ProjectRoute => {
  if (outcome === undefined || outcome.kind !== "answered")
    return { value: "abstain", answered: false };
  const label = argmax(outcome.probabilities);
  if (label === null || label === "unknown" || (outcome.probabilities[label] ?? 0) < floor)
    return { value: "abstain", answered: false };
  return { value: label, answered: label !== "none" };
};

export const caughtWake = (
  outcome: EngineOutcome | undefined,
  floor: number = POLICY.catchFloor,
): boolean => {
  if (outcome === undefined || outcome.kind !== "answered") return false;
  return (
    argmax(outcome.probabilities) === "nothing_new" &&
    (outcome.probabilities.nothing_new ?? 0) >= floor
  );
};
