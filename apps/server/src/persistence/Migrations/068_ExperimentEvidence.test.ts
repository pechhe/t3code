import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "evidence migration after existing managed work",
  (it) => {
    it.effect("appends evidence tables without changing the existing migration ledger", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        const previous =
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        yield* runMigrations({ toMigrationInclusive: 68 });
        expect(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 67 ORDER BY migration_id`,
        ).toEqual(previous);
        expect(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('experiment_evidence', 'experiment_evaluations') ORDER BY name`,
        ).toEqual([{ name: "experiment_evaluations" }, { name: "experiment_evidence" }]);
        expect(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 68`,
        ).toEqual([{ migration_id: 68, name: "ExperimentEvidence" }]);
      }),
    );
  },
);
