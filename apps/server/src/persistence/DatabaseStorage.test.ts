import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

const currentStatus = Effect.flatMap(DatabaseStorage.DatabaseStorage, (storage) =>
  storage.status.pipe(Stream.take(1), Stream.runHead),
);

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("publishes file accounting and the doctor command after each pass", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* TestClock.adjust("1 minute");
    const before = (yield* currentStatus).pipe(Option.getOrThrow);
    assert.isNotNull(before);
    assert.isAbove(before!.databaseBytes, 1048576);
    assert.isTrue(before!.incrementalVacuumEnabled);
    // Quoting follows the host shell, so check each word on its own.
    assert.include(before!.compactCommand, "doctor");
    assert.include(before!.compactCommand, "--base-dir");
    assert.include(before!.compactCommand, config.baseDir);

    // The next reclaim pass frees the dropped table and republishes.
    yield* sql`DROP TABLE discarded`;
    yield* TestClock.adjust("1 minute");
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const after = yield* storage.status.pipe(
      Stream.filter((status) => status !== null && status.databaseBytes < before!.databaseBytes),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.isAtMost(after!.databaseBytes, before!.databaseBytes - 1048576);
    assert.equal(after!.reclaimableBytes, 0);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("publishes nothing when doctor would repair a different database", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(yield* currentStatus, Option.some(null));
  }).pipe(
    Effect.provide(
      storageLayer(
        // A dev server without an explicit home keeps state in <baseDir>/dev,
        // while `doctor --base-dir` targets <baseDir>/userdata.
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return { ...config, dbPath: `${config.baseDir}/dev/statev2.sqlite` };
          }),
        ).pipe(Layer.provide(testConfig)),
      ),
    ),
  ),
);

it.effect.each([undefined, 5, 7, -2] as const)(
  "respects persisted completion across restarts (previous pass %s hours ago)",
  (hoursAgo) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      let passes = 0;
      if (hoursAgo !== undefined) {
        const completedAt = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { hours: hoursAgo }),
        );
        yield* sql`
        INSERT INTO orchestration_v2_projection_metadata VALUES ('event-store-compaction', 1, 0, ${completedAt})
      `;
      }
      const observed = ProjectionMaintenance.ProjectionMaintenanceV2.of({
        ...maintenance,
        compactEventStore: maintenance.compactEventStore.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              passes++;
            }),
          ),
        ),
      });
      const start = Effect.scoped(
        Effect.gen(function* () {
          yield* DatabaseStorage.DatabaseStorage;
          yield* TestClock.adjust("1 minute");
        }).pipe(
          Effect.provide(Layer.fresh(DatabaseStorage.layer)),
          Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceV2, observed),
        ),
      );
      yield* start;
      // Negative: a completion stamped in the future by a skewed clock.
      const expected = hoursAgo === 5 ? 0 : 1;
      assert.equal(passes, expected);
      yield* start;
      assert.equal(passes, expected);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* DatabaseStorage.DatabaseStorage;
          yield* TestClock.adjust("6 hours");
          assert.equal(passes, expected + 1);
        }).pipe(
          Effect.provide(Layer.fresh(DatabaseStorage.layer)),
          Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceV2, observed),
        ),
      );
    }).pipe(
      Effect.provide(
        ProjectionMaintenance.layer.pipe(
          Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(testConfig),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("waits a full interval after a failed pass before retrying", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    let attempts = 0;
    const failing = ProjectionMaintenance.ProjectionMaintenanceV2.of({
      ...maintenance,
      compactEventStore: Effect.suspend(() => {
        attempts++;
        return Effect.fail(
          new ProjectionMaintenance.ProjectionMaintenanceError({ operation: "compact event store" }),
        );
      }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* DatabaseStorage.DatabaseStorage;
        yield* TestClock.adjust("1 minute");
        assert.equal(attempts, 1);
        yield* TestClock.adjust("5 hours");
        assert.equal(attempts, 1);
        yield* TestClock.adjust("1 hour");
        assert.equal(attempts, 2);
      }).pipe(
        Effect.provide(Layer.fresh(DatabaseStorage.layer)),
        Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceV2, failing),
      ),
    );
  }).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(testConfig),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
