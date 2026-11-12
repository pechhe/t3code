// @effect-diagnostics nodeBuiltinImport:off - reads the state database read-only, like the migration preflight.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

export interface TaskCallRow {
  readonly harness: string;
  readonly mode: string;
  readonly outcome: string;
  readonly fault: string | null;
  readonly replayed: boolean;
  readonly calls: number;
}

/** Grouped rows of the record since `since`; none when the database or its record is missing. */
export const readTaskCallRows = (databasePath: string, since: string): readonly TaskCallRow[] => {
  if (!NodeFS.existsSync(databasePath)) return [];
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const recorded = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'browser_task_calls'")
      .get();
    if (recorded === undefined) return [];
    return db
      .prepare(
        `SELECT harness, mode, outcome, fault, replayed, COUNT(*) AS calls
         FROM browser_task_calls WHERE recorded_at >= ?
         GROUP BY harness, mode, outcome, fault, replayed`,
      )
      .all(since)
      .map((row) => ({
        harness: String(row.harness),
        mode: String(row.mode),
        outcome: String(row.outcome),
        fault: row.fault === null ? null : String(row.fault),
        replayed: Number(row.replayed) === 1,
        calls: Number(row.calls),
      }));
  } finally {
    db.close();
  }
};

const OUTCOMES = ["passed", "blocked", "failed", "refused", "cancelled"] as const;

export interface TaskCallGroup {
  readonly key: string;
  readonly calls: number;
  readonly outcomes: Readonly<Record<(typeof OUTCOMES)[number], number>>;
}

export interface TaskCallSummary {
  readonly calls: number;
  /** Repeated request ids read an earlier run; they are left out of every count below. */
  readonly repeats: number;
  readonly byHarness: readonly TaskCallGroup[];
  readonly byMode: readonly TaskCallGroup[];
  readonly byFault: readonly TaskCallGroup[];
}

const groupBy = (rows: readonly TaskCallRow[], keyOf: (row: TaskCallRow) => string) => {
  const groups = new Map<string, { calls: number; outcomes: Record<string, number> }>();
  for (const row of rows) {
    const group = groups.get(keyOf(row)) ?? { calls: 0, outcomes: {} };
    group.calls += row.calls;
    group.outcomes[row.outcome] = (group.outcomes[row.outcome] ?? 0) + row.calls;
    groups.set(keyOf(row), group);
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      calls: group.calls,
      outcomes: Object.fromEntries(
        OUTCOMES.map((outcome) => [outcome, group.outcomes[outcome] ?? 0]),
      ) as TaskCallGroup["outcomes"],
    }))
    .toSorted((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
};

export const summarizeTaskCalls = (rows: readonly TaskCallRow[]): TaskCallSummary => {
  const runs = rows.filter((row) => !row.replayed);
  return {
    calls: runs.reduce((total, row) => total + row.calls, 0),
    repeats: rows.filter((row) => row.replayed).reduce((total, row) => total + row.calls, 0),
    byHarness: groupBy(runs, (row) => row.harness),
    byMode: groupBy(runs, (row) => row.mode),
    byFault: groupBy(runs, (row) => row.fault ?? "none"),
  };
};

const cell = (count: number, total: number) =>
  `${count} (${total === 0 ? 0 : Math.round((count / total) * 100)}%)`.padStart(11);

const table = (title: string, groups: readonly TaskCallGroup[]) => {
  const width = Math.max(title.length, ...groups.map((group) => group.key.length));
  const header = [title.padEnd(width), "calls".padStart(6), ...OUTCOMES.map((o) => o.padStart(11))];
  const lines = groups.map((group) =>
    [
      group.key.padEnd(width),
      String(group.calls).padStart(6),
      ...OUTCOMES.map((outcome) => cell(group.outcomes[outcome], group.calls)),
    ].join("  "),
  );
  return [header.join("  "), ...lines].join("\n");
};

const formatTaskCallReport = (summary: TaskCallSummary, window: string) =>
  summary.calls === 0
    ? `No bounded browser task calls on this environment in the ${window}.`
    : [
        `Bounded browser task calls on this environment in the ${window}: ${summary.calls}${summary.repeats > 0 ? `, plus ${summary.repeats} repeated request ids not counted` : ""}.`,
        table("harness", summary.byHarness),
        table("mode", summary.byMode),
        table("fault", summary.byFault),
      ].join("\n\n");

const formatTaskCallJson = (since: string, summary: TaskCallSummary) =>
  JSON.stringify({ since, ...summary }, null, 2);

export const browserReportCommand = Command.make("report", {
  baseDir: baseDirFlag,
  hours: Flag.Int("hours").pipe(
    Flag.withDescription("How many hours back to report, ending now."),
    Flag.withDefault(24),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the summary as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Report how agents' bounded browser tasks went on this environment: passed, blocked, failed and refused calls by harness, mode and fault.",
  ),
  Command.withHandler(({ baseDir, hours, json }) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const now = yield* DateTime.now;
      const since = DateTime.formatIso(DateTime.subtractDuration(now, Duration.hours(hours)));
      const summary = summarizeTaskCalls(readTaskCallRows(config.dbPath, since));
      yield* Console.log(
        json
          ? formatTaskCallJson(since, summary)
          : formatTaskCallReport(summary, `last ${hours} hours`),
      );
    }),
  ),
);
