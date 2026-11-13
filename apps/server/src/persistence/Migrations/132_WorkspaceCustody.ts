import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_custody (id TEXT PRIMARY KEY, owner_ref TEXT NOT NULL UNIQUE, document_json TEXT NOT NULL)`;
});
