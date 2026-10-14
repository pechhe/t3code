import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "advisor consultation migration",
  (it) => {
    it.effect(
      "preserves legacy work and permits separate consultations in one thread without weakening request uniqueness",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 66 });
          yield* sql`INSERT INTO external_agent_sessions VALUES ('session', 'client', 'external', '{}')`;
          yield* sql`INSERT INTO external_agent_work VALUES ('original', 'session', 'work', 'attempt-one', 'request-one', 'child', 'fingerprint', '{}', 'accepted', NULL)`;
          const before = yield* sql`SELECT * FROM external_agent_work`;
          yield* runMigrations({ toMigrationInclusive: 67 });
          expect(yield* sql`SELECT * FROM external_agent_work`).toEqual(before);
          yield* sql`INSERT INTO external_agent_work VALUES ('followup', 'session', 'work', 'attempt-two', 'request-two', 'child', 'fingerprint-two', '{}', 'accepted', NULL)`;
          expect(
            yield* sql`SELECT * FROM external_agent_work WHERE thread_id = 'child'`,
          ).toHaveLength(2);
          const conflict = yield* Effect.result(
            sql`INSERT INTO external_agent_work VALUES ('duplicate', 'session', 'work', 'attempt-three', 'request-two', 'other-child', 'other', '{}', 'prepared', NULL)`,
          );
          expect(conflict._tag).toBe("Failure");
        }),
    );
  },
);
