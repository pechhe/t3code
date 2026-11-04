// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the static corpus
import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { summarizeCost, type UsageRow } from "../semanticLint/scoring.ts";
import { lexicalScores } from "./baseline.ts";
import { mulberry32, orderedCandidates, POOL_BY_ID, seedOf } from "./caseBuilder.ts";
import type { RankingCase } from "./corpusTypes.ts";
import type { View } from "./labels.ts";
import { buildRequest, tokensOf } from "./rule.ts";
import { paired, summarizeSystem, type CaseView } from "./scoring.ts";

export type Engine = DecisionRequest["engine"];

export type Outcome =
  | {
      readonly kind: "answered";
      readonly scores: Readonly<Record<string, number | null>>;
      readonly unanswered: number;
    }
  | { readonly kind: "failed"; readonly code: string };

export interface CallRecord {
  readonly caseId: string;
  readonly engine: Engine;
  readonly outcome: Outcome;
  readonly requestedModel: string | null;
  readonly resolvedModel: string | null;
  readonly adapterVersion: string | null;
  readonly digest: string | null;
  readonly latencyMs: number | null;
  /** Estimated from the request's size before the call; compared with the provider's count afterwards. */
  readonly estimatedInputTokens: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: string | null;
}

const requestSize = (request: DecisionRequest) =>
  Buffer.byteLength(JSON.stringify([request.evidence, request.questions]));

const outcomeOf = (c: RankingCase, result: DecisionResult): Outcome => {
  const scores: Record<string, number | null> = {};
  let unanswered = 0;
  for (const { ref } of orderedCandidates(c)) {
    const answer = result.answers.find((a) => a.id === ref);
    if (answer !== undefined && answer.status === "answered" && answer.type === "predicate")
      scores[ref] = answer.probability;
    else {
      scores[ref] = null;
      unanswered++;
    }
  }
  return { kind: "answered", scores, unanswered };
};

/** One admitted call per case and engine, in order, with a fixed gap well under the shared rate limit. No retry. */
export const runEvaluation = Effect.fn("ContextRanking.runEvaluation")(function* (
  cases: ReadonlyArray<RankingCase>,
  engines: ReadonlyArray<Engine>,
  options: { readonly gapMs: number },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  for (const c of cases) {
    for (const engine of engines) {
      const request = buildRequest(engine, c);
      const estimatedInputTokens = tokensOf(requestSize(request));
      const record = yield* service.decide(request).pipe(
        Effect.map((result): CallRecord => ({
          caseId: c.id,
          engine,
          outcome: outcomeOf(c, result),
          requestedModel: result.requestedModel,
          resolvedModel: result.resolvedModel,
          adapterVersion: result.adapterVersion,
          digest: result.digest,
          latencyMs: result.latencyMs,
          estimatedInputTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
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
              estimatedInputTokens,
              inputTokens: null,
              outputTokens: null,
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

const viewFor = (
  c: RankingCase,
  reference: View,
  score: (ref: string) => number | null,
): CaseView => ({
  caseId: c.id,
  stratum: c.stratum,
  fixedTokens: [...c.mandatory, ...c.requested].reduce(
    (n, id) => n + tokensOf(POOL_BY_ID.get(id)!.bodyBytes),
    0,
  ),
  candidates: orderedCandidates(c).map(({ ref, id }) => ({
    id,
    ref,
    tokens: tokensOf(POOL_BY_ID.get(id)!.bodyBytes),
    reference: reference(c, id),
    score: score(ref),
  })),
});

/** Seeded random scores: the floor any ranker must beat at the same k. */
const randomScores = (c: RankingCase): Record<string, number> => {
  const rand = mulberry32(seedOf(`random:${c.id}`));
  return Object.fromEntries(orderedCandidates(c).map(({ ref }) => [ref, rand()]));
};

export const evaluate = (
  cases: ReadonlyArray<RankingCase>,
  records: ReadonlyArray<CallRecord>,
  reference: View,
) => {
  const scoreSources: Record<string, (c: RankingCase) => (ref: string) => number | null> = {
    lexical: (c) => {
      const s = lexicalScores(c);
      return (ref) => s[ref] ?? null;
    },
    random: (c) => {
      const s = randomScores(c);
      return (ref) => s[ref] ?? null;
    },
  };
  const engines = [...new Set(records.map((r) => r.engine))].sort();
  for (const engine of engines) {
    const own = new Map(records.filter((r) => r.engine === engine).map((r) => [r.caseId, r]));
    scoreSources[engine] = (c) => {
      const outcome = own.get(c.id)?.outcome;
      return (ref) => (outcome?.kind === "answered" ? (outcome.scores[ref] ?? null) : null);
    };
  }
  const views: Record<string, CaseView[]> = {};
  for (const [name, source] of Object.entries(scoreSources))
    views[name] = cases.map((c) => viewFor(c, reference, source(c)));
  // A probability threshold means nothing for BM25 or random scores, so it is reported for the engines only.
  const thresholdApplies = (name: string) => name !== "lexical" && name !== "random";
  const systems = Object.fromEntries(
    Object.entries(views).map(([name, v]) => {
      const summary = summarizeSystem(v);
      return [
        name,
        thresholdApplies(name)
          ? summary
          : { ...summary, rules: { ...summary.rules, threshold: null } },
      ];
    }),
  );
  const baseline = views.lexical!;
  const pairedVsLexical = Object.fromEntries(
    Object.entries(views)
      .filter(([name]) => name !== "lexical")
      .map(([name, v]) => [
        name,
        { topK: paired(v, baseline, "topK"), budget: paired(v, baseline, "budget") },
      ]),
  );
  const cost: Record<string, unknown> = {};
  for (const engine of engines) {
    const own = records.filter((r) => r.engine === engine);
    const rows: UsageRow[] = own.flatMap((r) =>
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
    const measured = own.filter((r) => r.inputTokens !== null && r.inputTokens > 0);
    const ratios = measured.map((r) => r.estimatedInputTokens / r.inputTokens!);
    cost[engine] = {
      ...summarizeCost(rows, own.length - rows.length),
      attempts: own.length,
      failedAttempts: own.filter((r) => r.outcome.kind === "failed").length,
      failureCodes: own
        .filter((r) => r.outcome.kind === "failed")
        .map((r) => (r.outcome as { code: string }).code),
      unansweredQuestions: own.reduce(
        (n, r) => n + (r.outcome.kind === "answered" ? r.outcome.unanswered : 0),
        0,
      ),
      knownOutputTokens: own.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      tokenEstimate: {
        comparedCalls: measured.length,
        meanEstimateOverReported:
          ratios.length === 0 ? null : ratios.reduce((a, b) => a + b, 0) / ratios.length,
        minEstimateOverReported: ratios.length === 0 ? null : Math.min(...ratios),
        maxEstimateOverReported: ratios.length === 0 ? null : Math.max(...ratios),
        totalEstimated: measured.reduce((n, r) => n + r.estimatedInputTokens, 0),
        totalReported: measured.reduce((n, r) => n + r.inputTokens!, 0),
      },
    };
  }
  return { systems, pairedVsLexical, cost };
};

/** Stable identity of what the models and the baseline are shown: ids, splits, families, strata, tasks, context and candidates; not labels or results. */
export const corpusDigest = (cases: ReadonlyArray<RankingCase>): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        cases.map((c) => [
          c.id,
          c.split,
          c.family,
          c.stratum,
          c.task,
          c.mandatory,
          c.requested,
          orderedCandidates(c).map((o) => [o.ref, POOL_BY_ID.get(o.id)]),
        ]),
      ),
    )
    .digest("hex");
