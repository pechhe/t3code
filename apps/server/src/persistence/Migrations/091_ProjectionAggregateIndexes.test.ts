import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("projection aggregates", (it) => {
  it.effect("backfills counts and keeps inserts, moves, deletes and rollbacks exact", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      const insert = (id: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
           ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, 'thread', ${runId}, NULL, NULL, NULL, 1,
          'assistant_message', 'completed', '2026-10-27', ${JSON.stringify({ messageId: id })})
      `;
      yield* insert("a", null);
      yield* insert("b", "run");
      yield* runMigrations();
      const check = () =>
        Effect.gen(function* () {
          const expected = yield* sql`
          SELECT thread_id, run_id, COUNT(*) AS item_count
          FROM orchestration_v2_projection_turn_items GROUP BY thread_id, run_id
          ORDER BY thread_id, run_id
        `;
          const actual = yield* sql`
          SELECT thread_id, run_id, item_count FROM orchestration_v2_projection_run_item_counts
          ORDER BY thread_id, run_id
        `;
          assert.deepEqual(actual, expected);
        });
      yield* check();
      yield* insert("c", "run");
      yield* insert("empty", "");
      yield* check();
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}' WHERE turn_item_id = 'c'`;
      yield* check();
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET thread_id = 'other', run_id = NULL WHERE turn_item_id = 'b'`;
      yield* check();
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = 'moved' WHERE turn_item_id = 'a'`;
      yield* check();
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'c'`;
      yield* check();
      yield* sql
        .withTransaction(insert("rollback", "run").pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.catch(() => Effect.void));
      yield* check();
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
      yield* check();
    }),
  );

  it.effect("groups message ordinals through an index without a temporary sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      for (const [id, type, ordinal, messageId] of [
        ["later", "assistant_message", 9, "a"],
        ["earlier", "user_message", 2, "a"],
        ["other", "assistant_message", 5, "b"],
        ["tool", "dynamic_tool", 1, "a"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES (${id}, 'thread', ${ordinal}, ${type}, 'completed', '2026-10-27',
            ${JSON.stringify({ messageId })})
        `;
      }
      const readOrdinals = () => sql`
        SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread' AND type IN ('user_message', 'assistant_message')
        GROUP BY json_extract(payload_json, '$.messageId')
        ORDER BY message_id
      `;
      assert.deepEqual(yield* readOrdinals(), [
        { message_id: "a", ordinal: 2 },
        { message_id: "b", ordinal: 5 },
      ]);
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{"messageId":"b"}', ordinal = 1 WHERE turn_item_id = 'earlier'`;
      assert.deepEqual(yield* readOrdinals(), [
        { message_id: "a", ordinal: 9 },
        { message_id: "b", ordinal: 1 },
      ]);
      const plan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread' AND type IN ('user_message', 'assistant_message')
        GROUP BY json_extract(payload_json, '$.messageId')
      `;
      assert.isTrue(plan.some(({ detail }) => detail.includes("turn_items_message_ordinal_idx")));
      assert.isFalse(plan.some(({ detail }) => detail.includes("TEMP B-TREE")));
    }),
  );
});
