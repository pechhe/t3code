import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per bounded browser task call: no page content, typed values, logins or URLs.
  yield* sql`CREATE TABLE browser_task_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    harness TEXT NOT NULL,
    mode TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    fault TEXT,
    decisions INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    replayed INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX browser_task_calls_recorded_idx ON browser_task_calls(recorded_at)`;
});
