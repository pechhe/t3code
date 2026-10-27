import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import { compactableEventCondition } from "./compactionCandidates.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const maintenanceLayer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES
      ('old', 'thread', 'thread', 1, 'thread.metadata-updated', 'now', 'server', '{}', '{}', 2),
      ('new', 'thread', 'thread', 2, 'thread.metadata-updated', 'now', 'server', '{}', '{}', 2)
  `;
  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
    ) VALUES ('command', 'thread', 'thread', 'now', 2, 'accepted', 'thread.create')
  `;
});

it.effect(
  "retains replay anchors across indexed pages and removes only imported legacy threads",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* seed;
      for (const eventType of [
        "message.updated",
        "node.updated",
        "thread.pull-request-link-updated",
      ]) {
        yield* sql`
        WITH RECURSIVE numbers(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 55
        )
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        SELECT ${eventType} || '-' || n, 'thread', ${eventType}, n, ${eventType},
          'now', 'server', '{"id":"entity","host":"github","repository":"repo","number":1}', '{}', 2
        FROM numbers
      `;
      }
      yield* sql`
      INSERT INTO orchestration_v2_legacy_imports (
        thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
        imported_message_count, last_error
      ) VALUES ('imported', 'now', 'now', 'now', 1, NULL)
    `;
      for (const [id, kind, version, type] of [
        ["imported", "thread", 1, "thread.message-appended"],
        ["pending", "thread", 1, "thread.message-appended"],
        ["project", "project", 1, "project.updated"],
        ["created", "thread", 2, "thread.created"],
        ["turn-item", "thread", 2, "turn-item.updated"],
        ["subagent", "thread", 2, "subagent.updated"],
      ] as const) {
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (${id}, ${kind}, ${id}, 1, ${type}, 'now', 'server', '{}', '{}', ${version})
      `;
      }
      const plan = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN SELECT sequence FROM orchestration_events
        INDEXED BY orchestration_events_compactable_sequence_idx
      WHERE sequence <= 1000 AND ${compactableEventCondition(sql)}
      ORDER BY sequence DESC LIMIT 50
    `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("orchestration_events_compactable_sequence_idx")),
        plan.map((row) => row.detail).join("\n"),
      );
      const result = yield* maintenance.compactEventStore;
      assert.equal(result.deletedEventCount, 161);
      const retained = yield* sql<{ event_id: string }>`SELECT event_id FROM orchestration_events`;
      assert.sameMembers(
        retained.map((row) => row.event_id),
        [
          "new",
          "message.updated-1",
          "message.updated-55",
          "node.updated-1",
          "node.updated-55",
          "thread.pull-request-link-updated-1",
          "thread.pull-request-link-updated-55",
          "pending",
          "project",
          "created",
          "turn-item",
          "subagent",
        ],
      );
      assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
    }).pipe(Effect.provide(maintenanceLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("discovers events and receipts on the reader and deletes on the writer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "compaction-reader-" });
      yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          WITH RECURSIVE numbers(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 125
          )
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          )
          SELECT 'immutable-' || n, 'thread', 'thread', n + 2, 'run.updated',
            'now', 'server', '{}', '{}', 2 FROM numbers
        `;
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const result = yield* maintenance.compactEventStore.pipe(
          Effect.withTracer(tracer),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
        assert.equal(result.deletedEventCount, 1);
        const retained = yield* sql<{ event_id: string }>`
          SELECT event_id FROM orchestration_events ORDER BY sequence
        `;
        assert.equal(retained[0]?.event_id, "new");
        assert.lengthOf(retained, 126);
        const discovery = spans.filter((span) => {
          const query = span.attributes.get("db.query.text");
          return (
            typeof query === "string" &&
            query.trimStart().startsWith("SELECT") &&
            (query.includes("FROM orchestration_events AS event") ||
              query.includes("FROM orchestration_command_receipts AS receipt"))
          );
        });
        assert.lengthOf(discovery, 2);
        for (const span of discovery) assert.equal(span.attributes.get("db.connection"), "reader");
        const deletes = spans.filter((span) =>
          String(span.attributes.get("db.query.text")).includes("DELETE FROM orchestration_events"),
        );
        assert.lengthOf(deletes, 1);
        assert.equal(deletes[0]!.attributes.get("db.connection"), "writer");
        assert.isFalse(spans.some((span) => span.name === "sql.transaction"));
      }).pipe(
        Effect.provide(
          maintenanceLayer.pipe(
            Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("compacts settled intermediate updates while retaining prompt and usage anchors", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    for (const thread of [
      "settled",
      "unsettled",
      "running",
      "active",
      "preparing",
      "provider-running",
      "item-waiting",
      "background",
      "request-pending",
      "subagent-running",
    ]) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (${thread}, 'project', 'title', 'codex', 'full-access', 'default', 'now', 'now',
          ${JSON.stringify({ settledAt: thread === "unsettled" ? null : "now", settledOverride: thread === "active" ? "active" : null })})
      `;
      if (thread === "running" || thread === "preparing")
        yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${thread + ":run"}, ${thread}, 1, 'codex', ${thread}, 'now', '{}')
      `;
      if (thread === "provider-running")
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
          VALUES ('active-turn', ${thread}, 'provider-thread', 'node', 1, 'running', '{}')
        `;
      if (thread === "item-waiting")
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('active-item', ${thread}, 1, 'command_execution', 'waiting', 'now', '{}')
        `;
      if (thread === "background")
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads
            (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
          VALUES ('background-provider', ${thread}, 'codex', 'idle', 'now',
            '{"pendingBackgroundTasks":[{"id":"task"}]}')
        `;
      if (thread === "request-pending")
        yield* sql`
          INSERT INTO orchestration_v2_projection_runtime_requests
            (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
          VALUES ('request', ${thread}, 'node', 'approval', 'pending', 'now', '{}')
        `;
      if (thread === "subagent-running")
        yield* sql`
          INSERT INTO orchestration_v2_projection_subagents
            (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
          VALUES ('child', ${thread}, 'node', 'codex', 'provider_native', 'running', 'now', '{}')
        `;
      for (const type of ["turn-item.updated", "provider-turn.updated"]) {
        for (let n = 1; n <= 55; n++) {
          const payload = {
            id: "entity",
            type: "command_execution",
            ...(type === "provider-turn.updated" && (n === 30 || n === 31)
              ? { tokenUsage: { totalTokens: n === 30 ? 40 : 42 } }
              : {}),
          };
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES (${`${thread}:${type}:${n}`}, 'thread', ${thread},
              ${n + (type === "provider-turn.updated" ? 100 : 0)}, ${type},
              'now', 'server', ${JSON.stringify(payload)}, '{}', 2)
          `;
        }
      }
    }
    for (let n = 1; n <= 3; n++)
      yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${"prompt:" + n}, 'thread', 'settled', ${200 + n}, 'turn-item.updated',
        'now', 'server', '{"id":"subagent","type":"subagent","promptSequence":1}', '{}', 2)
    `;
    for (let n = 1; n <= 3; n++)
      yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, command_id,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${"receipt:" + n}, 'thread', 'settled', ${300 + n}, 'turn-item.updated',
        ${"command:" + n}, 'now', 'server', '{"id":"response","type":"user_input_request"}', '{}', 2)
    `;
    for (let n = 1; n <= 3; n++)
      yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, command_id,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${"attachment:" + n}, 'thread', 'settled', ${400 + n}, 'message.updated',
        ${"attachment-command:" + n}, 'now', 'server', '{"id":"message"}', '{}', 2)
    `;
    for (let n = 1; n <= 55; n++)
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (${"usage:" + n}, 'thread', 'settled', ${500 + n}, 'provider-turn.updated',
          'now', 'server', ${JSON.stringify({ id: "usage", tokenUsage: { totalTokens: n } })}, '{}', 2)
      `;
    const result = yield* maintenance.compactEventStore;
    assert.equal(result.deletedEventCount, 158);
    const rows = yield* sql<{ event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE stream_id = 'settled' ORDER BY sequence
    `;
    assert.sameMembers(
      rows.map((row) => row.event_id),
      [
        "settled:turn-item.updated:1",
        "settled:turn-item.updated:55",
        "settled:provider-turn.updated:1",
        "settled:provider-turn.updated:31",
        "settled:provider-turn.updated:55",
        "prompt:1",
        "prompt:2",
        "prompt:3",
        "receipt:1",
        "receipt:2",
        "receipt:3",
        "attachment:1",
        "attachment:2",
        "attachment:3",
        "usage:1",
        "usage:55",
      ],
    );
    const untouched = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id != 'settled'
    `;
    assert.equal(untouched[0]!.count, 990);
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
  }).pipe(Effect.provide(maintenanceLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("retains discovered intermediate events when the thread resumes before deletion", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES ('resumed', 'project', 'title', 'codex', 'full-access', 'default', 'now', 'now',
        '{"settledAt":"now"}')
    `;
    for (let n = 1; n <= 3; n++)
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (${"resumed:" + n}, 'thread', 'resumed', ${n}, 'turn-item.updated',
          'now', 'server', '{"id":"item","type":"command_execution"}', '{}', 2)
      `;
    let resumed = false;
    const resumeBeforeDelete: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (!query.trimStart().startsWith("DELETE FROM orchestration_events"))
        return Effect.succeed(statement);
      resumed = true;
      return sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = '{"settledAt":"now","settledOverride":"active"}'
        WHERE thread_id = 'resumed'
      `.pipe(Effect.orDie, Effect.as(statement));
    };
    const result = yield* maintenance.compactEventStore.pipe(
      Effect.provideService(Statement.CurrentTransformer, resumeBeforeDelete),
    );
    assert.isTrue(resumed);
    assert.equal(result.deletedEventCount, 0);
    assert.equal((yield* sql`SELECT sequence FROM orchestration_events`).length, 3);
  }).pipe(Effect.provide(maintenanceLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("returns at most 256 free pages per pass and continues on later passes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "compaction-reclaim-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* sql`CREATE TABLE reclaim_fixture (value BLOB)`;
        yield* sql`INSERT INTO reclaim_fixture VALUES (zeroblob(4194304))`;
        yield* sql`DELETE FROM reclaim_fixture`;
        const before = (yield* sql<{ page_count: number }>`PRAGMA page_count`)[0]!.page_count;
        const first = yield* maintenance.compactEventStore;
        const after = (yield* sql<{ page_count: number }>`PRAGMA page_count`)[0]!.page_count;
        assert.isAtLeast(before - after, 256);
        // Pointer-map pages can disappear along with the 256 data pages.
        assert.isAtMost(before - after, 257);
        assert.isAbove(first.reclaimableBytes, 0);
        const second = yield* maintenance.compactEventStore;
        assert.isBelow(second.reclaimableBytes, first.reclaimableBytes);
      }).pipe(
        Effect.provide(
          maintenanceLayer.pipe(
            Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
