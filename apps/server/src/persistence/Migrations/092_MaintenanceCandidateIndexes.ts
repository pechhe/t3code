import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_events_compactable_sequence_idx
    ON orchestration_events(sequence)
    -- Fixed at this migration: compaction reads the index by name, so a change to
    -- compactionCandidates.ts's event types needs a new index and fails its tests until then.
    WHERE (
      (application_event_version = 1 AND aggregate_kind = 'thread')
      OR (application_event_version = 2 AND event_type IN (
        'thread.archived',
        'thread.unarchived',
        'thread.settled',
        'thread.unsettled',
        'thread.snoozed',
        'thread.unsnoozed',
        'thread.pinned',
        'thread.auto-settle-set',
        'thread.rollover-hold-set',
        'thread.rollover-thresholds-set',
        'thread.compact-at-set',
        'thread.unpinned',
        'thread.pin-reordered',
        'thread.active-reordered',
        'thread.metadata-updated',
        'thread.pull-request-synced',
        'thread.runtime-mode-updated',
        'thread.interaction-mode-updated',
        'thread.model-selection-updated',
        'thread.provider-switched',
        'thread.guest-share-updated',
        'thread.visited',
        'thread.marked-unread',
        'thread.pull-request-link-updated',
        'message.updated',
        'node.updated'
      ))
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_runs_latest_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
      AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
  `;
});
