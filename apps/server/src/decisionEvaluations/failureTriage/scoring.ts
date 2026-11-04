import { wilson, type Interval } from "../semanticLint/scoring.ts";
import { TRIAGE_LABELS, type Reference, type Stratum, type TriageLabel } from "./corpusTypes.ts";

export type Outcome =
  | {
      readonly kind: "answered";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly kind: "unanswered"; readonly status: "unknown" | "refusal" | "no-choice" }
  | { readonly kind: "failed"; readonly code: string };

export interface Prediction {
  readonly caseId: string;
  readonly stratum: Stratum;
  readonly supported: Reference;
  readonly resolved: TriageLabel;
  /** null: the system gave no decision (failure, refusal or transport error); that is not an abstention. */
  readonly predicted: TriageLabel | null;
  readonly tie: boolean;
}

/** The label with the highest returned probability; an exact tie falls to unknown. The returned `choice` is recorded but not trusted. */
export const argmax = (
  probabilities: Readonly<Record<string, number>>,
): { readonly label: TriageLabel; readonly tie: boolean } => {
  let best: TriageLabel | undefined;
  let bestP = -1;
  let tie = false;
  for (const label of TRIAGE_LABELS) {
    const p = probabilities[label];
    if (p === undefined) continue;
    if (p > bestP) {
      best = label;
      bestP = p;
      tie = false;
    } else if (p === bestP) tie = true;
  }
  return best === undefined
    ? { label: "unknown", tie: true }
    : { label: tie ? "unknown" : best, tie };
};

export const predictionOf = (outcome: Outcome): { label: TriageLabel | null; tie: boolean } =>
  outcome.kind === "answered"
    ? (() => {
        const r = argmax(outcome.probabilities);
        return { label: r.label, tie: r.tie };
      })()
    : { label: null, tie: false };

const DISMISSAL: ReadonlySet<TriageLabel> = new Set(["known-flake", "environment"]);

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

export interface Summary {
  readonly cases: number;
  readonly decided: number;
  readonly noDecision: number;
  readonly explicitUnknown: number;
  readonly ties: number;
  readonly supportedUncertain: number;
  /** Predicted label against the label the evidence supports; a missing decision counts as wrong. */
  readonly accuracy: Rate;
  /** Predicted label against the cause later established, over every case, annotator-disputed ones included. */
  readonly resolvedRecovery: Rate;
  /** Resolved regression predicted as known-flake or environment. */
  readonly dangerousStrict: Rate;
  /** Resolved regression or never-resolved cause predicted as known-flake or environment. */
  readonly dangerousWide: Rate;
  /** As wide, but a fixture prediction also diverts the case from investigating the product. */
  readonly unsafeDiversion: Rate;
  /** known-flake predicted where the supported label is not known-flake; denominator is cases whose supported label is certain and not known-flake. */
  readonly falseFlake: Rate;
  /** Explicit unknown where the evidence supports a specific label. */
  readonly overAbstention: Rate;
  /** Explicit unknown where the evidence supports unknown. */
  readonly appropriateAbstention: Rate;
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly byStratum: Readonly<
    Record<string, { cases: number; accuracy: Rate; dangerousWide: Rate }>
  >;
}

const core = (predictions: ReadonlyArray<Prediction>) => {
  const certain = predictions.filter((p) => p.supported !== "uncertain");
  const correct = certain.filter((p) => p.predicted === p.supported).map((p) => p.caseId);
  const riskPool = predictions.filter(
    (p) => p.resolved === "regression" || p.resolved === "unknown",
  );
  const regPool = predictions.filter((p) => p.resolved === "regression");
  const dismissed = (p: Prediction) => p.predicted !== null && DISMISSAL.has(p.predicted);
  return { certain, correct, riskPool, regPool, dismissed };
};

export const summarize = (predictions: ReadonlyArray<Prediction>): Summary => {
  const { certain, correct, riskPool, regPool, dismissed } = core(predictions);
  const nonFlake = certain.filter((p) => p.supported !== "known-flake");
  const specific = certain.filter((p) => p.supported !== "unknown");
  const unknownSupported = certain.filter((p) => p.supported === "unknown");
  const confusion: Record<string, Record<string, number>> = {};
  for (const p of certain) {
    const row = (confusion[p.supported] ??= {});
    const key = p.predicted ?? "no-decision";
    row[key] = (row[key] ?? 0) + 1;
  }
  const strata = [...new Set(predictions.map((p) => p.stratum))].sort();
  return {
    cases: predictions.length,
    decided: predictions.filter((p) => p.predicted !== null).length,
    noDecision: predictions.filter((p) => p.predicted === null).length,
    explicitUnknown: predictions.filter((p) => p.predicted === "unknown").length,
    ties: predictions.filter((p) => p.tie).length,
    supportedUncertain: predictions.length - certain.length,
    accuracy: rate(correct, certain.length),
    resolvedRecovery: rate(
      predictions.filter((p) => p.predicted === p.resolved).map((p) => p.caseId),
      predictions.length,
    ),
    dangerousStrict: rate(
      regPool.filter(dismissed).map((p) => p.caseId),
      regPool.length,
    ),
    dangerousWide: rate(
      riskPool.filter(dismissed).map((p) => p.caseId),
      riskPool.length,
    ),
    unsafeDiversion: rate(
      riskPool.filter((p) => dismissed(p) || p.predicted === "fixture").map((p) => p.caseId),
      riskPool.length,
    ),
    falseFlake: rate(
      nonFlake.filter((p) => p.predicted === "known-flake").map((p) => p.caseId),
      nonFlake.length,
    ),
    overAbstention: rate(
      specific.filter((p) => p.predicted === "unknown").map((p) => p.caseId),
      specific.length,
    ),
    appropriateAbstention: rate(
      unknownSupported.filter((p) => p.predicted === "unknown").map((p) => p.caseId),
      unknownSupported.length,
    ),
    confusion,
    byStratum: Object.fromEntries(
      strata.map((stratum) => {
        const own = predictions.filter((p) => p.stratum === stratum);
        const c = core(own);
        return [
          stratum,
          {
            cases: own.length,
            accuracy: rate(c.correct, c.certain.length),
            dangerousWide: rate(
              c.riskPool.filter(c.dismissed).map((p) => p.caseId),
              c.riskPool.length,
            ),
          },
        ];
      }),
    ),
  };
};
