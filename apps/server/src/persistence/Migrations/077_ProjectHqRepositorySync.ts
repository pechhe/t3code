import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN hq_repository_key TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN hq_sync_local_only INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN hq_synced_revision INTEGER`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN hq_synced_value_hash TEXT`;
});
