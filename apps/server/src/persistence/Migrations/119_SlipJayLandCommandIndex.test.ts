import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("119_SlipJayLandCommandIndex", (it) => {
  it.effect(
    "backfills `slipjay land` commands, follows later ones and skips a malformed payload",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 118 });
        const insert = (id: string, type: string, input: string) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${id}, ${id}, 1, ${type}, 'completed', ${id}, ${JSON.stringify({ input, output: "op_1" })})
      `;
        yield* insert("a-land", "command_execution", "slipjay land --no-wait");
        yield* insert("b-other", "command_execution", "echo op_1");
        yield* insert("c-message", "assistant_message", "slipjay land");
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES ('malformed', 'malformed', 1, 'command_execution', 'completed', 'm', 'slipjay land op_1')
      `;
        yield* runMigrations();
        const submitted = (operationId: string) =>
          sql<{ thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_turn_items
            INDEXED BY orchestration_v2_projection_turn_items_slipjay_land_idx
          WHERE type = 'command_execution'
            AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.input') END
        LIKE '%slipjay%land%'
            AND instr(payload_json, ${operationId}) > 0
          ORDER BY updated_at ASC
        `.pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));
        assert.deepEqual(yield* submitted("op_1"), ["a-land"]);
        yield* insert("d-land", "command_execution", "cd repo && slipjay -q land");
        assert.deepEqual(yield* submitted("op_1"), ["a-land", "d-land"]);
        assert.deepEqual(yield* submitted("op_2"), []);
        yield* sql`
        UPDATE orchestration_v2_projection_turn_items SET payload_json = 'invalid' WHERE turn_item_id = 'd-land'
      `;
        assert.deepEqual(yield* submitted("op_1"), ["a-land"]);
      }),
  );
});
