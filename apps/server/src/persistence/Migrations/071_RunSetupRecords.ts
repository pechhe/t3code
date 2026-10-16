import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One observed setup per run; the record is evidence, so later captures never replace it.
  yield* sql`CREATE TABLE run_setup_records (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX run_setup_records_thread ON run_setup_records(thread_id, captured_at)`;
});
