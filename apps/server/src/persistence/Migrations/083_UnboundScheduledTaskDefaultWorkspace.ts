import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// An agent-created unbound task used to store `worktree` from `main` with `startFromOrigin`,
// which fails in any project without a `main` branch. It now stores the default a new thread
// starts with. Tasks a person created (the mobile app writes the same default), configured
// differently, or that carry a branch or Build item, keep their strategy, and the task id and webhook stay as they are.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE scheduled_tasks
    SET workspace_strategy_json = '{"type":"root","rootIsDefault":true}'
    WHERE thread_id IS NULL
      AND created_by = 'agent'
      AND json_extract(workspace_strategy_json, '$.type') = 'worktree'
      AND json_extract(workspace_strategy_json, '$.baseRef') = 'main'
      AND json_extract(workspace_strategy_json, '$.startFromOrigin') = 1
      AND json_type(workspace_strategy_json, '$.branch') IS NULL
      AND json_type(workspace_strategy_json, '$.forgeItem') IS NULL
  `;
});
