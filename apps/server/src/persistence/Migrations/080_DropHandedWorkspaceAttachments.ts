import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A move used to fork the chat and mark the source's attachments `movedTo` the fork. Moves now
// happen in place, so those entries would read as workspaces the archived source still holds.
const withoutHanded = `json_set(payload_json, '$.workspaceAttachments', (
  SELECT json_group_array(json(value)) FROM json_each(payload_json, '$.workspaceAttachments')
  WHERE json_type(value, '$.movedTo') IS NULL
))`;
const hasHanded = `EXISTS (
  SELECT 1 FROM json_each(payload_json, '$.workspaceAttachments')
  WHERE json_type(value, '$.movedTo') IS NOT NULL
)`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = ${withoutHanded}
    WHERE json_type(payload_json, '$.workspaceAttachments') = 'array' AND ${hasHanded}
  `);
  // The source events too, so rebuilding projections cannot restore them.
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = ${withoutHanded}
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND json_type(payload_json, '$.workspaceAttachments') = 'array' AND ${hasHanded}
  `);
});
