import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per `t3 browser run` run: no page content, scripts, URLs or logins.
  yield* sql`CREATE TABLE browser_script_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    harness TEXT NOT NULL,
    thread_id TEXT,
    project_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    tabs INTEGER NOT NULL,
    output_bytes INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX browser_script_runs_recorded_idx ON browser_script_runs(recorded_at)`;
});
