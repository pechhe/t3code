import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workspace_custody_active ON workspace_custody (id)
    WHERE json_extract(document_json, '$.phase') != 'released'
  `;
});
