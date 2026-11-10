import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Read by name (INDEXED BY) in parkedWait.ts; few threads park.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_parked_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND json_array_length(payload_json, '$.parkedWaits') > 0
  `;
});
