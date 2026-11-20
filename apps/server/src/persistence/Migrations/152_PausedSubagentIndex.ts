import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A new or resumed task looks up the tasks a Stop paused on its thread. Keep the predicate
  // identical to ProjectionStore's `pausedSubagents` filter; json_valid keeps a malformed
  // payload writable.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_paused_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pausedByParentStop') = 1 ELSE 0 END
  `;
});
