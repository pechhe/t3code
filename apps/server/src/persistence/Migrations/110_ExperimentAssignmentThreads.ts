import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE experiment_assignment_threads (
    assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id),
    thread_id TEXT NOT NULL,
    PRIMARY KEY (assignment_id, thread_id)
  )`;
  yield* sql`CREATE INDEX experiment_assignments_unit_id ON experiment_assignments(unit_id)`;
  yield* sql`CREATE INDEX experiment_assignment_threads_thread_id ON experiment_assignment_threads(thread_id)`;
});
