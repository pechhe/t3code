import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("157_ScheduledTaskChampion", (it) => {
  it.effect("leaves existing tasks without a Champion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 156 });
      yield* sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count
        ) VALUES (
          'task:1', 'T', 'P', 1, '{}', 'project:1', '{}', '{}', 'full-access', 'default',
          'user', 'web', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', 'never', 0
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 157 });
      const rows = yield* sql<{ readonly champion_id: string | null }>`
        SELECT champion_id FROM scheduled_tasks
      `;
      assert.deepEqual(rows, [{ champion_id: null }]);
    }),
  );
});
