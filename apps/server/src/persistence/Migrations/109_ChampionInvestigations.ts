import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champion_execution_attempts (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), check_id TEXT NOT NULL, at TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champion_execution_history ON champion_execution_attempts(champion_id, at DESC, id DESC)`;
  yield* sql`CREATE TABLE champion_investigations (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), finding_id TEXT NOT NULL, finding_attempt_id TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE UNIQUE INDEX champion_open_investigation ON champion_investigations(champion_id, finding_id) WHERE status IN ('open', 'cancel_requested')`;
  yield* sql`CREATE TABLE champion_branch_attempts (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES champion_investigations(id), champion_id TEXT NOT NULL REFERENCES champions(id), branch_id TEXT NOT NULL, request_id TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, document_json TEXT NOT NULL, UNIQUE(champion_id, request_id))`;
  yield* sql`CREATE INDEX champion_branch_capacity ON champion_branch_attempts(champion_id, state)`;
  yield* sql`CREATE INDEX champion_branch_budget ON champion_branch_attempts(champion_id, at)`;
  yield* sql`CREATE TABLE champion_cancel_intents (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES champion_investigations(id), attempt_id TEXT NOT NULL REFERENCES champion_branch_attempts(id), document_json TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE champion_recommendations (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), investigation_id TEXT NOT NULL REFERENCES champion_investigations(id), at TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champion_recommendation_history ON champion_recommendations(champion_id, at DESC, id DESC)`;
  yield* sql`CREATE TABLE champion_learning_revisions (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), learning_id TEXT NOT NULL, topic TEXT NOT NULL, at TEXT NOT NULL, review_at TEXT, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champion_learning_topic ON champion_learning_revisions(champion_id, topic, id)`;
  yield* sql`CREATE TABLE champion_learning_heads (champion_id TEXT NOT NULL REFERENCES champions(id), learning_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES champion_learning_revisions(id), PRIMARY KEY(champion_id, learning_id))`;
  yield* sql`CREATE TABLE champion_learning_receipts (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), topic TEXT NOT NULL, at TEXT NOT NULL, document_json TEXT NOT NULL)`;
});
