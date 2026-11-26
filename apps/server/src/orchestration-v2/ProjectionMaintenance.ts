import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  compactableEventCondition,
  pinnedThreadOf,
  READ_STATE_THREAD_EVENT_TYPES,
  settledWithoutActiveWorkOf,
  SUPERSEDABLE_THREAD_EVENT_TYPES,
} from "./compactionCandidates.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadDetailExpiry from "./ThreadDetailExpiry.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<
    ProjectionVerificationV2,
    ProjectionMaintenanceError,
    EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2
  >;
  readonly rebuild: Effect.Effect<
    ProjectionVerificationV2,
    ProjectionMaintenanceError,
    EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2
  >;
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly purgedRowCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
  /**
   * Removes a deleted thread's conversation, and that of deleted run-fork sources it alone kept.
   * Returns the number of rows removed.
   */
  readonly purgeDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionMaintenanceError>;
  /** Strips threads settled `afterDays` ago to messages and tool-call lines; paced like pruning. */
  readonly expireThreadDetail: (
    input: { readonly now: DateTime.Utc; readonly afterDays: number },
    betweenPages?: Effect.Effect<void>,
  ) => Effect.Effect<ThreadDetailExpiry.ThreadDetailExpiryResult, ProjectionMaintenanceError>;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

// Bounds how long one purge statement holds the writer: on a real database a 500-row batch of
// turn items took about 400 ms, index and count-trigger work included.
const PURGE_BATCH_SIZE = 50;
// Titles default to the first message, so a tombstone cannot keep the real one.
export const DELETED_THREAD_TITLE = "Deleted thread";

// Every thread_id table that holds conversation text. The thread row stays as the tombstone, and
// the metadata that storage cleanup and usage history still read (checkpoints, provider sessions,
// provider turns, run attempts, context transfers) stays with it.
export const DELETED_THREAD_CONTENT_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_plans",
  "mcp_app_model_context",
  // A legacy thread's transcript source; deleting it means the importer has nothing to restore.
  "projection_thread_messages",
] as const;

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

