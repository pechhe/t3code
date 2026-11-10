import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per managed delegation (T3-574): ids, role, models and the engine's pick. Never task text.
  yield* sql`CREATE TABLE delegation_model_shadow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    task_class TEXT NOT NULL,
    eligible_json TEXT NOT NULL,
    chosen_model TEXT NOT NULL,
    reassigned INTEGER NOT NULL,
    status TEXT NOT NULL,
    pick_model TEXT,
    probability REAL,
    confidence REAL,
    floor REAL NOT NULL,
    provider TEXT,
    error_code TEXT,
    latency_ms INTEGER,
    brief_chars INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX delegation_model_shadow_recorded_idx ON delegation_model_shadow(recorded_at)`;
});
