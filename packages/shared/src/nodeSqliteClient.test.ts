import type * as Scope from "effect/Scope";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const workerExits = vi.hoisted(() => new WeakMap<NodeWorkerThreads.Worker, Promise<void>>());
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));
const gateFixture = vi.hoisted(() => ({ lowerCeiling: false, disableAuthorizer: false }));
const checkpointWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (gateFixture.lowerCeiling && args[1]?.workerData?.writer) {
        args[1] = {
          ...args[1],
          workerData: { ...args[1].workerData, frameLimit: 100, backstop: 50 },
        };
      }
      if (
        gateFixture.disableAuthorizer &&
        args[1]?.workerData?.writer &&
        typeof args[0] === "string"
      ) {
        args[0] =
          'require("node:sqlite").DatabaseSync.prototype.setAuthorizer = undefined;\n' + args[0];
      }
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
      workerExits.set(this, new Promise((resolve) => this.once("exit", () => resolve())));
      if (args[1]?.workerData?.frames !== undefined) checkpointWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("records the writer connection owner on a waiting query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.withSpan("test.writerHolder"), Effect.forkChild);
      yield* Deferred.await(held);

      const waitingSpan = yield* Deferred.make<Tracer.Span>();
      const observeWaiter: Statement.Transformer = (statement, _sql, _fiber, span) =>
        Deferred.succeed(waitingSpan, span).pipe(Effect.as(statement));
      const waiter = yield* sql`SELECT 1`.pipe(
        Effect.provideService(Statement.CurrentTransformer, observeWaiter),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      );
      const span = yield* Deferred.await(waitingSpan);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);

      assert.equal(span.attributes.get("db.lock_owner_at_start.name"), "test.writerHolder");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.fiber_id"), "number");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.trace_id"), "string");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.span_id"), "string");
    }),
  );

  it.effect(
    "keeps nested transaction time on the outer writer without duplicating phase totals",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let outer: Tracer.Span | undefined;
        let nested: Tracer.Span | undefined;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            outer = yield* Effect.currentSpan;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                nested = yield* Effect.currentSpan;
                yield* TestClock.adjust("11 millis");
              }),
            );
          }),
        );
        assert.equal(outer?.attributes.get("db.transaction.body_ms"), 11);
        assert.equal(outer?.attributes.get("db.transaction.checkpoint_admission_wait_ms"), 0);
        assert.equal(outer?.attributes.get("db.transaction.begin_ms"), 0);
        assert.equal(outer?.attributes.get("db.transaction.commit_ms"), 0);
        assert.isFalse(nested?.attributes.has("db.transaction.body_ms"));
        assert.isFalse(nested?.attributes.has("db.transaction.checkpoint_admission_wait_ms"));
      }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("a rowid above 2^53 does not leave a transaction open", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE big (id INTEGER PRIMARY KEY, name TEXT)`;
    yield* sql`INSERT INTO big (id, name) VALUES (246166233861328896, 'first')`;
    // BEGIN reports the connection's last insert rowid; a failure to convert it must not
    // read as a failed BEGIN, or the open transaction is never rolled back.
    yield* sql.withTransaction(sql`INSERT INTO big (name) VALUES ('second')`);
    yield* sql.withTransaction(sql`UPDATE big SET name = 'third' WHERE name = 'second'`);
    const rows = yield* sql<{ name: string }>`SELECT name FROM big ORDER BY id`;
    assert.deepStrictEqual(
      rows.map((row) => row.name),
      ["first", "third"],
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect.each([false, true])("batches worker results without losing rows (reader=%s)", (reader) =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const route = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        reader ? effect.pipe(SqliteClient.readOnly) : effect;
      yield* route(sql`SELECT 1`);
      const worker = startedWorkers
        .filter((candidate) => !checkpointWorkers.includes(candidate))
        .at(-1)!;
      const batches: Array<ReadonlyArray<unknown>> = [];
      const record = (reply: { rows?: ReadonlyArray<unknown> }) => {
        if (Array.isArray(reply.rows) && reply.rows.length > 0) batches.push(reply.rows);
      };
      worker.prependListener("message", record);
      yield* Effect.gen(function* () {
        const text = "x".repeat(16 * 1024);
        const query = sql<{ n: number; text: string }>`
          WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 300
          ) SELECT n, ${text} AS text FROM sequence
        `;
        const rows = yield* reader ? route(query.values) : query;
        assert.equal(rows.length, 300);
        for (const [index, row] of rows.entries()) {
          assert.deepEqual(row, reader ? [index + 1, text] : { n: index + 1, text });
        }
        assert.isAbove(batches.length, 1);
        for (const batch of batches) {
          assert.isAtMost(batch.length, 16_384);
          assert.isAtMost(batch.length * text.length * 2, 8 * 1024 * 1024);
        }
        batches.length = 0;
        const narrow = sql<{ n: number }>`
          WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000
          ) SELECT n FROM sequence
        `;
        const narrowRows = yield* reader ? route(narrow.values) : narrow;
        assert.equal(narrowRows.length, 10_000);
        assert.deepEqual(narrowRows.at(-1), reader ? [10_000] : { n: 10_000 });
        assert.equal(batches.length, 1);
      }).pipe(Effect.ensuring(Effect.sync(() => worker.off("message", record))));
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename, writerWorker: true, readerWorker: true })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("acknowledges later chunks after a cancelled reader query", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      yield* sql`SELECT 1`.pipe(SqliteClient.readOnly);
      const worker = startedWorkers
        .slice(startedBefore)
        .find((candidate) => !checkpointWorkers.includes(candidate))!;
      const firstChunk = yield* Deferred.make<void>();
      const post = worker.postMessage.bind(worker);
      let cancelledRequest: { readonly id: number; readonly received: Int32Array } | undefined;
      using _intercept = vi.spyOn(worker, "postMessage").mockImplementation((message, ...args) => {
        if (message && typeof message === "object" && "sql" in message) {
          const request = message as {
            readonly id: number;
            readonly sql: string;
            readonly received: Int32Array;
          };
          if (request.sql.includes("SELECT 10001 AS n")) {
            cancelledRequest = { id: request.id, received: request.received };
            Atomics.store(request.received, 0, 0);
            worker.emit("message", {
              id: request.id,
              rows: [{ n: 10001 }],
              more: true,
            });
            Deferred.doneUnsafe(firstChunk, Effect.void);
            return;
          }
          if (request.sql.includes("SELECT 20002 AS n")) {
            worker.emit("message", {
              id: request.id,
              rows: [{ n: 20002 }],
              executionMs: 0,
              inTransaction: false,
            });
            return;
          }
        }
        post(message, ...args);
      });

      const abandoned = yield* Effect.forkChild(
        sql<{ n: number }>`SELECT 10001 AS n`.pipe(SqliteClient.readOnly),
        { startImmediately: true },
      );
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(abandoned);
      assert.isDefined(cancelledRequest);

      // The worker resets its acknowledgement before posting each subsequent chunk.
      Atomics.store(cancelledRequest!.received, 0, 0);
      worker.emit("message", {
        id: cancelledRequest!.id,
        rows: [{ n: 10002 }],
        more: true,
      });
      assert.equal(Atomics.load(cancelledRequest!.received, 0), 1);
      worker.emit("message", {
        id: cancelledRequest!.id,
        rows: [],
        executionMs: 0,
        inTransaction: false,
      });

      const next = yield* sql<{ n: number }>`SELECT 20002 AS n`.pipe(SqliteClient.readOnly);
      assert.deepEqual(next, [{ n: 20002 }]);
    }),
  ),
);

it.effect("coalesces savepoints with queries and preserves nested rollback", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const worker = startedWorkers.filter((entry) => !checkpointWorkers.includes(entry)).at(-1)!;
      using messages = vi.spyOn(worker, "postMessage");
      yield* sql.withTransaction(
        Effect.forEach(Array.from({ length: 53 }), () => sql.withTransaction(Effect.void)),
      );
      // The fork's WAL admission is one message before BEGIN; the savepoints add none.
      assert.equal(messages.mock.calls.length, 3);

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE counters SET value = 1 WHERE id = 1`;
          const failure = yield* sql
            .withTransaction(
              sql`UPDATE counters SET value = 2 WHERE id = 1`.pipe(
                Effect.andThen(Effect.fail("bad update")),
              ),
            )
            .pipe(Effect.flip);
          assert.equal(failure, "bad update");
          const sent = messages.mock.calls.length;
          assert.equal(
            yield* sql.withTransaction(Effect.fail("empty update")).pipe(Effect.flip),
            "empty update",
          );
          assert.equal(messages.mock.calls.length, sent);
          assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`, [{ value: 1 }]);
          assert.deepEqual(messages.mock.calls.at(-1)?.[0].savepoints, []);
          yield* sql.withTransaction(
            sql
              .withTransaction(
                sql`UPDATE counters SET value = 3 WHERE id = 1`.pipe(
                  Effect.andThen(Effect.fail("nested update")),
                ),
              )
              .pipe(Effect.flip),
          );
          assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`, [{ value: 1 }]);

          yield* sql.withTransaction(sql`UPDATE counters SET value = 4 WHERE id = 1`);
          yield* sql`UPDATE counters SET value = 5 WHERE id = 1`;
          const unsent = yield* sql
            .withTransaction(sql.unsafe("SELECT ?", [Symbol("uncloneable")]))
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(unsent));
        }),
      );
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`, [{ value: 5 }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reuses a worker query after an iterator constraint failure", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unique_entries(name TEXT UNIQUE)`;
      const insert = (name: string) =>
        sql<{ name: string }>`INSERT INTO unique_entries VALUES (${name}) RETURNING name`;
      yield* insert("first");
      const error = yield* insert("first").pipe(Effect.flip);
      assert.equal(error.reason._tag, "UniqueViolation");
      assert.deepEqual(yield* insert("second"), [{ name: "second" }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("commits on the worker writer after a returning write timed out on a lock", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* sql`UPDATE counters SET value = 1 WHERE id = 1 RETURNING value`.pipe(
        Effect.flip,
      );
      assert.equal(error.reason._tag, "LockTimeoutError");
      yield* Effect.sync(() => other.exec("COMMIT"));

      yield* sql.withTransaction(sql`UPDATE counters SET value = 2 WHERE id = 1`);
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[2]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // Deferred BEGIN permits a competing commit, causing SQLITE_BUSY_SNAPSHOT that no timeout can resolve.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("waits for another process's lock while the database opens", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-open-" });
    const filename = path.join(directory, "state.sqlite");
    const seed = new NodeSqlite.DatabaseSync(filename);
    seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries(name TEXT NOT NULL)");
    seed.close();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const holder = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
        db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
        console.log("held");
        setTimeout(() => db.close(), 300);`,
        filename,
      ]),
    );
    yield* Stream.runHead(holder.stdout);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT COUNT(*) FROM entries`.values, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lets the event loop run while a write waits for another connection's lock", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const write = yield* Effect.forkChild(
        sql`UPDATE counters SET value = value + 1 WHERE id = 1`,
        { startImmediately: true },
      );
      // A writer on the event loop sleeps in SQLite's busy handler here, so this commit
      // cannot run until that write has already timed out.
      yield* eventLoopTurn;
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = 10 WHERE id = 1; COMMIT"));
      yield* Fiber.join(write);
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finishes a write already sent to the writer before its caller is interrupted", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const posted = yield* Deferred.make<void>();
      const writer = startedWorkers.findLast((worker) => !checkpointWorkers.includes(worker))!;
      const post = writer.postMessage.bind(writer);
      using _observe = vi.spyOn(writer, "postMessage").mockImplementation((message, ...args) => {
        post(message, ...args);
        if (
          message &&
          typeof message === "object" &&
          "sql" in message &&
          typeof message.sql === "string" &&
          message.sql.startsWith("UPDATE") &&
          !("type" in message)
        )
          Deferred.doneUnsafe(posted, Effect.void);
      });
      const write = yield* Effect.forkChild(
        sql`UPDATE counters SET value = value + 1 WHERE id = 1`,
        { startImmediately: true },
      );
      yield* Deferred.await(posted);
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(write), {
        startImmediately: true,
      });
      yield* eventLoopTurn;
      // The write is waiting in the worker for the lock, so the interrupt has to wait too.
      assert.isUndefined(interrupted.pollUnsafe());
      yield* Effect.sync(() => other.exec("COMMIT"));
      yield* Fiber.join(interrupted);
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("serves a read on another worker while a read-only transaction holds one", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const read = () => sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
      const readerHeld = yield* Deferred.make<void>();
      const other = yield* Effect.forkChild(
        Deferred.await(readerHeld).pipe(Effect.andThen(read())),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const held = yield* countEntries(sql);
            yield* Deferred.succeed(readerHeld, undefined);
            // Waiting for the only reader here would deadlock this join.
            return [held, yield* Fiber.join(other)];
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, [1, 1]);
      assert.equal(yield* read(), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

it.effect("lets a read waiting for a busy reader be cancelled", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const holding = yield* Effect.forEach(
        // Every reader the client keeps.
        Array.from({ length: 4 }),
        () =>
          Effect.gen(function* () {
            const held = yield* Deferred.make<void>();
            const fiber = yield* Effect.forkChild(
              sql
                .withTransaction(
                  countEntries(sql).pipe(
                    Effect.andThen(Deferred.succeed(held, undefined)),
                    Effect.andThen(Deferred.await(release)),
                  ),
                )
                .pipe(SqliteClient.readOnly),
            );
            yield* Deferred.await(held);
            return fiber;
          }),
      );
      const waiting = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
      );
      yield* Effect.yieldNow;
      // Returns only once the waiting read has given up its place.
      yield* Fiber.interrupt(waiting);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll(holding);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("lets an interrupted fiber's finalizer wait for the writer", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const writerHeld = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(writerHeld);
      const cancelled = yield* Effect.forkChild(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            sql`INSERT INTO entries VALUES ('statement')`.pipe(
              Effect.andThen(sql.withTransaction(sql`INSERT INTO entries VALUES ('transaction')`)),
              Effect.andThen(sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly)),
            ),
          ),
        ),
      );
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(cancelled));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(interrupting);

      assert.equal(yield* countEntries(sql), 3);
    }),
  ),
);

