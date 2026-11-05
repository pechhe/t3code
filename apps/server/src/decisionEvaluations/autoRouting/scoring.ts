import { wilson, type Interval } from "../semanticLint/scoring.ts";
import type { AutoCase, Decision } from "./corpusTypes.ts";
import type { Routed } from "./policy.ts";

export const WORKFLOW_RANK = { chat: 0, solo: 1, shape: 1, lead: 2 } as const;

export type Reference = string | "uncertain";

export interface Judged {
  readonly caseId: string;
  readonly decision: Decision;
  readonly reference: Reference;
  readonly routed: Routed;
  readonly constrained: boolean;
}

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly interval: Interval;
  readonly cases: ReadonlyArray<string>;
}
const rate = (hits: ReadonlyArray<string>, denominator: number): Rate => ({
  numerator: hits.length,
  denominator,
  interval: wilson(hits.length, denominator),
  cases: hits,
});

export type Direction = "correct" | "under" | "over" | "lateral";

/** How a wrong routing affects the work: under-served work risks escalation and rework, over-served work wastes capability. */
export const direction = (decision: Decision, predicted: string, reference: string): Direction => {
  if (predicted === reference) return "correct";
  if (decision === "mainModel" || decision === "subagentTier")
    return predicted === "routine" ? "under" : "over";
  if (decision === "workflow") {
    const p = WORKFLOW_RANK[predicted as keyof typeof WORKFLOW_RANK];
    const r = WORKFLOW_RANK[reference as keyof typeof WORKFLOW_RANK];
    return p < r ? "under" : p > r ? "over" : "lateral";
  }
  return "lateral";
};

export interface DecisionSummary {
  readonly scored: number;
  readonly uncertainReference: number;
  readonly correct: Rate;
  readonly fromConstraint: number;
  readonly fromEngine: number;
  readonly fallback: number;
  readonly under: ReadonlyArray<string>;
  readonly over: ReadonlyArray<string>;
  readonly lateral: ReadonlyArray<string>;
  /** Correct among cases the system decided itself (no constraint, no fallback). */
  readonly correctWhenDecided: Rate;
  /** The tier decisions' relative cost in worker-cost units; null for other decisions. */
  readonly relativeCost: Readonly<Record<string, number>> | null;
}

/** Relative worker cost with routine = 1 and demanding = k. A routine answer to demanding work pays once and is redone at demanding. */
export const COST_RATIOS = [2, 4, 10] as const;
export const REWORK_FRACTION = 0.5;

export const summarize = (decision: Decision, judged: ReadonlyArray<Judged>): DecisionSummary => {
  const certain = judged.filter((j) => j.reference !== "uncertain");
  const hit = certain.filter((j) => j.routed.value === j.reference);
  const decided = certain.filter((j) => j.routed.source === "engine");
  const dirs = certain.map((j) => ({ j, d: direction(decision, j.routed.value, j.reference) }));
  const tier = decision === "mainModel" || decision === "subagentTier";
  return {
    scored: certain.length,
    uncertainReference: judged.length - certain.length,
    correct: rate(
      hit.map((j) => j.caseId),
      certain.length,
    ),
    fromConstraint: judged.filter((j) => j.routed.source === "constraint").length,
    fromEngine: judged.filter((j) => j.routed.source === "engine").length,
    fallback: judged.filter((j) => j.routed.source === "fallback").length,
    under: dirs.filter((x) => x.d === "under").map((x) => x.j.caseId),
    over: dirs.filter((x) => x.d === "over").map((x) => x.j.caseId),
    lateral: dirs.filter((x) => x.d === "lateral").map((x) => x.j.caseId),
    correctWhenDecided: rate(
      decided.filter((j) => j.routed.value === j.reference).map((j) => j.caseId),
      decided.length,
    ),
    relativeCost: tier
      ? Object.fromEntries(
          COST_RATIOS.map((k) => [
            `demanding=${k}x`,
            certain.reduce((n, j) => {
              if (j.routed.value === "demanding") return n + k;
              return n + 1 + (j.reference === "demanding" ? REWORK_FRACTION + k : 0);
            }, 0),
          ]),
        )
      : null,
  };
};

export const casesById = (cases: ReadonlyArray<AutoCase>) => new Map(cases.map((c) => [c.id, c]));
