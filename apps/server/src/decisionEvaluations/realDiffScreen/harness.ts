import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { DecisionService } from "../../decisions/DecisionService.ts";
import {
  auc,
  summarizeCost,
  wilson,
  type Interval,
  type Outcome,
  type UsageRow,
} from "../semanticLint/scoring.ts";
import { heuristicFlag } from "./baseline.ts";
import { evidenceOf, referenceOf, strataOf, type CaseRecord, type Stratum } from "./corpus.ts";
import { buildRequest, FLAG_THRESHOLD } from "./rule.ts";

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

/** One admitted call per case and engine, in order, a fixed gap apart. No retry. */
export const runEvaluation = Effect.fn("RealDiffScreen.runEvaluation")(function* (
  cases: ReadonlyArray<CaseRecord>,
  engines: ReadonlyArray<Engine>,
  options: { readonly gapMs: number },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  for (const c of cases) {
    const evidence = evidenceOf(c);
    for (const engine of engines) {
      const record = yield* service.decide(buildRequest(engine, evidence)).pipe(
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

/** Mulberry32, so a bootstrap interval is reproducible. */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export interface Scored {
  readonly caseId: string;
  readonly reference: "defect" | "ok";
  readonly stratum: Stratum;
  readonly flagged: boolean;
}

/** Items read per real defect: every flagged case divided by the defects among them. Percentile bootstrap over cases. */
export const readBurden = (
  scored: ReadonlyArray<Scored>,
  iterations = 2000,
  seed = 573,
): { value: number | null; low: number | null; high: number | null } => {
  const ratio = (rows: ReadonlyArray<Scored>) => {
    const flagged = rows.filter((r) => r.flagged).length;
    const caught = rows.filter((r) => r.flagged && r.reference === "defect").length;
    return caught === 0 ? null : flagged / caught;
  };
  const random = generator(seed);
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = scored.map(() => scored[Math.floor(random() * scored.length)]!);
    const v = ratio(sample);
    if (v !== null) values.push(v);
  }
  values.sort((a, b) => a - b);
  const at = (q: number) =>
    values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? null;
  return { value: ratio(scored), low: at(0.025), high: at(0.975) };
};

export interface SystemResult {
  readonly cases: number;
  readonly failed: number;
  readonly unanswered: number;
  readonly caught: number;
  readonly defects: number;
  readonly recall: Interval;
  readonly recallByStratum: Readonly<
    Record<"diff-only" | "needs-files", { caught: number; total: number; recall: Interval }>
  >;
  readonly falseAlarms: number;
  readonly clean: number;
  readonly falseAlarmRate: Interval;
  readonly flaggedPerDefect: ReturnType<typeof readBurden>;
  /** Ranking quality of the returned probability over scored cases, independent of the 0.5 threshold. */
  readonly auc: number | null;
  readonly missedIds: ReadonlyArray<string>;
  readonly falseAlarmIds: ReadonlyArray<string>;
}

/** Failures, refusals and unknowns count as not flagged: a screener that cannot answer misses. */
export const summarizeSystem = (
  cases: ReadonlyArray<CaseRecord>,
  flagOf: (c: CaseRecord) => { flagged: boolean; outcome: Outcome },
  /** Case ids a reader judged to be real defects the labels missed; they leave the clean set when applied. */
  reclassified: ReadonlySet<string> = new Set(),
): SystemResult => {
  const all = cases.map((c) => ({ c, ...flagOf(c) }));
  const scored: Scored[] = all.flatMap(({ c, flagged }) => {
    const ref = referenceOf(c);
    if (ref === "uncertain" || reclassified.has(c.id)) return [];
    return [{ caseId: c.id, reference: ref, stratum: strataOf(c), flagged }];
  });
  const defects = scored.filter((s) => s.reference === "defect");
  const clean = scored.filter((s) => s.reference === "ok");
  const caught = defects.filter((s) => s.flagged);
  const falseAlarms = clean.filter((s) => s.flagged);
  const byStratum = (stratum: "diff-only" | "needs-files") => {
    const rows = defects.filter((s) => s.stratum === stratum);
    const hit = rows.filter((s) => s.flagged).length;
    return { caught: hit, total: rows.length, recall: wilson(hit, rows.length) };
  };
  return {
    cases: scored.length,
    failed: all.filter((a) => a.outcome.kind === "failed").length,
    unanswered: all.filter((a) => a.outcome.kind === "unanswered").length,
    caught: caught.length,
    defects: defects.length,
    recall: wilson(caught.length, defects.length),
    recallByStratum: {
      "diff-only": byStratum("diff-only"),
      "needs-files": byStratum("needs-files"),
    },
    falseAlarms: falseAlarms.length,
    clean: clean.length,
    falseAlarmRate: wilson(falseAlarms.length, clean.length),
    flaggedPerDefect: readBurden(scored),
    auc: auc(
      all.flatMap(({ c, flagged, outcome }) => {
        const ref = referenceOf(c);
        return ref === "uncertain" || reclassified.has(c.id)
          ? []
          : [{ caseId: c.id, category: strataOf(c), reference: ref, flagged, outcome }];
      }),
    ),
    missedIds: defects.filter((s) => !s.flagged).map((s) => s.caseId),
    falseAlarmIds: falseAlarms.map((s) => s.caseId),
  };
};

export const evaluate = (
  cases: ReadonlyArray<CaseRecord>,
  records: ReadonlyArray<CallRecord>,
  reclassified: ReadonlySet<string> = new Set(),
) => {
  const systems: Record<string, SystemResult> = {};
  const cost: Record<
    string,
    ReturnType<typeof summarizeCost> & { attempts: number; failedAttempts: number }
  > = {};
  const engines = [...new Set(records.map((r) => r.engine))];
  const evidence = new Map(cases.map((c) => [c.id, evidenceOf(c)]));
  systems["heuristic"] = summarizeSystem(
    cases,
    (c) => {
      const flagged = heuristicFlag(evidence.get(c.id)!);
      return { flagged, outcome: { kind: "answered", probability: flagged ? 1 : 0 } };
    },
    reclassified,
  );
  systems["flag-all"] = summarizeSystem(
    cases,
    () => ({ flagged: true, outcome: { kind: "answered", probability: 1 } }),
    reclassified,
  );
  for (const engine of engines) {
    const own = new Map(records.filter((r) => r.engine === engine).map((r) => [r.caseId, r]));
    systems[engine] = summarizeSystem(
      cases,
      (c) => {
        const outcome = own.get(c.id)?.outcome ?? { kind: "failed" as const, code: "not-run" };
        return { flagged: flaggedByModel(outcome), outcome };
      },
      reclassified,
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
