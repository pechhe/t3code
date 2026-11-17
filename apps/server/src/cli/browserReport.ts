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

const RUN_OUTCOMES = ["succeeded", "failed", "time-limit", "output-limit"] as const;

export interface BrowserRunRow {
  readonly harness: string;
  readonly outcome: string;
  readonly durationMs: number;
}

/** `browser_script_runs` since `since`; none when the database or its table is missing. */
export const readBrowserRunRows = (
  databasePath: string,
  since: string,
): readonly BrowserRunRow[] => {
  if (!NodeFS.existsSync(databasePath)) return [];
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const recorded = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'browser_script_runs'")
      .get();
    if (recorded === undefined) return [];
    return db
      .prepare(
        `SELECT harness, outcome, duration_ms
         FROM browser_script_runs WHERE recorded_at >= ?`,
      )
      .all(since)
      .map((row) => ({
        harness: String(row.harness),
        outcome: String(row.outcome),
        durationMs: Number(row.duration_ms),
      }));
  } finally {
    db.close();
  }
};

export interface BrowserRunGroup {
  readonly key: string;
  readonly runs: number;
  readonly medianMs: number;
  readonly outcomes: Readonly<Record<(typeof RUN_OUTCOMES)[number], number>>;
}

export interface BrowserRunSummary {
  readonly runs: number;
  readonly byHarness: readonly BrowserRunGroup[];
}

/** The middle duration, or the mean of the middle two, so one slow run does not move it. */
const median = (values: readonly number[]) => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
  );
};

export const summarizeBrowserRuns = (rows: readonly BrowserRunRow[]): BrowserRunSummary => {
  const groups = new Map<string, { durations: number[]; outcomes: Record<string, number> }>();
  for (const row of rows) {
    const group = groups.get(row.harness) ?? { durations: [], outcomes: {} };
    group.durations.push(row.durationMs);
    group.outcomes[row.outcome] = (group.outcomes[row.outcome] ?? 0) + 1;
    groups.set(row.harness, group);
  }
  return {
    runs: rows.length,
    byHarness: [...groups]
      .map(([key, group]) => ({
        key,
        runs: group.durations.length,
        medianMs: median(group.durations),
        outcomes: Object.fromEntries(
          RUN_OUTCOMES.map((outcome) => [outcome, group.outcomes[outcome] ?? 0]),
        ) as BrowserRunGroup["outcomes"],
      }))
      .toSorted((a, b) => b.runs - a.runs || a.key.localeCompare(b.key)),
  };
};

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

const formatRunJson = (since: string, summary: TaskCallSummary, runs: BrowserRunSummary) =>
  JSON.stringify({ since, ...summary, browserRuns: runs }, null, 2);

const tableRuns = (groups: readonly BrowserRunGroup[]) => {
  const width = Math.max("harness".length, ...groups.map((group) => group.key.length));
  return [
    [
      "harness".padEnd(width),
      "runs".padStart(6),
      "median".padStart(8),
      ...RUN_OUTCOMES.map((o) => o.padStart(12)),
    ].join("  "),
    ...groups.map((group) =>
      [
        group.key.padEnd(width),
        String(group.runs).padStart(6),
        `${group.medianMs}ms`.padStart(8),
        ...RUN_OUTCOMES.map((outcome) => String(group.outcomes[outcome]).padStart(12)),
      ].join("  "),
    ),
  ].join("\n");
};

const formatBrowserRunReport = (summary: BrowserRunSummary, window: string) =>
  summary.runs === 0
    ? `No browser runs on this environment in the ${window}.`
    : `Browser runs on this environment in the ${window}: ${summary.runs}.\n\n${tableRuns(summary.byHarness)}`;

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
    "Report how agents' bounded browser work went on this environment: passed, blocked, failed and refused task calls by harness, mode and fault, and the browser runs scripts made.",
  ),
  Command.withHandler(({ baseDir, hours, json }) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const now = yield* DateTime.now;
      const since = DateTime.formatIso(DateTime.subtractDuration(now, Duration.hours(hours)));
      const summary = summarizeTaskCalls(readTaskCallRows(config.dbPath, since));
      const runs = summarizeBrowserRuns(readBrowserRunRows(config.dbPath, since));
      yield* Console.log(
        json
          ? formatRunJson(since, summary, runs)
          : [
              formatTaskCallReport(summary, `last ${hours} hours`),
              formatBrowserRunReport(runs, `last ${hours} hours`),
            ].join("\n\n"),
      );
    }),
  ),
);
