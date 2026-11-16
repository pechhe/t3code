import {
  type OrchestrationV2ContextHandoff,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { settledWithoutActiveWorkOf } from "./compactionCandidates.ts";
import {
  expireContextHandoffDetail,
  expireSubagentRecordDetail,
  expireTurnItemDetail,
} from "./WireProjection.ts";

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJson),
);
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2ContextHandoffJson));
const decodeSubagent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);
const encodeSubagent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2SubagentJson));

// Messages, plans and notices are kept whole; these types carry output, reasoning, diffs, or a
// subagent's prompt and result. A `handoff` item's summary follows its record (stripHandoffs).
const DETAILED_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "reasoning",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
];
const THREAD_PAGE_SIZE = 100;
const LIST_PAGE_SIZE = 200;
const NODE_BATCH_SIZE = 500;
// Freeing a megabyte payload's overflow pages holds the writer, as in pruneEventStore.
const PAYLOAD_BUDGET = 4 * 1024 * 1024;

export interface ThreadDetailExpiryResult {
  readonly expiredThreadCount: number;
  readonly strippedItemCount: number;
  readonly removedItemBytes: number;
  readonly deletedNodeCount: number;
  readonly deletedEventCount: number;
}

function byBudget<Row extends { readonly bytes: number }>(rows: ReadonlyArray<Row>) {
  const batches: Array<Array<Row>> = [];
  let budget = 0;
  for (const row of rows) {
    const batch = batches.at(-1);
    if (batch === undefined || budget + row.bytes > PAYLOAD_BUDGET) {
      batches.push([row]);
      budget = row.bytes;
    } else {
      batch.push(row);
      budget += row.bytes;
    }
  }
  return batches;
}

/**
 * Strips threads settled for `afterDays` to their messages and tool-call lines: each detailed
 * item takes its expired wire shape, settled leaf nodes go, and the log keeps only what thread
 * reads, verification and usage history read. Every write rechecks that the thread is still
 * eligible, so a thread that resumes mid-pass keeps everything not yet removed.
 */
