import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread's own compact-at point. Threads that dragged a context-rollover band keep its hard
 * point, in the column and in the stored thread the projection reads. The old rollover fields
 * stay in the stored JSON, unread. The point is not held to the provider's bounds here, since the
 * model is unknown; clients and the Claude adapter clamp it where they use it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_threads)
  `;
  if (!columns.some((column) => column.name === "compact_at")) {
    yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN compact_at INTEGER`;
  }
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET compact_at = CAST(json_extract(payload_json, '$.rolloverThresholds.hard') AS INTEGER),
        payload_json = json_set(
          payload_json,
          '$.compactAt',
          CAST(json_extract(payload_json, '$.rolloverThresholds.hard') AS INTEGER)
        )
    WHERE compact_at IS NULL
      AND json_type(payload_json, '$.rolloverThresholds.hard') = 'integer'
      AND json_extract(payload_json, '$.rolloverThresholds.hard') > 0
  `;
  // Every thread event stores the whole thread, so the source events get the point too, and
  // rebuilding projections cannot drop it.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.compactAt',
      CAST(json_extract(payload_json, '$.rolloverThresholds.hard') AS INTEGER)
    )
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND event_type LIKE 'thread.%'
      AND json_type(payload_json, '$.compactAt') IS NULL
      AND json_type(payload_json, '$.rolloverThresholds.hard') = 'integer'
      AND json_extract(payload_json, '$.rolloverThresholds.hard') > 0
  `;
});
