import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("138_ThreadWatchesToWaits", (it) => {
  it.effect("carries each held watch into the thread's waits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 137 });
      const insert = (threadId: string, payload: unknown) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (${threadId}, 'project', 'title', 'codex', 'full-access', 'default', 'now', 'now', ${JSON.stringify(payload)})
      `;
      const startedAt = "2026-11-10T09:00:00.000Z";
      const parked = {
        id: "parked-wait:1",
        title: "Build #7",
        startedAt,
        target: { kind: "build_item", number: 7, until: "closed" },
        givesUpAt: "2026-11-11T09:00:00.000Z",
      };
      yield* insert("lead", {
        title: "Lead",
        threadWatches: [
          // Stored before watches had targets.
          { id: "thread-watch:a", title: "Worker", startedAt, threadId: "thread-worker" },
          {
            id: "thread-watch:b",
            title: "Ship it",
            startedAt,
            target: { kind: "build_item", number: 9, until: "unblocked" },
            waitsOnPerson: { need: "acceptance", ref: "T3-9" },
          },
          {
            id: "thread-watch:server:landing-watch:op-1:lead",
            title: "Build #9",
            startedAt,
            target: { kind: "landing", operationId: "op-1" },
          },
          // A parked wait already wakes the thread for this target.
          { id: "thread-watch:c", title: "Build #7", startedAt, target: parked.target },
        ],
        parkedWaits: [parked],
      });
      yield* insert("idle", { title: "Idle" });
      const [leadRow] = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'lead'
      `;
      // The same payload as its source event, so a projection rebuild keeps the waits.
      for (const [eventId, version] of [
        ["event:lead", 2],
        ["event:v1", 1],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (${eventId}, 'thread', 'lead', ${version}, 'thread.metadata-updated', 'now',
            'user', ${leadRow!.payload_json}, '{}', ${version})
        `;
      }
      yield* runMigrations();

      const rows = yield* sql<{ thread_id: string; payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      const [idle, lead] = rows.map((row) => JSON.parse(row.payload_json));
      assert.deepEqual(idle, { title: "Idle" });
      assert.notProperty(lead, "threadWatches");
      const waits = lead.parkedWaits as ReadonlyArray<Record<string, unknown>>;
      assert.deepEqual(
        waits.map((wait) => [wait.id, wait.target, wait.waitsOnPerson]),
        [
          [parked.id, parked.target, undefined],
          ["thread-watch:a", { kind: "thread", threadId: "thread-worker" }, undefined],
          [
            "thread-watch:b",
            { kind: "build_item", number: 9, until: "unblocked" },
            { need: "acceptance", ref: "T3-9" },
          ],
          [
            "thread-watch:server:landing-watch:op-1:lead",
            { kind: "landing", operationId: "op-1" },
            undefined,
          ],
        ],
      );
      // A converted watch gives up like a wait with no expected time; T3's landing wait never does.
      assert.isString(waits[1]!.givesUpAt);
      assert.notProperty(waits[3]!, "givesUpAt");
      const events = yield* sql<{ event_id: string; payload_json: string }>`
        SELECT event_id, payload_json FROM orchestration_events ORDER BY event_id
      `;
      const [eventLead, eventV1] = events.map((event) => JSON.parse(event.payload_json));
      assert.deepEqual(eventLead, lead);
      assert.property(eventV1, "threadWatches");
      const index = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'orchestration_v2_projection_threads_watching_idx'
      `;
      assert.deepEqual(index, []);
    }),
  );
});