export const expireThreadDetail = Effect.fn("ProjectionMaintenance.expireThreadDetail")(function* (
  input: { readonly now: DateTime.Utc; readonly afterDays: number },
  betweenPages: Effect.Effect<void>,
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = DateTime.formatIso(DateTime.subtract(input.now, { days: input.afterDays }));
  const removed = { at: DateTime.formatIso(input.now), afterDays: input.afterDays };

  // Anything still depending on a thread holds it: its own parked waits and watches, a parent
  // or delegator waiting on it, a scheduled task bound to it, or another thread waiting on it.
  const eligible = sql`
    candidate.deleted_at IS NULL
    AND json_extract(candidate.payload_json, '$.pinnedAt') IS NULL
    AND julianday(json_extract(candidate.payload_json, '$.settledAt')) <= julianday(${cutoff})
    AND IFNULL(json_array_length(candidate.payload_json, '$.parkedWaits'), 0) = 0
    AND IFNULL(json_array_length(candidate.payload_json, '$.threadWatches'), 0) = 0
    AND ${settledWithoutActiveWorkOf(sql, "candidate.thread_id")}
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_subagents AS link
        INDEXED BY orchestration_v2_projection_subagents_child_thread_idx
      WHERE link.child_thread_id = candidate.thread_id
        AND (link.status IN ('idle', 'pending', 'running', 'waiting')
          OR json_extract(link.payload_json, '$.pausedByParentStop') = 1
          OR json_extract(link.payload_json, '$.completionDelivery.state') IN ('pending', 'claimed'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks AS task WHERE task.thread_id = candidate.thread_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads AS watcher
        INDEXED BY orchestration_v2_projection_threads_watching_idx
      CROSS JOIN json_each(watcher.payload_json, '$.threadWatches') AS watch
      WHERE watcher.deleted_at IS NULL
        AND json_array_length(watcher.payload_json, '$.threadWatches') > 0
        AND COALESCE(
          json_extract(watch.value, '$.target.threadId'),
          json_extract(watch.value, '$.threadId')
        ) = candidate.thread_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads AS parker
        INDEXED BY orchestration_v2_projection_threads_parked_idx
      CROSS JOIN json_each(parker.payload_json, '$.parkedWaits') AS wait
      WHERE parker.deleted_at IS NULL
        AND json_array_length(parker.payload_json, '$.parkedWaits') > 0
        AND json_extract(wait.value, '$.target.kind') = 'thread'
        AND json_extract(wait.value, '$.target.threadId') = candidate.thread_id
    )
  `;
  // The writer's recheck: the same thread, still eligible, under the settling discovery saw.
  const stillEligible = (threadId: string, settledAt: string) => sql`
    EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads AS candidate
      WHERE candidate.thread_id = ${threadId}
        AND json_extract(candidate.payload_json, '$.settledAt') = ${settledAt}
        AND ${eligible}
    )
  `;
  const pace = Effect.andThen(Effect.yieldNow, betweenPages);

  let strippedItemCount = 0;
  let removedItemBytes = 0;
  let deletedNodeCount = 0;
  let deletedEventCount = 0;
  let expiredThreadCount = 0;

  // Each step returns false when the recheck failed: the thread resumed, so it is left alone.
  const stripItems = Effect.fn("ProjectionMaintenance.expireThreadDetail.items")(function* (
    threadId: string,
    settledAt: string,
  ) {
    let afterRowId = 0;
    while (true) {
      const listed = yield* sql<{ readonly row_id: number; readonly bytes: number }>`
        SELECT rowid AS row_id, octet_length(payload_json) AS bytes
        FROM orchestration_v2_projection_turn_items
          INDEXED BY orchestration_v2_projection_turn_items_thread_type_idx
        WHERE thread_id = ${threadId} AND type IN ${sql.in(DETAILED_ITEM_TYPES)}
          AND rowid > ${afterRowId}
        ORDER BY rowid LIMIT ${LIST_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);
      for (const group of byBudget(listed)) {
        const rows = yield* sql<{
          readonly turn_item_id: string;
          readonly updated_at: string;
          readonly payload_json: string;
        }>`
          SELECT turn_item_id, updated_at, payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE rowid IN ${sql.in(group.map((row) => row.row_id))}
        `.pipe(NodeSqliteClient.readOnly);
        const updates: Array<readonly [turnItemId: string, updatedAt: string, payload: string]> =
          [];
        for (const row of rows) {
          // An item this build cannot read is left as it is rather than stopping the pass.
          const item = yield* decodeItem(row.payload_json).pipe(Effect.option);
          if (Option.isNone(item)) continue;
          const expired = expireTurnItemDetail(item.value, removed);
          if (expired === undefined) continue;
          const payload = yield* encodeItem(expired);
          updates.push([row.turn_item_id, row.updated_at, payload]);
          removedItemBytes += Buffer.byteLength(row.payload_json) - Buffer.byteLength(payload);
          // Decoding a megabyte payload holds the event loop; yield between rows.
          yield* Effect.yieldNow;
        }
        if (updates.length > 0) {
          // One statement per item: a joined batch would rescan the batch for every item.
          const updated = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [guard] = yield* sql<{ readonly eligible: number }>`
                SELECT ${stillEligible(threadId, settledAt)} AS eligible
              `;
              if (guard?.eligible !== 1) return 0;
              let count = 0;
              for (const [turnItemId, updatedAt, payload] of updates) {
                const rows = yield* sql<{ readonly turn_item_id: string }>`
                  UPDATE orchestration_v2_projection_turn_items SET payload_json = ${payload}
                  WHERE turn_item_id = ${turnItemId} AND thread_id = ${threadId}
                    AND updated_at = ${updatedAt}
                  RETURNING turn_item_id
                `;
                count += rows.length;
              }
              return count;
            }),
          );
          strippedItemCount += updated;
          if (updated < updates.length) return false;
        }
        yield* pace;
      }
      afterRowId = listed.at(-1)?.row_id ?? afterRowId;
      if (listed.length < LIST_PAGE_SIZE) return true;
    }
  });

  // Handoff records copy command output into what a recovered provider is given again.
  const stripHandoffs = Effect.fn("ProjectionMaintenance.expireThreadDetail.handoffs")(function* (
    threadId: string,
    settledAt: string,
  ) {
    const listed = yield* sql<{ readonly row_id: number; readonly bytes: number }>`
      SELECT rowid AS row_id, octet_length(payload_json) AS bytes
      FROM orchestration_v2_projection_context_handoffs
        INDEXED BY orchestration_v2_projection_context_handoffs_thread_idx
      WHERE thread_id = ${threadId}
    `.pipe(NodeSqliteClient.readOnly);
    for (const group of byBudget(listed)) {
      const rows = yield* sql<{
        readonly context_handoff_id: string;
        readonly updated_at: string;
        readonly payload_json: string;
      }>`
        SELECT context_handoff_id, updated_at, payload_json
        FROM orchestration_v2_projection_context_handoffs
        WHERE rowid IN ${sql.in(group.map((row) => row.row_id))}
      `.pipe(NodeSqliteClient.readOnly);
      const handoffs: Array<{
        readonly row: (typeof rows)[number];
        readonly value: OrchestrationV2ContextHandoff;
      }> = [];
      for (const row of rows) {
        const handoff = yield* decodeHandoff(row.payload_json).pipe(Effect.option);
        if (Option.isSome(handoff)) handoffs.push({ row, value: handoff.value });
        yield* Effect.yieldNow;
      }
      // A historical command's output ends where its stored input says the command does.
      const commandIds = Array.from(
        new Set(
          handoffs.flatMap(({ value }) =>
            (value.history?.messages ?? [])
              .filter((message) => message.kind === "command_execution")
              .map((message) => message.itemId),
          ),
        ),
      );
      const commandInputs = new Map<string, string>();
      for (let index = 0; index < commandIds.length; index += LIST_PAGE_SIZE) {
        const inputs = yield* sql<{ readonly turn_item_id: string; readonly input: unknown }>`
          SELECT turn_item_id, json_extract(payload_json, '$.input') AS input
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id IN ${sql.in(commandIds.slice(index, index + LIST_PAGE_SIZE))}
            AND type = 'command_execution'
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of inputs)
          if (typeof row.input === "string") commandInputs.set(row.turn_item_id, row.input);
        yield* Effect.yieldNow;
      }
      const updates: Array<readonly [handoffId: string, updatedAt: string, payload: string]> = [];
      const summaries = new Map<string, string>();
      for (const handoff of handoffs) {
        const expired = expireContextHandoffDetail(handoff.value, commandInputs);
        if (expired === undefined) continue;
        updates.push([
          handoff.row.context_handoff_id,
          handoff.row.updated_at,
          yield* encodeHandoff(expired),
        ]);
        if (expired.summaryText !== handoff.value.summaryText)
          summaries.set(handoff.value.id, expired.summaryText);
        yield* Effect.yieldNow;
      }
      // Each `handoff` item copied its record's summary when the handoff happened.
      const itemUpdates: Array<readonly [turnItemId: string, updatedAt: string, payload: string]> =
        [];
      if (summaries.size > 0) {
        const items = yield* sql<{
          readonly turn_item_id: string;
          readonly updated_at: string;
          readonly payload_json: string;
        }>`
          SELECT turn_item_id, updated_at, payload_json
          FROM orchestration_v2_projection_turn_items
            INDEXED BY orchestration_v2_projection_turn_items_thread_type_idx
          WHERE thread_id = ${threadId} AND type = 'handoff'
            AND json_extract(payload_json, '$.contextHandoffId') IN ${sql.in(Array.from(summaries.keys()))}
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of items) {
          const item = yield* decodeItem(row.payload_json).pipe(Effect.option);
          if (Option.isNone(item) || item.value.type !== "handoff") continue;
          const summary = summaries.get(item.value.contextHandoffId);
          if (summary === undefined || item.value.summary === undefined) continue;
          const payload = yield* encodeItem({ ...item.value, summary });
          itemUpdates.push([row.turn_item_id, row.updated_at, payload]);
          removedItemBytes += Buffer.byteLength(row.payload_json) - Buffer.byteLength(payload);
          yield* Effect.yieldNow;
        }
      }
      if (updates.length > 0) {
        const updated = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [guard] = yield* sql<{ readonly eligible: number }>`
              SELECT ${stillEligible(threadId, settledAt)} AS eligible
            `;
            if (guard?.eligible !== 1) return 0;
            let count = 0;
            for (const [handoffId, updatedAt, payload] of updates) {
              const rows = yield* sql<{ readonly context_handoff_id: string }>`
                UPDATE orchestration_v2_projection_context_handoffs SET payload_json = ${payload}
                WHERE context_handoff_id = ${handoffId} AND thread_id = ${threadId}
                  AND updated_at = ${updatedAt}
                RETURNING context_handoff_id
              `;
              count += rows.length;
            }
            for (const [turnItemId, updatedAt, payload] of itemUpdates) {
              const rows = yield* sql<{ readonly turn_item_id: string }>`
                UPDATE orchestration_v2_projection_turn_items SET payload_json = ${payload}
                WHERE turn_item_id = ${turnItemId} AND thread_id = ${threadId}
                  AND updated_at = ${updatedAt}
                RETURNING turn_item_id
              `;
              count += rows.length;
            }
            return count;
          }),
        );
        if (updated < updates.length + itemUpdates.length) return false;
        strippedItemCount += itemUpdates.length;
      }
      yield* pace;
    }
    return true;
  });

  // The thread's own finished subagent records keep what their items keep. One still owed to its
  // parent (an undelivered completion, a Stop's pause), or whose child thread lives in another
  // environment so its record is the only local answer, keeps its prompt and result.
  const stripSubagents = Effect.fn("ProjectionMaintenance.expireThreadDetail.subagents")(function* (
    threadId: string,
    settledAt: string,
  ) {
    const listed = yield* sql<{ readonly row_id: number; readonly bytes: number }>`
      SELECT rowid AS row_id, octet_length(payload_json) AS bytes
      FROM orchestration_v2_projection_subagents
        INDEXED BY orchestration_v2_projection_subagents_settled_idx
      WHERE thread_id = ${threadId}
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND IFNULL(completion_delivery_state, '') NOT IN ('pending', 'claimed')
        AND child_thread_id IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    for (const group of byBudget(listed)) {
      const rows = yield* sql<{
        readonly subagent_id: string;
        readonly updated_at: string;
        readonly payload_json: string;
      }>`
        SELECT subagent_id, updated_at, payload_json
        FROM orchestration_v2_projection_subagents
        WHERE rowid IN ${sql.in(group.map((row) => row.row_id))}
      `.pipe(NodeSqliteClient.readOnly);
      const updates: Array<readonly [subagentId: string, updatedAt: string, payload: string]> = [];
      for (const row of rows) {
        const subagent = yield* decodeSubagent(row.payload_json).pipe(Effect.option);
        if (
          Option.isNone(subagent) ||
          subagent.value.pausedByParentStop === true ||
          subagent.value.childThreadId === null
        ) {
          continue;
        }
        const expired = expireSubagentRecordDetail(subagent.value, removed);
        if (expired === undefined) continue;
        const payload = yield* encodeSubagent(expired);
        updates.push([row.subagent_id, row.updated_at, payload]);
        removedItemBytes += Buffer.byteLength(row.payload_json) - Buffer.byteLength(payload);
        yield* Effect.yieldNow;
      }
      if (updates.length > 0) {
        const updated = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [guard] = yield* sql<{ readonly eligible: number }>`
              SELECT ${stillEligible(threadId, settledAt)} AS eligible
            `;
            if (guard?.eligible !== 1) return 0;
            let count = 0;
            for (const [subagentId, updatedAt, payload] of updates) {
              const rows = yield* sql<{ readonly subagent_id: string }>`
                UPDATE orchestration_v2_projection_subagents SET payload_json = ${payload}
                WHERE subagent_id = ${subagentId} AND thread_id = ${threadId}
                  AND updated_at = ${updatedAt}
                RETURNING subagent_id
              `;
              count += rows.length;
            }
            return count;
          }),
        );
        if (updated < updates.length) return false;
      }
      yield* pace;
    }
    return true;
  });

  // Snapshots already skip settled leaf nodes. A run with a superseded attempt keeps them: the
  // timeline finds an item's attempt through its node's root.
  const deleteLeafNodes = Effect.fn("ProjectionMaintenance.expireThreadDetail.nodes")(function* (
    threadId: string,
    settledAt: string,
  ) {
    while (true) {
      const deleted = yield* sql<{ readonly node_id: string }>`
        DELETE FROM orchestration_v2_projection_nodes
        WHERE rowid IN (
          SELECT rowid FROM orchestration_v2_projection_nodes
            INDEXED BY orchestration_v2_projection_nodes_settled_leaf_idx
          WHERE thread_id = ${threadId}
            AND (kind IN ('tool_call', 'assistant_message', 'reasoning')
              AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
              AND run_id IS NOT NULL) = 1
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_run_attempts AS attempt
              WHERE attempt.run_id = orchestration_v2_projection_nodes.run_id
                AND attempt.status = 'superseded'
            )
          LIMIT ${NODE_BATCH_SIZE}
        )
          AND ${stillEligible(threadId, settledAt)}
        RETURNING node_id
      `;
      deletedNodeCount += deleted.length;
      yield* pace;
      if (deleted.length < NODE_BATCH_SIZE) return true;
    }
  });

  // The log keeps the thread's newest event (cursors and stream versions) and any prompt anchor
  // it names, `thread.created` (verification and the legacy importer) and each attempt's first
  // `running` run update (Codex usage history). Command-id events go: a retry is refused instead.
  const deleteEvents = Effect.fn("ProjectionMaintenance.expireThreadDetail.events")(function* (
    threadId: string,
    settledAt: string,
    newest: { readonly sequence: number; readonly anchor: number | null },
  ) {
    const runningAttempts = new Set<string>();
    let afterSequence = 0;
    while (true) {
      const rows = yield* sql<{
        readonly sequence: number;
        readonly event_type: string;
        readonly bytes: number;
        readonly running_attempt: string | null;
      }>`
        SELECT sequence, event_type, octet_length(payload_json) AS bytes,
          CASE WHEN event_type = 'run.updated'
            AND json_extract(payload_json, '$.status') = 'running'
          THEN json_array(json_extract(payload_json, '$.id'),
            json_extract(payload_json, '$.activeAttemptId'))
          END AS running_attempt
        FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence > ${afterSequence} AND sequence < ${newest.sequence}
        ORDER BY sequence LIMIT ${LIST_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);
      const obsolete = rows.filter((row) => {
        if (row.event_type === "thread.created" || row.sequence === newest.anchor) return false;
        if (row.running_attempt === null) return true;
        if (runningAttempts.has(row.running_attempt)) return true;
        runningAttempts.add(row.running_attempt);
        return false;
      });
      yield* Effect.yieldNow;
      for (const batch of byBudget(obsolete)) {
        const through = Math.max(...batch.map((row) => row.sequence));
        // The boundary is published before the rows go, so a client resuming meanwhile sees it.
        yield* sql`
          INSERT INTO orchestration_v2_event_prune_marks (thread_id, pruned_through_sequence)
          VALUES (${threadId}, ${through})
          ON CONFLICT (thread_id) DO UPDATE SET pruned_through_sequence =
            MAX(pruned_through_sequence, excluded.pruned_through_sequence)
        `;
        const deleted = yield* sql<{ readonly sequence: number }>`
          DELETE FROM orchestration_events
          WHERE sequence IN ${sql.in(batch.map((row) => row.sequence))}
            AND stream_id = ${threadId}
            AND ${stillEligible(threadId, settledAt)}
          RETURNING sequence
        `;
        deletedEventCount += deleted.length;
        if (deleted.length < batch.length) return false;
        yield* pace;
      }
      afterSequence = rows.at(-1)?.sequence ?? afterSequence;
      if (rows.length < LIST_PAGE_SIZE) return true;
    }
  });

  let afterThreadId = "";
  while (true) {
    // The eligibility check costs about a millisecond a thread, so each statement judges one page
    // of threads; a single scan held the reader for seconds once most threads had expired.
    const page = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id > ${afterThreadId}
      ORDER BY thread_id LIMIT ${THREAD_PAGE_SIZE}
    `.pipe(NodeSqliteClient.readOnly);
    const candidates =
      page.length === 0
        ? []
        : yield* sql<{ readonly thread_id: string; readonly settled_at: string }>`
            SELECT candidate.thread_id,
              json_extract(candidate.payload_json, '$.settledAt') AS settled_at
            FROM orchestration_v2_projection_threads AS candidate
            WHERE candidate.thread_id IN ${sql.in(page.map((row) => row.thread_id))}
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_thread_detail_expiry AS expiry
                WHERE expiry.thread_id = candidate.thread_id
                  AND expiry.settled_at = json_extract(candidate.payload_json, '$.settledAt')
              )
              AND ${eligible}
            ORDER BY candidate.thread_id
          `.pipe(NodeSqliteClient.readOnly);
    yield* pace;
    for (const { thread_id: threadId, settled_at: settledAt } of candidates) {
      if (!(yield* stripItems(threadId, settledAt))) continue;
      if (!(yield* stripHandoffs(threadId, settledAt))) continue;
      if (!(yield* stripSubagents(threadId, settledAt))) continue;
      if (!(yield* deleteLeafNodes(threadId, settledAt))) continue;
      const newestRows = yield* sql<{
        readonly sequence: number;
        readonly anchor: number | null;
      }>`
        SELECT sequence, json_extract(payload_json, '$.promptSequence') AS anchor
        FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
        ORDER BY sequence DESC LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
      const newest = newestRows[0] ?? { sequence: 0, anchor: null };
      // Recorded before the log shrinks, so a retry meanwhile is refused rather than answered
      // empty; settled_at is filled in only once the thread is done.
      const recorded = yield* sql<{ readonly thread_id: string }>`
        INSERT INTO orchestration_v2_thread_detail_expiry (
          thread_id, settled_at, expired_at, expired_through_sequence
        )
        SELECT ${threadId}, NULL, ${removed.at}, ${newest.sequence}
        WHERE ${stillEligible(threadId, settledAt)}
        ON CONFLICT (thread_id) DO UPDATE SET
          settled_at = NULL,
          expired_at = excluded.expired_at,
          expired_through_sequence =
            MAX(expired_through_sequence, excluded.expired_through_sequence)
        RETURNING thread_id
      `;
      if (recorded.length === 0) continue;
      if (!(yield* deleteEvents(threadId, settledAt, newest))) continue;
      yield* sql`
        UPDATE orchestration_v2_thread_detail_expiry SET settled_at = ${settledAt}
        WHERE thread_id = ${threadId}
      `;
      expiredThreadCount += 1;
    }
    if (page.length < THREAD_PAGE_SIZE) break;
    afterThreadId = page.at(-1)?.thread_id ?? afterThreadId;
  }

  return {
    expiredThreadCount,
    strippedItemCount,
    removedItemBytes,
    deletedNodeCount,
    deletedEventCount,
  } satisfies ThreadDetailExpiryResult;
});
