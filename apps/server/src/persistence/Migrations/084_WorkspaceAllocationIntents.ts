import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_allocation_intents (
      attempt_id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      detail TEXT
    )
  `;
});
