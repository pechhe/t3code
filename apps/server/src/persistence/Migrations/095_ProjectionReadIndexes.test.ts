import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("095_ProjectionReadIndexes", (it) => {
  it.effect("backfills watching threads and follows watch, payload and deletion changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      const insert = (threadId: string, payload: string) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (${threadId}, 'project', 'title', 'codex', 'full-access', 'default', 'now', 'now', ${payload})
      `;
      yield* insert("watching", '{"threadWatches":[{"id":"w"}]}');
      yield* insert("idle", '{"threadWatches":[]}');
      yield* insert("legacy", "{}");
      yield* runMigrations();
      const watching = () =>
        sql<{ thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
            INDEXED BY orchestration_v2_projection_threads_watching_idx
          WHERE deleted_at IS NULL
            AND json_array_length(payload_json, '$.threadWatches') > 0
          ORDER BY thread_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));
      assert.deepEqual(yield* watching(), ["watching"]);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = '{"threadWatches":[{"id":"w"}]}' WHERE thread_id = 'legacy'
      `;
      assert.deepEqual(yield* watching(), ["legacy", "watching"]);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = '{"threadWatches":[]}' WHERE thread_id = 'watching'
      `;
      assert.deepEqual(yield* watching(), ["legacy"]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id = 'legacy'`;
      assert.deepEqual(yield* watching(), []);
    }),
  );

  it.effect("reads a thread's turn items of the requested types through the type index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT payload_json FROM orchestration_v2_projection_turn_items
          INDEXED BY orchestration_v2_projection_turn_items_thread_type_idx
        WHERE thread_id = 'thread' AND type IN (SELECT value FROM json_each('["error"]'))
        ORDER BY ordinal ASC, turn_item_id ASC
      `;
      assert.isTrue(
        plan.some(({ detail }) =>
          detail.includes(
            "orchestration_v2_projection_turn_items_thread_type_idx (thread_id=? AND type=?)",
          ),
        ),
      );
    }),
  );
});
