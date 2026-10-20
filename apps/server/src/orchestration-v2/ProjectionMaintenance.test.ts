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

it.effect("discovers events and receipts on the reader and deletes on the writer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "compaction-reader-" });
      yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* seed;
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
