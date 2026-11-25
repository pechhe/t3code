import { assert, it } from "@effect/vitest";
import { PAST_DEFAULT_CHAMPION_INSTRUCTIONS } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const seed = (sql: SqlClient.SqlClient, id: string, document: Record<string, unknown>) =>
  sql`INSERT INTO champions (id, project_id, document_json)
      VALUES (${id}, 'project-1', ${JSON.stringify(document)})`;

layer("158_ChampionsObserveOnly", (it) => {
  it.effect(
    "releases repairs, keeps findings open and dismissible for a case, migrates past default instructions, keeps custom ones and drops the repair tables with their rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // As the server opens its database, so dropping a table with referenced rows would fail.
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations({ toMigrationInclusive: 157 });
        yield* seed(sql, "past", {
          champion: {
            id: "past",
            repairsVia: "other",
            whenInTarget: "work",
            attention: ["Repair: stuck", "Folder fine"],
            charter: {
              maxConcurrentRepairs: 1,
              maxRepairsPerDay: 3,
              instructions: PAST_DEFAULT_CHAMPION_INSTRUCTIONS[0],
            },
          },
          findings: [
            {
              id: "past:metric:s1",
              status: "working",
              workId: "w1",
              attemptId: "a1",
              childThreadId: "child-1",
              diagnosis: { text: "cause" },
            },
            { id: "past:qualitative:1", status: "open", escalationThreadId: "case-1" },
            { id: "past:qualitative:2", status: "verified" },
          ],
        });
        yield* seed(sql, "custom", {
          champion: {
            id: "custom",
            charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "Mine." },
          },
          findings: [],
        });
        yield* sql`INSERT INTO champion_repair_claims (work_id, attempt_id, phase, client_request_id, role, state, updated_at) VALUES ('w1', 'a1', 'implementation', 'r1', 'implementer', 'accepted', '2026-01-01T00:00:00.000Z')`;
        const at = "2026-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO champion_investigations (id, champion_id, finding_id, finding_attempt_id, status, at, document_json) VALUES ('inv-1', 'past', 'past:metric:s1', 'a1', 'running', ${at}, '{}')`;
        yield* sql`INSERT INTO champion_branch_attempts (id, investigation_id, champion_id, branch_id, request_id, at, state, document_json) VALUES ('branch-1', 'inv-1', 'past', 'b1', 'req-1', ${at}, 'accepted', '{}')`;
        yield* sql`INSERT INTO champion_cancel_intents (id, investigation_id, attempt_id, document_json) VALUES ('cancel-1', 'inv-1', 'branch-1', '{}')`;
        yield* sql`INSERT INTO champion_recommendations (id, champion_id, investigation_id, at, document_json) VALUES ('rec-1', 'past', 'inv-1', ${at}, '{}')`;
        yield* runMigrations({ toMigrationInclusive: 158 });

        const read = (id: string) =>
          sql<{ document_json: string }>`SELECT document_json FROM champions WHERE id = ${id}`.pipe(
            Effect.map((rows) => JSON.parse(rows[0]!.document_json)),
          );
        const past = yield* read("past");
        assert.deepEqual(past.champion.charter, {});
        assert.isUndefined(past.champion.repairsVia);
        assert.isUndefined(past.champion.whenInTarget);
        assert.deepEqual(past.champion.attention, ["Folder fine"]);
        assert.deepEqual(past.findings[0], { id: "past:metric:s1", status: "open" });
        assert.equal(past.findings[2].status, "verified");
        assert.deepEqual((yield* read("custom")).champion.charter, { instructions: "Mine." });

        // Only the open finding without a case waits for one.
        assert.deepEqual(yield* sql`SELECT champion_id, finding_id FROM champion_case_backfill`, [
          { champion_id: "past", finding_id: "past:metric:s1" },
        ]);
        const released = yield* sql<{ document_json: string }>`
          SELECT document_json FROM champion_activity WHERE champion_id = 'past'`;
        assert.lengthOf(released, 1);
        assert.include(JSON.parse(released[0]!.document_json), {
          kind: "repair-released",
          findingId: "past:metric:s1",
          threadId: "child-1",
        });
        const tables = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
            'champion_repair_claims', 'champion_investigations', 'champion_branch_attempts',
            'champion_recommendations', 'champion_cancel_intents')`;
        assert.deepEqual(tables, []);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
  );
});
