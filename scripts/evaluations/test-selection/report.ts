// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { budgetInput, readDurations } from "./baseline.ts";
import type { CallRecord, CaseFile } from "./run.ts";
import {
  baselineSelection,
  cheapestFirstSelection,
  measure,
  oracleSelection,
  randomSelection,
  semanticSelection,
  type ArmMetrics,
  type Scores,
  type Selection,
} from "./select.ts";

const DIR = import.meta.dirname;
export const BUDGETS = [60, 20, 10] as const;
export const RANDOM_SEEDS = [1, 2, 3, 4, 5] as const;

export function scoresFrom(
  records: ReadonlyArray<CallRecord>,
  caseId: string,
  engine: string,
): Scores {
  const scores = new Map<string, number | undefined>();
  for (const r of records) {
    if (r.caseId !== caseId || r.engine !== engine) continue;
    for (const a of r.answers ?? [])
      scores.set(a.file, a.status === "answered" ? a.probability : undefined);
  }
  return scores;
}

export interface Row {
  readonly caseId: string;
  readonly budget: number;
  readonly arm: string;
  readonly metrics: ArmMetrics;
  readonly detected: boolean;
}

export function evaluate(
  cases: ReadonlyArray<CaseFile>,
  results: ReadonlyArray<{ rule: string; records: ReadonlyArray<CallRecord> }>,
  durations: Record<string, number>,
): ReadonlyArray<Row> {
  const rows: Row[] = [];
  for (const c of cases) {
    const failing = new Set(c.failing ?? []);
    const passing = new Set(c.verifiedPassing ?? []);
    for (const budget of BUDGETS) {
      const { input } = budgetInput(
        c.candidates,
        { changed: c.changed, deleted: [] },
        durations,
        budget,
      );
      const push = (arm: string, selection: Selection) => {
        const metrics = measure(selection, input, failing, passing);
        rows.push({ caseId: c.id, budget, arm, metrics, detected: metrics.caught > 0 });
      };
      push("baseline", baselineSelection(input));
      push("cheapest-first", cheapestFirstSelection(input));
      push("oracle", oracleSelection(input, failing));
      for (const seed of RANDOM_SEEDS) push(`random-${seed}`, randomSelection(input, seed));
      for (const { rule, records } of results)
        for (const engine of ["jev", "luna"]) {
          if (!records.some((r) => r.caseId === c.id && r.engine === engine)) continue;
          push(`${engine}-${rule}`, semanticSelection(input, scoresFrom(records, c.id, engine)));
        }
    }
  }
  return rows;
}

/** Totals per budget and arm; random seeds are averaged. Recall is over failing test files; detection is per regression. */
export function summarise(rows: ReadonlyArray<Row>) {
  const byKey = new Map<string, Row[]>();
  for (const row of rows) {
    const arm = row.arm.startsWith("random-") ? "random(mean of 5 seeds)" : row.arm;
    byKey.set(`${row.budget}|${arm}`, [...(byKey.get(`${row.budget}|${arm}`) ?? []), row]);
  }
  return [...byKey.entries()].map(([key, group]) => {
    const [budget, arm] = key.split("|") as [string, string];
    const seeds = arm.startsWith("random") ? RANDOM_SEEDS.length : 1;
    const sum = (f: (r: Row) => number) => group.reduce((a, r) => a + f(r), 0) / seeds;
    const cases = group.length / seeds;
    return {
      budget: Number(budget),
      arm,
      cases,
      caught: sum((r) => r.metrics.caught),
      missed: sum((r) => r.metrics.missed.length),
      casesDetected: sum((r) => Number(r.detected)),
      casesAllCaught: sum((r) => Number(r.metrics.missed.length === 0)),
      selected: sum((r) => r.metrics.selected),
      deferred: sum((r) => r.metrics.deferred),
      spentOnPassing: sum((r) => r.metrics.spentOnPassing),
      spentOnUnknown: sum((r) => r.metrics.spentOnUnknown),
      estimatedSeconds: sum((r) => r.metrics.seconds),
    };
  });
}

/**
 * Pairwise ranking quality among scored discretionary candidates: the chance a failing test
 * outscores a passing one (ties half). Abstentions are excluded and counted, never scored.
 */
export function separation(
  cases: ReadonlyArray<CaseFile>,
  results: ReadonlyArray<{ rule: string; records: ReadonlyArray<CallRecord> }>,
  durations: Record<string, number>,
) {
  const out: Array<{
    arm: string;
    auc: number | null;
    pairs: number;
    abstained: number;
    scored: number;
  }> = [];
  for (const { rule, records } of results)
    for (const engine of ["jev", "luna"]) {
      let wins = 0,
        pairs = 0,
        abstained = 0,
        scored = 0;
      for (const c of cases) {
        const failing = new Set(c.failing ?? []);
        const passing = new Set(c.verifiedPassing ?? []);
        const { input } = budgetInput(
          c.candidates,
          { changed: c.changed, deleted: [] },
          durations,
          60,
        );
        const scores = scoresFrom(records, c.id, engine);
        const optional = input.gateOrder.slice(input.mandatory);
        const pos = optional.filter((t) => failing.has(t.file) && scores.get(t.file) !== undefined);
        const neg = optional.filter((t) => passing.has(t.file) && scores.get(t.file) !== undefined);
        for (const t of optional) {
          if (scores.get(t.file) === undefined) abstained++;
          else scored++;
        }
        for (const p of pos)
          for (const n of neg) {
            pairs++;
            wins +=
              (scores.get(p.file) as number) > (scores.get(n.file) as number)
                ? 1
                : (scores.get(p.file) as number) === (scores.get(n.file) as number)
                  ? 0.5
                  : 0;
          }
      }
      out.push({
        arm: `${engine}-${rule}`,
        auc: pairs ? wins / pairs : null,
        pairs,
        abstained,
        scored,
      });
    }
  return out;
}

