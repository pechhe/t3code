import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit recovery scans every thread's failures; keep this predicate identical to
  // ProjectionStore's filter. json_valid keeps a malformed payload writable, so this replaces
  // the fork's unguarded migration-092 index for the same lookup.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_turn_items_usage_limit_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.class') = 'usage_limit'
        ELSE 0 END
  `;
});
