import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX orchestration_events_compactable_sequence_idx`;
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
        'node.updated',
        'turn-item.updated',
        'provider-turn.updated'
      ))
    )
  `;
  // ProjectionMaintenance's settled-thread check reads these two by name (INDEXED BY), so its
  // status lists must stay equivalent to their predicates; a drift fails with "no query solution".
  yield* sql`
    CREATE INDEX orchestration_v2_turn_items_active_thread_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE status IN ('pending', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_provider_turns_active_thread_idx
    ON orchestration_v2_projection_provider_turns(thread_id)
    WHERE status IN ('pending', 'running')
  `;
});
