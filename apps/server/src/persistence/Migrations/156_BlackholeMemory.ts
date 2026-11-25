import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Blackhole's observational memory for every thread: the ledger records pi-blackhole would
 * append to a Pi session, each anchored after the turn item it was written at.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS blackhole_memory_records (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      anchor_item_id TEXT NOT NULL,
      custom_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, seq)
    )
  `;
});
