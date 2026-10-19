import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FleetProjection from "./FleetProjection.ts";

const layer = FleetProjection.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("counts pending runtime, secret and release requests together", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, type TEXT, status TEXT)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('a', 'pending'), ('a', 'pending'), ('b', 'resolved')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items VALUES ('a', 'secret_request', 'waiting'), ('a', 'release_approval_request', 'waiting'), ('b', 'secret_request', 'completed'), ('b', 'command', 'waiting')`;
    const projection = yield* FleetProjection.FleetProjection;
    expect(yield* projection.pendingRequests([ThreadId.make("a"), ThreadId.make("b")])).toEqual([
      { threadId: "a", count: 4 },
    ]);
    expect(yield* projection.pendingRequests([ThreadId.make("b")])).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("aggregates messages by recipient and sender inside the hour without reading text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT)`;
    const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T12:00:00.000Z"));
    const insert = (
      recipient: string,
      sender: string | null,
      offset = 0,
      scheduled = false,
      role = "user",
    ) => sql`
    INSERT INTO orchestration_v2_projection_messages VALUES (${recipient}, ${role}, ${DateTime.formatIso(DateTime.makeUnsafe(now - offset))}, ${JSON.stringify({ senderThreadId: sender, ...(scheduled ? { scheduledTaskId: "schedule" } : {}), text: "private transcript".repeat(100) })})
  `;
    for (let index = 0; index < 10; index++) {
      yield* insert("a", "b");
      yield* insert("b", "a");
    }
    yield* insert("a", null);
    yield* insert("a", "b", 0, true);
    yield* insert("a", "b", 3_600_000);
    yield* insert("a", "b", -1);
    yield* insert("a", "a");
    yield* insert("a", "b", 0, false, "assistant");
    const projection = yield* FleetProjection.FleetProjection;
    const ids = [ThreadId.make("a"), ThreadId.make("b")];
    expect(yield* projection.messageCounts(now, ids)).toEqual([
      { threadId: "a", senderThreadId: "b", count: 10 },
      { threadId: "b", senderThreadId: "a", count: 10 },
    ]);
    expect(yield* projection.messageCounts(now, [ThreadId.make("b")])).toEqual([
      { threadId: "b", senderThreadId: "a", count: 10 },
    ]);
    expect(yield* projection.messageCounts(now + 3_600_001, ids)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
