import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("gives tasks saved before roles the default role and keeps their model fallback", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    const insert = (id: string, agentRole: string | null) => sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count, agent_role
      ) VALUES (
        ${id}, ${id}, 'Audit', 0, '{"type":"interval","everyMs":60000}', 'project-1', NULL,
        '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
        'agent', 'mcp', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'never', 0,
        ${agentRole}
      )
    `;
    yield* insert("legacy", null);
    yield* insert("chosen", "chore-worker");
    yield* runMigrations();
    const rows = yield* sql<{
      readonly task_id: string;
      readonly agent_role: string;
      readonly model_selection_json: string;
    }>`
      SELECT task_id, agent_role, model_selection_json FROM scheduled_tasks ORDER BY task_id
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.task_id, row.agent_role, row.model_selection_json]),
      [
        ["chosen", "chore-worker", '{"instanceId":"codex","model":"gpt-5"}'],
        ["legacy", "implementation-worker", '{"instanceId":"codex","model":"gpt-5"}'],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
