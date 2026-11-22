import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Read by name (INDEXED BY) by the autonomous-run sweep; few threads ever hold a run.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_autonomous_run_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.autonomousRun') IS NOT NULL
        ELSE 0 END
  `;
});
