import type {
  ChampionFinding,
  ChampionSummary,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  classifyFinding,
  NOT_SAVED_PREFIX,
  escalationShells,
  formatEscalationBrief,
  stuckState,
  type EscalationDocument,
  type EscalationFinding,
} from "./championEscalation.ts";

type ChampionShellRow = {
  readonly owner_thread_id: string;
  readonly setup_thread_id: string | null;
  readonly id: string;
  readonly name: string;
  readonly attention: number;
  readonly setup_attention: number;
  readonly stuck_thread_id: string | null;
  readonly failures: number | null;
  readonly folder_error: number;
  readonly journey: number;
  readonly lifecycle: string | null;
  /** JSON array of the findings that have an escalation thread, open and archived. */
  readonly escalations: string | null;
};

/**
 * The Champions owning, setting up or escalating any of the given threads (fork/differences.md
 * `champions`), read with a shell snapshot so each thread shell can carry its Champion.
 */
export const readChampionShellRows = (sql: SqlClient.SqlClient, encodedThreadIds: string) =>
  sql<ChampionShellRow>`
    WITH target_threads AS (SELECT value FROM json_each(${encodedThreadIds}))
    SELECT json_extract(document_json, '$.champion.ownerThreadId') AS owner_thread_id,
      json_extract(document_json, '$.champion.setupThreadId') AS setup_thread_id,
      id, json_extract(document_json, '$.champion.name') AS name,
      json_array_length(json_extract(document_json, '$.champion.attention')) AS attention,
      CASE WHEN EXISTS (SELECT 1 FROM json_each(document_json, '$.champion.attention') WHERE value LIKE 'Setup %')
        THEN 1 ELSE 0 END AS setup_attention,
      json_extract(document_json, '$.champion.stuckEscalationThreadId') AS stuck_thread_id,
      json_extract(document_json, '$.champion.consecutiveCheckFailures') AS failures,
      CASE WHEN EXISTS (SELECT 1 FROM json_each(document_json, '$.champion.attention') WHERE value LIKE ${`${NOT_SAVED_PREFIX}%`})
        THEN 1 ELSE 0 END AS folder_error,
      json_extract(document_json, '$.champion.lifecycle') AS lifecycle,
      CASE WHEN json_type(document_json, '$.champion.journeys') IS NOT NULL THEN 1 ELSE 0 END AS journey,
      (SELECT json_group_array(json(facts)) FROM (
        SELECT json_object('id', json_extract(f.value, '$.id'), 'title', json_extract(f.value, '$.title'),
          'metricId', json_extract(f.value, '$.metricId'), 'status', json_extract(f.value, '$.status'),
          'decisionStatus', json_extract(f.value, '$.decision.status'),
          'repairAttention', json_extract(f.value, '$.repairAttention'),
          'escalationThreadId', json_extract(f.value, '$.escalationThreadId')) AS facts
        FROM json_each(champions.document_json, '$.findings') f
        WHERE json_extract(f.value, '$.escalationThreadId') IS NOT NULL
        UNION ALL
        SELECT json_object('id', json_extract(a.document_json, '$.id'), 'title', json_extract(a.document_json, '$.title'),
          'metricId', json_extract(a.document_json, '$.metricId'), 'status', json_extract(a.document_json, '$.status'),
          'decisionStatus', json_extract(a.document_json, '$.decision.status'),
          'repairAttention', json_extract(a.document_json, '$.repairAttention'),
          'escalationThreadId', json_extract(a.document_json, '$.escalationThreadId'))
        FROM champion_finding_archive a
        WHERE a.champion_id = champions.id AND json_extract(a.document_json, '$.escalationThreadId') IS NOT NULL
      )) AS escalations
    FROM champions
    WHERE json_extract(document_json, '$.champion.ownerThreadId') IN (SELECT value FROM target_threads)
      OR json_extract(document_json, '$.champion.setupThreadId') IN (SELECT value FROM target_threads)
      OR json_extract(document_json, '$.champion.stuckEscalationThreadId') IN (SELECT value FROM target_threads)
      OR EXISTS (SELECT 1 FROM json_each(document_json, '$.findings') f
        WHERE json_extract(f.value, '$.escalationThreadId') IN (SELECT value FROM target_threads))
      OR EXISTS (SELECT 1 FROM champion_finding_archive a WHERE a.champion_id = champions.id
        AND json_extract(a.document_json, '$.escalationThreadId') IN (SELECT value FROM target_threads))
  `;

