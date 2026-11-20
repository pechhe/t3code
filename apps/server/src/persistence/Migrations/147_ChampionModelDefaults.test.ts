import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const codex = { instanceId: "codex", model: "gpt-5.4" };
const claude = { instanceId: "claudeAgent", model: "claude-sonnet-4-6" };

const seed = (sql: SqlClient.SqlClient, id: string, champion: Record<string, unknown>) =>
  sql`INSERT INTO champions (id, project_id, document_json)
      VALUES (${id}, 'project-1', ${JSON.stringify({ champion: { id, ...champion } })})`;

const readDefaults = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly id: number; readonly document_json: string }>`
      SELECT id, document_json FROM champion_model_defaults`;
    return rows.map((row) => ({ id: row.id, document: JSON.parse(row.document_json) }));
  });

layer("147_ChampionModelDefaults", (it) => {
  it.effect("creates no row when there are no active champions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 146 });
      yield* seed(sql, "retired", {
        lifecycle: "retired",
        updatedAt: "2026-01-01T00:00:00.000Z",
        routineModelSelection: codex,
        setupModelSelection: codex,
      });
      yield* runMigrations({ toMigrationInclusive: 147 });
      assert.deepStrictEqual(yield* readDefaults(sql), []);
    }),
  );
});

layer("147_ChampionModelDefaults seeding", (it) => {
  it.effect("seeds the most common active selections, ignoring inactive champions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 146 });
      // Class-backed champions keep their stored selections.
      yield* seed(sql, "a", {
        lifecycle: "active",
        updatedAt: "2026-02-01T00:00:00.000Z",
        classes: [{ role: "checks" }],
        routineModelSelection: codex,
        setupModelSelection: claude,
      });
      // Only stored models, with a legacy `provider` key and option order differences.
      yield* seed(sql, "b", {
        lifecycle: "active",
        updatedAt: "2026-02-02T00:00:00.000Z",
        routineModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: [
            { id: "b", value: 1 },
            { id: "a", value: 2 },
          ],
        },
        setupModelSelection: claude,
      });
      yield* seed(sql, "c", {
        lifecycle: "active",
        updatedAt: "2026-02-03T00:00:00.000Z",
        routineModelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [
            { id: "a", value: 2 },
            { id: "b", value: 1 },
          ],
        },
        setupModelSelection: codex,
      });
      yield* seed(sql, "paused", {
        lifecycle: "paused",
        updatedAt: "2026-03-01T00:00:00.000Z",
        routineModelSelection: claude,
        setupModelSelection: codex,
      });
      yield* seed(sql, "retired", {
        lifecycle: "retired",
        updatedAt: "2026-03-02T00:00:00.000Z",
        routineModelSelection: claude,
        setupModelSelection: codex,
      });
      yield* runMigrations({ toMigrationInclusive: 147 });

      const rows = yield* readDefaults(sql);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.id, 1);
      assert.deepStrictEqual(rows[0]!.document, {
        checks: {
          model: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "a", value: 2 },
              { id: "b", value: 1 },
            ],
          },
        },
        advice: { model: claude },
      });
    }),
  );
});

layer("147_ChampionModelDefaults ties", (it) => {
  it.effect("breaks ties by most recently updated champion and keeps pinned selections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 146 });
      yield* seed(sql, "old", {
        lifecycle: "active",
        updatedAt: "2026-02-01T00:00:00.000Z",
        routineModelSelection: codex,
        setupModelSelection: { ...codex, pinned: true },
      });
      yield* seed(sql, "new", {
        lifecycle: "active",
        updatedAt: "2026-02-09T00:00:00.000Z",
        routineModelSelection: claude,
        setupModelSelection: claude,
      });
      yield* runMigrations({ toMigrationInclusive: 147 });

      const rows = yield* readDefaults(sql);
      assert.deepStrictEqual(rows[0]!.document, {
        checks: { model: claude },
        advice: { model: claude },
      });
    }),
  );
});
