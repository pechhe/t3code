import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const PROJECT_COLUMNS = [
  ["hq_repository_key", "weave_repository_key"],
  ["hq_sync_local_only", "weave_sync_local_only"],
  ["hq_synced_revision", "weave_synced_revision"],
  ["hq_synced_value_hash", "weave_synced_value_hash"],
  ["hq_unregistered_key", "weave_unregistered_key"],
] as const;

const EVENT_FIELDS = [
  ["hqRepositoryKey", "weaveRepositoryKey"],
  ["hqSyncLocalOnly", "weaveSyncLocalOnly"],
  ["hqSyncedRevision", "weaveSyncedRevision"],
  ["hqSyncedValueHash", "weaveSyncedValueHash"],
  ["hqUnregisteredKey", "weaveUnregisteredKey"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const [from, to] of PROJECT_COLUMNS) {
    yield* sql.unsafe(`ALTER TABLE projection_projects RENAME COLUMN ${from} TO ${to}`);
  }
  yield* sql`ALTER TABLE build_send_back_deliveries RENAME COLUMN hq_origin TO weave_origin`;

  yield* sql`DROP INDEX idx_hq_build_records_due`;
  yield* sql`DROP INDEX idx_hq_build_records_thread`;
  yield* sql`ALTER TABLE hq_build_records RENAME TO weave_forge_records`;
  yield* sql`CREATE INDEX idx_weave_forge_records_due
    ON weave_forge_records(status, next_attempt_at, created_at)`;
  yield* sql`CREATE INDEX idx_weave_forge_records_thread
    ON weave_forge_records(thread_id, created_at)`;
  yield* sql`ALTER TABLE hq_build_reviewer_runs RENAME TO weave_forge_reviewer_runs`;

  // Projects read these fields back from stored events, which decode by the current names.
  // json() keeps each value's JSON type: a null means "clear", and json_extract would turn true into 1.
  for (const [from, to] of EVENT_FIELDS) {
    yield* sql.unsafe(`
      UPDATE orchestration_events
      SET payload_json = json_remove(
        json_set(payload_json, '$.${to}', json(payload_json -> '$.${from}')),
        '$.${from}'
      )
      WHERE event_type = 'project.meta-updated'
        AND json_type(payload_json, '$.${from}') IS NOT NULL
    `);
  }
});
