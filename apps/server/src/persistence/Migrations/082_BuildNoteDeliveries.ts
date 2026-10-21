import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing rows retain the legacy send-back path until their recording HQ supports claims.
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'send_back'`;
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN spec_project TEXT`;
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN spec_number INTEGER`;
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN delivered_thread_id TEXT`;
});
