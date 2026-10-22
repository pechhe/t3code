import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A task now names a subagent role instead of a model, so editing that role's policy reaches
// every task. Tasks saved before roles keep their stored model as the fallback for a machine
// whose policy cannot resolve the role, so their runs only move once the role resolves.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET agent_role = 'implementation-worker'
    WHERE agent_role IS NULL
  `;
});
