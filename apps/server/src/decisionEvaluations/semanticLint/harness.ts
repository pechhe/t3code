// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the static corpus
import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { baselineFlag } from "./baseline.ts";
import type { CorpusCase, Label } from "./corpusTypes.ts";
import { buildRequest, FLAG_THRESHOLD } from "./rule.ts";
import {
  summarize,
  summarizeCost,
  type Outcome,
  type Prediction,
  type UsageRow,
} from "./scoring.ts";

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
  readonly costUsd: number | null;
  readonly costStatus: string | null;
}

const outcomeOf = (result: DecisionResult): Outcome => {
  const answer = result.answers.find((a) => a.id === "defect");
  if (answer === undefined) return { kind: "unanswered", status: "no-predicate" };
  if (answer.status !== "answered") return { kind: "unanswered", status: answer.status };
  return answer.type === "predicate"
    ? { kind: "answered", probability: answer.probability }
    : { kind: "unanswered", status: "no-predicate" };
};

/** One admitted call per case and engine, in order, with a fixed gap that keeps well under the shared rate limit. No retry. */
export const runEvaluation = Effect.fn("SemanticLint.runEvaluation")(function* (
  cases: ReadonlyArray<CorpusCase>,
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
          costUsd: result.cost.usd,
          costStatus: result.cost.status,
        })),
        Effect.catchTags({
          DecisionError: (error) =>
            Effect.succeed<CallRecord>({
              caseId: c.id,
              engine,
              outcome: { kind: "failed", code: error.code },
              requestedModel: null,
              resolvedModel: null,
              adapterVersion: null,
              digest: null,
              latencyMs: null,
              inputTokens: null,
              costUsd: null,
              costStatus: null,
            }),
        }),
      );
      records.push(record);
      yield* Effect.sleep(Duration.millis(options.gapMs));
    }
  }
  return records;
});

export const flaggedByModel = (outcome: Outcome): boolean =>
  outcome.kind === "answered" && outcome.probability >= FLAG_THRESHOLD;

export const evaluate = (
  cases: ReadonlyArray<CorpusCase>,
  records: ReadonlyArray<CallRecord>,
  reference: (id: string) => Label,
) => {
  const systems: Record<string, ReturnType<typeof summarize>> = {};
  const cost: Record<
    string,
    ReturnType<typeof summarizeCost> & { attempts: number; failedAttempts: number }
  > = {};
  const engines = [...new Set(records.map((r) => r.engine))];
  const predict = (flag: (c: CorpusCase) => Pick<Prediction, "flagged" | "outcome">) =>
    cases.map((c): Prediction => ({
      caseId: c.id,
      category: c.category,
      reference: reference(c.id),
      ...flag(c),
    }));
  systems["baseline"] = summarize(
    predict((c) => ({
      flagged: baselineFlag(c),
      outcome: { kind: "answered", probability: baselineFlag(c) ? 1 : 0 },
    })),
  );
  for (const engine of engines) {
    const own = new Map(records.filter((r) => r.engine === engine).map((r) => [r.caseId, r]));
    systems[engine] = summarize(
      predict((c) => {
        const outcome = own.get(c.id)?.outcome ?? { kind: "failed" as const, code: "not-run" };
        return { flagged: flaggedByModel(outcome), outcome };
      }),
    );
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
    };
  }
  return { systems, cost };
};

/** Stable identity of the cases a run used, independent of labels and results. */
export const corpusDigest = (cases: ReadonlyArray<CorpusCase>): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(cases.map((c) => [c.id, c.split, c.category, c.stratum, c.evidence])))
    .digest("hex");
