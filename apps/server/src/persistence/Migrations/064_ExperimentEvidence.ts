import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE experiment_evidence (
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id),
    episode_id TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX experiment_evidence_assignment_idx ON experiment_evidence(assignment_id, episode_id)`;
  yield* sql`CREATE TABLE experiment_evaluations (
    id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id),
    episode_id TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX experiment_evaluations_assignment_idx ON experiment_evaluations(assignment_id, episode_id)`;
});
