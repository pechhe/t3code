import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE external_agent_sessions (
    session_key TEXT PRIMARY KEY, client_session_id TEXT NOT NULL,
    external_session_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    UNIQUE(client_session_id, external_session_id)
  )`;
  yield* sql`CREATE TABLE external_agent_work (
    task_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES external_agent_sessions(session_key),
    work_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','accepted','cancelled','launch-unknown','refused')),
    failure_reason TEXT, UNIQUE(session_key, work_id, attempt_id), UNIQUE(session_key, request_id)
  )`;
});
