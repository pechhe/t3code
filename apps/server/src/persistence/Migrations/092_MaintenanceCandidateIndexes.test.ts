import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "092_MaintenanceCandidateIndexes",
  (it) => {
    it.effect("backfills usage-limit failures and follows their payload and status changes", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 91 });
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES
          ('limit', 'thread-limit', 1, 'error', 'failed', 'now', '{"failure":{"class":"usage_limit"}}'),
          ('other', 'thread-other', 1, 'error', 'failed', 'now', '{"failure":{"class":"unknown"}}')
      `;
        yield* runMigrations();
        const candidates = () =>
          sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_turn_items
          INDEXED BY orchestration_v2_turn_items_usage_limit_idx
        WHERE type = 'error' AND status = 'failed'
          AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
        ORDER BY thread_id
      `.pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));
        assert.deepEqual(yield* candidates(), ["thread-limit"]);
        yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{"failure":{"class":"usage_limit"}}' WHERE turn_item_id = 'other'
      `;
        assert.deepEqual(yield* candidates(), ["thread-limit", "thread-other"]);
        yield* sql`
        UPDATE orchestration_v2_projection_turn_items SET status = 'completed'
        WHERE turn_item_id = 'limit'
      `;
        assert.deepEqual(yield* candidates(), ["thread-other"]);
        yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'other'`;
        assert.deepEqual(yield* candidates(), []);
      }),
    );
  },
);