/** For unlabelled historical changes: how far each engine moves the discretionary selection from the gate's. */
export function agreement(
  cases: ReadonlyArray<CaseFile>,
  results: ReadonlyArray<{ rule: string; records: ReadonlyArray<CallRecord> }>,
  durations: Record<string, number>,
  budget: number,
) {
  return cases.flatMap((c) => {
    const { input } = budgetInput(
      c.candidates,
      { changed: c.changed, deleted: [] },
      durations,
      budget,
    );
    const base = new Set(baselineSelection(input).selected.map((t) => t.file));
    const picks: Record<string, Set<string>> = {};
    const rows = [];
    for (const { rule, records } of results)
      for (const engine of ["jev", "luna"]) {
        const scores = scoresFrom(records, c.id, engine);
        if (scores.size === 0) continue;
        const chosen = new Set(semanticSelection(input, scores).selected.map((t) => t.file));
        picks[engine] = chosen;
        rows.push({
          caseId: c.id,
          budget,
          arm: `${engine}-${rule}`,
          candidates: c.candidates.length,
          baselineSelected: base.size,
          promoted: [...chosen].filter((f) => !base.has(f)).length,
          abstained: [...scores.values()].filter((v) => v === undefined).length,
          relevantCalls: [...scores.values()].filter((v) => v !== undefined && v >= 0.5).length,
        });
      }
    return rows;
  });
}

/** Per budget and arm, cases where the arm caught more / fewer failing files than the gate, with the distinct source files behind them. */
export function paired(rows: ReadonlyArray<Row>, cluster: ReadonlyMap<string, string>) {
  const out: Array<{
    budget: number;
    arm: string;
    better: number;
    worse: number;
    same: number;
    sourceFilesBetter: number;
    sourceFilesWorse: number;
  }> = [];
  for (const budget of BUDGETS)
    for (const arm of [...new Set(rows.map((r) => r.arm))].filter(
      (a) => a !== "baseline" && !a.startsWith("random-"),
    )) {
      let better = 0,
        worse = 0,
        same = 0;
      const betterFiles = new Set<string>(),
        worseFiles = new Set<string>();
      for (const row of rows.filter((r) => r.arm === arm && r.budget === budget)) {
        const base = rows.find(
          (r) => r.arm === "baseline" && r.budget === budget && r.caseId === row.caseId,
        )!;
        if (row.metrics.caught > base.metrics.caught) {
          better++;
          betterFiles.add(cluster.get(row.caseId)!);
        } else if (row.metrics.caught < base.metrics.caught) {
          worse++;
          worseFiles.add(cluster.get(row.caseId)!);
        } else same++;
      }
      out.push({
        budget,
        arm,
        better,
        worse,
        same,
        sourceFilesBetter: betterFiles.size,
        sourceFilesWorse: worseFiles.size,
      });
    }
  return out;
}

if (import.meta.main) {
  const splitFilter = process.argv[2] ?? "heldout";
  const splits = JSON.parse(
    NodeFS.readFileSync(NodePath.join(DIR, "corpus/split.json"), "utf8"),
  ) as Record<string, string>;
  const dir = NodePath.join(DIR, "corpus/cases");
  const cases = NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((f) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as CaseFile)
    .filter((c) => splits[c.id] === splitFilter);
  const resultDir = NodePath.join(DIR, "results");
  const results = NodeFS.existsSync(resultDir)
    ? NodeFS.readdirSync(resultDir)
        .filter(
          (f) => f.startsWith(`${splitFilter}-`) && f.endsWith(".json") && !f.includes("attempt"),
        )
        .map((f) => JSON.parse(NodeFS.readFileSync(NodePath.join(resultDir, f), "utf8")))
    : [];
  if (splitFilter === "historical") {
    console.log(
      JSON.stringify(
        BUDGETS.flatMap((b) => agreement(cases, results, readDurations(), b)),
        null,
        1,
      ),
    );
    process.exit(0);
  }
  const merged = [...new Set(results.map((r: { rule: string }) => r.rule))].map((rule) => ({
    rule,
    records: results
      .filter((r: { rule: string }) => r.rule === rule)
      .flatMap((r: { records: CallRecord[] }) => r.records),
  }));
  const rows = evaluate(cases, merged, readDurations());
  const cluster = new Map<string, string>(cases.map((c) => [c.id, c.changed.join(",")]));
  console.log(
    JSON.stringify(
      {
        summary: summarise(rows),
        separation: separation(cases, merged, readDurations()),
        pairedVsBaseline: paired(rows, cluster),
      },
      null,
      1,
    ),
  );
}
