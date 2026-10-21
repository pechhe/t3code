import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const kept = { projectId: "project-1", workspacePath: "/w/kept", releasedAt: null };
const handed = { ...kept, workspacePath: "/w/handed", movedTo: "thread-fork" };

it.effect("drops attachments handed to a fork from projections and events", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });
    const insert = (id: string, payload: object) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${JSON.stringify(payload)}
      )
    `;
    yield* insert("thread-1", { id: "thread-1", workspaceAttachments: [kept, handed] });
    yield* insert("thread-2", { id: "thread-2" });
    const event = (id: string, version: number) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${id}, 'thread', 'thread-1', ${version === 2 ? 0 : 1}, 'thread.updated',
        '2026-10-01T00:00:00.000Z', 'server',
        ${JSON.stringify({ id: "thread-1", workspaceAttachments: [kept, handed] })}, '{}',
        ${version}
      )
    `;
    yield* event("event-v2", 2);
    yield* event("event-v1", 1);
    yield* runMigrations();
    const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
      SELECT thread_id, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.thread_id, JSON.parse(row.payload_json).workspaceAttachments]),
      [
        ["thread-1", [kept]],
        ["thread-2", undefined],
      ],
    );
    const events = yield* sql<{ readonly event_id: string; readonly payload_json: string }>`
      SELECT event_id, payload_json FROM orchestration_events ORDER BY event_id
    `;
    // Rebuilding projections from the events cannot bring the handed entries back.
    assert.deepStrictEqual(
      events.map((row) => [row.event_id, JSON.parse(row.payload_json).workspaceAttachments]),
      [
        ["event-v1", [kept, handed]],
        ["event-v2", [kept]],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
