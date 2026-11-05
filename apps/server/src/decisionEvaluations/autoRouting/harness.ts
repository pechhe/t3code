// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the static corpus
import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { BASELINES } from "./baseline.ts";
import { applyConstraints } from "./baseline.ts";
import { DECISIONS, type AutoCase, type Decision } from "./corpusTypes.ts";
import { extractConstraints } from "./constraints.ts";
import { routeAll, type EngineOutcome, type Routed } from "./policy.ts";
import { buildRequest } from "./rule.ts";
import { summarize, type Judged, type Reference } from "./scoring.ts";
import { summarizeCost, type UsageRow } from "../semanticLint/scoring.ts";

export type Engine = DecisionRequest["engine"];

export interface CallRecord {
  readonly caseId: string;
  readonly decision: Decision;
  readonly engine: Engine;
  readonly outcome: EngineOutcome;
  readonly requestedModel: string | null;
  readonly resolvedModel: string | null;
  readonly adapterVersion: string | null;
  readonly digest: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: string | null;
  readonly startedAt: string;
}

const outcomeOf = (decision: Decision, result: DecisionResult): EngineOutcome => {
  const answer = result.answers.find((a) => a.id === decision);
  if (answer === undefined) return { kind: "unanswered", status: "no-choice" };
  if (answer.status !== "answered") return { kind: "unanswered", status: answer.status };
  if (answer.type !== "choice") return { kind: "unanswered", status: "no-choice" };
  return { kind: "answered", choice: answer.choice, probabilities: answer.probabilities };
};

/** One admitted call per case, decision and engine, in order, with a fixed gap under the shared limit. No retry; every failure is a record. */
export const runEvaluation = Effect.fn("AutoRouting.runEvaluation")(function* (
  cases: ReadonlyArray<AutoCase>,
  engines: ReadonlyArray<Engine>,
  options: {
    readonly gapMs: number;
    readonly onRecord?: (record: CallRecord) => void;
    readonly resumed?: ReadonlyArray<CallRecord> | undefined;
  },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  for (const c of cases) {
    for (const decision of DECISIONS) {
      for (const engine of engines) {
        const earlier = options.resumed?.find(
          (r) => r.caseId === c.id && r.decision === decision && r.engine === engine,
        );
        if (earlier !== undefined) {
          records.push(earlier);
          continue;
        }
        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const record = yield* service.decide(buildRequest(engine, decision, c)).pipe(
          Effect.map((result): CallRecord => ({
            caseId: c.id,
            decision,
            engine,
            outcome: outcomeOf(decision, result),
            requestedModel: result.requestedModel,
            resolvedModel: result.resolvedModel,
            adapterVersion: result.adapterVersion,
            digest: result.digest,
            latencyMs: result.latencyMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costUsd: result.cost.usd,
            costStatus: result.cost.status,
            startedAt,
          })),
          Effect.catchTags({
            DecisionError: (error) =>
              Effect.succeed<CallRecord>({
                caseId: c.id,
                decision,
                engine,
                outcome: { kind: "failed", code: error.code },
                requestedModel: null,
                resolvedModel: null,
                adapterVersion: null,
                digest: null,
                latencyMs: null,
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                costStatus: null,
                startedAt,
              }),
          }),
        );
        records.push(record);
        options.onRecord?.(record);
        yield* Effect.sleep(Duration.millis(options.gapMs));
      }
    }
  }
  return records;
});

export type ReferenceFor = (c: AutoCase, decision: Decision) => Reference;

const routedFor = (
  system: string,
  c: AutoCase,
  records: ReadonlyArray<CallRecord>,
): Record<Decision, Routed> => {
  if (system === "jev" || system === "luna") {
    const outcomes: Partial<Record<Decision, EngineOutcome>> = {};
    for (const r of records)
      if (r.caseId === c.id && r.engine === system) outcomes[r.decision] = r.outcome;
    return routeAll(c, outcomes);
  }
  const base = BASELINES[system as keyof typeof BASELINES](c);
  const { final, constrained } = applyConstraints(c, base);
  return Object.fromEntries(
    DECISIONS.map((d) => [
      d,
      {
        value: final[d] as string,
        source: constrained.includes(d) ? "constraint" : "engine",
        engineChoice: null,
        reason: system,
      } satisfies Routed,
    ]),
  ) as Record<Decision, Routed>;
};

/** Baselines count as deciding for themselves (source "engine") where no constraint applies, so rates are comparable across systems. */
export const evaluate = (
  cases: ReadonlyArray<AutoCase>,
  records: ReadonlyArray<CallRecord>,
  reference: ReferenceFor,
) => {
  const engines = [...new Set(records.map((r) => r.engine))].sort();
  const systems = [...engines, ...Object.keys(BASELINES)];
  const summary: Record<string, Record<string, unknown>> = {};
  const routes: Record<string, Record<string, Record<Decision, Routed>>> = {};
  for (const system of systems) {
    summary[system] = {};
    routes[system] = {};
    for (const c of cases) routes[system]![c.id] = routedFor(system, c, records);
    for (const decision of DECISIONS) {
      const judged: Judged[] = cases.map((c) => ({
        caseId: c.id,
        decision,
        reference: reference(c, decision),
        routed: routes[system]![c.id]![decision],
        constrained: routes[system]![c.id]![decision].source === "constraint",
      }));
      summary[system]![decision] = summarize(decision, judged);
    }
  }
  // Classifier disagreement with a hard constraint: counted, never acted on.
  const overrideAttempts = engines.map((engine) => ({
    engine,
    attempts: cases.flatMap((c) =>
      DECISIONS.filter((d) => routes[engine]![c.id]![d].source === "constraint")
        .filter((d) => {
          const e = routes[engine]![c.id]![d].engineChoice;
          const v = routes[engine]![c.id]![d].value;
          return e !== null && e !== v;
        })
        .map((d) => `${c.id}:${d}`),
    ),
    violations: cases.flatMap((c) => {
      const k = extractConstraints(c.task);
      const r = routes[engine]![c.id]!;
      return [
        ...(k.project !== undefined && r.project.value !== k.project ? [`${c.id}:project`] : []),
        ...(k.workflow !== undefined && r.workflow.value !== k.workflow
          ? [`${c.id}:workflow`]
          : []),
      ];
    }),
  }));
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
    cost[engine] = {
      ...summarizeCost(rows, own.length - rows.length),
      attempts: own.length,
      failedAttempts: own.filter((r) => r.outcome.kind === "failed").length,
      failureCodes: own
        .filter((r) => r.outcome.kind === "failed")
        .map((r) => `${r.caseId}:${r.decision}:${(r.outcome as { code: string }).code}`),
      unanswered: own
        .filter((r) => r.outcome.kind === "unanswered")
        .map((r) => `${r.caseId}:${r.decision}`),
      outputTokensKnown: own.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      requestedModels: [...new Set(own.map((r) => r.requestedModel))],
      resolvedModels: [...new Set(own.map((r) => r.resolvedModel))],
    };
  }
  return { summary, routes, overrideAttempts, cost };
};

export const corpusDigest = (cases: ReadonlyArray<AutoCase>): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        cases.map((c) => [
          c.id,
          c.split,
          c.family,
          c.stratum,
          c.tags,
          c.task,
          c.startedIn,
          c.project,
          c.explicit,
          c.source ?? null,
        ]),
      ),
    )
    .digest("hex");
