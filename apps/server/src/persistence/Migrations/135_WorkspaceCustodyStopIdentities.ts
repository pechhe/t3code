import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE workspace_custody SET document_json = json_set(document_json, '$.obligations', json(COALESCE((
    SELECT json_group_array(json_set(value, '$.stopProcesses', json('[]'), '$.stopIdentityUnknown', json('false')))
    FROM json_each(document_json, '$.obligations')
  ), '[]')))`;
});
