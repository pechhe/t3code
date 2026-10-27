import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { compactableEventCondition } from "../../orchestration-v2/compactionCandidates.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades the candidate index without changing stored history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 92 });
    for (const type of ["turn-item.updated", "provider-turn.updated", "subagent.updated"]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (${type}, 'thread', ${type}, 1, ${type}, 'now', 'server', '{}', '{}', 2)
      `;
    }
    yield* runMigrations();
    const candidates = yield* sql<{ event_type: string }>`
      SELECT event_type FROM orchestration_events
        INDEXED BY orchestration_events_compactable_sequence_idx
      WHERE ${compactableEventCondition(sql)} ORDER BY sequence
    `;
    assert.deepEqual(
      candidates.map((row) => row.event_type),
      ["turn-item.updated", "provider-turn.updated"],
    );
    assert.equal((yield* sql`SELECT * FROM orchestration_events`).length, 3);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
