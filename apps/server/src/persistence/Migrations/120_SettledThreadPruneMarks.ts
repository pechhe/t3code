import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A settled thread's removed events are scattered through the log, so the boundary a
// reconnecting client is checked against is kept per thread, not as one log-wide sequence.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_event_prune_marks (
      thread_id TEXT PRIMARY KEY,
      pruned_through_sequence INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
});
