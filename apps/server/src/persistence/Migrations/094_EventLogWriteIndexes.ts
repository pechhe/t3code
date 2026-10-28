import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every event write maintains each event-log index; these two cost a page per event for nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No query filters on correlation_id; it is only read back with the row.
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  // Streamed events carry no command id; lookups by command id still imply IS NOT NULL.
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`
    CREATE INDEX idx_orch_events_command_id
    ON orchestration_events(command_id)
    WHERE command_id IS NOT NULL
  `;
});
