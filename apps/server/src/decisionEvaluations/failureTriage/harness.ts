// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the static corpus
import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { summarizeCost, type UsageRow } from "../semanticLint/scoring.ts";
import { baselineLabel } from "./baseline.ts";
import type { Reference, TriageCase, TriageLabel } from "./corpusTypes.ts";
import { buildRequest } from "./rule.ts";
import { predictionOf, summarize, type Outcome, type Prediction } from "./scoring.ts";

export type Engine = DecisionRequest["engine"];

export interface CallRecord {
  readonly caseId: string;
  readonly engine: Engine;
  readonly outcome: Outcome;
  readonly requestedModel: string | null;
  readonly resolvedModel: string | null;
  readonly adapterVersion: string | null;
  readonly digest: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: string | null;
}

const outcomeOf = (result: DecisionResult): Outcome => {
  const answer = result.answers.find((a) => a.id === "cause");
  if (answer === undefined) return { kind: "unanswered", status: "no-choice" };
  if (answer.status !== "answered") return { kind: "unanswered", status: answer.status };
  return answer.type === "choice"
    ? { kind: "answered", choice: answer.choice, probabilities: answer.probabilities }
    : { kind: "unanswered", status: "no-choice" };
};

const failedRecord = (c: TriageCase, engine: Engine, code: string): CallRecord => ({
  caseId: c.id,
  engine,
  outcome: { kind: "failed", code },
  requestedModel: null,
  resolvedModel: null,
  adapterVersion: null,
  digest: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  costStatus: null,
});

/** One admitted call per case and engine, in order, with a fixed gap that keeps well under the shared rate limit. No retry. */
export const runEvaluation = Effect.fn("FailureTriage.runEvaluation")(function* (
  cases: ReadonlyArray<TriageCase>,
  engines: ReadonlyArray<Engine>,
  options: { readonly gapMs: number },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  for (const c of cases) {
    for (const engine of engines) {
      const record = yield* service.decide(buildRequest(engine, c)).pipe(
        Effect.map((result): CallRecord => ({
          caseId: c.id,
          engine,
          outcome: outcomeOf(result),
          requestedModel: result.requestedModel,
          resolvedModel: result.resolvedModel,
          adapterVersion: result.adapterVersion,
          digest: result.digest,
          latencyMs: result.latencyMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.cost.usd,
          costStatus: result.cost.status,
        })),
        Effect.catchTags({
          DecisionError: (error) => Effect.succeed(failedRecord(c, engine, error.code)),
        }),
      );
      records.push(record);
      yield* Effect.sleep(Duration.millis(options.gapMs));
    }
  }
  return records;
});

const predictionsFor = (
  cases: ReadonlyArray<TriageCase>,
  reference: (id: string) => Reference,
  predict: (c: TriageCase) => { label: TriageLabel | null; tie: boolean },
): ReadonlyArray<Prediction> =>
  cases.map((c) => {
    const p = predict(c);
    return {
      caseId: c.id,
      stratum: c.stratum,
      supported: reference(c.id),
      resolved: c.resolvedCause.label,
      predicted: p.label,
      tie: p.tie,
    };
  });

export const evaluate = (
  cases: ReadonlyArray<TriageCase>,
  records: ReadonlyArray<CallRecord>,
  reference: (id: string) => Reference,
) => {
  const systems: Record<string, ReturnType<typeof summarize>> = {
    baseline: summarize(
      predictionsFor(cases, reference, (c) => ({ label: baselineLabel(c), tie: false })),
    ),
    alwaysUnknown: summarize(
      predictionsFor(cases, reference, () => ({ label: "unknown", tie: false })),
    ),
  };
  const cost: Record<
    string,
    ReturnType<typeof summarizeCost> & {
      attempts: number;
      failedAttempts: number;
      choiceDisagreesWithArgmax: number;
      knownOutputTokens: number;
    }
  > = {};
  const predictions: Record<
    string,
    ReadonlyArray<{ caseId: string; predicted: TriageLabel | null }>
  > = {
    baseline: cases.map((c) => ({ caseId: c.id, predicted: baselineLabel(c) })),
  };
  for (const engine of new Set(records.map((r) => r.engine))) {
    const own = new Map(records.filter((r) => r.engine === engine).map((r) => [r.caseId, r]));
    const decide = (c: TriageCase) => {
      const outcome = own.get(c.id)?.outcome ?? { kind: "failed" as const, code: "not-run" };
      return predictionOf(outcome);
    };
    systems[engine] = summarize(predictionsFor(cases, reference, decide));
    predictions[engine] = cases.map((c) => ({ caseId: c.id, predicted: decide(c).label }));
    const rows: UsageRow[] = [...own.values()].flatMap((r) =>
      r.latencyMs === null
        ? []
        : [
            {
              latencyMs: r.latencyMs,
              inputTokens: r.inputTokens,
              costUsd: r.costUsd,
              costStatus: r.costStatus ?? "unknown",
            },
          ],
    );
    cost[engine] = {
      ...summarizeCost(rows, own.size - rows.length),
      attempts: own.size,
      failedAttempts: [...own.values()].filter((r) => r.outcome.kind === "failed").length,
      choiceDisagreesWithArgmax: [...own.values()].filter(
        (r) => r.outcome.kind === "answered" && predictionOf(r.outcome).label !== r.outcome.choice,
      ).length,
      knownOutputTokens:
        rows.length === 0 ? 0 : [...own.values()].reduce((n, r) => n + (r.outputTokens ?? 0), 0),
    };
  }
  return { systems, cost, predictions };
};

/** Stable identity of what the models are shown: ids, splits, families, strata and evidence, not labels or results. */
export const corpusDigest = (cases: ReadonlyArray<TriageCase>): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(cases.map((c) => [c.id, c.split, c.family, c.stratum, c.evidence])))
    .digest("hex");