type FindingFacts = {
  readonly id: string;
  readonly title: string;
  readonly metricId: string | null;
  readonly status: EscalationFinding["status"];
  readonly decisionStatus: "requested" | "resolved" | null;
  readonly repairAttention: string | null;
  readonly escalationThreadId: string;
};

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const escalationDocument = (row: ChampionShellRow): EscalationDocument => {
  const seen = new Set<string>();
  // An open finding comes before its archived twin, so the open one decides.
  const facts = (parseJson(row.escalations ?? "[]") as ReadonlyArray<FindingFacts>).filter((f) =>
    seen.has(f.escalationThreadId) ? false : (seen.add(f.escalationThreadId), true),
  );
  return {
    champion: {
      attention: row.folder_error > 0 ? [NOT_SAVED_PREFIX] : [],
      consecutiveCheckFailures: row.failures ?? 0,
      stuckEscalationThreadId: row.stuck_thread_id,
      journeys: row.journey > 0 ? {} : undefined,
      lifecycle: row.lifecycle ?? undefined,
    },
    findings: facts.map((f) => ({
      id: f.id,
      title: f.title,
      metricId: f.metricId,
      status: f.status,
      repairAttention: f.repairAttention,
      escalationThreadId: f.escalationThreadId,
      decision: f.decisionStatus === null ? null : { status: f.decisionStatus, id: "" },
    })),
  };
};

/** Adds each thread's Champion, as its owner, setup or escalation thread, to the shells it read. */
export const withChampions = (rows: ReadonlyArray<ChampionShellRow>) => {
  const champions = new Map<string, NonNullable<OrchestrationV2ThreadShell["champion"]>>();
  for (const row of rows) {
    champions.set(row.owner_thread_id, {
      id: row.id,
      attention: row.attention > 0,
      kind: "owner",
      name: row.name,
    });
    if (row.setup_thread_id !== null)
      champions.set(row.setup_thread_id, {
        id: row.id,
        attention: row.setup_attention > 0,
        kind: "setup",
        name: row.name,
      });
    for (const [threadId, shell] of escalationShells(escalationDocument(row)))
      champions.set(threadId, {
        id: row.id,
        attention: !shell.resolved,
        kind: "escalation",
        name: row.name,
        ...shell,
      });
  }
  return <T extends OrchestrationV2ThreadShell>(thread: T): T =>
    champions.has(thread.id) ? { ...thread, champion: champions.get(thread.id)! } : thread;
};

/**
 * The brief for an escalation thread's first message, or "" for any other thread. Read from the full
 * Champion document because it needs the finding's evidence, diagnosis and decision.
 */
export const readEscalationBrief = Effect.fn("Champions.readEscalationBrief")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const live = yield* sql<{ document_json: string }>`
    SELECT document_json FROM champions
    WHERE json_extract(document_json, '$.champion.stuckEscalationThreadId') = ${threadId}
      OR EXISTS (SELECT 1 FROM json_each(document_json, '$.findings') f
        WHERE json_extract(f.value, '$.escalationThreadId') = ${threadId})
    LIMIT 1`;
  const archived =
    live[0] !== undefined
      ? []
      : yield* sql<{ document_json: string; finding_json: string }>`
          SELECT c.document_json AS document_json, a.document_json AS finding_json
          FROM champion_finding_archive a JOIN champions c ON c.id = a.champion_id
          WHERE json_extract(a.document_json, '$.escalationThreadId') = ${threadId} LIMIT 1`;
  const source = live[0] ?? archived[0];
  if (source === undefined) return "";
  const doc = parseJson(source.document_json) as {
    champion: ChampionSummary;
    findings: ReadonlyArray<ChampionFinding>;
  };
  const finding =
    doc.findings.find((candidate) => candidate.escalationThreadId === threadId) ??
    (archived[0] === undefined
      ? undefined
      : (parseJson(archived[0].finding_json) as ChampionFinding));
  const stuck = stuckState(doc.champion);
  const shell =
    finding !== undefined
      ? {
          findingId: finding.id,
          ...classifyFinding(finding, doc.champion.journeys !== undefined),
        }
      : {
          findingId: null,
          severity: "stuck" as const,
          trigger: stuck.trigger,
          resolved: !stuck.stuck,
        };
  // The current streak's checks (failureCounted stays set after recovery, so the streak length bounds
  // the read); each one's ending leaves no activity row.
  const streak = Math.min(5, doc.champion.consecutiveCheckFailures ?? 0);
  const failures =
    finding === undefined && streak > 0
      ? (yield* sql<{ document_json: string }>`
          SELECT document_json FROM champion_checks
          WHERE champion_id = ${doc.champion.id}
            AND json_extract(document_json, '$.failureCounted') = 1
          ORDER BY started_at DESC LIMIT ${streak}`).map((row) => {
          const check = parseJson(row.document_json) as {
            id: string;
            startedAt: string;
            cancelled?: boolean;
            reported?: boolean;
            skipped?: string;
          };
          const status = check.cancelled ? "cancelled" : check.reported ? "reported" : "pending";
          return {
            at: check.startedAt,
            text: `check ${check.id.slice(0, 8)} (${status})${check.skipped === undefined ? "" : `: ${check.skipped}`}`,
          };
        })
      : undefined;
  return formatEscalationBrief({
    champion: doc.champion,
    shell,
    finding,
    attention: doc.champion.attention,
    ownerThreadId: doc.champion.ownerThreadId,
    repository: doc.champion.folder?.repository,
    failures,
  });
});
