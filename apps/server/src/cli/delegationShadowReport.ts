// @effect-diagnostics nodeBuiltinImport:off - reads the state database read-only, like the browser report.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { lookupRate, parseRateTable, type RateTable } from "../usage/usagePricing.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

export interface ShadowRow {
  readonly threadId: string;
  readonly role: string;
  readonly status: string;
  readonly eligible: readonly string[];
  readonly chosen: string;
  readonly pick: string | null;
  readonly reassigned: boolean;
}

/** What T3 already keeps per task; `null` is unknown, never zero. */
export interface TaskOutcome {
  readonly runs: number | null;
  readonly lastRunStatus: string | null;
  readonly tokens: number | null;
}

const OPEN_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const GROUPS = ["agree", "cheaper", "dearer", "same-price", "unpriced"] as const;
export type Group = (typeof GROUPS)[number];

export interface GroupOutcomes {
  readonly delegations: number;
  readonly meanTokens: number | null;
  readonly tokensUnknown: number;
  readonly furtherRuns: number;
  readonly furtherRunsUnknown: number;
  readonly failedOrCancelled: number;
  readonly stillOpen: number;
  readonly endingUnknown: number;
}

export interface RoleScore {
  readonly role: string;
  readonly delegations: number;
  /** Decided by an experiment, not the agent; left out of every count below. */
  readonly reassigned: number;
  readonly soleModel: number;
  readonly failed: number;
  readonly abstained: number;
  readonly recommended: number;
  readonly agreed: number;
  readonly groups: Readonly<Record<Group, GroupOutcomes>>;
}

/** The price of a model for ordering only: input plus output cost per token; `null` when unpriced. */
export type PriceOf = (model: string) => number | null;

const outcomesOf = (members: readonly TaskOutcome[]): GroupOutcomes => {
  const tokens = members.flatMap((m) => (m.tokens === null ? [] : [m.tokens]));
  return {
    delegations: members.length,
    meanTokens:
      tokens.length === 0 ? null : Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length),
    tokensUnknown: members.filter((m) => m.tokens === null).length,
    furtherRuns: members.filter((m) => m.runs !== null && m.runs > 1).length,
    furtherRunsUnknown: members.filter((m) => m.runs === null).length,
    failedOrCancelled: members.filter(
      (m) => m.lastRunStatus === "failed" || m.lastRunStatus === "cancelled",
    ).length,
    stillOpen: members.filter((m) => m.lastRunStatus !== null && OPEN_RUN.has(m.lastRunStatus))
      .length,
    endingUnknown: members.filter((m) => m.lastRunStatus === null).length,
  };
};

const UNKNOWN: TaskOutcome = { runs: null, lastRunStatus: null, tokens: null };

export const scoreShadow = (
  rows: readonly ShadowRow[],
  outcomeOf: (threadId: string) => TaskOutcome | undefined,
  priceOf: PriceOf,
): readonly RoleScore[] => {
  const roles = [...new Set(rows.map((row) => row.role))].toSorted();
  return roles.map((role) => {
    const mine = rows.filter((row) => row.role === role);
    const counted = mine.filter((row) => !row.reassigned);
    const recommended = counted.filter((row) => row.status === "recommended" && row.pick !== null);
    const members: Record<Group, TaskOutcome[]> = {
      agree: [],
      cheaper: [],
      dearer: [],
      "same-price": [],
      unpriced: [],
    };
    for (const row of recommended) {
      const outcome = outcomeOf(row.threadId) ?? UNKNOWN;
      if (row.pick === row.chosen) {
        members.agree.push(outcome);
        continue;
      }
      const picked = priceOf(row.pick!);
      const chosen = priceOf(row.chosen);
      const group: Group =
        picked === null || chosen === null
          ? "unpriced"
          : picked < chosen
            ? "cheaper"
            : picked > chosen
              ? "dearer"
              : "same-price";
      members[group].push(outcome);
    }
    return {
      role,
      delegations: mine.length,
      reassigned: mine.length - counted.length,
      soleModel: counted.filter((row) => row.status === "sole-model").length,
      failed: counted.filter((row) => row.status === "failed").length,
      abstained: counted.filter((row) => row.status === "abstained").length,
      recommended: recommended.length,
      agreed: members.agree.length,
      groups: Object.fromEntries(
        GROUPS.map((group) => [group, outcomesOf(members[group])]),
      ) as Record<Group, GroupOutcomes>,
    };
  });
};

const open = (databasePath: string) =>
  NodeFS.existsSync(databasePath)
    ? new NodeSqlite.DatabaseSync(databasePath, { readOnly: true })
    : undefined;

