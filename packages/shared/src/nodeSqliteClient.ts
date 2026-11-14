import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  /** Ignored for in-memory databases, which cannot share a second connection. */
  readonly readerWorker?: boolean | undefined;
  /** Runs the writer and WAL checkpoints off the event loop. Ignored for in-memory databases. */
  readonly writerWorker?: boolean | undefined;
  readonly checkpointGateBound?: Duration.Input | undefined;
}

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

interface Lease {
  readonly connection: Acquired["connection"];
  readonly value: Connection;
  /** The writer was held by another borrower when this lease asked for it. */
  readonly contended?: boolean;
  /** The writer's borrower when this lease asked for it, for the lock-wait trace. */
  readonly ownerAtWaitStart?: ConnectionOwner | undefined;
  readonly release: Effect.Effect<void>;
}

interface ConnectionOwner {
  readonly fiberId: number;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>): ConnectionOwner => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent: Tracer.AnySpan | undefined = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") break;
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

const annotateAcquired = (
  fiber: Fiber.Fiber<unknown, unknown>,
  acquired: Acquired | undefined,
  ownerAtWaitStart?: ConnectionOwner,
) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
  if (ownerAtWaitStart !== undefined) {
    span.attribute("db.lock_owner_at_start.fiber_id", ownerAtWaitStart.fiberId);
    span.attribute("db.lock_owner_at_start.name", ownerAtWaitStart.name);
    if (ownerAtWaitStart.traceId !== undefined) {
      span.attribute("db.lock_owner_at_start.trace_id", ownerAtWaitStart.traceId);
    }
    if (ownerAtWaitStart.spanId !== undefined) {
      span.attribute("db.lock_owner_at_start.span_id", ownerAtWaitStart.spanId);
    }
  }
};

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

interface TransactionTiming {
  readonly clock: Clock.Clock;
  span?: Tracer.Span;
  admissionMs: number;
  beginMs: number;
  bodyMs: number;
  commitMs: number;
  checkpointEpisodeId?: string;
  readonly checkpointReasons: Set<string>;
}

const TransactionAcquire = Context.Reference<
  | {
      acquired?: Acquired;
      ownerAtWaitStart: ConnectionOwner | undefined;
      restore: Restore | undefined;
      timing?: TransactionTiming;
    }
  | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

const checkNodeSqliteCompat = Effect.fn("checkNodeSqliteCompat")(function () {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
});

// node:sqlite supplies errcode; classifySqliteError expects errno.
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

// SQLite retains text/blob bindings until rebind or finalization; node:sqlite cannot clear them.
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // Named parameters may be callable objects; read data properties only to avoid invoking getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

// Inline worker source also runs in bundles and single-executable builds without module files.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const describe = (error) => ({
  message: String(error && error.message ? error.message : error),
  code: error && error.code,
  errcode: error && error.errcode,
  errstr: error && error.errstr,
});
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Reads the header, so a file that is not a database fails here rather than on first use.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  if (workerData.requireWal && mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", ...describe(error) });
}
const writes = new WeakMap();
let classifying;
const constants = require("node:sqlite").constants;
const hasAuthorizer = typeof db?.setAuthorizer === "function" &&
  ["SQLITE_OK", "SQLITE_TRANSACTION", "SQLITE_SAVEPOINT", "SQLITE_PRAGMA", "SQLITE_READ", "SQLITE_SELECT", "SQLITE_FUNCTION", "SQLITE_RECURSIVE"]
    .every((name) => typeof constants?.[name] === "number");