export const layer: Layer.Layer<ProjectionMaintenanceV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const verify = Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction, Effect.withSpan("ProjectionMaintenance.verify"));

    const rebuild = Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      // Settled threads' item history lives only in the projection once it is pruned from the log.
      const pruned = yield* sql`SELECT 1 FROM orchestration_v2_event_prune_marks LIMIT 1`;
      if (pruned.length > 0) {
        return yield* new ProjectionMaintenanceError({
          operation: "rebuild",
          cause: "Settled threads' events were pruned; replay would lose their history",
        });
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    }).pipe(Effect.withSpan("ProjectionMaintenance.rebuild"));

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // A thread still working keeps merged token usage; every thread keeps prompt anchors and the
    // command responses receipt retries read.
    const settledWithoutActiveWork = settledWithoutActiveWorkOf(sql, "event.stream_id");
    // Pinning unsettles a thread today; removal states the rule instead of leaning on that.
    const pinned = pinnedThreadOf(sql, "event.stream_id");
    // Small indexed pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;
    // One page can hold megabyte payloads, and freeing their overflow pages holds the writer.
    const DELETE_PAYLOAD_BUDGET = 4 * 1024 * 1024;
    type Obsolete = { readonly sequence: number; readonly payloadLength: number };
    const deleteBatches = <Row extends Obsolete>(rows: ReadonlyArray<Row>) => {
      const batches: Array<Array<Row>> = [];
      let budget = 0;
      for (const row of rows) {
        const batch = batches.at(-1);
        if (batch === undefined || budget + row.payloadLength > DELETE_PAYLOAD_BUDGET) {
          batches.push([row]);
          budget = row.payloadLength;
        } else {
          batch.push(row);
          budget += row.payloadLength;
        }
      }
      return batches;
    };

    // A run fork shows its source's history without copying it, through any chain of forks, and a
    // pending merge-back still reads its source. Such a deleted thread keeps its content until
    // every live thread that shows it is deleted too.
    const purgeableThreads = (deletedThreadId: ThreadId | undefined) =>
      sql<{
        readonly thread_id: string;
      }>`
      WITH RECURSIVE shown(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
        UNION
        SELECT transfer.source_thread_id
        FROM orchestration_v2_projection_context_transfers AS transfer
        JOIN orchestration_v2_projection_threads AS target
          ON target.thread_id = transfer.target_thread_id
        WHERE transfer.type = 'merge_back' AND transfer.status = 'pending'
          AND target.deleted_at IS NULL
        UNION
        SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
        FROM shown
        JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = shown.thread_id
        WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
      ),
      candidate(thread_id) AS (${
        deletedThreadId === undefined
          ? sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL`
          : // Deleting a fork can release the deleted sources it was the last to show.
            sql`
              SELECT ${deletedThreadId}
              UNION
              SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
              FROM candidate
              JOIN orchestration_v2_projection_threads AS fork
                ON fork.thread_id = candidate.thread_id
              WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
            `
      })
      SELECT thread.thread_id
      FROM candidate
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = candidate.thread_id
      WHERE thread.deleted_at IS NOT NULL
        AND thread.thread_id NOT IN (SELECT thread_id FROM shown WHERE thread_id IS NOT NULL)
        -- Earlier effects still read the thread; a later purge or sweep takes it.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.status IN ('pending', 'running')
            -- Title generation has its own lane and needs nothing the purge removes.
            AND effect.effect_type NOT IN ('thread-content.purge', 'thread-title.generate')
        )
        -- A live parent settles its delegated task from this child's runs.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents AS task
          JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = task.thread_id
          WHERE task.child_thread_id = thread.thread_id
            AND task.status IN ('idle', 'pending', 'running', 'waiting')
            AND parent.deleted_at IS NULL
        )
        -- The delete's own purge always runs; the sweep only takes threads with something left.
        AND ${
          deletedThreadId !== undefined
            ? sql`1 = 1`
            : sql.or([
                sql`thread.title <> ${DELETED_THREAD_TITLE}`,
                // A thread renamed to the placeholder still has its first title in thread.created.
                sql`EXISTS (
            SELECT 1 FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = thread.thread_id
              AND event_type IN ('thread.created', 'thread.deleted')
              AND json_extract(payload_json, '$.title') IS NOT ${DELETED_THREAD_TITLE}
          )`,
                sql`json_type(thread.payload_json, '$.guestShare') IS NOT NULL`,
                // An interrupted pass leaves events the purge does not keep.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_events
                    INDEXED BY idx_orchestration_events_agent_stream_sequence
                  WHERE application_event_version = 2
                    AND aggregate_kind = 'thread'
                    AND stream_id = thread.thread_id
                    AND event_type NOT IN ('thread.created', 'thread.deleted')
                    AND NOT (
                      event_type = 'run.updated'
                      AND json_extract(payload_json, '$.status') = 'running'
                    )
                )`,
                // The purge deletes settled requests and clears a failed one's error.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_v2_effect_outbox AS effect
                  WHERE effect.thread_id = thread.thread_id
                    AND effect.effect_type <> 'thread-content.purge'
                    AND (
                      effect.status IN ('succeeded', 'cancelled')
                      OR (effect.status = 'failed' AND effect.last_error IS NOT NULL)
                    )
                )`,
                ...DELETED_THREAD_CONTENT_TABLES.map(
                  (table) =>
                    sql`EXISTS (SELECT 1 FROM ${sql(table)} WHERE thread_id = thread.thread_id)`,
                ),
              ])
        }
    `.pipe(NodeSqliteClient.readOnly);

    const purgeThreads = Effect.fnUntraced(function* (
      deletedThreadId: ThreadId | undefined,
      betweenPages: Effect.Effect<void>,
    ) {
      const threads = yield* purgeableThreads(deletedThreadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      let purged = 0;
      // Each statement commits on its own, so a huge thread never holds the writer for long.
      const drain = Effect.fnUntraced(function* (
        deleteBatch: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      ) {
        for (;;) {
          const rows = yield* deleteBatch;
          purged += rows.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
          if (rows.length < PURGE_BATCH_SIZE) return;
        }
      });
      for (const { thread_id: threadId } of threads) {
        const tombstone = sql`(
          SELECT json_remove(json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}), '$.guestShare')
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        )`;
        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_remove(
            json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}),
            '$.guestShare'
          )
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted')
        `;
        // The head row only holds the stream's position, so any other head becomes the tombstone.
        // First, so the head never borrows a prompt from an anchor already deleted below.
        yield* sql`
          UPDATE orchestration_events
          SET event_type = 'thread.deleted', payload_json = ${tombstone}, metadata_json = '{}'
          WHERE sequence = (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            )
            AND event_type NOT IN ('thread.created', 'thread.deleted')
            AND NOT (
              event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
            )
        `;
        for (const table of DELETED_THREAD_CONTENT_TABLES) {
          yield* drain(sql`
            DELETE FROM ${sql(table)}
            WHERE rowid IN (
              SELECT rowid FROM ${sql(table)} WHERE thread_id = ${threadId} LIMIT ${PURGE_BATCH_SIZE}
            )
            RETURNING 1 AS purged
          `);
        }
        // Keep only what the pruner keeps for any stream: replay still delivers the deletion.
        yield* drain(sql`
          DELETE FROM orchestration_events
          WHERE sequence IN (
            SELECT sequence FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type NOT IN ('thread.created', 'thread.deleted')
              AND NOT (
                event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
              )
              AND sequence < (
                SELECT MAX(sequence) FROM orchestration_events
                WHERE application_event_version = 2
                  AND aggregate_kind = 'thread'
                  AND stream_id = ${threadId}
              )
            -- Newest first: a row borrowing its prompt goes before the anchor it borrows from.
            ORDER BY sequence DESC
            LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1 AS purged
        `);
        // Settled requests can hold answers, feedback, and titles. A failed one stays as the
        // marker that keeps a deleted thread's worktree, so only its text goes.
        yield* sql`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND status IN ('succeeded', 'cancelled')
        `;
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET payload_json = CASE
            WHEN json_type(payload_json, '$.title') = 'text'
              THEN json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE})
            ELSE json_remove(payload_json, '$.feedback', '$.answers')
          END,
            last_error = NULL
          WHERE thread_id = ${threadId} AND status = 'failed'
        `;
        // Its v1 events then go with the imported-history prune, and no import refills it.
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET transcript_imported_at = ${now}
          WHERE thread_id = ${threadId} AND transcript_imported_at IS NULL
        `;
        // Last, because the new title is what marks the purge as done.
        yield* sql`
          UPDATE projection_threads SET title = ${DELETED_THREAD_TITLE} WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET title = ${DELETED_THREAD_TITLE}, payload_json = ${tombstone}
          WHERE thread_id = ${threadId}
        `;
      }
      return purged;
    });

    const purgeDeletedThread: ProjectionMaintenanceV2Shape["purgeDeletedThread"] = (threadId) =>
      purgeThreads(threadId, Effect.void).pipe(
        Effect.withSpan("ProjectionMaintenance.purgeDeletedThread"),
        Effect.mapError(
          (cause) => new ProjectionMaintenanceError({ operation: "purge deleted thread", cause }),
        ),
      );

    // In a thread still working, first and latest keyed events preserve replay order and final
    // state. A settled thread's projection already holds both, so its keyed events go.
    const pruneEventStore = Effect.fn("ProjectionMaintenance.pruneEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
    ) {
      // Catches threads deleted before purging existed, and any purge a crash interrupted.
      const purgedRowCount = yield* purgeThreads(undefined, betweenPages);
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly);
      let throughSequence = bounds[0]?.event_sequence ?? 0;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<
        string,
        (Obsolete & { readonly protected: boolean }) | null
      >();
      const retainedProviderUsageKeys = new Set<string>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
          readonly thread_settled: number;
          readonly thread_pinned: number;
          readonly has_newer: number;
          readonly has_command: number;
          readonly payload_length: number;
          readonly protected_intermediate: number;
          readonly has_provider_usage: number;
        }>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN ('message.updated', 'node.updated', 'turn-item.updated', 'provider-turn.updated', 'provider-session.updated')
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'thread.pull-request-link-updated'
              THEN json_array(json_extract(event.payload_json, '$.host'),
                json_extract(event.payload_json, '$.repository'),
                json_extract(event.payload_json, '$.number'))
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread,
            CASE WHEN event.application_event_version = 2
              AND event.event_type IN ('message.updated', 'node.updated', 'turn-item.updated', 'provider-turn.updated')
              THEN ${settledWithoutActiveWork} ELSE 0 END AS thread_settled,
            ${pinned} AS thread_pinned,
            EXISTS (
              SELECT 1 FROM orchestration_events AS newer
                INDEXED BY idx_orchestration_events_agent_stream_sequence
              WHERE newer.application_event_version = 2 AND newer.aggregate_kind = 'thread'
                AND newer.stream_id = event.stream_id AND newer.sequence > event.sequence
            ) AS has_newer,
            event.command_id IS NOT NULL AS has_command,
            length(event.payload_json) AS payload_length,
            CASE
              WHEN event.command_id IS NOT NULL
                AND event.event_type IN ('message.updated', 'turn-item.updated', 'provider-turn.updated', 'provider-session.updated') THEN 1
              WHEN event.event_type = 'turn-item.updated'
                AND json_extract(event.payload_json, '$.type') = 'subagent' THEN 1
              ELSE 0 END AS protected_intermediate,
            CASE WHEN event.event_type = 'provider-turn.updated'
              AND json_type(event.payload_json, '$.tokenUsage') = 'object'
              THEN 1 ELSE 0 END AS has_provider_usage
          FROM orchestration_events AS event
            INDEXED BY orchestration_events_compactable_sequence_idx
          WHERE event.sequence <= ${throughSequence}
            AND ${compactableEventCondition(sql)}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete: Obsolete[] = [];
        const settled: Array<Obsolete & { readonly threadId: string }> = [];
        for (const row of rows) {
          const current = { sequence: row.sequence, payloadLength: row.payload_length };
          // A thread's newest event stays: it is the high-water an idle client's cursor rests on.
          // Subagent items stay too: a retained row can name one as the anchor holding its prompt.
          if (
            row.thread_settled === 1 &&
            row.thread_pinned === 0 &&
            row.has_command === 0 &&
            row.protected_intermediate === 0 &&
            row.has_newer === 1
          ) {
            settled.push({ ...current, threadId: row.stream_id });
            continue;
          }
          // A working thread keeps every turn-item and provider-turn update.
          if (
            row.thread_settled !== 1 &&
            (row.event_type === "turn-item.updated" || row.event_type === "provider-turn.updated")
          ) {
            continue;
          }
          if (row.imported_legacy_thread === 1) {
            obsolete.push(current);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(current);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(current);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(current);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              row.event_type === "turn-item.updated" ||
              row.event_type === "provider-turn.updated" ||
              row.event_type === "provider-session.updated"
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const keepUsage = row.has_provider_usage === 1 && !retainedProviderUsageKeys.has(key);
              if (keepUsage) retainedProviderUsageKeys.add(key);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null && !candidate.protected) obsolete.push(candidate);
                oldestCandidateByEntityKey.set(key, {
                  ...current,
                  protected: row.protected_intermediate === 1 || keepUsage,
                });
              }
            }
          }
        }
        // Yield even without deletions for clients using the synchronous fallback.
        yield* Effect.yieldNow;
        for (const batch of deleteBatches(obsolete)) {
          // Recheck on the writer: a thread can resume while reader discovery yields.
          const deleted = yield* sql<{ sequence: number }>`
            DELETE FROM orchestration_events AS event
            WHERE sequence IN ${sql.in(batch.map((row) => row.sequence))}
              AND (event_type NOT IN ('turn-item.updated', 'provider-turn.updated')
                OR (${settledWithoutActiveWork}))
            RETURNING sequence
          `;
          deletedEventCount += deleted.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
        }
        for (const batch of deleteBatches(settled)) {
          const throughByThread = new Map<string, number>();
          for (const row of batch) {
            throughByThread.set(
              row.threadId,
              Math.max(throughByThread.get(row.threadId) ?? 0, row.sequence),
            );
          }
          // The boundary is published before the rows go, so a client resuming meanwhile sees it.
          for (const [threadId, through] of throughByThread) {
            yield* sql`
              INSERT INTO orchestration_v2_event_prune_marks (thread_id, pruned_through_sequence)
              VALUES (${threadId}, ${through})
              ON CONFLICT (thread_id) DO UPDATE SET pruned_through_sequence =
                MAX(pruned_through_sequence, excluded.pruned_through_sequence)
            `;
          }
          const deleted = yield* sql<{ sequence: number }>`
            DELETE FROM orchestration_events AS event
            WHERE sequence IN ${sql.in(batch.map((row) => row.sequence))}
              AND command_id IS NULL
              AND (${settledWithoutActiveWork})
              AND NOT ${pinned}
            RETURNING sequence
          `;
          deletedEventCount += deleted.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
        }
        yield* betweenPages;
        throughSequence = (rows.at(-1)?.sequence ?? 1) - 1;
        if (rows.length < COMPACTION_PAGE_SIZE) break;
      }

      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        throughReceiptRowId = (rows.at(-1)?.row_id ?? 1) - 1;
        if (rows.length < COMPACTION_PAGE_SIZE) break;
      }

      // Existing files opt in through doctor's offline VACUUM; never rebuild a live file here.
      const mode = yield* sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`;
      if (mode[0]?.auto_vacuum === 2) {
        for (let page = 0; page < 256; page++) {
          const free = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
          if ((free[0]?.freelist_count ?? 0) === 0) break;
          yield* sql`PRAGMA incremental_vacuum(1)`;
          yield* Effect.yieldNow;
        }
      }
      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return { deletedEventCount, deletedReceiptCount, purgedRowCount, reclaimableBytes };
    });

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      pruneEventStore: Effect.fn("ProjectionMaintenanceV2.pruneEventStore")((betweenPages) =>
        mapError("prune event store")(pruneEventStore(betweenPages)),
      ),
      purgeDeletedThread,
      expireThreadDetail: Effect.fn("ProjectionMaintenanceV2.expireThreadDetail")(
        (input, betweenPages = Effect.void) =>
          mapError("expire thread detail")(
            ThreadDetailExpiry.expireThreadDetail(input, betweenPages).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          ),
      ),
    });
  }),
);
