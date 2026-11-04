import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champions_project ON champions(project_id)`;
  yield* sql`CREATE TABLE champion_checks (
    id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id),
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL,
    status TEXT NOT NULL, document_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX champion_checks_history ON champion_checks(champion_id, started_at DESC)`;
  yield* sql`CREATE UNIQUE INDEX champion_one_outstanding ON champion_checks(champion_id, thread_id) WHERE status = 'pending'`;
  yield* sql`CREATE TABLE champion_repair_claims (
    work_id TEXT NOT NULL, attempt_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
    role TEXT NOT NULL, PRIMARY KEY(work_id, attempt_id)
  )`;
  yield* sql`CREATE TABLE champion_metric_definitions (
    champion_id TEXT NOT NULL REFERENCES champions(id), metric_id TEXT NOT NULL,
    version INTEGER NOT NULL, created_at TEXT NOT NULL, document_json TEXT NOT NULL,
    PRIMARY KEY(champion_id, metric_id, version)
  )`;
  yield* sql`CREATE TABLE champion_activity (
    id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), document_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX champion_activity_history ON champion_activity(champion_id, id DESC)`;
});
