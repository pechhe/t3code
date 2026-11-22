import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// T3 no longer records anything in Weave's Forge for an agent (WV-71): agents reach Weave through
// Executor and record their own work there, so the queue of records owed and the reviewer runs it
// tracked go.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS weave_forge_records`;
  yield* sql`DROP TABLE IF EXISTS weave_forge_reviewer_runs`;
});
