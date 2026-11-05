import { applyConstraints, currentDefault, type Choices } from "./baseline.ts";
import type { AutoCase, Decision, Tier } from "./corpusTypes.ts";
import { extractConstraints } from "./constraints.ts";

export type EngineOutcome =
  | {
      readonly kind: "answered";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly kind: "unanswered"; readonly status: "unknown" | "refusal" | "no-choice" }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Abstain and fallback, declared before any held-out call (the tune split tried choiceFloor 0.4 once; it was worse than 0.6 on tune, so 0.6 stays: `results/tune-floor-0.4.json`; the held-out split never moves them).
 * An engine's choice is used only above its confidence floor. Anything else (failure, `unknown`, refusal, a tie, low confidence)
 * keeps the current behaviour; for a tier that is the demanding one, so the pipeline can only fail towards more capability.
 */
export const POLICY = {
  version: "auto-routing-policy-v1",
  /** Minimum probability of the chosen label for project and workflow. */
  choiceFloor: 0.6,
  /** A tier goes down to routine only when the engine puts at least this probability on routine. */
  routineFloor: 0.75,
} as const;

export type Source = "constraint" | "engine" | "fallback";

export interface Routed {
  readonly value: string;
  readonly source: Source;
  /** Engine answered but its choice was set aside by a constraint or a floor. */
  readonly engineChoice: string | null;
  readonly reason: string;
}

const argmax = (p: Readonly<Record<string, number>>): { label: string | null; tie: boolean } => {
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
  return { label: tie ? null : best, tie };
};

/** Combine the user's explicit constraints, one engine's answer and the current-behaviour fallback for one decision. */
export const routeDecision = (
  c: AutoCase,
  decision: Decision,
  outcome: EngineOutcome | undefined,
): Routed => {
  const fallback = currentDefault(c)[decision] as string;
  const { final, constrained } = applyConstraints(c, currentDefault(c));
  const engineChoice =
    outcome?.kind === "answered" ? (argmax(outcome.probabilities).label ?? null) : null;
  if (constrained.includes(decision))
    return {
      value: final[decision] as string,
      source: "constraint",
      engineChoice,
      reason: "explicit user constraint",
    };
  if (outcome === undefined || outcome.kind !== "answered")
    return {
      value: fallback,
      source: "fallback",
      engineChoice,
      reason: outcome?.kind ?? "no call",
    };
  const { label } = argmax(outcome.probabilities);
  if (label === null || label === "unknown")
    return {
      value: fallback,
      source: "fallback",
      engineChoice,
      reason: label === null ? "tie" : "unknown",
    };
  if (decision === "mainModel" || decision === "subagentTier") {
    const routine = outcome.probabilities.routine ?? 0;
    return routine >= POLICY.routineFloor
      ? { value: "routine", source: "engine", engineChoice, reason: "routine above floor" }
      : {
          value: "demanding",
          source: label === "demanding" ? "engine" : "fallback",
          engineChoice,
          reason: "below routine floor",
        };
  }
  return (outcome.probabilities[label] ?? 0) >= POLICY.choiceFloor
    ? { value: label, source: "engine", engineChoice, reason: "above floor" }
    : { value: fallback, source: "fallback", engineChoice, reason: "below choice floor" };
};

export const routeAll = (
  c: AutoCase,
  outcomes: Partial<Record<Decision, EngineOutcome>>,
): Record<Decision, Routed> => ({
  project: routeDecision(c, "project", outcomes.project),
  workflow: routeDecision(c, "workflow", outcomes.workflow),
  mainModel: routeDecision(c, "mainModel", outcomes.mainModel),
  subagentTier: routeDecision(c, "subagentTier", outcomes.subagentTier),
});

/**
 * An established thread keeps its route. A later message re-routes only when the user states a change outright;
 * a classifier reading a follow-up such as "also add a test" can never move the thread.
 */
export const settleThreadRoute = (
  previous: Choices | undefined,
  proposed: Choices,
  followUpText: string,
): Choices => {
  if (previous === undefined) return proposed;
  const k = extractConstraints(followUpText);
  return {
    project: k.project ?? previous.project,
    workflow: k.workflow ?? previous.workflow,
    mainModel: k.model
      ? k.model === "opus"
        ? "demanding"
        : ("routine" as Tier)
      : previous.mainModel,
    subagentTier: previous.subagentTier,
  };
};
