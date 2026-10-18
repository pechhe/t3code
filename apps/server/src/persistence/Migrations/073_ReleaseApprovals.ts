import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The approval itself, owned by ReleaseApprovals. Each requesting thread shows it through a
  // `release_approval_request` turn item; this table is what dedupes cards and keeps approvals.
  yield* sql`CREATE TABLE release_approvals (
    approval_id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    candidate TEXT NOT NULL,
    base TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL,
    answer_json TEXT,
    superseded_by TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX release_approvals_repository_idx ON release_approvals(repository, status)`;
  yield* sql`CREATE TABLE release_approval_requesters (
    approval_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    PRIMARY KEY(approval_id, thread_id)
  )`;
  // Every thread shell looks for its open release card; this keeps that lookup off the
  // thread's whole turn history.
  yield* sql`CREATE INDEX release_approval_cards_waiting_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at)
    WHERE type = 'release_approval_request' AND status = 'waiting'`;
});