if (workerData.writer && hasAuthorizer) {
  const persistentPragmas = new Set(["application_id", "auto_vacuum", "journal_mode", "schema_version", "user_version"]);
  db.setAuthorizer((code, action, argument) => {
    if (classifying === undefined) return constants.SQLITE_OK;
    if (code === constants.SQLITE_TRANSACTION || code === constants.SQLITE_SAVEPOINT) {
      classifying.writes ||= action === "BEGIN";
    } else if (code === constants.SQLITE_PRAGMA) {
      const name = action?.toLowerCase();
      classifying.writes ||= name === "incremental_vacuum" || name === "optimize" ||
        (argument !== null && persistentPragmas.has(name));
    } else if (![constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(code)) {
      classifying.writes = true;
    }
    return constants.SQLITE_OK;
  });
}
// EXPLAIN compiles without executing: older Node lacks the authorizer, and SQL text
// cannot distinguish a CTE read from a write or a persistent PRAGMA from a connection setting.
const writesWithoutAuthorizer = (sql) => {
  try {
    return db.prepare("EXPLAIN " + sql).all().some((op) =>
      (op.opcode === "Transaction" && op.p2 !== 0) ||
      ((op.opcode === "AutoCommit" || op.opcode === "Savepoint") && op.p1 === 0) ||
      (op.opcode === "JournalMode" && op.p3 !== -1) ||
      ["Vacuum", "VUpdate", "VCreate", "VDestroy"].includes(op.opcode));
  } catch { return true; }
};
const prepareStatement = (sql) => {
  const current = { writes: false };
  classifying = current;
  try {
    const statement = db.prepare(sql);
    writes.set(statement, workerData.writer && (hasAuthorizer ? current.writes : writesWithoutAuthorizer(sql)));
    return statement;
  } finally { classifying = undefined; }
};
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return prepareStatement(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = prepareStatement(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
let admission;
let episode;
const reportEpisode = (outcome, state) => {
  if (episode === undefined) return;
  parentPort.postMessage({ type: "checkpoint-episode", attributes: {
    episodeId: episode.id, outcome, reasons: [...episode.reasons].join(","),
    durationMs: performance.now() - episode.startedAt,
    startLog: episode.startLog, startCheckpointed: episode.startCheckpointed,
    endLog: state.log, endCheckpointed: state.checkpointed, peakLog: episode.peakLog,
    writersHeld: episode.writersHeld, writesWhileReleased: episode.writesWhileReleased,
    regates: episode.regates, releasedAfterMs: episode.releasedAfterMs,
  }});
  episode = undefined;
};
const walState = () => db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
const admit = (request) => {
  let state;
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    if (db.isTransaction || !workerData.writer || !writes.get(prepare(request.sql, request.cached))) {
      parentPort.postMessage({ id: request.id, rows: [] });
      return;
    }
    state = walState();
    if (state.log < workerData.backstop || (state.log === state.checkpointed && state.log < workerData.frameLimit)) {
      reportEpisode("cleared", state);
      parentPort.postMessage({ id: request.id, rows: [] });
      return;
    }
    const released = episode?.releasedAt;
    if (released && state.log < workerData.frameLimit &&
        state.log >= released.log && state.checkpointed <= released.checkpointed) {
      episode.peakLog = Math.max(episode.peakLog, state.log);
      episode.writesWhileReleased++;
      parentPort.postMessage({ id: request.id, rows: [] });
      return;
    }
    if (episode === undefined) episode = {
      id: require("node:crypto").randomUUID(), startedAt: performance.now(),
      startLog: state.log, startCheckpointed: state.checkpointed, peakLog: state.log,
      writersHeld: 0, writesWhileReleased: 0, regates: 0, reasons: new Set(["wal-ceiling"]),
    };
    if (released) episode.regates++;
    episode.releasedAt = undefined;
    episode.writersHeld++;
    const current = { id: request.id, startedAt: performance.now(), timer: undefined };
    admission = current;
    parentPort.postMessage({ type: "admission-wait", id: request.id, episodeId: episode.id });
    const check = () => {
      if (admission !== current) return;
      try {
        db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        state = walState();
        // Backfill alone cannot restart a WAL whose end mark a reader still pins.
        if (state.log >= workerData.frameLimit && state.log === state.checkpointed) {
          const busyTimeout = db.prepare("PRAGMA busy_timeout").get().timeout;
          try {
            db.exec("PRAGMA busy_timeout = 0");
            db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
            state = walState();
          } finally { db.exec("PRAGMA busy_timeout = " + busyTimeout); }
        }
        episode.peakLog = Math.max(episode.peakLog, state.log);
        const waited = performance.now() - current.startedAt;
        const cleared = state.log < workerData.backstop || (state.log === state.checkpointed && state.log < workerData.frameLimit);
        const hard = state.log >= workerData.frameLimit;
        if (hard) episode.reasons.add("release-limit");
        if (state.checkpointed < state.log) episode.reasons.add("checkpoint-pinned");
        if (cleared || (!hard && waited >= workerData.gateBoundMs)) {
          admission = undefined;
          const attributes = {
            admissionMs: waited, episodeId: episode.id, reasons: [...episode.reasons].join(","),
          };
          if (cleared) reportEpisode("cleared", state);
          else {
            episode.releasedAfterMs = waited;
            episode.releasedAt = state;
            const releasedEpisode = episode;
            reportEpisode("released", state);
            episode = releasedEpisode;
          }
          parentPort.postMessage({ id: current.id, rows: [], ...attributes });
          return;
        }
        current.timer = setTimeout(check, Math.min(50, workerData.gateBoundMs));
      } catch (error) {
        admission = undefined;
        reportEpisode("failed", state);
        parentPort.postMessage({ id: current.id, error: { operation: "execute", ...describe(error) } });
      }
    };
    check();
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: { operation: "execute", ...describe(error) } });
  }
};
parentPort.on("message", (request) => {
  if (request.type === "cancel-admission") {
    if (admission?.id === request.id) {
      clearTimeout(admission.timer);
      admission = undefined;
      reportEpisode("cancelled", walState());
    }
    return;
  }
  if (request.type === "admit") { admit(request); return; }

  if (request.type === "close") {
    if (admission !== undefined) clearTimeout(admission.timer);
    admission = undefined;
    if (episode !== undefined) reportEpisode("handed-back", walState());
    // Closing lets SQLite checkpoint and remove the WAL, which terminating would skip.
    try {
      if (db !== undefined) db.close();
    } catch {}
    parentPort.close();
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers, received } = request;
  let operation = "open";
  const startedAt = performance.now();
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      let rows = [];
      let bytes = 0;
      let pendingBatch = false;
      for (const row of statement.iterate(...params)) {
        let rowBytes = 0;
        for (const key in row) {
          const value = row[key];
          rowBytes += typeof value === "string" ? value.length * 2
            : ArrayBuffer.isView(value) ? value.byteLength : 8;
        }
        if (rows.length > 0 && (rows.length >= 16384 || bytes + rowBytes > 8 * 1024 * 1024)) {
          // Build the next batch during receipt, but allow only one unacknowledged message.
          if (pendingBatch) Atomics.wait(received, 0, 0);
          Atomics.store(received, 0, 0);
          parentPort.postMessage({ id, rows, more: true });
          rows = [];
          bytes = 0;
          pendingBatch = true;
        }
        rows.push(row);
        bytes += rowBytes;
      }
      if (pendingBatch) Atomics.wait(received, 0, 0);
      parentPort.postMessage({ id, rows, executionMs: performance.now() - startedAt, inTransaction: db.isTransaction });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [], executionMs: performance.now() - startedAt, inTransaction: db.isTransaction });
    }
  } catch (error) {
    // A failed iterator can report its previous SQLite error when the statement is reused.
    statements.delete(sql);
    parentPort.postMessage({ id, error: { operation, ...describe(error) }, inTransaction: db?.isTransaction });
  }
});
`;

interface WorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

interface WorkerFailure {
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
}

type WorkerStartup =
  | { readonly type: "ready" }
  | ({ readonly type: "unavailable" } & WorkerFailure);

type WorkerRowsChunk = {
  readonly id: number;
  readonly rows: ReadonlyArray<any>;
  readonly more: true;
};

type WorkerRowsFinal = {
  readonly id: number;
  readonly rows: ReadonlyArray<any>;
  readonly more?: false;
  readonly inTransaction?: boolean;
  readonly executionMs?: number;
  readonly admissionMs?: number;
  readonly episodeId?: string;
  readonly reasons?: string;
};

type WorkerErrorReply = {
  readonly id: number;
  readonly inTransaction?: boolean;
  readonly error: WorkerFailure & { readonly operation: "open" | "prepare" | "execute" };
};

type WorkerFinalReply = WorkerRowsFinal | WorkerErrorReply;
type WorkerReply = WorkerRowsChunk | WorkerFinalReply;

const workerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

const failedWith = (
  { message, code, errcode, errstr }: WorkerFailure,
  operation: keyof typeof workerFailureMessages,
) =>
  failed(
    Object.assign(new Error(message), { code, errcode, errstr }),
    workerFailureMessages[operation],
    operation,
  );

// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

// WAL readers run concurrently; one worker serialized every read behind the slowest transaction.
const READER_COUNT = 4;
const READER_STARTUP_TIMEOUT = Duration.seconds(10);

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeWorkerConnection = Effect.fnUntraced(function* (options: {
  readonly filename: string;
  readonly role: "reader" | "writer";
  readonly readOnly: boolean;
  readonly onReply?: () => void;
  readonly gateBoundMs?: number;
}) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const label = options.role === "reader" ? "Database reader" : "Database writer";
  const readOnly = options.readOnly;
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<WorkerStartup>;
      }
    | undefined;
  let nextRequestId = 0;
  // A replacement writer would lose the pragmas callers set on it, such as foreign_keys.
  let writerStopped: string | undefined;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(workerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        readOnly,
        requireWal: options.role === "reader",
        allowExtension: false,
        prepareCacheSize: 200,
        writer: options.role === "writer" && !readOnly,
        gateBoundMs: options.gateBoundMs ?? 1000,
        frameLimit: 250_000,
        backstop: 10_000,
      },
    });
    let announce: (startup: WorkerStartup) => void = () => {};
    const started = new Promise<WorkerStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    let writerTransaction = false;
    const pending = new Map<
      number,
      {
        readonly admission: boolean;
        cancelled: boolean;
        readonly endsTransaction: boolean;
        readonly received: Int32Array;
        readonly rows: Array<unknown>;
        readonly resume: (reply: WorkerFinalReply) => void;
      }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
      if (options.role === "writer") writerStopped = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, request] of pending) {
        if (!request.cancelled) {
          request.resume(
            request.endsTransaction
              ? { id, rows: [] }
              : { id, error: { operation: "execute", message } },
          );
        }
      }
      pending.clear();
    };
    worker.on(
      "message",
      (
        reply:
          | WorkerReply
          | WorkerStartup
          | { readonly type: "checkpoint-episode"; readonly attributes: Record<string, unknown> }
          | { readonly type: "admission-wait" },
      ) => {
        if ("type" in reply && reply.type === "checkpoint-episode") {
          const attributes = reply.attributes;
          runFork(
            Effect.logWarning("SQLite checkpoint gate held writes", attributes).pipe(
              Effect.withSpan("sqlite.checkpointGate", { root: true, level: "Warn", attributes }),
            ),
          );
          return;
        }
        if ("type" in reply && reply.type === "admission-wait") return;
        if ("type" in reply) {
          announce(reply);
          if (pending.size === 0) worker.unref();
          return;
        }
        const request = pending.get(reply.id);
        if (request === undefined) return;
        if ("rows" in reply && reply.more === true) {
          if (!request.cancelled) {
            for (const row of reply.rows) request.rows.push(row);
          }
          Atomics.store(request.received, 0, 1);
          Atomics.notify(request.received, 0);
          return;
        }
        pending.delete(reply.id);
        if (pending.size === 0) worker.unref();
        if (request.cancelled) return;
        if ("rows" in reply && request.rows.length > 0) {
          for (const row of reply.rows) request.rows.push(row);
          request.resume({ ...reply, rows: request.rows });
        } else {
          request.resume(reply);
        }
      },
    );
    worker.on("error", (cause) => stop(`${label} failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`${label} exited with code ${code}`));

    const request = (
      input: WorkerRequest,
      admission = false,
    ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        // A COMMIT that never reached a writer must fail; only its ROLLBACK is moot.
        const endsTransaction = readOnly
          ? endsReadTransaction(input.sql)
          : /^\s*ROLLBACK\b/i.test(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(failedWith({ message: stoppedMessage }, "execute"));
        }
        const timing = fiber.getRef(TransactionAcquire)?.timing;
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        const reply = Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          const received = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
          pending.set(id, {
            admission,
            cancelled: false,
            endsTransaction,
            received,
            rows: [],
            resume: (reply) => {
              if (!admission) {
                options.onReply?.();
                writerTransaction = reply.inTransaction ?? writerTransaction;
              }
              if ("rows" in reply && timing !== undefined) {
                if (admission) {
                  timing.admissionMs += reply.admissionMs ?? 0;
                  if (reply.episodeId !== undefined) timing.checkpointEpisodeId = reply.episodeId;
                  for (const reason of reply.reasons?.split(",") ?? [])
                    timing.checkpointReasons.add(reason);
                } else if (/^\s*BEGIN\b/i.test(input.sql)) timing.beginMs += reply.executionMs ?? 0;
                else if (/^\s*COMMIT\b/i.test(input.sql)) {
                  timing.commitMs += reply.executionMs ?? 0;
                  timing.span?.attribute("db.transaction.commit_ms", timing.commitMs);
                }
              }
              resume(
                "rows" in reply
                  ? Effect.succeed(reply.rows)
                  : Effect.fail(failedWith(reply.error, reply.error.operation)),
              );
            },
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          worker.postMessage({
            id,
            safeIntegers,
            ...input,
            cached,
            received,
            ...(admission ? { type: "admit" } : {}),
          });
          return Effect.sync(() => {
            const request = pending.get(id);
            if (admission) {
              pending.delete(id);
            } else if (request !== undefined) {
              // A cancelled read stays registered to acknowledge chunks until its final reply.
              request.cancelled = true;
              request.rows.length = 0;
            }
            if (pending.size === 0) worker.unref();
            Atomics.store(received, 0, 1);
            Atomics.notify(received, 0);
            if (admission) {
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
              worker.postMessage({ type: "cancel-admission", id });
            }
          });
        });
        // A posted write runs to the end, as it did on the event loop; the caller and its lock
        // must not move on while the worker is still applying it. Reads stay cancellable.
        if (admission) return (fiber.getRef(TransactionAcquire)?.restore ?? identity)(reply);
        if (options.role !== "writer") return reply;
        const needsAdmission =
          !writerTransaction && !/^\s*(SELECT|EXPLAIN|COMMIT|ROLLBACK)\b/i.test(input.sql);
        return needsAdmission
          ? request(input, true).pipe(Effect.andThen(Effect.uninterruptible(reply)))
          : Effect.uninterruptible(reply);
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // Read snapshots need deferred BEGIN; readonly connections reject IMMEDIATE and EXCLUSIVE.
        const statement = readOnly && /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const open = current;
      if (open === undefined) return;
      if (options.role === "writer") {
        await new Promise<void>((resolve) => {
          open.worker.once("exit", () => resolve());
          open.worker.ref();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          open.worker.postMessage({ type: "close" });
        });
      }
      await open.worker.terminate();
    }),
  );

  const retire = (worker: NodeWorkerThreads.Worker) => {
    if (current?.worker === worker) current = undefined;
    void worker.terminate();
  };

  return Effect.suspend((): Effect.Effect<Connection, SqlError> => {
    if (current === undefined && writerStopped !== undefined) {
      return Effect.fail(failedWith({ message: writerStopped }, "execute"));
    }
    let entry: NonNullable<typeof current>;
    try {
      entry = current ?? start();
    } catch (cause) {
      return Effect.fail(failed(cause, workerFailureMessages.open, "open"));
    }
    const started = Effect.promise(() => entry.started);
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        // Readers fall back to the writer; the writer has no fallback, so a slow disk only delays it.
        return restore(
          options.role === "reader"
            ? Effect.timeoutOption(started, READER_STARTUP_TIMEOUT)
            : Effect.asSome(started),
        );
      }),
      (startup): Effect.Effect<Connection, SqlError> => {
        const outcome = Option.getOrUndefined(startup);
        if (outcome?.type === "ready") {
          // A late ready event must not hand out a worker retired by another acquire timeout.
          return current === entry
            ? Effect.succeed(entry.connection)
            : Effect.fail(failedWith({ message: `${label} stopped while starting` }, "open"));
        }
        retire(entry.worker);
        return Effect.fail(
          failedWith(
            outcome ?? {
              message: `${label} did not open the database within ${Duration.toMillis(READER_STARTUP_TIMEOUT)} ms`,
            },
            "open",
          ),
        );
      },
    );
  });
});

