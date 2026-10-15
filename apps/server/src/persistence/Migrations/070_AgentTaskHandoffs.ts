import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The revision an isolated writer's run handed back, read once when the run ended.
  yield* sql`CREATE TABLE agent_task_handoffs (
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, revision TEXT,
    quiescent INTEGER NOT NULL, PRIMARY KEY(thread_id, run_id)
  )`;
});
