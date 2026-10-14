import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A conversation can now own several consultation tasks; request and attempt identities stay unique.
  yield* sql`CREATE TABLE external_agent_work_consultations (
    task_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES external_agent_sessions(session_key),
    work_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','accepted','cancelled','launch-unknown','refused')),
    failure_reason TEXT, UNIQUE(session_key, work_id, attempt_id), UNIQUE(session_key, request_id)
  )`;
  yield* sql`INSERT INTO external_agent_work_consultations SELECT * FROM external_agent_work`;
  yield* sql`DROP TABLE external_agent_work`;
  yield* sql`ALTER TABLE external_agent_work_consultations RENAME TO external_agent_work`;
  yield* sql`CREATE INDEX external_agent_work_thread ON external_agent_work(thread_id)`;
});
