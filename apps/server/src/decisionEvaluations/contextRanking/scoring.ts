import { wilson, type Interval } from "../semanticLint/scoring.ts";
import type { Reference, Stratum } from "./corpusTypes.ts";
import { THRESHOLD, TOKEN_BUDGET, TOP_K } from "./rule.ts";

export interface ScoredCandidate {
  readonly id: string;
  readonly ref: string;
  /** Estimated tokens of this candidate's body. */
  readonly tokens: number;
  readonly reference: Reference;
  /** null: the system gave this candidate no score (failed call, refusal or unknown); it is never selected and ranks last. */
  readonly score: number | null;
}

export interface CaseView {
  readonly caseId: string;
  readonly stratum: Stratum;
  /** Estimated tokens of the mandatory and requested context, included whatever a ranker says. */
  readonly fixedTokens: number;
  readonly candidates: ReadonlyArray<ScoredCandidate>;
}

export type RuleName = "topK" | "threshold" | "budget" | "all" | "none";
export const RULES: ReadonlyArray<RuleName> = ["topK", "threshold", "budget", "all", "none"];

/** Highest score first; unscored candidates last; equal scores keep the shown order, so the result never depends on hash order. */
export const ranked = (
  candidates: ReadonlyArray<ScoredCandidate>,
): ReadonlyArray<ScoredCandidate> =>
  [...candidates].sort(
    (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.ref.localeCompare(b.ref),
  );

export const select = (view: CaseView, rule: RuleName): ReadonlySet<string> => {
  if (rule === "all") return new Set(view.candidates.map((c) => c.id));
  if (rule === "none") return new Set();
  const order = ranked(view.candidates).filter((c) => c.score !== null);
  if (rule === "topK") return new Set(order.slice(0, TOP_K).map((c) => c.id));
  if (rule === "threshold")
    return new Set(order.filter((c) => c.score! >= THRESHOLD).map((c) => c.id));
  const chosen = new Set<string>();
  let spent = 0;
  for (const c of order) {
    if (spent + c.tokens > TOKEN_BUDGET) continue;
    spent += c.tokens;
    chosen.add(c.id);
  }
  return chosen;
};

/** Average precision of the needed candidates in the system's order; unscored candidates earn nothing but stay in the denominator. Null when a case has none. */
export const averagePrecision = (view: CaseView): number | null => {
  const order = ranked(view.candidates);
  const needed = order.filter((c) => c.reference === "needed").length;
  if (needed === 0) return null;
  let hits = 0;
  let sum = 0;
  order.forEach((c, i) => {
    if (c.reference !== "needed" || c.score === null) return;
    hits++;
    sum += hits / (i + 1);
  });
  return sum / needed;
};

export interface RuleSummary {
  readonly cases: number;
  readonly casesWithNeeded: number;
  readonly neededItems: number;
  readonly neededRetained: number;
  readonly recall: Interval;
  /** Cases in which at least one needed candidate was dropped. */
  readonly criticalOmissionCases: number;
  readonly criticalOmissionIds: ReadonlyArray<string>;
  readonly allNeededRetainedCases: number;
  readonly included: Readonly<Record<Reference, number>> & { readonly total: number };
  /** Needed among included candidates / included candidates; helpful and uncertain count as not needed here. */
  readonly precisionStrict: Interval;
  /** Unneeded among included candidates. */
  readonly noise: Interval;
  readonly meanIncludedCandidates: number | null;
  /** Estimated tokens including the fixed context. */
  readonly meanIncludedTokens: number | null;
  readonly meanAllTokens: number | null;
  readonly tokenSavingFraction: number | null;
  /** Mean candidates included on cases with no needed candidate: what a ranker adds when nothing should be added. */
  readonly meanIncludedWhenNoneNeeded: number | null;
}

export const summarizeRule = (views: ReadonlyArray<CaseView>, rule: RuleName): RuleSummary => {
  let neededItems = 0;
  let neededRetained = 0;
  let casesWithNeeded = 0;
  let allRetained = 0;
  const critical: string[] = [];
  const included: Record<Reference, number> = { needed: 0, helpful: 0, unneeded: 0, uncertain: 0 };
  let includedTotal = 0;
  let includedTokens = 0;
  let allTokens = 0;
  const noneNeeded: number[] = [];
  for (const v of views) {
    const chosen = select(v, rule);
    const needed = v.candidates.filter((c) => c.reference === "needed");
    neededItems += needed.length;
    const kept = needed.filter((c) => chosen.has(c.id)).length;
    neededRetained += kept;
    if (needed.length > 0) {
      casesWithNeeded++;
      if (kept === needed.length) allRetained++;
      else critical.push(v.caseId);
    } else noneNeeded.push(chosen.size);
    for (const c of v.candidates) {
      allTokens += c.tokens;
      if (!chosen.has(c.id)) continue;
      included[c.reference]++;
      includedTotal++;
      includedTokens += c.tokens;
    }
  }
  const n = views.length;
  const fixed = views.reduce((s, v) => s + v.fixedTokens, 0);
  const meanIncludedTokens = n === 0 ? null : (includedTokens + fixed) / n;
  const meanAllTokens = n === 0 ? null : (allTokens + fixed) / n;
  return {
    cases: n,
    casesWithNeeded,
    neededItems,
    neededRetained,
    recall: wilson(neededRetained, neededItems),
    criticalOmissionCases: critical.length,
    criticalOmissionIds: critical,
    allNeededRetainedCases: allRetained,
    included: { ...included, total: includedTotal },
    precisionStrict: wilson(included.needed, includedTotal),
    noise: wilson(included.unneeded, includedTotal),
    meanIncludedCandidates: n === 0 ? null : includedTotal / n,
    meanIncludedTokens,
    meanAllTokens,
    tokenSavingFraction:
      meanIncludedTokens === null || meanAllTokens === null || meanAllTokens === 0
        ? null
        : 1 - meanIncludedTokens / meanAllTokens,
    meanIncludedWhenNoneNeeded:
      noneNeeded.length === 0 ? null : noneNeeded.reduce((a, b) => a + b, 0) / noneNeeded.length,
  };
};

export interface SystemSummary {
  readonly rules: Readonly<Record<RuleName, RuleSummary>>;
  readonly meanAveragePrecision: number | null;
  readonly byStratumTopK: Readonly<
    Record<
      string,
      { cases: number; neededItems: number; neededRetained: number; criticalOmissionCases: number }
    >
  >;
}

export const summarizeSystem = (views: ReadonlyArray<CaseView>): SystemSummary => {
  const aps = views.map(averagePrecision).filter((x): x is number => x !== null);
  const byStratumTopK: Record<
    string,
    { cases: number; neededItems: number; neededRetained: number; criticalOmissionCases: number }
  > = {};
  for (const stratum of new Set(views.map((v) => v.stratum))) {
    const s = summarizeRule(
      views.filter((v) => v.stratum === stratum),
      "topK",
    );
    byStratumTopK[stratum] = {
      cases: s.cases,
      neededItems: s.neededItems,
      neededRetained: s.neededRetained,
      criticalOmissionCases: s.criticalOmissionCases,
    };
  }
  return {
    rules: Object.fromEntries(RULES.map((r) => [r, summarizeRule(views, r)])) as Record<
      RuleName,
      RuleSummary
    >,
    meanAveragePrecision: aps.length === 0 ? null : aps.reduce((a, b) => a + b, 0) / aps.length,
    byStratumTopK,
  };
};

/** Cases where `system` kept every needed candidate and `other` did not, and the reverse, under one rule. */
export const paired = (
  system: ReadonlyArray<CaseView>,
  other: ReadonlyArray<CaseView>,
  rule: RuleName,
) => {
  let better = 0;
  let worse = 0;
  const betterCases: string[] = [];
  const worseCases: string[] = [];
  system.forEach((v, i) => {
    const o = other[i]!;
    const needed = v.candidates.filter((c) => c.reference === "needed");
    if (needed.length === 0) return;
    const mine = needed.every((c) => select(v, rule).has(c.id));
    const theirs = needed.every((c) => select(o, rule).has(c.id));
    if (mine && !theirs) {
      better++;
      betterCases.push(v.caseId);
    } else if (!mine && theirs) {
      worse++;
      worseCases.push(v.caseId);
    }
  });
  return { better, worse, betterCases, worseCases };
};
