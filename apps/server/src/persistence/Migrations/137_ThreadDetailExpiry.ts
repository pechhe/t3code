import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per thread whose detail expired. settled_at names the settling the expiry finished
// under (null while it runs), so a thread settled again later expires again; a command retry
// whose result sequence is at or below expired_through_sequence lost its events to it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_thread_detail_expiry (
      thread_id TEXT PRIMARY KEY,
      settled_at TEXT,
      expired_at TEXT NOT NULL,
      expired_through_sequence INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
});
