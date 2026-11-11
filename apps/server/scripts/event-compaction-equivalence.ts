// Native I/O and runtime JSON hashes are the contract of this offline SQLite CLI.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeSqlite from "node:sqlite";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as Maintenance from "../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";

// A settled thread's events leave the log, so replay no longer equals the projection. The proof
// is that the projection tables, which are all a client loads, are byte-identical after the pass.
// node apps/server/scripts/event-compaction-equivalence.ts BASELINE.sqlite .t3/unique-experiment-directory
const [baselineArgument, directoryArgument] = process.argv.slice(2);
if (!baselineArgument || !directoryArgument)
  throw new Error("Provide baseline and a new .t3 experiment directory");
const directory = NodePath.resolve(directoryArgument);
const sandbox = NodePath.resolve(".t3") + NodePath.sep;
const baseline = await NodeFSP.realpath(baselineArgument);
if (!baseline.startsWith(sandbox))
  throw new Error("Baseline must be an offline copy inside this workspace's .t3");
const baselineWal = await NodeFSP.stat(`${baseline}-wal`).catch((cause: unknown) => {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
  throw cause;
});
if (baselineWal && baselineWal.size > 0)
  throw new Error("Baseline has a nonempty WAL; supply a clean offline copy");
if (!directory.startsWith(sandbox))
  throw new Error("Experiment must be inside this workspace's .t3");
await NodeFSP.mkdir(directory, { recursive: true });
if (!(await NodeFSP.realpath(directory)).startsWith(sandbox))
  throw new Error("Experiment directory must remain inside this workspace's .t3");
const filename = NodePath.join(directory, "experiment.sqlite");
await NodeFSP.copyFile(
  baseline,
  filename,
  NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
);
const report = (stage: string, result: unknown) => console.log(JSON.stringify({ stage, result }));
// Longest time the event loop went unserved: what a connected client would feel as a freeze.
const loopDelay = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
const timed = Effect.fn("EventCompactionEquivalence.measure")(function* <A, E, R>(
  stage: string,
  effect: Effect.Effect<A, E, R>,
) {
  loopDelay.reset();
  loopDelay.enable();
  const start = performance.now();
  const result = yield* effect;
  loopDelay.disable();
  report(stage, {
    seconds: (performance.now() - start) / 1000,
    longestEventLoopStallMs: loopDelay.max / 1_000_000,
  });
  return result;
});
const snapshot = () => {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name LIKE 'orchestration_v2_projection_%' AND name != 'orchestration_v2_projection_metadata'
      UNION ALL SELECT 'orchestration_v2_turn_item_positions' ORDER BY name
    `)
        .all()
        .map(({ name }) => {
          if (typeof name !== "string" || !/^\w+$/.test(name))
            throw new Error("Unexpected table name");
          const hash = NodeCrypto.createHash("sha256");
          const columns = db.prepare(`PRAGMA table_info(${name})`).all();
          const keys = columns
            .filter((column) => Number(column.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((column) => String(column.name));
          let rows = 0;
          for (const row of db
            .prepare(
              `SELECT * FROM ${name} ORDER BY ${(keys.length ? keys : columns.map((column) => String(column.name))).join(",")}`,
            )
            .iterate()) {
            hash.update(JSON.stringify(row));
            hash.update("\n");
            rows++;
          }
          return [name, { rows, sha256: hash.digest("hex") }];
        }),
    );
  } finally {
    db.close();
  }
};
const accounting = async () => {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    return {
      fileBytes: (await NodeFSP.stat(filename)).size,
      pages: db.prepare("PRAGMA page_count").get(),
      free: db.prepare("PRAGMA freelist_count").get(),
      events: db
        .prepare(`SELECT event_type, COUNT(*) AS count,
        SUM(length(CAST(payload_json AS BLOB))) AS payload_bytes
        FROM orchestration_events GROUP BY event_type ORDER BY event_type`)
        .all(),
      largest: db
        .prepare(`SELECT name, SUM(pgsize) AS bytes, SUM(unused) AS unused_bytes FROM dbstat
        GROUP BY name ORDER BY bytes DESC LIMIT 25`)
        .all(),
    };
  } finally {
    db.close();
  }
};
const serviceLayer = Maintenance.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(NodeSqliteClient.layer({ filename })),
);
const differences = <A>(before: Record<string, A>, after: Record<string, A>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
await Effect.runPromise(
  Effect.gen(function* () {
    const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    report("before", yield* Effect.promise(accounting));
    const before = yield* Effect.promise(async () => snapshot());
    // The server sleeps here to hold a 10% duty; a 1 ms sleep keeps the same slices without the wait.
    const compaction = yield* timed(
      "compaction-runtime",
      maintenance.pruneEventStore(Effect.sleep("1 millis")),
    );
    report("compaction", compaction);
    report("after-compaction", yield* Effect.promise(accounting));
    const projectionDifferences = differences(
      before,
      yield* Effect.promise(async () => snapshot()),
    );
    report("projection-differences", projectionDifferences);
    // The server's reclaim loop, run to exhaustion instead of one bounded pass a minute.
    const reclaimedPages = yield* timed(
      "reclaim-runtime",
      Effect.gen(function* () {
        let pages = 0;
        while (true) {
          const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
          if ((free[0]?.freelist_count ?? 0) === 0) return pages;
          yield* sql`PRAGMA incremental_vacuum(1)`;
          yield* Effect.yieldNow;
          pages++;
        }
      }),
    );
    report("reclaimed-pages", reclaimedPages);
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    report("after-reclamation", yield* Effect.promise(accounting));
    const verification = yield* maintenance.verify;
    report("verification", verification);
    if (projectionDifferences.length || !verification.valid) process.exitCode = 1;
  }).pipe(Effect.provide(serviceLayer)),
);
