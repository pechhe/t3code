import { wilson, type Interval } from "../semanticLint/scoring.ts";
import type { ClaimLabel, DecisionLabel } from "./corpusTypes.ts";

/** A label the labelers could not settle on is `uncertain`; it is reported, never scored. */
export type Reference = string | "uncertain";

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

export interface Judgement {
  readonly caseId: string;
  readonly reference: Reference;
  /** The system's own label (null when none) and whether it asks a person or adjudicator to look. */
  readonly label: string | null;
  readonly flagged: boolean;
  /** An engine call that failed or abstained; always flagged, counted separately. */
  readonly abstained: boolean;
}

export interface ClaimSummary {
  readonly scored: number;
  readonly uncertainReference: number;
  /** Reference says contradicted or insufficient (a person should look). */
  readonly needReview: number;
  /** The reference is unsupported and the system let the claim through: the dangerous miss. */
  readonly unsupportedMisses: Rate;
  readonly reviewRecall: Rate;
  readonly contradictedRecall: Rate;
  /** Reference is supported and the system flagged it: needless review. */
  readonly falseAlarms: Rate;
  readonly flagged: number;
  readonly abstentions: number;
  /** Cases a person would review as a share of all scored cases. */
  readonly reviewLoad: Rate;
  readonly exact: Rate;
}

export const summarizeClaims = (judged: ReadonlyArray<Judgement>): ClaimSummary => {
  const scored = judged.filter((j) => j.reference !== "uncertain");
  const unsupported = scored.filter((j) => j.reference !== "supported");
  const supported = scored.filter((j) => j.reference === "supported");
  const contradicted = scored.filter((j) => j.reference === "contradicted");
  const ids = (xs: ReadonlyArray<Judgement>) => xs.map((j) => j.caseId);
  return {
    scored: scored.length,
    uncertainReference: judged.length - scored.length,
    needReview: unsupported.length,
    unsupportedMisses: rate(ids(unsupported.filter((j) => !j.flagged)), unsupported.length),
    reviewRecall: rate(ids(unsupported.filter((j) => j.flagged)), unsupported.length),
    contradictedRecall: rate(ids(contradicted.filter((j) => j.flagged)), contradicted.length),
    falseAlarms: rate(ids(supported.filter((j) => j.flagged)), supported.length),
    flagged: scored.filter((j) => j.flagged).length,
    abstentions: scored.filter((j) => j.abstained).length,
    reviewLoad: rate(ids(scored.filter((j) => j.flagged)), scored.length),
    exact: rate(ids(scored.filter((j) => j.label === j.reference)), scored.length),
  };
};

export interface DecisionSummary {
  readonly scored: number;
  readonly uncertainReference: number;
  readonly candidates: number;
  /** Reference is settled-consequential and the system escalated it. */
  readonly candidateRecall: Rate;
  readonly missedCandidates: Rate;
  /** Reference is anything else and the system escalated it: a needless adjudication. */
  readonly falseEscalations: Rate;
  /** Of the escalations, those the reference does not call settled-consequential, by reference label. */
  readonly falseEscalationsByReference: Readonly<Record<string, number>>;
  readonly escalated: number;
  readonly abstentions: number;
  readonly adjudicationLoad: Rate;
  readonly exact: Rate;
}

export const summarizeDecisions = (judged: ReadonlyArray<Judgement>): DecisionSummary => {
  const scored = judged.filter((j) => j.reference !== "uncertain");
  const candidates = scored.filter((j) => j.reference === "settled-consequential");
  const others = scored.filter((j) => j.reference !== "settled-consequential");
  const ids = (xs: ReadonlyArray<Judgement>) => xs.map((j) => j.caseId);
  const byRef: Record<string, number> = {};
  for (const j of others.filter((o) => o.flagged))
    byRef[j.reference] = (byRef[j.reference] ?? 0) + 1;
  return {
    scored: scored.length,
    uncertainReference: judged.length - scored.length,
    candidates: candidates.length,
    candidateRecall: rate(ids(candidates.filter((j) => j.flagged)), candidates.length),
    missedCandidates: rate(ids(candidates.filter((j) => !j.flagged)), candidates.length),
    falseEscalations: rate(ids(others.filter((j) => j.flagged)), others.length),
    falseEscalationsByReference: byRef,
    escalated: scored.filter((j) => j.flagged).length,
    abstentions: scored.filter((j) => j.abstained).length,
    adjudicationLoad: rate(ids(scored.filter((j) => j.flagged)), scored.length),
    exact: rate(ids(scored.filter((j) => j.label === j.reference)), scored.length),
  };
};

export type { ClaimLabel, DecisionLabel };
