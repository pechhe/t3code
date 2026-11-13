import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champion_measurements (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), check_id TEXT NOT NULL, role TEXT NOT NULL, request_id TEXT, at TEXT NOT NULL, admitted_at TEXT, state TEXT NOT NULL, document_json TEXT NOT NULL, UNIQUE(champion_id, request_id))`;
  yield* sql`CREATE INDEX champion_measurement_check ON champion_measurements(check_id)`;
  yield* sql`CREATE INDEX champion_measurement_capacity ON champion_measurements(champion_id, state)`;
  yield* sql`CREATE INDEX champion_measurement_budget ON champion_measurements(champion_id, admitted_at)`;
});