const hasTable = (db: NodeSqlite.DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** The rows of the record from `since`, oldest first, at most `first` of them. */
export const readShadowRows = (
  db: NodeSqlite.DatabaseSync,
  since: string,
  first: number | undefined,
): readonly ShadowRow[] => {
  if (!hasTable(db, "delegation_model_shadow")) return [];
  return db
    .prepare(
      `SELECT thread_id, role, status, eligible_json, chosen_model, pick_model, reassigned
       FROM delegation_model_shadow WHERE recorded_at >= ? ORDER BY id LIMIT ?`,
    )
    .all(since, first ?? -1)
    .map((row) => ({
      threadId: String(row.thread_id),
      role: String(row.role),
      status: String(row.status),
      eligible: JSON.parse(String(row.eligible_json)) as string[],
      chosen: String(row.chosen_model),
      pick: row.pick_model === null ? null : String(row.pick_model),
      reassigned: Number(row.reassigned) === 1,
    }));
};

const turnTokens = (payload: string): number | null => {
  const usage = (JSON.parse(payload) as { turnTokenUsage?: Record<string, unknown> })
    .turnTokenUsage;
  return usage?.usageStatus === "complete" &&
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
    ? usage.inputTokens + usage.outputTokens
    : null;
};

export const readTaskOutcomes = (
  db: NodeSqlite.DatabaseSync,
  threadIds: readonly string[],
): ReadonlyMap<string, TaskOutcome> => {
  const outcomes = new Map<string, TaskOutcome>();
  if (!hasTable(db, "orchestration_v2_projection_runs")) return outcomes;
  const runs = db.prepare(
    "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal",
  );
  const turns = db.prepare(
    "SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE thread_id = ?",
  );
  for (const threadId of threadIds) {
    const statuses = runs.all(threadId).map((row) => String(row.status));
    if (statuses.length === 0) continue;
    const perTurn = turns.all(threadId).map((row) => turnTokens(String(row.payload_json)));
    outcomes.set(threadId, {
      runs: statuses.length,
      lastRunStatus: statuses.at(-1)!,
      tokens:
        perTurn.length === 0 || perTurn.some((tokens) => tokens === null)
          ? null
          : perTurn.reduce((total, tokens) => total! + tokens!, 0),
    });
  }
  return outcomes;
};

/** T3's own cached rate table, the one usage reports price with; unpriced when it is missing. */
export const readPriceOf = (stateDir: string): PriceOf => {
  let table: RateTable = new Map();
  try {
    const cached = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, "usage-model-rates.json"), "utf8"),
    ) as { document?: unknown };
    table = parseRateTable(cached.document);
  } catch {
    // No cache yet: every cheaper/dearer claim is then reported as unpriced.
  }
  return (model) => {
    const rate = lookupRate(table, model);
    return rate === null ? null : rate.inputCostPerToken + rate.outputCostPerToken;
  };
};

const formatJson = (value: unknown) => JSON.stringify(value, null, 2);
const pct = (count: number, total: number) =>
  total === 0 ? "n/a" : `${Math.round((count / total) * 100)}%`;
const unknown = (count: number) => (count === 0 ? "" : ` (${count} unknown)`);

export const formatShadowReport = (scores: readonly RoleScore[], window: string) => {
  if (scores.length === 0)
    return `No delegation model picks recorded on this environment ${window}.`;
  const total = scores.reduce((sum, score) => sum + score.delegations, 0);
  return [
    `Delegation model picks ${window}: ${total} managed delegations. Agreement counts only picks at or above the declared probability floor; everything else is an abstention.`,
    ...scores.map((score) => {
      const lines = [
        `${score.role}: ${score.delegations} delegations; ${score.recommended} recommended, ${score.abstained} abstained, ${score.failed} engine failures, ${score.soleModel} with one eligible model${score.reassigned > 0 ? `, ${score.reassigned} reassigned by an experiment (not counted)` : ""}`,
        `  agreement: ${score.agreed} of ${score.recommended} (${pct(score.agreed, score.recommended)})`,
      ];
      for (const group of GROUPS) {
        const g = score.groups[group];
        if (g.delegations === 0) continue;
        lines.push(
          `  ${group.padEnd(10)} ${String(g.delegations).padStart(4)} tasks | mean tokens ${g.meanTokens ?? "unknown"}${unknown(g.tokensUnknown)} | further runs ${g.furtherRuns}${unknown(g.furtherRunsUnknown)} | failed or cancelled ${g.failedOrCancelled}${g.stillOpen > 0 ? `, ${g.stillOpen} still open` : ""}${unknown(g.endingUnknown)}`,
        );
      }
      return lines.join("\n");
    }),
  ].join("\n\n");
};

export const delegationShadowCommand = Command.make("shadow", {
  baseDir: baseDirFlag,
  days: Flag.Int("days").pipe(
    Flag.withDescription("How many days back to report, ending now."),
    Flag.withDefault(14),
  ),
  first: Flag.Int("first").pipe(
    Flag.withDescription("Report only the earliest N delegations in the window."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the scores as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Report how often the decision engine's model pick agreed with the agent's choice on managed delegations, and how each group's tasks went.",
  ),
  Command.withHandler(({ baseDir, days, first, json }) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const since = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, Duration.days(days)),
      );
      const db = open(config.dbPath);
      const limit = first._tag === "Some" ? first.value : undefined;
      const scores = (() => {
        if (db === undefined) return [];
        try {
          const rows = readShadowRows(db, since, limit);
          const outcomes = readTaskOutcomes(
            db,
            rows.map((row) => row.threadId),
          );
          return scoreShadow(rows, (id) => outcomes.get(id), readPriceOf(config.stateDir));
        } finally {
          db.close();
        }
      })();
      yield* Console.log(
        json ? formatJson({ since, scores }) : formatShadowReport(scores, `since ${since}`),
      );
    }),
  ),
);

export const delegationCommand = Command.make("delegation").pipe(
  Command.withDescription("Inspect how delegation behaves on this environment."),
  Command.withSubcommands([delegationShadowCommand]),
);
