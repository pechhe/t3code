import type * as SqlClient from "effect/sql/SqlClient";

// Keep thread.created as the verification and replay anchor; clients recognize deletion by thread.deleted event type.
export const SUPERSEDABLE_THREAD_EVENT_TYPES = [
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.rollover-hold-set",
  "thread.rollover-thresholds-set",
  "thread.compact-at-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "thread.guest-share-updated",
];
// Read-state events preserve updatedAt and supersede only each other. Activity events supersede both groups.
export const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];

// Must stay equivalent to orchestration_events_compactable_sequence_idx's predicate (migration 136),
// which compaction reads by name: changing these types needs a new index.
export const compactableEventCondition = (sql: SqlClient.SqlClient) =>
  sql.literal(`
  ((application_event_version = 1 AND aggregate_kind = 'thread')
    OR (application_event_version = 2 AND event_type IN (
      ${[
        ...SUPERSEDABLE_THREAD_EVENT_TYPES,
        ...READ_STATE_THREAD_EVENT_TYPES,
        "thread.pull-request-link-updated",
        "message.updated",
        "node.updated",
        "turn-item.updated",
        "provider-turn.updated",
        "provider-session.updated",
      ]
        .map((type) => `'${type}'`)
        .join(", ")}
    )))
`);

/** The thread named by `threadId` (a column) is settled and nothing in it is still working. */
export const settledWithoutActiveWorkOf = (sql: SqlClient.SqlClient, threadId: string) =>
  sql.literal(`
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = ${threadId}
          AND json_extract(thread.payload_json, '$.settledOverride') IS NOT 'active'
          AND (json_extract(thread.payload_json, '$.settledAt') IS NOT NULL
            OR json_extract(thread.payload_json, '$.settledOverride') = 'settled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = ${threadId} AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_turns AS turn
          INDEXED BY orchestration_v2_provider_turns_active_thread_idx
        WHERE turn.thread_id = ${threadId} AND turn.status IN ('pending', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
          INDEXED BY orchestration_v2_turn_items_active_thread_idx
        WHERE item.thread_id = ${threadId} AND item.status IN ('pending', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
        WHERE request.thread_id = ${threadId} AND request.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
        WHERE subagent.thread_id = ${threadId} AND subagent.status IN ('pending', 'running', 'waiting')
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider_thread
        WHERE provider_thread.thread_id = ${threadId}
          AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
      )
    `);

export const pinnedThreadOf = (sql: SqlClient.SqlClient, threadId: string) =>
  sql.literal(`
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS pinned_thread
        WHERE pinned_thread.thread_id = ${threadId}
          AND json_extract(pinned_thread.payload_json, '$.pinnedAt') IS NOT NULL
      )
    `);
