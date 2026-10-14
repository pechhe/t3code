import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE experiments (
    id TEXT PRIMARY KEY, definition_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','running','paused','stopped')),
    created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE experiment_assignments (
    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
    unit_kind TEXT NOT NULL, unit_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    stratum TEXT NOT NULL, variant_id TEXT NOT NULL, assignment_method TEXT NOT NULL,
    payload_json TEXT NOT NULL, UNIQUE(experiment_id, unit_kind, unit_id)
  )`;
  yield* sql`CREATE INDEX experiment_assignments_thread_idx ON experiment_assignments(thread_id)`;
  yield* sql`CREATE INDEX experiment_assignments_balance_idx ON experiment_assignments(experiment_id, assignment_method, stratum, variant_id)`;
  yield* sql`CREATE TABLE experiment_outcomes (
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id), payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX experiment_outcomes_assignment_idx ON experiment_outcomes(assignment_id)`;
  yield* sql`CREATE TABLE experiment_observations (
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id), payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX experiment_observations_assignment_idx ON experiment_observations(assignment_id)`;
});
