import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const implicitDefault = { type: "worktree", baseRef: "main", startFromOrigin: true };

it.effect("repairs only the implicit main default of unbound scheduled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 82 });
    const insert = (
      id: string,
      threadId: string | null,
      strategy: object,
      createdBy = "agent",
    ) => sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count
      ) VALUES (
        ${id}, ${id}, 'Audit', 0, '{"type":"interval","everyMs":60000}', 'project-1', ${threadId},
        ${JSON.stringify(strategy)}, '{}', 'full-access', 'default',
        ${createdBy}, 'mcp', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'never', 0
      )
    `;
    yield* insert("implicit", null, implicitDefault);
    yield* insert("bound", "thread-1", implicitDefault);
    yield* insert("other-base", null, { ...implicitDefault, baseRef: "develop" });
    yield* insert("local-base", null, { type: "worktree", baseRef: "main" });
    yield* insert("branch", null, { ...implicitDefault, branch: "nightly" });
    yield* insert("build-item", null, { ...implicitDefault, forgeItem: 42 });
    yield* insert("checkout", null, { type: "root" });
    yield* insert("by-person", null, implicitDefault, "user");
    yield* runMigrations();
    const rows = yield* sql<{ readonly task_id: string; readonly workspace_strategy_json: string }>`
      SELECT task_id, workspace_strategy_json FROM scheduled_tasks ORDER BY task_id
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.task_id, JSON.parse(row.workspace_strategy_json)]),
      [
        ["bound", implicitDefault],
        ["branch", { ...implicitDefault, branch: "nightly" }],
        ["build-item", { ...implicitDefault, forgeItem: 42 }],
        ["by-person", implicitDefault],
        ["checkout", { type: "root" }],
        ["implicit", { type: "root", rootIsDefault: true }],
        ["local-base", { type: "worktree", baseRef: "main" }],
        ["other-base", { ...implicitDefault, baseRef: "develop" }],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
