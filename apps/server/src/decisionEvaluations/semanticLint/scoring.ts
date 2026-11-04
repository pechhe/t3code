import type { Label } from "./corpusTypes.ts";

export type Outcome =
  | { readonly kind: "answered"; readonly probability: number }
  | { readonly kind: "unanswered"; readonly status: "unknown" | "refusal" | "no-predicate" }
  | { readonly kind: "failed"; readonly code: string };

export interface Prediction {
  readonly caseId: string;
  readonly category: string;
  readonly reference: Label;
  readonly flagged: boolean;
  readonly outcome: Outcome;
}

export interface Interval {
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

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

export interface Confusion {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
}

export const confusion = (predictions: ReadonlyArray<Prediction>): Confusion => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of predictions) {
    if (p.reference === "uncertain") continue;
    if (p.reference === "defect") {
      if (p.flagged) tp++;
      else fn++;
    } else if (p.flagged) fp++;
    else tn++;
  }
  return { tp, fp, fn, tn };
};

/** Mann-Whitney AUC over answered cases with a certain reference; null without both classes. */
export const auc = (predictions: ReadonlyArray<Prediction>): number | null => {
  const scored = predictions.flatMap((p) =>
    p.outcome.kind === "answered" && p.reference !== "uncertain"
      ? [{ positive: p.reference === "defect", score: p.outcome.probability }]
      : [],
  );
  const positives = scored.filter((s) => s.positive);
  const negatives = scored.filter((s) => !s.positive);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const p of positives)
    for (const n of negatives) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
};

export interface SystemSummary {
  readonly cases: number;
  readonly answered: number;
  readonly failed: number;
  readonly unanswered: number;
  readonly confusion: Confusion;
  readonly precision: Interval;
  readonly recall: Interval;
  readonly falseAlarmRate: Interval;
  readonly auc: number | null;
  readonly flaggedTotal: number;
  readonly flaggedPerTrueDefect: number | null;
  readonly uncertainFlagged: number;
  readonly uncertainTotal: number;
  readonly misses: ReadonlyArray<string>;
  readonly falseAlarms: ReadonlyArray<string>;
}

/** Failures, refusals and unknowns count as not flagged: a screener that cannot answer misses. */
export const summarize = (predictions: ReadonlyArray<Prediction>): SystemSummary => {
  const c = confusion(predictions);
  const uncertain = predictions.filter((p) => p.reference === "uncertain");
  const flaggedTotal = predictions.filter((p) => p.flagged).length;
  return {
    cases: predictions.length,
    answered: predictions.filter((p) => p.outcome.kind === "answered").length,
    failed: predictions.filter((p) => p.outcome.kind === "failed").length,
    unanswered: predictions.filter((p) => p.outcome.kind === "unanswered").length,
    confusion: c,
    precision: wilson(c.tp, c.tp + c.fp),
    recall: wilson(c.tp, c.tp + c.fn),
    falseAlarmRate: wilson(c.fp, c.fp + c.tn),
    auc: auc(predictions),
    flaggedTotal,
    flaggedPerTrueDefect: c.tp === 0 ? null : flaggedTotal / c.tp,
    uncertainFlagged: uncertain.filter((p) => p.flagged).length,
    uncertainTotal: uncertain.length,
    misses: predictions.filter((p) => p.reference === "defect" && !p.flagged).map((p) => p.caseId),
    falseAlarms: predictions.filter((p) => p.reference === "ok" && p.flagged).map((p) => p.caseId),
  };
};

export interface CostSummary {
  readonly calls: number;
  readonly latencyMs: {
    readonly mean: number | null;
    readonly p50: number | null;
    readonly max: number | null;
  };
  /** Attempts that returned no usage or cost, such as failures; their spend is unknown, not zero. */
  readonly unobservedAttempts: number;
  readonly inputTokens: number | null;
  readonly knownInputTokens: number;
  readonly costUsd: number | null;
  readonly knownCostUsd: number;
  readonly costKnownCalls: number;
  readonly costStatuses: ReadonlyArray<string>;
}

export interface UsageRow {
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: string;
}

/** Sums only what providers reported; any unknown component keeps the total unknown. */
export const summarizeCost = (
  rows: ReadonlyArray<UsageRow>,
  unobservedAttempts = 0,
): CostSummary => {
  const sorted = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const known = rows.filter((r) => r.costUsd !== null);
  const tokensKnown = rows.every((r) => r.inputTokens !== null);
  return {
    calls: rows.length,
    latencyMs: {
      mean: rows.length === 0 ? null : sorted.reduce((n, v) => n + v, 0) / sorted.length,
      p50: rows.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!,
      max: rows.length === 0 ? null : sorted[sorted.length - 1]!,
    },
    unobservedAttempts,
    inputTokens:
      unobservedAttempts === 0 && rows.length > 0 && tokensKnown
        ? rows.reduce((n, r) => n + r.inputTokens!, 0)
        : null,
    knownInputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
    costUsd:
      unobservedAttempts === 0 && rows.length > 0 && known.length === rows.length
        ? known.reduce((n, r) => n + r.costUsd!, 0)
        : null,
    knownCostUsd: known.reduce((n, r) => n + r.costUsd!, 0),
    costKnownCalls: known.length,
    costStatuses: [...new Set(rows.map((r) => r.costStatus))].sort(),
  };
};
