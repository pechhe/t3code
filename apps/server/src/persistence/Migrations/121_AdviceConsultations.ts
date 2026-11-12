import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE advice_request_keys (
    worker_thread_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, destination TEXT NOT NULL,
    pending INTEGER NOT NULL DEFAULT 1, advisor_json TEXT,
    PRIMARY KEY(worker_thread_id, request_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX advice_request_keys_one_pending
    ON advice_request_keys(worker_thread_id) WHERE pending = 1`;
  yield* sql`CREATE TABLE advice_consultations (
    worker_thread_id TEXT NOT NULL, worker_run_id TEXT, request_id TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL, parent_environment_id TEXT, worker_environment_id TEXT,
    fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled')),
    request_delivered INTEGER NOT NULL DEFAULT 0,
    answer_delivered INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (worker_thread_id, request_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX advice_consultations_one_pending
    ON advice_consultations(worker_thread_id) WHERE status = 'pending'`;
  yield* sql`CREATE INDEX advice_consultations_completion_hold ON advice_consultations(worker_thread_id)
    WHERE worker_environment_id IS NULL AND (status = 'pending' OR (status = 'answered' AND answer_delivered = 0))
      AND json_extract(payload_json, '$.blocking') = 1`;
  yield* sql`CREATE INDEX advice_consultations_delivery
    ON advice_consultations(status, request_delivered, answer_delivered)`;
});
