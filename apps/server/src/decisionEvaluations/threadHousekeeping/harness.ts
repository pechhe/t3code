import type { DecisionResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { wakeByOutcome, wakeNever } from "./baseline.ts";
import { SPEC_MARKS } from "./definitions.ts";
import { POLICY, caughtWake, routeProject, type EngineOutcome } from "./policy.ts";
import { buildProjectRequest, buildWakeRequest } from "./rule.ts";
import {
  summarizeCost,
  summarizeProject,
  summarizeWake,
  type ProjectRow,
  type UsageRow,
  type WakeRow,
} from "./scoring.ts";
import {
  WAKE_KINDS,
  type Chore,
  type Engine,
  type ProjectCase,
  type ProjectPublic,
  type WakeCase,
  type WakePublic,
  type WakeKind,
} from "./types.ts";

export interface CallRecord {
  readonly caseId: string;
  readonly chore: Chore;
  /** Index into the case's asks (always 0 for a wake). */
  readonly ask: number;
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

const outcomeOf = (id: string, result: DecisionResult): EngineOutcome => {
  const answer = result.answers.find((a) => a.id === id);
  if (answer === undefined) return { kind: "unanswered", status: "no-choice" };
  if (answer.status !== "answered") return { kind: "unanswered", status: answer.status };
  if (answer.type !== "choice") return { kind: "unanswered", status: "no-choice" };
  return { kind: "answered", choice: answer.choice, probabilities: answer.probabilities };
};

export interface RunInput {
  readonly projects: ReadonlyArray<ProjectCase>;
  readonly wakes: ReadonlyArray<WakeCase>;
}

/** One admitted call per ask and engine, in order, with a fixed gap under the shared limit. No retry; every failure is a record. */
export const runEvaluation = Effect.fn("ThreadHousekeeping.runEvaluation")(function* (
  input: RunInput,
  engines: ReadonlyArray<Engine>,
  options: {
    readonly gapMs: number;
    readonly onRecord?: (record: CallRecord) => void;
    readonly resumed?: ReadonlyArray<CallRecord> | undefined;
  },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  const jobs = [
    ...input.projects.flatMap((c) =>
      c.asks.map((_, ask) => ({
        caseId: c.caseId,
        chore: "project" as const,
        ask,
        id: "project",
        build: (e: Engine) => buildProjectRequest(e, c, ask),
      })),
    ),
    ...input.wakes.map((c) => ({
      caseId: c.caseId,
      chore: "wake" as const,
      ask: 0,
      id: "wake",
      build: (e: Engine) => buildWakeRequest(e, c),
    })),
  ];
  for (const job of jobs) {
    for (const engine of engines) {
      const earlier = options.resumed?.find(
        (r) =>
          r.caseId === job.caseId &&
          r.chore === job.chore &&
          r.ask === job.ask &&
          r.engine === engine,
      );
      if (earlier !== undefined) {
        records.push(earlier);
        continue;
      }
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const base = {
        caseId: job.caseId,
        chore: job.chore,
        ask: job.ask,
        engine,
        startedAt,
      } as const;
      const record = yield* service.decide(job.build(engine)).pipe(
        Effect.map((result): CallRecord => ({
          ...base,
          outcome: outcomeOf(job.id, result),
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
          DecisionError: (error) =>
            Effect.succeed<CallRecord>({
              ...base,
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
            }),
        }),
      );
      records.push(record);
      options.onRecord?.(record);
      yield* Effect.sleep(Duration.millis(options.gapMs));
    }
  }
  return records;
});

const outcomesFor = (records: ReadonlyArray<CallRecord>, caseId: string, engine: Engine) =>
  records.filter((r) => r.caseId === caseId && r.engine === engine).sort((a, b) => a.ask - b.ask);

export interface ScoreInput {
  readonly projects: ReadonlyArray<ProjectPublic>;
  readonly wakes: ReadonlyArray<WakePublic>;
  /** Agreed labels by case id (`uncertain` where the labelers split). */
  readonly labels: Readonly<Record<string, string>>;
  /** Wake kinds the by-kind baseline catches, from the tuning labels. */
  readonly tuneCatchKinds: ReadonlySet<WakeKind>;
}

export const evaluate = (
  input: ScoreInput,
  records: ReadonlyArray<CallRecord>,
  engines: ReadonlyArray<Engine>,
) => {
  const certain = (id: string) =>
    input.labels[id] !== undefined && input.labels[id] !== "uncertain" ? input.labels[id]! : null;

  const projectSystems = ["keyword", "agent", "never", ...engines] as const;
  const projectRow = (system: string, c: ProjectPublic, ask: number): ProjectRow | null => {
    const label = certain(c.caseId);
    if (label === null) return null;
    if (system === "keyword" || system === "agent" || system === "never") {
      const pred = system === "keyword" ? c.keyword : system === "agent" ? c.agent : "none";
      return { caseId: c.caseId, label, pred, moved: pred !== "none" };
    }
    const outcome = outcomesFor(records, c.caseId, system as Engine).find(
      (r) => r.ask === ask,
    )?.outcome;
    const routed = routeProject(outcome);
    return {
      caseId: c.caseId,
      label,
      pred: routed.answered ? routed.value : "none",
      moved: routed.answered,
    };
  };
  const project = Object.fromEntries(
    projectSystems.map((system) => {
      const pick = (which: "final" | "first" | "all") =>
        input.projects.flatMap((c) => {
          const asks =
            which === "final"
              ? [c.asks - 1]
              : which === "first"
                ? [0]
                : Array.from({ length: c.asks }, (_, i) => i);
          return asks.flatMap((a) => projectRow(system, c, a) ?? []);
        });
      const final = pick("final");
      const byStratum = Object.fromEntries(
        (["moved", "stayed"] as const).map((s) => [
          s,
          summarizeProject(
            final.filter((r) => input.projects.find((c) => c.caseId === r.caseId)!.stratum === s),
          ),
        ]),
      );
      return [
        system,
        {
          final: summarizeProject(final),
          firstAsk: summarizeProject(pick("first")),
          everyAsk: summarizeProject(pick("all")),
          byStratum,
        },
      ];
    }),
  );
  const projectLabelCounts = {
    cases: input.projects.length,
    agreed: input.projects.filter((c) => certain(c.caseId) !== null).length,
    uncertain: input.projects.filter((c) => certain(c.caseId) === null).length,
    labelNone: input.projects.filter((c) => certain(c.caseId) === "none").length,
  };

  const wakeRowFor = (system: string, c: WakePublic, floor: number): WakeRow | null => {
    const label = certain(c.caseId);
    if (label !== "nothing_new" && label !== "something_new") return null;
    const caught =
      system === "never"
        ? wakeNever()
        : system === "byOutcome"
          ? wakeByOutcome(c)
          : system === "byKind"
            ? input.tuneCatchKinds.has(c.wakeKind)
            : caughtWake(outcomesFor(records, c.caseId, system as Engine)[0]?.outcome, floor);
    return { caseId: c.caseId, label, caught };
  };
  const wakeSystems = ["never", "byOutcome", "byKind", ...engines] as const;
  const wake = Object.fromEntries(
    WAKE_KINDS.map((kind) => {
      const own = input.wakes.filter((c) => c.wakeKind === kind);
      return [
        kind,
        {
          specMark: SPEC_MARKS[kind],
          sampled: own.length,
          uncertainLabel: own.filter((c) => certain(c.caseId) === null).length,
          systems: Object.fromEntries(
            wakeSystems.map((s) => [
              s,
              {
                declared: summarizeWake(
                  own.flatMap((c) => wakeRowFor(s, c, POLICY.catchFloor) ?? []),
                ),
                sensitivity:
                  s === "jev" || s === "luna"
                    ? Object.fromEntries(
                        POLICY.sensitivityFloors.map((f) => [
                          f,
                          summarizeWake(own.flatMap((c) => wakeRowFor(s, c, f) ?? [])),
                        ]),
                      )
                    : null,
              },
            ]),
          ),
        },
      ];
    }),
  );
  const wakeOverall = Object.fromEntries(
    wakeSystems.map((s) => [
      s,
      summarizeWake(input.wakes.flatMap((c) => wakeRowFor(s, c, POLICY.catchFloor) ?? [])),
    ]),
  );

  const cost = Object.fromEntries(
    engines.map((engine) => {
      const own = records.filter((r) => r.engine === engine);
      const rows: UsageRow[] = own.flatMap((r) =>
        r.latencyMs === null
          ? []
          : [
              {
                latencyMs: r.latencyMs,
                inputTokens: r.inputTokens,
                outputTokens: r.outputTokens,
                costUsd: r.costUsd,
              },
            ],
      );
      return [
        engine,
        {
          ...summarizeCost(rows, own.length - rows.length),
          failed: own
            .filter((r) => r.outcome.kind === "failed")
            .map((r) => `${r.caseId}:${r.ask}:${(r.outcome as { code: string }).code}`),
          unanswered: own.filter((r) => r.outcome.kind === "unanswered").length,
          requestedModels: [...new Set(own.map((r) => r.requestedModel))],
          resolvedModels: [...new Set(own.map((r) => r.resolvedModel))],
        },
      ];
    }),
  );
  return { project, projectLabelCounts, wake, wakeOverall, cost };
};