it.effect("gives a queued read the first reader that frees up", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const holders = yield* Effect.forEach([0, 1, 2, 3], () =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const fiber = yield* sql
            .withTransaction(
              countEntries(sql).pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
            )
            .pipe(SqliteClient.readOnly, Effect.forkChild);
          yield* Deferred.await(held);
          return { fiber, release };
        }),
      );
      const cancelled = yield* Effect.uninterruptibleMask((restore) =>
        SqliteClient.readOnly(restore(sql.withTransaction(countEntries(sql)))),
      ).pipe((effect) => Effect.forkChild(effect, { startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      const cancelledRead = yield* Effect.uninterruptibleMask((restore) =>
        SqliteClient.readOnly(restore(countEntries(sql))),
      ).pipe((effect) => Effect.forkChild(effect, { startImmediately: true }));
      yield* Fiber.interrupt(cancelledRead);
      const queuedSpan = yield* Deferred.make<Tracer.Span>();
      const observeQueued: Statement.Transformer = (statement, _sql, _fiber, span) =>
        Deferred.succeed(queuedSpan, span).pipe(Effect.as(statement));
      const queued = yield* countEntries(sql).pipe(
        Effect.provideService(Statement.CurrentTransformer, observeQueued),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        SqliteClient.readOnly,
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      );
      // Masked read-only work keeps its cancellation pending and still runs once a reader frees up.
      let maskedRan = 0;
      const maskedRuns = yield* Effect.forEach(
        [
          Effect.scoped(
            Effect.flatMap(sql.reserve, (connection) =>
              connection.executeUnprepared("SELECT 1", [], undefined),
            ),
          ).pipe(Effect.asVoid),
          sql.withTransaction(countEntries(sql)).pipe(Effect.asVoid),
        ],
        (effect) =>
          effect.pipe(
            Effect.andThen(Effect.sync(() => maskedRan++)),
            Effect.uninterruptible,
            SqliteClient.readOnly,
            (masked) => Effect.forkChild(masked, { startImmediately: true }),
          ),
      );
      const interrupting = yield* Effect.forEach(maskedRuns, (fiber) =>
        Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(holders[1]!.release, undefined);
      yield* Fiber.join(holders[1]!.fiber);
      // Pinned to the first reader it saw, this read would wait for that reader's transaction.
      assert.equal(yield* Fiber.join(queued), 1);
      assert.equal((yield* Deferred.await(queuedSpan)).attributes.get("db.lock_wait_ms"), 1000);
      for (const { fiber, release } of [holders[0]!, holders[2]!, holders[3]!]) {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
      }
      yield* Effect.forEach(interrupting, Fiber.join);
      assert.equal(maskedRan, 2);
    }),
  ),
);

