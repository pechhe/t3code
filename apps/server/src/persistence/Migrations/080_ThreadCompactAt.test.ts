import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateThreadCompactAt from "./080_ThreadCompactAt.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("080_ThreadCompactAt", (it) => {
  it.effect("keeps each dragged rollover hard point as the thread's compact-at point", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      const now = "2026-01-01T00:00:00.000Z";
      const insert = (id: string, payload: unknown) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default', ${now}, ${now},
          ${JSON.stringify(payload)}
        )
      `;
      yield* insert("dragged", {
        id: "dragged",
        rolloverThresholds: { soft: 150_000, hard: 180_000 },
      });
      yield* insert("held", { id: "held", rolloverHold: { kind: "off" } });
      yield* insert("null-band", { id: "null-band", rolloverThresholds: null });
      const insertEvent = (id: string, version: number, type: string, payload: unknown) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`event:${id}`}, 'thread', 'dragged', ${version}, ${type}, ${now}, 'user',
          ${JSON.stringify(payload)}, '{}', 2
        )
      `;
      yield* insertEvent("band", 0, "thread.rollover-thresholds-set", {
        id: "dragged",
        rolloverThresholds: { soft: 150_000, hard: 180_000 },
      });
      yield* insertEvent("renamed", 1, "thread.metadata-updated", {
        id: "dragged",
        rolloverThresholds: { soft: 150_000, hard: 180_000 },
      });
      yield* insertEvent("reset", 2, "thread.compact-at-set", { id: "dragged", compactAt: null });
      yield* runMigrations({ toMigrationInclusive: 80 });

      // The stored events carry the point too, so a projection rebuild keeps it; a later reset
      // is left as it was.
      const events = yield* sql<{ readonly id: string; readonly compactAt: number | null }>`
        SELECT event_id AS id, json_extract(payload_json, '$.compactAt') AS compactAt
        FROM orchestration_events ORDER BY event_id
      `;
      assert.deepEqual(events, [
        { id: "event:band", compactAt: 180_000 },
        { id: "event:renamed", compactAt: 180_000 },
        { id: "event:reset", compactAt: null },
      ]);

      const rows = yield* sql<{
        readonly id: string;
        readonly compactAt: number | null;
        readonly payloadCompactAt: number | null;
      }>`
        SELECT thread_id AS id, compact_at AS compactAt,
          json_extract(payload_json, '$.compactAt') AS payloadCompactAt
        FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(rows, [
        { id: "dragged", compactAt: 180_000, payloadCompactAt: 180_000 },
        { id: "held", compactAt: null, payloadCompactAt: null },
        { id: "null-band", compactAt: null, payloadCompactAt: null },
      ]);

      // Running it again changes nothing, and the old fields stay in the stored thread.
      yield* migrateThreadCompactAt;
      const again = yield* sql<{ readonly compactAt: number | null }>`
        SELECT compact_at AS compactAt FROM orchestration_v2_projection_threads
        WHERE thread_id = 'dragged'
      `;
      assert.deepEqual(again, [{ compactAt: 180_000 }]);
      const legacy = yield* sql<{ readonly hard: number }>`
        SELECT json_extract(payload_json, '$.rolloverThresholds.hard') AS hard
        FROM orchestration_v2_projection_threads WHERE thread_id = 'dragged'
      `;
      assert.deepEqual(legacy, [{ hard: 180_000 }]);
    }),
  );
});
