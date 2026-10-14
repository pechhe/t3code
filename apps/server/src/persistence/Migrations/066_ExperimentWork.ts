import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE experiment_work_units (
    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, work_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(owner_key, work_id)
  )`;
  yield* sql`CREATE TABLE experiment_work_allocations (
    id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES experiment_work_units(id), payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE experiment_work_evidence (
    id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES experiment_work_units(id),
    attribution_key TEXT UNIQUE, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE experiment_work_tasks (
    task_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES experiment_work_units(id),
    thread_id TEXT NOT NULL UNIQUE, binding_json TEXT NOT NULL,
    launch_state TEXT NOT NULL DEFAULT 'prepared' CHECK(launch_state IN ('prepared','accepted','refused','launch-unknown'))
  )`;
});