it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);

      // A read beside an open read transaction must not start a worker on the next slot.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          countEntries(sql).pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      const other = yield* countEntries(sql).pipe(SqliteClient.readOnly, (effect) =>
        Effect.forkChild(effect, { startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.equal(yield* Fiber.join(other), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, writerWorker: true, checkpointGateBound: "1 millis" }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const collectGateRecords = Effect.gen(function* () {
  const records: Array<Record<string, unknown>> = [];
  const first = yield* Deferred.make<void>();
  const logger = Logger.make<unknown, void>(({ message }) => {
    const [text, attributes] = Array.isArray(message) ? message : [];
    if (text !== "SQLite checkpoint gate held writes") return;
    records.push(attributes as Record<string, unknown>);
    Deferred.doneUnsafe(first, Effect.void);
  });
  return { records, first, layer: Logger.layer([logger], { mergeWithExisting: false }) };
});

const pinnedWal = (sql: SqlClient.SqlClient, filename: string) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE pages(payload BLOB)`;
    yield* sql`CREATE TABLE pings(n INTEGER)`;
    yield* sql`INSERT INTO pages VALUES (x'00')`;
    const pin = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (db) =>
        Effect.sync(() => {
          if (db.isTransaction) db.exec("ROLLBACK");
          db.close();
        }),
    );
    pin.exec("BEGIN");
    pin.prepare("SELECT COUNT(*) FROM pages").get();
    return pin;
  });

it.live("bounds admission below the disk ceiling and records why a pinned WAL held writes", () =>
  Effect.gen(function* () {
    const gate = yield* collectGateRecords;
    yield* withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const pin = yield* pinnedWal(sql, filename);
        yield* sql`INSERT INTO pages VALUES (zeroblob(${48 * 1024 * 1024}))`;
        yield* sql`INSERT INTO pings VALUES (1)`;
        assert.isTrue(pin.isTransaction);
        pin.exec("COMMIT");
        yield* sql`INSERT INTO pings VALUES (2)`;
        yield* Deferred.await(gate.first);
        const record = gate.records[0]!;
        assert.equal(record.outcome, "released");
        assert.include(String(record.reasons), "wal-ceiling");
        assert.include(String(record.reasons), "checkpoint-pinned");
        assert.typeOf(record.releasedAfterMs, "number");
        assert.isAtLeast(Number(record.peakLog), 10_000);
        assert.deepEqual(yield* sql`SELECT n FROM pings`, [{ n: 1 }, { n: 2 }]);
      }),
    ).pipe(Effect.provide(gate.layer));
  }),
);

it.live.each([{ authorizer: true }, { authorizer: false }])(
  "holds writes at the pinned-reader disk ceiling, permits cancellation, then resumes after the pin ends (authorizer: $authorizer)",
  ({ authorizer }) =>
    Effect.gen(function* () {
      gateFixture.lowerCeiling = true;
      gateFixture.disableAuthorizer = !authorizer;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          gateFixture.lowerCeiling = false;
          gateFixture.disableAuthorizer = false;
        }),
      );
      const gate = yield* collectGateRecords;
      yield* withCheckpointClient((sql, filename) =>
        Effect.gen(function* () {
          const pin = yield* pinnedWal(sql, filename);
          yield* sql`INSERT INTO pages VALUES (zeroblob(${1024 * 1024}))`;
          const writer = startedWorkers.findLast((worker) => !checkpointWorkers.includes(worker))!;
          const held = yield* Deferred.make<void>();
          const onMessage = (reply: { type?: string }) => {
            if (reply.type === "admission-wait") Deferred.doneUnsafe(held, Effect.void);
          };
          writer.on("message", onMessage);
          yield* Effect.addFinalizer(() => Effect.sync(() => writer.off("message", onMessage)));
          const write = yield* sql
            .withTransaction(sql`INSERT INTO pings VALUES (1)`)
            .pipe(Effect.forkChild);
          assert.equal(
            yield* Effect.race(
              Deferred.await(held).pipe(Effect.as("held")),
              Fiber.await(write).pipe(Effect.as("ran")),
            ),
            "held",
          );
          yield* Fiber.interrupt(write);
          yield* Deferred.await(gate.first);
          assert.equal(gate.records[0]!.outcome, "cancelled");
          assert.include(String(gate.records[0]!.reasons), "release-limit");
          assert.deepEqual(
            yield* sql`WITH empty AS (SELECT n FROM pings) SELECT count(*) FROM empty`.values,
            [[0]],
          );
          pin.exec("COMMIT");
          assert.deepEqual(yield* sql`SELECT n FROM pings`, []);
          const spans: Array<Map<string, unknown>> = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (...args) => {
                if (span.name === "sql.transaction") spans.push(new Map(span.attributes));
                end(...args);
              };
              return span;
            },
          });
          yield* sql
            .withTransaction(sql`INSERT INTO pings VALUES (2)`)
            .pipe(Effect.provideService(Tracer.Tracer, tracer));
          assert.deepEqual(yield* sql`SELECT n FROM pings`, [{ n: 2 }]);
          assert.lengthOf(spans, 1);
          for (const attribute of [
            "lease_wait_ms",
            "checkpoint_admission_wait_ms",
            "begin_ms",
            "body_ms",
            "commit_ms",
          ])
            assert.typeOf(spans[0]!.get(`db.transaction.${attribute}`), "number");

          yield* sql`INSERT INTO pages VALUES (zeroblob(${1024 * 1024}))`;
          yield* sql`PRAGMA wal_checkpoint(PASSIVE)`;
          pin.exec("BEGIN");
          pin.prepare("SELECT COUNT(*) FROM pages").get();
          const heldAgain = yield* Deferred.make<void>();
          const observeAgain = (reply: { type?: string }) => {
            if (reply.type === "admission-wait") Deferred.doneUnsafe(heldAgain, Effect.void);
          };
          writer.on("message", observeAgain);
          yield* Effect.addFinalizer(() => Effect.sync(() => writer.off("message", observeAgain)));
          const afterBackfill = yield* sql`PRAGMA user_version = 3`.pipe(Effect.forkChild);
          assert.equal(
            yield* Effect.race(
              Deferred.await(heldAgain).pipe(Effect.as("held")),
              Fiber.await(afterBackfill).pipe(Effect.as("ran")),
            ),
            "held",
          );
          yield* Fiber.interrupt(afterBackfill);
          pin.exec("COMMIT");
          assert.deepEqual(yield* sql`SELECT n FROM pings`, [{ n: 2 }]);
          assert.deepEqual(yield* sql`PRAGMA user_version`.values, [[0]]);
        }),
      ).pipe(Effect.provide(gate.layer));
    }),
);

const withLogLines = <A, E, R>(
  use: (lines: Queue.Queue<ReadonlyArray<unknown>>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<ReadonlyArray<unknown>>();
    const logger = Logger.make(({ logLevel, message }) => {
      Queue.offerUnsafe(lines, [logLevel, ...(message as ReadonlyArray<unknown>)]);
    });
    return yield* use(lines).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

const readConnection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const spans: Array<Tracer.Span> = [];
    const observe: Statement.Transformer = (statement, _sql, _fiber, span) =>
      Effect.sync(() => {
        spans.push(span);
        return statement;
      });
    const count = yield* countEntries(sql).pipe(
      SqliteClient.readOnly,
      Effect.provideService(Statement.CurrentTransformer, observe),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
    return { count, connection: spans.map((span) => span.attributes.get("db.connection")) };
  });

const withWorkers = <A, E, R>(
  mode: { readonly failWith?: string; readonly silent?: boolean },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      failingWorkers.message = mode.failWith;
      silentWorkers.on = mode.silent ?? false;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        failingWorkers.message = undefined;
        silentWorkers.on = false;
      }),
  );

const unavailableWarning = "SQLite reader worker unavailable; reads use the writer";

const notWal = "database uses journal_mode delete, not wal";

it.effect.each([
  {
    failure: "a crash",
    workers: { failWith: "reader start failed" },
    startup: Duration.zero,
    reason: "Database reader failed: reader start failed",
  },
  {
    failure: "a startup timeout",
    workers: { silent: true },
    startup: Duration.seconds(10),
    reason: "Database reader did not open the database within 10000 ms",
  },
])(
  "reads on the writer after $failure until a retry starts the reader again",
  ({ workers, startup, reason }) =>
    withLogLines((lines) =>
      withReaderClient((sql) =>
        Effect.gen(function* () {
          const failed = yield* withWorkers(
            workers,
            Effect.gen(function* () {
              const read = yield* Effect.forkChild(readConnection(sql), {
                startImmediately: true,
              });
              yield* TestClock.adjust(startup);
              return yield* Fiber.join(read);
            }),
          );
          assert.deepEqual(failed, { count: 1, connection: ["writer"] });
          const startedBefore = startedWorkers.length;
          assert.deepEqual(yield* readConnection(sql), { count: 1, connection: ["writer"] });
          assert.equal(startedWorkers.length, startedBefore);
          assert.deepEqual(yield* Queue.take(lines), ["Warn", unavailableWarning, { reason }]);

          yield* TestClock.adjust("1 second");
          assert.equal(startedWorkers.length, startedBefore + 1);
          assert.deepEqual(yield* Queue.take(lines), [
            "Info",
            "SQLite reader worker available again; reads use the reader workers",
          ]);
          assert.deepEqual(yield* readConnection(sql), { count: 1, connection: ["reader"] });
          assert.equal(Queue.sizeUnsafe(lines), 0);
        }),
      ),
    ),
);

it.effect("backs off a reader that never starts without logging each retry", () =>
  withLogLines((lines) =>
    withReaderClient((sql) =>
      withWorkers(
        { silent: true },
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(readConnection(sql), { startImmediately: true });
          yield* TestClock.adjust("10 seconds");
          assert.deepEqual(yield* Fiber.join(read), { count: 1, connection: ["writer"] });

          const startedBefore = startedWorkers.length;
          // Each retry waits 10 s for startup; the gaps between them double from 1 s up to a minute.
          yield* TestClock.adjust("10 minutes");
          assert.equal(startedWorkers.length - startedBefore, 12);
          assert.equal(Queue.sizeUnsafe(lines), 1);
        }),
      ),
    ),
  ),
);

it.effect.each([
  { phase: "the retry waits", beforeClose: Duration.zero, retries: 0 },
  { phase: "a retried reader starts", beforeClose: Duration.seconds(1), retries: 1 },
])("stops retrying the reader when the client closes while $phase", ({ beforeClose, retries }) =>
  withWorkers(
    { silent: true },
    Effect.gen(function* () {
      const startedAtClose = yield* withReaderClient((sql) =>
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(readConnection(sql), { startImmediately: true });
          yield* TestClock.adjust("10 seconds");
          assert.deepEqual(yield* Fiber.join(read), { count: 1, connection: ["writer"] });

          const startedBefore = startedWorkers.length;
          yield* TestClock.adjust(beforeClose);
          assert.equal(startedWorkers.length - startedBefore, retries);
          return startedWorkers.length;
        }),
      );
      yield* TestClock.adjust("10 minutes");
      assert.equal(startedWorkers.length, startedAtClose);
    }),
  ),
);

it.effect.each([
  {
    when: "the database is not in WAL mode",
    journalMode: "DELETE",
    workers: {},
    starts: 1,
    logged: [["Warn", unavailableWarning, { reason: notWal }]],
  },
  {
    when: "a retry finds the database out of WAL mode",
    journalMode: "WAL",
    workers: { failWith: "reader start failed" },
    starts: 2,
    logged: [
      ["Warn", unavailableWarning, { reason: "Database reader failed: reader start failed" }],
      [
        "Info",
        "SQLite reader worker retries stopped permanently; reads use the writer",
        { reason: notWal },
      ],
    ],
  },
])(
  "keeps readers off without further retries when $when",
  ({ journalMode, workers, starts, logged }) =>
    withLogLines((lines) =>
      withFileClient((sql) =>
        Effect.gen(function* () {
          yield* sql.unsafe(`PRAGMA journal_mode = ${journalMode}`);
          yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
          yield* sql`INSERT INTO entries VALUES ('kept')`;
          const startedBefore = startedWorkers.length;

          const failed = yield* withWorkers(workers, readConnection(sql));
          assert.deepEqual(failed, { count: 1, connection: ["writer"] });
          yield* sql`PRAGMA journal_mode = DELETE`;
          yield* TestClock.adjust("1 second");
          yield* Effect.promise(() => workerExits.get(startedWorkers.at(-1)!)!);
          yield* TestClock.adjust("1 hour");
          assert.deepEqual(yield* readConnection(sql), { count: 1, connection: ["writer"] });
          assert.equal(startedWorkers.length, startedBefore + starts);
          assert.deepEqual(yield* Queue.clear(lines), logged);
        }),
      ),
    ),
);

it.effect("fails with a typed SqlError when the database file is not SQLite", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-notadb-" });
    const filename = path.join(directory, "state.sqlite");
    yield* fs.writeFileString(filename, "not a db\n");

    const exit = yield* Layer.build(SqliteClient.layer({ filename, writerWorker: true })).pipe(
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.isTrue(SqlError.isSqlError(Cause.squash(exit.cause)));
    if (Exit.isFailure(exit)) assert.isFalse(Cause.hasDies(exit.cause));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets the worker's queued messages land, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect.each([
  { reservation: false, masked: false },
  { reservation: false, masked: true },
  { reservation: true, masked: false },
  { reservation: true, masked: true },
])(
  "preserves caller cancellation while waiting (reservation=$reservation, masked=$masked)",
  ({ reservation, masked }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const body = sql`INSERT INTO entries VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
      );
      const acquire = reservation
        ? Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* sql.reserve;
              yield* connection.executeUnprepared("INSERT INTO entries VALUES (1)", [], undefined);
              yield* Deferred.succeed(entered, undefined);
            }),
          )
        : sql.withTransaction(body);
      const waiter = yield* Effect.forkChild(masked ? Effect.uninterruptible(acquire) : acquire, {
        startImmediately: true,
      });
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.gen(function* () {
        yield* eventLoopTurn;
        assert.equal(cancelled.pollUnsafe() !== undefined, !masked);
        assert.isFalse(yield* Deferred.isDone(entered));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
      yield* Fiber.join(cancelled);
      assert.equal(yield* Deferred.isDone(entered), masked);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
      assert.deepEqual(
        yield* sql`SELECT value FROM entries ORDER BY value`.values,
        masked ? [[1], [2]] : [[2]],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps writes moving while an outside reader pins the WAL, then trims the WAL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-pinned-wal-" });
    const filename = path.join(directory, "state.sqlite");
    // Stands in for `sqlite3 statev2.sqlite` or a backup script reading the database.
    const outside = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (db) =>
        Effect.sync(() => {
          if (db.isTransaction) db.exec("COMMIT");
          db.close();
        }),
    );
    outside.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs(data BLOB NOT NULL)");
    const walSize = fs.stat(`${filename}-wal`).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orDie,
    );
    const limit = 8 * 1024 * 1024;
    const payload = new Uint8Array(1024 * 1024).fill(7);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      yield* sql`INSERT INTO blobs VALUES (${payload})`;
      outside.exec("BEGIN");
      outside.prepare("SELECT COUNT(*) FROM blobs").get();
      for (let write = 0; write < 24; write++) yield* sql`INSERT INTO blobs VALUES (${payload})`;
      assert.isAbove(yield* walSize, limit);
      outside.exec("COMMIT");
      const checkpointer = checkpointWorkers.at(-1)!;
      const caughtUp = Effect.callback<void>((resume) => {
        const onMessage = (message: { type?: unknown; log?: unknown; checkpointed?: unknown }) => {
          if (
            message?.type === "checked" &&
            typeof message.log === "number" &&
            message.log > 0 &&
            message.log === message.checkpointed
          ) {
            resume(Effect.void);
          }
        };
        checkpointer.on("message", onMessage);
        checkpointer.ref();
        return Effect.sync(() => {
          checkpointer.off("message", onMessage);
          checkpointer.unref();
        });
      });
      // The worker checkpoints the released frames; the next write restarts the WAL at the limit.
      yield* Effect.all([caughtUp, sql`DELETE FROM blobs WHERE rowid = 1`], { concurrency: 2 });
      yield* sql`DELETE FROM blobs WHERE rowid = 2`;
      assert.isAtMost(yield* walSize, limit);
      assert.deepEqual(yield* sql`SELECT COUNT(*) FROM blobs`.values, [[23]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
