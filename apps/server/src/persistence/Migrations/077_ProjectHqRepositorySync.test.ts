import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades existing projects with safe HQ defaults and preserves their icons", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 76 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, project_icon_json, created_at, updated_at)
    VALUES ('existing', 'Existing', '/work/existing', '[]', '{"kind":"emoji","emoji":"🦊"}', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z')`;
    yield* runMigrations();
    const rows =
      yield* sql`SELECT hq_repository_key, hq_sync_local_only, hq_synced_revision, hq_synced_value_hash, project_icon_json FROM projection_projects WHERE project_id = 'existing'`;
    assert.deepEqual(rows, [
      {
        hq_repository_key: null,
        hq_sync_local_only: 0,
        hq_synced_revision: null,
        hq_synced_value_hash: null,
        project_icon_json: '{"kind":"emoji","emoji":"🦊"}',
      },
    ]);
    yield* runMigrations();
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
