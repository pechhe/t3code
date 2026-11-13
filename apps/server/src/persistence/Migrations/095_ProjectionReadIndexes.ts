import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Watch reactors address the watching index by name; migration 129 replaces the original type-index keys.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // ProjectionStore.readCanonicalProjection's turn-item type filter.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, ordinal, turn_item_id)
  `;
  // The landing, thread and Forge watch reactors' sweep; few threads hold a watch.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_watching_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND json_array_length(payload_json, '$.threadWatches') > 0
  `;
});
