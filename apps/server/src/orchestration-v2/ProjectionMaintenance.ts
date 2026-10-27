import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  compactableEventCondition,
  READ_STATE_THREAD_EVENT_TYPES,
  SUPERSEDABLE_THREAD_EVENT_TYPES,
} from "./compactionCandidates.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

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
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const verify = Effect.gen(function* () {
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
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
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
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // Keep prompt anchors, merged token usage, and command responses needed by receipt retries.
    const settledWithoutActiveWork = sql.literal(`
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = event.stream_id
          AND json_extract(thread.payload_json, '$.settledOverride') IS NOT 'active'
          AND (json_extract(thread.payload_json, '$.settledAt') IS NOT NULL
            OR json_extract(thread.payload_json, '$.settledOverride') = 'settled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = event.stream_id AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_turns AS turn
          INDEXED BY orchestration_v2_provider_turns_active_thread_idx
        WHERE turn.thread_id = event.stream_id AND turn.status IN ('pending', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
          INDEXED BY orchestration_v2_turn_items_active_thread_idx
        WHERE item.thread_id = event.stream_id AND item.status IN ('pending', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
        WHERE request.thread_id = event.stream_id AND request.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
        WHERE subagent.thread_id = event.stream_id AND subagent.status IN ('pending', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider_thread
        WHERE provider_thread.thread_id = event.stream_id
          AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
      )
    `);
    // Small indexed pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    // First and latest keyed events preserve replay insertion order and final state.
    const compactEventStore = Effect.gen(function* () {
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
        { readonly sequence: number; readonly protected: boolean } | null
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
          readonly intermediate_eligible: number;
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
                AND event.event_type IN ('message.updated', 'node.updated', 'turn-item.updated', 'provider-turn.updated')
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
            CASE WHEN event.event_type IN ('turn-item.updated', 'provider-turn.updated')
              THEN ${settledWithoutActiveWork} ELSE 1 END AS intermediate_eligible,
            CASE
              WHEN event.command_id IS NOT NULL
                AND event.event_type IN ('message.updated', 'turn-item.updated', 'provider-turn.updated') THEN 1
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
        const obsolete: number[] = [];
        for (const row of rows) {
          if (row.intermediate_eligible !== 1) continue;
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(row.sequence);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(row.sequence);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              row.event_type === "turn-item.updated" ||
              row.event_type === "provider-turn.updated"
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const keepUsage = row.has_provider_usage === 1 && !retainedProviderUsageKeys.has(key);
              if (keepUsage) retainedProviderUsageKeys.add(key);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null && !candidate.protected) obsolete.push(candidate.sequence);
                oldestCandidateByEntityKey.set(key, {
                  sequence: row.sequence,
                  protected: row.protected_intermediate === 1 || keepUsage,
                });
              }
            }
          }
        }
        // Yield even without deletions for clients using the synchronous fallback.
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          // Recheck on the writer: a thread can resume while reader discovery yields.
          const deleted = yield* sql<{ sequence: number }>`
            DELETE FROM orchestration_events AS event WHERE sequence IN ${sql.in(obsolete)}
              AND (event_type NOT IN ('turn-item.updated', 'provider-turn.updated')
                OR (${settledWithoutActiveWork}))
            RETURNING sequence
          `;
          deletedEventCount += deleted.length;
          yield* Effect.yieldNow;
        }
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

      return { deletedEventCount, deletedReceiptCount, reclaimableBytes };
    });

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore: mapError("compact event store")(compactEventStore),
    });
  }),
);
