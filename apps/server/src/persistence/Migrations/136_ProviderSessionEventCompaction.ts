import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX orchestration_events_compactable_sequence_idx`;
  yield* sql`
    CREATE INDEX orchestration_events_compactable_sequence_idx
    ON orchestration_events(sequence)
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
        'provider-turn.updated',
        'provider-session.updated'
      ))
    )
  `;
});
