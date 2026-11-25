import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("159_ChampionLearningCandidates", (it) => {
  it.effect("stores a Champion's learning candidates, waiting until a finding carries them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 159 });
      yield* sql`INSERT INTO champions (id, project_id, document_json) VALUES ('c1', 'p1', '{}')`;
      yield* sql`INSERT INTO champion_learning_candidates (id, champion_id, at, statement, evidence, home)
        VALUES ('l1', 'c1', '2026-01-01T00:00:00.000Z', 'A trap', 'Seen twice', 'doc')`;
      assert.deepEqual(
        yield* sql`SELECT urgent, carried_by FROM champion_learning_candidates WHERE id = 'l1'`,
        [{ urgent: 0, carried_by: null }],
      );
      const orphan =
        yield* sql`INSERT INTO champion_learning_candidates (id, champion_id, at, statement, evidence, home)
        VALUES ('l2', 'missing', '2026-01-01T00:00:00.000Z', 's', 'e', 'doc')`.pipe(Effect.exit);
      assert.isTrue(orphan._tag === "Failure");
    }),
  );
});