// A reader that cannot start turns off the whole pool, so routing never picks a dead slot.
const makeReader = Effect.fnUntraced(function* (filename: string, pool: { unavailable: boolean }) {
  const acquire = yield* makeWorkerConnection({ filename, role: "reader", readOnly: true });
  return Effect.suspend((): Effect.Effect<Connection | undefined> =>
    pool.unavailable
      ? Effect.undefined
      : acquire.pipe(
          Effect.map((connection) => (pool.unavailable ? undefined : connection)),
          Effect.catch((error) => {
            if (pool.unavailable) return Effect.undefined;
            pool.unavailable = true;
            const cause = error.reason.cause;
            return Effect.logWarning("SQLite reader worker unavailable; reads use the writer", {
              reason: cause instanceof Error ? cause.message : error.message,
            }).pipe(Effect.as(undefined));
          }),
        ),
  );
});

// A checkpoint copies WAL pages into the database and syncs it. On the writer's thread every
// write would wait for that sync, so a second connection checkpoints beside the writes.
const CHECKPOINT_FRAMES = 4000;
const CHECKPOINT_IDLE_MS = 100;
// If checkpoints fall behind constant writes, the writer checkpoints itself, delaying writes only.
const WRITER_BACKSTOP_FRAMES = 10_000;

const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
let frames;
let passive;
let idle;
const check = (force) => {
  if (db === undefined) {
    db = new DatabaseSync(workerData.filename);
    db.exec("PRAGMA busy_timeout = 5000;");
    // macOS requires F_FULLFSYNC to flush the drive cache.
    db.exec("PRAGMA checkpoint_fullfsync = ON;");
    frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  }
  const before = frames.get();
  let state = before;
  if (state.log - state.checkpointed >= workerData.frames || (force && state.log > state.checkpointed)) {
    passive.get();
    state = frames.get();
  }
  // The WAL restarts only once every frame is checkpointed, so catch up when writes pause.
  // A reader pinning the WAL stops progress; the next write retries instead of a timer loop.
  const progressed = !force || state.checkpointed > before.checkpointed;
  if (state.log > state.checkpointed && progressed) {
    idle = setTimeout(() => run(true), workerData.idleMs);
  }
  parentPort.postMessage({ type: "checked", log: state.log, checkpointed: state.checkpointed });
};
const run = (force) => {
  clearTimeout(idle);
  try {
    check(force);
  } catch (error) {
    parentPort.postMessage({ type: "failed", message: String(error && error.message ? error.message : error) });
  }
};
parentPort.on("message", () => run(false));
`;

const sqliteVersion = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    return String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  } finally {
    db.close();
  }
};

// Returns the writer's per-statement notification, or undefined when the writer checkpoints alone.
const startCheckpointWorker = Effect.fnUntraced(function* (filename: string) {
  const warn = (reason: string) =>
    Effect.logWarning("SQLite checkpoint worker unavailable; the writer checkpoints its own WAL", {
      reason,
    });
  const version = sqliteVersion();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, so counting frames would checkpoint on every write.
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const started = Result.try(
    () =>
      new NodeWorkerThreads.Worker(checkpointWorkerSource, {
        eval: true,
        workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
      }),
  );
  if (Result.isFailure(started)) {
    yield* warn(String(started.failure));
    return undefined;
  }
  const worker = started.success;
  worker.unref();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    void worker.terminate();
    runFork(warn(reason));
  };
  worker.on("message", (message: { readonly type?: unknown; readonly message?: unknown }) => {
    if (message?.type === "failed") stop(String(message.message));
  });
  worker.on("error", (cause) => stop(cause.message));
  worker.on("exit", (code) => stop(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      return worker.terminate();
    }),
  );
  let scheduled = false;
  return () => {
    if (stopped || scheduled) return;
    scheduled = true;
    // One check per event-loop turn is enough, however many statements finished in it.
    setImmediate(() => {
      scheduled = false;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      if (!stopped) worker.postMessage(0);
    });
  };
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite();
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values" = "rows",
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        let arrays = false;
        let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            arrays = mode === "values";
            if (arrays) statement.setReturnArrays(true);
            result = Exit.succeed(statement.all(...(params as any)));
          } else {
            const value = statement.run(...(params as any));
            result = Exit.succeed(
              mode === "raw" ? (value as unknown as ReadonlyArray<unknown>) : [],
            );
          }
        } catch (cause) {
          result = Exit.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
        if (arrays) {
          try {
            statement.setReturnArrays(false);
          } catch (cause) {
            return Exit.die(
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
            );
          }
        }
        return result;
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, raw ? "raw" : "rows"),
      );
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, "values"),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatement(statement, params ?? [], "values"),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [])),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const writerWorker = options.writerWorker === true && isFileDatabase;
  let checkpointAfterWrite: (() => void) | undefined;
  const writerConnection: Effect.Effect<Connection, SqlError> = writerWorker
    ? yield* makeWorkerConnection({
        filename: options.filename,
        role: "writer",
        readOnly: options.readonly ?? false,
        onReply: () => checkpointAfterWrite?.(),
        gateBoundMs: Duration.toMillis(
          Duration.fromInputUnsafe(options.checkpointGateBound ?? 1000),
        ),
      })
    : Effect.succeed(yield* makeConnection);
  // Opening now fails the layer for a file that is not a database, not its first query.
  const opened = yield* writerConnection;
  // Started after the writer, so it stops first and the writer's close can checkpoint.
  if (writerWorker && options.readonly !== true) {
    checkpointAfterWrite = yield* startCheckpointWorker(options.filename);
    if (checkpointAfterWrite !== undefined) {
      yield* opened.executeUnprepared(
        `PRAGMA wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES}`,
        [],
        undefined,
      );
    }
  }
  const readerPool = { unavailable: false };
  const readers =
    options.readerWorker && isFileDatabase
      ? yield* Effect.forEach(Array.from({ length: READER_COUNT }), () =>
          makeReader(options.filename, readerPool),
        )
      : undefined;
  const readerPermits = yield* Semaphore.make(READER_COUNT);
  const readerBusy = Array.from({ length: READER_COUNT }, () => false);

  // Waits for a permit as interruptibly as the caller, even inside SqlClient's
  // uninterruptible transaction acquire, then claims it with no gap in which an
  // interruption could strand it: the order `Semaphore.withPermits` uses. Run it
  // uninterruptibly.
  const claim = (permits: Semaphore.Semaphore, restore: Restore): Effect.Effect<void> =>
    restore(permits.withPermits(1)(Effect.void)).pipe(
      Effect.andThen(permits.takeIfAvailable(1)),
      Effect.flatMap((claimed) => (claimed ? Effect.void : claim(permits, restore))),
    );

  // The writer's current borrower, recorded so a borrower that waits names it.
  let activeWriter: ConnectionOwner | undefined;

  const leaseWriter = (
    fiber: Fiber.Fiber<unknown, unknown>,
    restore: Restore,
  ): Effect.Effect<Lease> => {
    const owner = connectionOwner(fiber);
    const ownerAtWaitStart = activeWriter;
    // Record the owner in the same step that takes the permit, so a borrower that
    // finds it busy always names its holder.
    return Effect.flatMap(semaphore.takeIfAvailable(1), (immediate) =>
      Effect.as(
        (immediate ? Effect.void : claim(semaphore, restore)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              activeWriter = owner;
            }),
          ),
        ),
        {
          connection: "writer" as const,
          value: opened,
          contended: !immediate,
          ownerAtWaitStart,
          release: Effect.sync(() => {
            if (activeWriter === owner) activeWriter = undefined;
          }).pipe(Effect.andThen(semaphore.release(1)), Effect.asVoid),
        },
      ),
    );
  };
  // The lowest free slot, so later workers start only when reads overlap.
  const leaseReader = (
    fiber: Fiber.Fiber<unknown, unknown>,
    available: NonNullable<typeof readers>,
    restore: Restore,
  ): Effect.Effect<Lease> =>
    Effect.flatMap(claim(readerPermits, restore), () => {
      const slot = readerBusy.indexOf(false);
      readerBusy[slot] = true;
      const release = Effect.suspend(() => {
        readerBusy[slot] = false;
        return readerPermits.release(1);
      }).pipe(Effect.asVoid);
      return restore(available[slot]!).pipe(
        Effect.onError(() => release),
        Effect.flatMap((reader): Effect.Effect<Lease> =>
          reader === undefined
            ? Effect.andThen(release, leaseWriter(fiber, restore))
            : Effect.succeed({ connection: "reader" as const, value: reader, release }),
        ),
      );
    });
  const lease = (fiber: Fiber.Fiber<unknown, unknown>, restore: Restore) =>
    Effect.uninterruptible(
      readers !== undefined && !readerPool.unavailable && Context.get(fiber.context, ReadOnly)
        ? leaseReader(fiber, readers, restore)
        : leaseWriter(fiber, restore),
    );

  const acquired = (
    taken: { readonly connection: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: taken.connection,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const borrower: Borrower = (use) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.withFiber((fiber) => {
        const clock = fiber.getRef(Clock.Clock);
        const start = clock.monotonicTimeNanosUnsafe();
        return Effect.acquireUseRelease(
          lease(fiber, restore),
          (taken) => {
            if (
              fiber.getRef(References.TracerEnabled) &&
              fiber.getRef(Statement.SpanPropagationEnabled)
            )
              annotateAcquired(fiber, acquired(taken, clock, start), taken.ownerAtWaitStart);
            return restore(Effect.suspend(() => use(taken.value)));
          },
          (taken) => taken.release,
        );
      }),
    );
  // SqlClient runs this uninterruptibly, so the caller's interruptibility comes
  // from `withTransaction` below.
  const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
    Effect.withFiber((fiber) => {
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const pending = fiber.getRef(TransactionAcquire);
      return Effect.uninterruptible(
        Effect.flatMap(lease(fiber, pending?.restore ?? restore), (taken) => {
          if (pending !== undefined) {
            pending.acquired = acquired(taken, clock, start);
            pending.ownerAtWaitStart = taken.ownerAtWaitStart;
            if (
              taken.connection === "writer" &&
              options.readonly !== true &&
              fiber.getRef(References.TracerEnabled)
            ) {
              pending.timing = {
                clock,
                admissionMs: 0,
                beginMs: 0,
                bodyMs: 0,
                commitMs: 0,
                checkpointReasons: new Set(),
              };
            }
          }
          return Effect.as(Scope.addFinalizer(scope, taken.release), taken.value);
        }),
      );
    }),
  ).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));

  const client = yield* Client.make({
    driver: "node:sqlite",
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // BEGIN IMMEDIATE avoids read-then-write SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        // SqlClient masks setup; acquisition must preserve the caller's interruptibility.
        const pending: {
          acquired?: Acquired;
          ownerAtWaitStart: ConnectionOwner | undefined;
          restore: Restore | undefined;
          timing?: TransactionTiming;
        } = {
          ownerAtWaitStart: undefined,
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired, pending.ownerAtWaitStart);
          pending.restore = undefined;
          const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
          const timing = pending.timing;
          if (timing === undefined) return effect;
          if (span?._tag === "Span") {
            timing.span = span;
            span.attribute("db.transaction.lease_wait_ms", pending.acquired!.lockWaitMs);
            span.attribute("db.transaction.checkpoint_admission_wait_ms", timing.admissionMs);
            span.attribute("db.transaction.begin_ms", timing.beginMs);
            span.attribute("db.transaction.commit_ms", 0);
            if (timing.checkpointEpisodeId !== undefined) {
              span.attribute("db.transaction.checkpoint_episode_id", timing.checkpointEpisodeId);
              span.attribute(
                "db.transaction.checkpoint_reason",
                [...timing.checkpointReasons].join(","),
              );
            }
          }
          const started = timing.clock.monotonicTimeNanosUnsafe();
          return effect.pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                timing.bodyMs = Number(timing.clock.monotonicTimeNanosUnsafe() - started) / 1e6;
                timing.span?.attribute("db.transaction.body_ms", timing.bodyMs);
              }),
            ),
          );
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
