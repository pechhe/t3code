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

// Must stay equivalent to orchestration_events_compactable_sequence_idx's predicate (migration 093),
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
      ]
        .map((type) => `'${type}'`)
        .join(", ")}
    )))
`);
