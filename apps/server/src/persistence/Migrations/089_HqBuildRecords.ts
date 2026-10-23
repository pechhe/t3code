import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a thread's agent owes Weave's Build record, queued rather than sent from the turn that
  // produced it (Spec #4395). Ending an agent replaces its identity, and a turn or a restart can
  // overtake the call, so a row is kept until Weave takes it: `status` is `pending` until then,
  // `delivered` once accepted, and `parked` when Weave refused it for a reason a retry cannot
  // change. `result_json` holds Weave's answer, such as the session a lead's row opened, which a
  // later row names as its parent.
  yield* sql`CREATE TABLE hq_build_records (
    record_key TEXT PRIMARY KEY,
    origin TEXT,
    spec_id TEXT,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  )`;
  yield* sql`CREATE INDEX idx_hq_build_records_due
    ON hq_build_records(status, next_attempt_at, created_at)`;
  yield* sql`CREATE INDEX idx_hq_build_records_thread
    ON hq_build_records(thread_id, created_at)`;
  // A reviewer's own run, recorded from the answer Weave gave T3's proxy: the run id reaches T3
  // nowhere else, and it is what its run times are recorded against once the reviewer's agent has
  // gone. Kept here, rather than in memory, so a restart between the run and its record loses none.
  // `t3_run_id` is the T3 run the reviewer reported it in, which is what that run's own usage names.
  yield* sql`CREATE TABLE hq_build_reviewer_runs (
    reviewer_thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    t3_run_id TEXT,
    spec_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (reviewer_thread_id, run_id)
  )`;
});
