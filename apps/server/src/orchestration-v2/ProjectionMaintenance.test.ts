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
