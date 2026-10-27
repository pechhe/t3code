// Native I/O and runtime JSON hashes are the contract of this offline SQLite CLI.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as Maintenance from "../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import { rebuildMessageSearch } from "../src/orchestration-v2/messageSearchIndex.ts";

// Recovery modes require unchanged event history; --resume-compaction also requires saved baseline digests.
// node apps/server/scripts/event-compaction-equivalence.ts BASELINE.sqlite .t3/unique-experiment-directory
const [baselineArgument, directoryArgument, recoveryArgument] = process.argv.slice(2);
if (
  recoveryArgument !== undefined &&
  !["--resume-baseline", "--resume-compaction"].includes(recoveryArgument)
)
  throw new Error("Unknown recovery argument");
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
if (recoveryArgument !== undefined) {
  const existing = await NodeFSP.realpath(filename);
  if (existing === baseline || !existing.startsWith(sandbox))
    throw new Error("Experiment must be a separate copy inside this workspace's .t3");
  const source = new NodeSqlite.DatabaseSync(baseline, { readOnly: true });
  const experiment = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const counts = "SELECT COUNT(*) AS count, MAX(sequence) AS sequence FROM orchestration_events";
    if (
      JSON.stringify(source.prepare(counts).get()) !==
      JSON.stringify(experiment.prepare(counts).get())
    )
      throw new Error("Experiment history changed; cannot resume its baseline phase");
  } finally {
    source.close();
    experiment.close();
  }
} else {
  await NodeFSP.copyFile(baseline, filename, NodeFS.constants.COPYFILE_EXCL);
}
const report = (stage: string, result: unknown) => console.log(JSON.stringify({ stage, result }));
const timed = Effect.fn("EventCompactionEquivalence.measure")(function* <A, E, R>(
  stage: string,
  effect: Effect.Effect<A, E, R>,
) {
  const start = performance.now();
  const result = yield* effect;
  report(stage, { seconds: (performance.now() - start) / 1000 });
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
      indexes: db
        .prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat
        WHERE name IN (SELECT name FROM sqlite_master WHERE type = 'index') GROUP BY name ORDER BY name`)
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
const replay = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* EventStore.EventStoreV2;
  const ids = yield* sql<{ thread_id: string }>`
    SELECT DISTINCT stream_id AS thread_id FROM orchestration_events
    WHERE application_event_version = 2 AND event_type = 'thread.created' ORDER BY stream_id
  `;
  const results: Record<string, string> = {};
  let completed = 0;
  for (const { thread_id } of ids) {
    let projection: ReturnType<typeof ProjectionStore.emptyProjection> | undefined;
    let sequence = 0;
    while (true) {
      const page = yield* store
        .read({ threadId: ThreadId.make(thread_id), afterSequence: sequence, limit: 500 })
        .pipe(Stream.runCollect);
      for (const stored of page) {
        if (stored.event.type === "thread.created")
          projection = ProjectionStore.emptyProjection(stored.event);
        else if (projection)
          projection = ProjectionStore.applyToProjection(projection, stored.event);
        sequence = stored.sequence;
      }
      if (page.length < 500) break;
    }
    results[thread_id] = NodeCrypto.createHash("sha256")
      .update(JSON.stringify(projection))
      .digest("hex");
    completed++;
    if (completed % 100 === 0) report("replay-progress", { completed, total: ids.length });
  }
  return results;
});
const differences = <A>(before: Record<string, A>, after: Record<string, A>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
const decodeReplay = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ rows: Schema.Number, sha256: Schema.String })),
  ),
);
await Effect.runPromise(
  Effect.gen(function* () {
    const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    report("before", yield* Effect.promise(accounting));
    const { baselineReplay, before } = yield* Effect.gen(function* () {
      if (recoveryArgument === "--resume-compaction") {
        const baselineReplay = yield* Effect.promise(async () =>
          decodeReplay(
            await NodeFSP.readFile(NodePath.join(directory, "baseline-replay.json"), "utf8"),
          ),
        );
        const before = yield* Effect.promise(async () =>
          decodeSnapshot(
            await NodeFSP.readFile(NodePath.join(directory, "baseline-projections.json"), "utf8"),
          ),
        );
        const current = yield* Effect.promise(async () => snapshot());
        const changed = differences(before, current);
        report("resumed-baseline-differences", changed);
        if (changed.length || !(yield* maintenance.verify).valid)
          throw new Error("Saved baseline no longer matches the experiment projections");
        return { baselineReplay, before };
      }
      const original = yield* Effect.promise(async () => snapshot());
      report("original-projections", original);
      const baselineReplay = yield* timed("baseline-replay", replay);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "baseline-replay.json"),
          JSON.stringify(baselineReplay),
        ),
      );
      const baselineVerification = yield* timed("baseline-rebuild", maintenance.rebuild);
      report("baseline-verification", baselineVerification);
      if (!baselineVerification.valid) throw new Error("Baseline rebuild is invalid");
      const before = yield* Effect.promise(async () => snapshot());
      report("baseline-projections", before);
      report("baseline-rebuild-differences", differences(original, before));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "baseline-projections.json"),
          JSON.stringify(before),
        ),
      );
      return { baselineReplay, before };
    });
    report("before-compaction", yield* Effect.promise(accounting));
    report("compaction", yield* timed("compaction-runtime", maintenance.compactEventStore));
    report("after-compaction", yield* Effect.promise(accounting));
    const afterReplay = yield* timed("compacted-replay", replay);
    const replayDifferences = differences(baselineReplay, afterReplay);
    const compactedVerification = yield* timed("compacted-rebuild", maintenance.rebuild);
    report("compacted-verification", compactedVerification);
    const after = yield* Effect.promise(async () => snapshot());
    const projectionDifferences = differences(before, after);
    report("equivalence", { replayDifferences, projectionDifferences });
    // The offline doctor uses the same conversion; FTS rowids must be rebuilt after VACUUM.
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
    yield* timed("vacuum", sql`VACUUM`);
    yield* timed("message-search-rebuild", rebuildMessageSearch(sql));
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    report("after-reclamation", yield* Effect.promise(accounting));
    const vacuumDifferences = differences(after, yield* Effect.promise(async () => snapshot()));
    report("vacuum-projection-differences", vacuumDifferences);
    const verification = yield* maintenance.verify;
    report("verification", verification);
    if (
      replayDifferences.length ||
      projectionDifferences.length ||
      vacuumDifferences.length ||
      !compactedVerification.valid ||
      !verification.valid
    )
      process.exitCode = 1;
  }).pipe(Effect.provide(serviceLayer)),
);
