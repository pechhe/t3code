import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Read by name (INDEXED BY) by the Arc run sweep; few threads ever hold a run.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_arc_run_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.arcRun') IS NOT NULL
  `;
});
