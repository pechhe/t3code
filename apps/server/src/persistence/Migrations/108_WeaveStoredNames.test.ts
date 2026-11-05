import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("108_WeaveStoredNames", (it) => {
  it.effect("moves every stored Weave name and keeps its values and JSON types", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          hq_repository_key, hq_sync_local_only, hq_synced_revision, hq_synced_value_hash,
          hq_unregistered_key
        ) VALUES (
          'project-1', 'YardSmith', '/repo', '[]', 'at', 'at',
          'pechhe/yardsmith', 1, 7, 'hash', 'pechhe/unlisted'
        )
      `;
      yield* sql`
        INSERT INTO hq_build_records (
          record_key, thread_id, kind, payload_json, status, next_attempt_at, created_at
        ) VALUES ('record-1', 'thread-1', 'usage', '{}', 'pending', 1, 1)
      `;
      yield* sql`
        INSERT INTO hq_build_reviewer_runs (reviewer_thread_id, run_id, created_at)
        VALUES ('thread-1', 'run-1', 1)
      `;
      const insertEvent = (id: string, eventType: string, payload: unknown) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          ${id}, 'project', 'project-1', ${Number(id)}, ${eventType}, 'at',
          ${`command-${id}`}, 'client', ${JSON.stringify(payload)}, '{}'
        )
      `;
      yield* insertEvent("1", "project.meta-updated", {
        projectId: "project-1",
        updatedAt: "at",
        hqRepositoryKey: "pechhe/yardsmith",
        hqSyncLocalOnly: true,
        hqSyncedRevision: 7,
        hqSyncedValueHash: "hash",
        hqUnregisteredKey: null,
      });
      yield* insertEvent("2", "project.meta-updated", { projectId: "project-1", title: "Kept" });
      yield* insertEvent("3", "thread.message", {
        hqRepositoryKey: "a message about the old name",
      });

      yield* runMigrations({ toMigrationInclusive: 108 });

      const [project] = yield* sql<Record<string, unknown>>`
        SELECT weave_repository_key, weave_sync_local_only, weave_synced_revision,
          weave_synced_value_hash, weave_unregistered_key
        FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.deepStrictEqual(
        { ...project },
        {
          weave_repository_key: "pechhe/yardsmith",
          weave_sync_local_only: 1,
          weave_synced_revision: 7,
          weave_synced_value_hash: "hash",
          weave_unregistered_key: "pechhe/unlisted",
        },
      );
      assert.lengthOf(
        yield* sql`SELECT 1 FROM weave_forge_records WHERE record_key = 'record-1'`,
        1,
      );
      assert.lengthOf(
        yield* sql`SELECT 1 FROM weave_forge_reviewer_runs WHERE run_id = 'run-1'`,
        1,
      );
      assert.lengthOf(yield* sql`SELECT weave_origin FROM build_send_back_deliveries`, 0);

      const events = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_events ORDER BY stream_version
      `;
      assert.deepStrictEqual(JSON.parse(events[0]!.payload), {
        projectId: "project-1",
        updatedAt: "at",
        weaveRepositoryKey: "pechhe/yardsmith",
        weaveSyncLocalOnly: true,
        weaveSyncedRevision: 7,
        weaveSyncedValueHash: "hash",
        weaveUnregisteredKey: null,
      });
      assert.deepStrictEqual(JSON.parse(events[1]!.payload), {
        projectId: "project-1",
        title: "Kept",
      });
      assert.deepStrictEqual(JSON.parse(events[2]!.payload), {
        hqRepositoryKey: "a message about the old name",
      });

      const leftovers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name LIKE '%hq%' OR sql LIKE '%hq!_%' ESCAPE '!'
      `;
      assert.deepStrictEqual(leftovers, []);
    }),
  );
});
