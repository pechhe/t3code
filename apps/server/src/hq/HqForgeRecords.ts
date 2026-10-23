/**
 * What a thread's agent owes Weave's Forge record, queued rather than sent from the turn that
 * produced it (Spec #4395). Ending an agent replaces its identity, so everything it has to record
 * must reach Weave first; and a provider turn can end, or T3 restart, between a record being made
 * and Weave taking it. A row therefore waits here in `hq_build_records` until Weave accepts it,
 * and is retried for as long as Weave is unreachable. A refusal Weave states with a code is
 * permanent: the row is parked with its reason, visible through `outstanding`, instead of holding
 * the thread's later rows or spamming a person's Forge record.
 *
 * Rows go out in the order their thread made them, and a row that has to wait holds the rows of its
 * thread behind it, so its `end` only goes once nothing else of the thread's is left. A row queued
 * while its Forge item could not be read carries no Spec: the pass resolves it when it sends,
 * waiting while Weave still cannot answer, parking it when the link names no Spec at all, and
 * writing the Spec onto the row so later rows of that Spec can find it. A row belongs to the Weave
 * it was queued on, and waits while T3 is connected to another. A helper's row additionally waits
 * for the lead's session of that Spec, because the session id it must name as its parent is only
 * known once the lead's own row has been delivered, and a helper queued while its link was unread
 * resolves its lead on every attempt. A turn's usage waits for the record of its own run, because
 * that is the session Weave attributes it to; a reviewer's usage names the Forge run its own T3 run
 * reported, and waits for that report while the run's end has not been queued. That report is
 * written before the reviewer is given the answer naming its run, retrying a failed write briefly
 * first, and it keeps the T3 run it was made in, so a write that has to wait names that run rather
 * than the one its thread has moved on to.
 */
import { sameHqAddress } from "@t3tools/shared/hqOrigins";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/** A record Weave has not taken yet is tried again after this, doubling up to the cap. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;
/**
 * A reviewer's run is written into local storage before its agent is answered, because that answer
 * is the only place Weave's run id reaches T3. A write that fails is tried again this many times,
 * waiting this long after the first failed try and doubling, before the answer goes out without it.
 */
const REPORT_WRITE_ATTEMPTS = 5;
const REPORT_WRITE_BACKOFF_MS = 50;
/** Those tries as the waits between them: this long after the first failure, doubling. */
const REPORT_WRITE_RETRY = Schedule.exponential(Duration.millis(REPORT_WRITE_BACKOFF_MS)).pipe(
  Schedule.upTo({ times: REPORT_WRITE_ATTEMPTS - 1 }),
);

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const recordBase = {
  /**
   * Identifies the record, so recording the same thing twice stores one row. A session and an end
   * default to one key per thread; every other kind needs the caller's own, such as
   * `runtimes:<threadId>:<runId>`, because one thread has many.
   */
  recordKey: Schema.optional(Schema.String),
  /** The Weave the record belongs to, and the Forge item it is about, for a reader of the queue. */
  origin: Schema.optional(Schema.NullOr(Schema.String)),
  specId: Schema.optional(Schema.NullOr(Schema.String)),
  threadId: ThreadId,
} as const;

/** A lead's Forge item bind and the session it opens, sent as one record so a restart cannot split them. */
const SessionRecord = Schema.Struct({
  ...recordBase,
  kind: Schema.Literal("session"),
  bind: JsonObject,
  startSession: JsonObject,
});
/** A delegated helper's own record, which names its lead's session as its parent. */
const HelperRecord = Schema.Struct({
  ...recordBase,
  kind: Schema.Literal("helper"),
  recordKey: Schema.String,
  /** Absent when the link could not be read at queue time; delivery resolves the lead with the Spec. */
  leadThreadId: Schema.optional(ThreadId),
  /** The T3 run that did the work, which is how that run's own usage finds this record. */
  t3RunId: Schema.optional(Schema.String),
  args: JsonObject,
});
const UsageRecord = Schema.Struct({
  ...recordBase,
  kind: Schema.Literal("usage"),
  recordKey: Schema.String,
  /** The T3 run that spent the tokens; never sent, it only picks this thread's record for it. */
  t3RunId: Schema.optional(Schema.String),
  args: JsonObject,
});
const RuntimesRecord = Schema.Struct({
  ...recordBase,
  kind: Schema.Literal("runtimes"),
  recordKey: Schema.String,
  args: JsonObject,
});
/** The HQ agent's end, which runs only after everything else its thread recorded. */
const EndRecord = Schema.Struct({
  ...recordBase,
  kind: Schema.Literal("end"),
  role: Schema.String,
});

const HqForgeRecordInput = Schema.Union([
  SessionRecord,
  HelperRecord,
  UsageRecord,
  RuntimesRecord,
  EndRecord,
]);
/** A record to queue: its kind chooses what reaches Weave and in what order. */
export type HqForgeRecordInput = typeof HqForgeRecordInput.Type;
export type HqForgeRecordKind = HqForgeRecordInput["kind"];
export type HqForgeRecordStatus = "pending" | "delivered" | "parked";

/** One queued record as `outstanding` reports it. */
export interface HqForgeRecord {
  readonly recordKey: string;
  readonly origin: string | null;
  readonly specId: string | null;
  readonly threadId: ThreadId;
  readonly kind: HqForgeRecordKind;
  readonly status: HqForgeRecordStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  /** Weave's answer when it took the record, such as the session a lead's row opened. */
  readonly result: unknown;
}

/** A reviewer's own Forge run, recorded for whoever reports its run times. */
export interface HqForgeReviewerRun {
  readonly reviewerThreadId: ThreadId;
  readonly runId: string;
  /** The T3 run the reviewer reported it in, which is what that run's own usage names. */
  readonly t3RunId: string | null;
  readonly specId: string | null;
  readonly createdAt: number;
}

const SessionPayload = Schema.Struct({ bind: JsonObject, startSession: JsonObject });
const HelperPayload = Schema.Struct({
  leadThreadId: Schema.optional(ThreadId),
  t3RunId: Schema.optional(Schema.String),
  args: JsonObject,
});
const UsagePayload = Schema.Struct({ t3RunId: Schema.optional(Schema.String), args: JsonObject });
const ArgsPayload = Schema.Struct({ args: JsonObject });
const EndPayload = Schema.Struct({ role: Schema.String });
const decodeSessionPayload = Schema.decodeUnknownOption(SessionPayload);
const decodeHelperPayload = Schema.decodeUnknownOption(HelperPayload);
const decodeUsagePayload = Schema.decodeUnknownOption(UsagePayload);
const decodeArgsPayload = Schema.decodeUnknownOption(ArgsPayload);
const decodeEndPayload = Schema.decodeUnknownOption(EndPayload);
/** A session row's answer: the session Weave opened, which a helper names as its parent. */
const HqSession = Schema.Struct({
  session: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  sessionId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});
const decodeSession = Schema.decodeUnknownOption(HqSession);
/** The generation Weave's bind returned, which a session has to be opened under. */
const decodeBoundGeneration = Schema.decodeUnknownOption(
  Schema.Struct({ generation: Schema.Number }),
);

/** The session a row's answer named, which a helper's parent or a turn's attribution uses. */
const sessionIdOf = (resultJson: string | null): string | null => {
  const answer = resultJson === null ? Option.none<unknown>() : decodeJson(resultJson);
  if (Option.isNone(answer)) return null;
  return Option.getOrNull(
    Option.flatMap(decodeSession(answer.value), (session) =>
      Option.fromNullishOr(session.session?.id ?? session.sessionId ?? session.id),
    ),
  );
};

/** The T3 run a helper row recorded, which the usage of that run is attributed to. */
const t3RunIdOf = (payloadJson: string): string | null =>
  Option.getOrNull(
    decodeJson(payloadJson).pipe(
      Option.flatMap(decodeHelperPayload),
      Option.flatMap((payload) => Option.fromNullishOr(payload.t3RunId)),
    ),
  );

export class HqForgeRecordError extends Schema.TaggedError<HqForgeRecordError>()(
  "HqForgeRecordError",
  {
    operation: Schema.Literals(["enqueue", "read", "deliver", "forget"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 could not ${this.operation} what a thread owes Weave's Forge record.`;
  }
}

export class HqForgeRecords extends Context.Service<
  HqForgeRecords,
  {
    /** Queues a record. A record whose key is already queued is left alone, so this is free to repeat. */
    readonly enqueue: (record: HqForgeRecordInput) => Effect.Effect<void, HqForgeRecordError>;
    /** The records a thread, or any thread, still owes Weave: `pending` ones and `parked` ones. */
    readonly outstanding: (options?: {
      readonly threadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<HqForgeRecord>, HqForgeRecordError>;
    /** A reviewer's own Forge runs, recorded from what Weave answered its `hq_build_run` call. */
    readonly reviewerRuns: Effect.Effect<ReadonlyArray<HqForgeReviewerRun>, HqForgeRecordError>;
    /** Drops what a deleted thread still owes: nothing can act as it any more. */
    readonly forgetThread: (threadId: ThreadId) => Effect.Effect<void, HqForgeRecordError>;
    /** Tries every record that is due once. The worker runs this; a test can drive it directly. */
    readonly deliverDue: Effect.Effect<void, HqForgeRecordError>;
    /** Records a reviewer's run and delivers what is owed, waking on a new record or a new HQ. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/hq/HqForgeRecords") {}

/** What one attempt did, all of which the queue knows how to record. */
type DeliveryOutcome =
  | { readonly _tag: "delivered"; readonly value: unknown }
  | { readonly _tag: "refused"; readonly code: string }
  | { readonly _tag: "retry"; readonly reason: string }
  /** Waiting on another row of its own: not an attempt, so nothing is counted against it. */
  | { readonly _tag: "blocked" };

const delivered = (value: unknown): DeliveryOutcome => ({ _tag: "delivered", value });
const refused = (code: string): DeliveryOutcome => ({ _tag: "refused", code });
const retry = (reason: string): DeliveryOutcome => ({ _tag: "retry", reason });
const blocked: DeliveryOutcome = { _tag: "blocked" };

/** Whether a thread's own row has reached Weave, and the session its answer named if it has. */
type DeliveredSession =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "delivered"; readonly sessionId: string | null };

/**
 * The order one thread's rows go out in. The row that opens its session first, because usage waits
 * for it and would otherwise hold it back; then what the thread did; then its end, which nothing
 * else of the thread may follow or be left behind by.
 */
const ROW_ORDER_GROUP: Record<HqForgeRecordInput["kind"], number> = {
  session: 0,
  helper: 0,
  usage: 1,
  runtimes: 1,
  end: 2,
};

/** How long a row waits after its `attempts`th failure, so a long outage costs few calls. */
const retryDelay = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

/**
 * The key a record is stored under: one per thread for a session or an end when the caller names
 * none, because a thread opens one of each unless it links another item or runs again.
 */
const defaultRecordKey = (record: HqForgeRecordInput) =>
  record.kind === "session" || record.kind === "end"
    ? (record.recordKey ?? `${record.kind}:${record.threadId}`)
    : record.recordKey;

const payloadOf = (record: HqForgeRecordInput): unknown => {
  switch (record.kind) {
    case "session":
      return { bind: record.bind, startSession: record.startSession };
    case "helper":
      return {
        leadThreadId: record.leadThreadId,
        t3RunId: record.t3RunId,
        args: record.args,
      };
    case "usage":
      return { t3RunId: record.t3RunId, args: record.args };
    case "runtimes":
      return { args: record.args };
    case "end":
      return { role: record.role };
  }
};

/** A row as the queue reads it, including the payload and answer it keeps in JSON. */
interface Row {
  readonly recordKey: string;
  readonly origin: string | null;
  readonly specId: string | null;
  readonly threadId: ThreadId;
  readonly kind: HqForgeRecordInput["kind"];
  readonly payloadJson: string;
  readonly status: HqForgeRecordStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly resultJson: string | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hq = yield* HqAgentConnections.HqAgentConnections;
  const buildSpec = yield* ForgeSpecOfThread.ForgeSpecOfThread;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const wakeups = yield* Queue.unbounded<void>();
  /** Shared by the pass and by a read of the runs, so neither meets a report in neither place. */
  const reviewerRunDrain = yield* Semaphore.make(1);

  const failed = (operation: HqForgeRecordError["operation"], cause: unknown) =>
    new HqForgeRecordError({ operation, cause });

  const rowsOf = (rows: ReadonlyArray<Row>) =>
    rows.map((row): HqForgeRecord => ({
      recordKey: row.recordKey,
      origin: row.origin,
      specId: row.specId,
      threadId: row.threadId,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt,
      result: row.resultJson === null ? null : Option.getOrUndefined(decodeJson(row.resultJson)),
    }));

  const enqueue: HqForgeRecords["Service"]["enqueue"] = Effect.fn("HqForgeRecords.enqueue")(
    function* (record) {
      const now = yield* Clock.currentTimeMillis;
      const payload = yield* Effect.sync(() => encodeJson(payloadOf(record)));
      // Weave has already accepted a record with this key, so queueing it again changes nothing.
      yield* sql`INSERT INTO hq_build_records
        (record_key, origin, spec_id, thread_id, kind, payload_json, status, attempts,
          next_attempt_at, created_at)
        VALUES (${defaultRecordKey(record)}, ${record.origin ?? null}, ${record.specId ?? null},
          ${record.threadId}, ${record.kind}, ${payload}, 'pending', 0, ${now}, ${now})
        ON CONFLICT (record_key) DO NOTHING`;
      // A new record is due at once; it must not wait out another row's backoff.
      yield* Queue.offer(wakeups, undefined);
    },
    Effect.mapError((cause) => failed("enqueue", cause)),
  );

  const outstanding: HqForgeRecords["Service"]["outstanding"] = (options) =>
    sql<Row>`
      SELECT record_key AS "recordKey", origin, spec_id AS "specId", thread_id AS "threadId", kind,
        payload_json AS "payloadJson", status, attempts, next_attempt_at AS "nextAttemptAt",
        last_error AS "lastError", result_json AS "resultJson", created_at AS "createdAt",
        delivered_at AS "deliveredAt"
      FROM hq_build_records
      WHERE status <> 'delivered' AND (${options?.threadId ?? null} IS NULL OR thread_id = ${options?.threadId ?? null})
      ORDER BY created_at, rowid
    `.pipe(
      Effect.map(rowsOf),
      Effect.mapError((cause) => failed("read", cause)),
    );

  /**
   * The T3 run a thread is on now. A reviewer's usage names the Forge run its own T3 run reported,
   * so the run is read while the report is made and stamped onto it: by the time the report is
   * written, or written again after a failure, the thread may be on another run.
   */
  const reportedRunIdOf = Effect.fn("HqForgeRecords.reportedRunIdOf")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* projections.getThreadShell(threadId);
    // A thread that no longer exists has no run to name; its run keeps the latest-report fallback.
    return shell?.latestRunId ?? null;
  });

  /**
   * Records the reviewer runs reported so far. The runs are only forgotten once their rows are
   * stored, so a failed insert leaves them for the next drain instead of losing them.
   */
  const drainReportedRuns = Effect.gen(function* () {
    const reported = yield* hq.reportedRuns;
    if (reported.length === 0) return;
    for (const report of reported) {
      const now = yield* Clock.currentTimeMillis;
      // The run the report was made in, which a report whose write had to wait must keep naming
      // rather than the one its thread has moved on to. Only a report nothing stamped falls back.
      const t3RunId = report.t3RunId ?? (yield* reportedRunIdOf(report.threadId));
      yield* sql`INSERT INTO hq_build_reviewer_runs
        (reviewer_thread_id, run_id, t3_run_id, spec_id, created_at)
        VALUES (${report.threadId}, ${report.runId}, ${t3RunId}, ${report.specId}, ${now})
        ON CONFLICT (reviewer_thread_id, run_id)
          DO UPDATE SET spec_id = coalesce(excluded.spec_id, spec_id),
            t3_run_id = coalesce(excluded.t3_run_id, t3_run_id)`;
    }
    yield* hq.forgetReportedRuns(reported);
  });

  /** The drain as the queue runs it: one at a time, so a reader never meets a report in neither place. */
  const recordReportedRuns = reviewerRunDrain.withPermits(1)(drainReportedRuns);

  /**
   * The drain as the proxied answer runs it: the reviewer waits for its run to be on record, so a
   * write that fails a moment is tried again before the answer goes out. Every try failing leaves
   * the run reported for the queue's next pass, which is better than holding the agent for ever.
   */
  const recordReportedRunsBeforeAnswering = recordReportedRuns.pipe(
    Effect.retry(REPORT_WRITE_RETRY),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record a reviewer's Weave run", cause),
    ),
  );

  const reviewerRuns: HqForgeRecords["Service"]["reviewerRuns"] = reviewerRunDrain.withPermits(1)(
    Effect.gen(function* () {
      // A run reported just before its thread finished may still be only in the connection's memory,
      // so reading one is what records it: completion would otherwise find no run to record times
      // against, and a restart would lose the run altogether.
      yield* drainReportedRuns;
      const rows = yield* sql<{
        readonly reviewerThreadId: ThreadId;
        readonly runId: string;
        readonly t3RunId: string | null;
        readonly specId: string | null;
        readonly createdAt: number;
      }>`
        SELECT reviewer_thread_id AS "reviewerThreadId", run_id AS "runId",
          t3_run_id AS "t3RunId", spec_id AS "specId", created_at AS "createdAt"
        FROM hq_build_reviewer_runs
        ORDER BY created_at, rowid
      `;
      return rows;
    }).pipe(Effect.mapError((cause) => failed("read", cause))),
  );

  const forgetThread: HqForgeRecords["Service"]["forgetThread"] = Effect.fn(
    "HqForgeRecords.forgetThread",
  )(
    function* (threadId) {
      yield* sql`DELETE FROM hq_build_records WHERE thread_id = ${threadId} AND status <> 'delivered'`;
    },
    Effect.mapError((cause) => failed("forget", cause)),
  );

  /** The session a lead's delivered row opened for this Spec, which its turns count toward. */
  const deliveredLeadSessionOf = Effect.fn("HqForgeRecords.deliveredLeadSessionOf")(function* (
    threadId: ThreadId,
    specId: string | null,
  ): Effect.fn.Return<DeliveredSession, HqForgeRecordError> {
    const [row] = yield* sql<{ readonly resultJson: string | null }>`
      SELECT result_json AS "resultJson" FROM hq_build_records
      WHERE thread_id = ${threadId} AND kind = 'session' AND status = 'delivered'
        AND (${specId} IS NULL OR spec_id = ${specId})
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `.pipe(Effect.mapError((cause) => failed("deliver", cause)));
    if (row === undefined) return { _tag: "waiting" };
    return { _tag: "delivered", sessionId: sessionIdOf(row.resultJson) };
  });

  /**
   * The session the record of one T3 run opened, which is what that run's own usage counts toward.
   * A usage row naming a run whose record has not reached Weave waits rather than taking another
   * run's session, so a follow-up run is never attributed to the one before it.
   */
  const deliveredRunSessionOf = Effect.fn("HqForgeRecords.deliveredRunSessionOf")(function* (
    threadId: ThreadId,
    specId: string | null,
    t3RunId: string | null,
  ): Effect.fn.Return<DeliveredSession, HqForgeRecordError> {
    const rows = yield* sql<{
      readonly payloadJson: string;
      readonly resultJson: string | null;
    }>`
      SELECT payload_json AS "payloadJson", result_json AS "resultJson" FROM hq_build_records
      WHERE thread_id = ${threadId} AND kind = 'helper' AND status = 'delivered'
        AND (${specId} IS NULL OR spec_id = ${specId})
      ORDER BY created_at DESC, rowid DESC
    `.pipe(Effect.mapError((cause) => failed("deliver", cause)));
    // A row that names no run keeps the record of the thread's latest one.
    const row =
      t3RunId === null
        ? rows[0]
        : rows.find((candidate) => t3RunIdOf(candidate.payloadJson) === t3RunId);
    if (row === undefined) return { _tag: "waiting" };
    return { _tag: "delivered", sessionId: sessionIdOf(row.resultJson) };
  });

  /** A reviewer's own Forge run, as reported behind the proxy. */
  const reviewerRunIdOf = Effect.fn("HqForgeRecords.reviewerRunIdOf")(function* (
    threadId: ThreadId,
    t3RunId: string | null,
  ): Effect.fn.Return<string | null, HqForgeRecordError> {
    // A usage row naming no T3 run keeps the thread's latest report, as it did before the run was
    // recorded: only a report that names its run can be matched to it.
    const read =
      t3RunId === null
        ? sql<{ readonly runId: string }>`
            SELECT run_id AS "runId" FROM hq_build_reviewer_runs
            WHERE reviewer_thread_id = ${threadId}
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          `
        : sql<{ readonly runId: string }>`
            SELECT run_id AS "runId" FROM hq_build_reviewer_runs
            WHERE reviewer_thread_id = ${threadId} AND t3_run_id = ${t3RunId}
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          `;
    const rows = yield* read.pipe(Effect.mapError((cause) => failed("deliver", cause)));
    return rows[0]?.runId ?? null;
  });

  /**
   * Whether a run's end has been queued. Nothing reports a run once its end is queued, so a reviewer
   * whose usage found no report of its run takes its end as the answer that none is coming.
   */
  const endQueued = Effect.fn("HqForgeRecords.endQueued")(function* (
    threadId: ThreadId,
    t3RunId: string,
  ): Effect.fn.Return<boolean, HqForgeRecordError> {
    const rows = yield* sql<{ readonly present: number }>`
      SELECT 1 AS present FROM hq_build_records
      WHERE record_key = ${`end:${threadId}:${t3RunId}`}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => failed("deliver", cause)));
    return rows.length > 0;
  });

  /**
   * What Weave can attribute a turn to: the session its thread recorded, or a reviewer's own run.
   * A T3 run id means nothing to Weave, so one is never sent. `null` is a wait: the row naming the
   * session, or the report naming the reviewer's run, is not here yet, and the usage row holds its
   * thread's end until it is.
   */
  const attributionOf = Effect.fn("HqForgeRecords.attributionOf")(function* (
    agent: HqAgentConnections.HqAgent,
    specId: string | null,
    t3RunId: string | null,
  ): Effect.fn.Return<Record<string, string> | null, HqForgeRecordError> {
    if (agent.role.endsWith("-reviewer")) {
      const runId = yield* reviewerRunIdOf(agent.threadId, t3RunId);
      if (runId !== null) return { runId };
      // A usage row that names no T3 run keeps the latest report, and is sent without ids when the
      // reviewer has reported none at all.
      if (t3RunId === null) return {};
      // A reviewer's report of its own run reaches T3 only from its `hq_build_run` answer, so a row
      // that finds none waits for it rather than naming another run's, unless the run's end has
      // been queued and no report can follow: then the usage is sent without ids and the end after it.
      return (yield* endQueued(agent.threadId, t3RunId)) ? {} : null;
    }
    // A lead's turns count toward the session its link opened for this Spec; a helper's toward the
    // session its own run's record opened, never another run's of the same thread.
    const own =
      agent.role === "lead"
        ? yield* deliveredLeadSessionOf(agent.threadId, specId)
        : yield* deliveredRunSessionOf(agent.threadId, specId, t3RunId);
    if (own._tag === "waiting") return null;
    return own.sessionId === null ? {} : { sessionId: own.sessionId };
  });

  /**
   * One record's trip to Weave. Anything Weave could still accept is reported as a retry rather
   * than raised, so the queue decides how long to wait.
   */
  const attempt = Effect.fn("HqForgeRecords.attempt")(function* (
    row: Row,
  ): Effect.fn.Return<DeliveryOutcome, HqForgeRecordError> {
    const payload = decodeJson(row.payloadJson);
    if (Option.isNone(payload)) return refused("record_payload_invalid");
    // A row belongs to the Weave it was queued on: recorded on another it would land in the wrong
    // place, so it waits for that connection to come back. A row with no origin is not pinned,
    // because it was queued while Weave could not be read at all.
    if (row.origin !== null) {
      const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
      if (connected === null || !sameHqAddress(row.origin, connected.origin))
        return retry("other_origin");
    }
    // An end names the role it was queued with: HQ needs only the reference and role to end the
    // agent, and the thread may already be gone.
    if (row.kind === "end") {
      const record = decodeEndPayload(payload.value);
      if (Option.isNone(record)) return refused("record_payload_invalid");
      return yield* hq.endAgent({ threadId: row.threadId, role: record.value.role }).pipe(
        Effect.map(() => delivered(null)),
        Effect.catchTags({
          HqAgentCallUnavailable: (error) => Effect.succeed(retry(error.reason)),
        }),
      );
    }
    // The thread's own projection says who its agent acts as, exactly as a turn reads it.
    const identity = yield* projections.getThread(row.threadId).pipe(
      Effect.map((thread) => {
        const role = HqAgentConnections.hqAgentRole(thread);
        return role === undefined
          ? Option.none<HqAgentConnections.HqAgent>()
          : Option.some({
              threadId: row.threadId,
              role,
              model: thread.modelSelection.model,
            });
      }),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(identity)) return retry("thread_unavailable");
    const agent = identity.value;
    /**
     * The thread's Forge link as this attempt resolved it, read at most once: the Spec a row is sent
     * under and the lead a helper names both come from it. `waiting` is a Weave that cannot answer.
     */
    let link: Option.Option<ForgeSpecOfThread.ForgeSpecOfThreadResult> | "waiting" | undefined;
    const resolveLink = Effect.gen(function* () {
      if (link !== undefined) return link;
      const resolved = yield* buildSpec.of(row.threadId).pipe(
        Effect.catchTags({
          BuildSpecUnavailable: () => Effect.succeed("unavailable" as const),
        }),
      );
      link = resolved === "unavailable" ? ("waiting" as const) : resolved;
      return link;
    });
    // A row queued while its Forge item could not be read is resolved now: it waits while Weave
    // still cannot answer, and a link that names no Spec at all has nothing to record.
    let specId = row.specId;
    if (specId === null) {
      const resolved = yield* resolveLink;
      if (resolved === "waiting") return retry("build_spec_unavailable");
      if (Option.isNone(resolved)) return refused("no_build_link");
      specId = resolved.value.specId;
      // The row is this Spec's from now on: a helper's parent or a turn's session is looked up by
      // the Spec it was recorded under, so it has to be on the row, not only in this attempt.
      yield* sql`UPDATE hq_build_records SET spec_id = ${specId}
        WHERE record_key = ${row.recordKey}`.pipe(
        Effect.mapError((cause) => failed("deliver", cause)),
      );
    }
    const call = (tool: string, args: Record<string, unknown>) =>
      hq.callAs(agent, tool, args).pipe(
        Effect.map((result) => delivered(result.value)),
        Effect.catchTags({
          HqAgentCallRefused: (error) => Effect.succeed(refused(error.code)),
          HqAgentCallUnavailable: (error) => Effect.succeed(retry(error.reason)),
        }),
      );
    /** Args that name the Spec: the row's own, or the one it resolved to at send time. */
    const underSpec = (args: Record<string, unknown>): Record<string, unknown> =>
      specId === null ? args : { ...args, specId };
    switch (row.kind) {
      case "session": {
        const record = decodeSessionPayload(payload.value);
        if (Option.isNone(record)) return refused("record_payload_invalid");
        const bound = yield* call("hq_build_bind", underSpec(record.value.bind));
        if (bound._tag !== "delivered") return bound;
        // The session is opened under the generation the bind returned, which only Weave knows.
        const generation = decodeBoundGeneration(bound.value);
        return yield* call("hq_build_start_session", {
          ...underSpec(record.value.startSession),
          ...(Option.isSome(generation) ? { generation: generation.value.generation } : {}),
        });
      }
      case "helper": {
        const record = decodeHelperPayload(payload.value);
        if (Option.isNone(record)) return refused("record_payload_invalid");
        // A helper queued while its link could not be read carries no lead, and its row keeps the
        // Spec the first attempt resolved but not the lead: the lead is resolved on every attempt,
        // waiting while Weave cannot answer rather than parking a record it could still deliver.
        let leadThreadId = record.value.leadThreadId;
        if (leadThreadId === undefined) {
          const resolved = yield* resolveLink;
          if (resolved === "waiting") return retry("build_spec_unavailable");
          if (Option.isNone(resolved)) return refused("no_build_link");
          leadThreadId = resolved.value.leadThreadId;
        }
        // The lead's session for this Spec, never another Spec's: a lead relinked between Specs
        // has one session per Spec, and this helper counts toward only one of them.
        const lead = yield* deliveredLeadSessionOf(leadThreadId, specId);
        // Its lead has not opened a session yet, so there is no parent to name. This is not a
        // failure: the record waits until the lead's own row has gone.
        if (lead._tag === "waiting" || lead.sessionId === null) return blocked;
        return yield* call("hq_build_record_helper", {
          ...record.value.args,
          parentSessionId: lead.sessionId,
        });
      }
      case "usage": {
        const record = decodeUsagePayload(payload.value);
        if (Option.isNone(record)) return refused("record_payload_invalid");
        const attribution = yield* attributionOf(agent, specId, record.value.t3RunId ?? null);
        if (attribution === null) return blocked;
        return yield* call("hq_build_record_usage", { ...record.value.args, ...attribution });
      }
      case "runtimes": {
        const record = decodeArgsPayload(payload.value);
        if (Option.isNone(record)) return refused("record_payload_invalid");
        return yield* call("hq_build_record_run_times", record.value.args);
      }
    }
  });

  const pendingRows = sql<Row>`
    SELECT record_key AS "recordKey", origin, spec_id AS "specId", thread_id AS "threadId", kind,
      payload_json AS "payloadJson", status, attempts, next_attempt_at AS "nextAttemptAt",
      last_error AS "lastError", result_json AS "resultJson", created_at AS "createdAt",
      delivered_at AS "deliveredAt"
    FROM hq_build_records
    WHERE status = 'pending'
    ORDER BY created_at, rowid
  `.pipe(Effect.mapError((cause) => failed("read", cause)));

  /**
   * One row's trip to Weave, and whether nothing else of its thread has to wait for it: a
   * delivered or parked row is settled, while a retry or a wait holds the rows behind it.
   */
  const deliverRow = Effect.fn("HqForgeRecords.deliverRow")(
    function* (row: Row) {
      const outcome = yield* attempt(row);
      const at = yield* Clock.currentTimeMillis;
      if (outcome._tag === "delivered") {
        yield* sql`UPDATE hq_build_records
          SET status = 'delivered', delivered_at = ${at}, result_json = ${outcome.value === undefined ? null : encodeJson(outcome.value)},
          last_error = NULL
          WHERE record_key = ${row.recordKey}`;
        return true;
      }
      if (outcome._tag === "blocked") return false;
      const attempts = row.attempts + 1;
      if (outcome._tag === "refused") {
        yield* sql`UPDATE hq_build_records
          SET status = 'parked', attempts = ${attempts}, last_error = ${outcome.code}
          WHERE record_key = ${row.recordKey}`;
        return true;
      }
      yield* sql`UPDATE hq_build_records
        SET attempts = ${attempts}, last_error = ${outcome.reason},
          next_attempt_at = ${at + retryDelay(attempts)}
        WHERE record_key = ${row.recordKey}`;
      return false;
    },
    (effect) => effect.pipe(Effect.mapError((cause) => failed("deliver", cause))),
  );

  /**
   * Sends one thread's rows until one of them has to wait: a row that is not due yet, or one that
   * had to be retried or is waiting on another row, holds the rows behind it, so the thread's end
   * only goes once nothing else of its is left to send as the agent it replaces.
   */
  const deliverThread = Effect.fn("HqForgeRecords.deliverThread")(function* (
    queued: ReadonlyArray<Row>,
  ) {
    const ordered = [...queued].sort(
      (left, right) => ROW_ORDER_GROUP[left.kind] - ROW_ORDER_GROUP[right.kind],
    );
    for (const row of ordered) {
      const now = yield* Clock.currentTimeMillis;
      if (row.nextAttemptAt > now) return;
      const settled = yield* deliverRow(row);
      if (!settled) return;
    }
  });

  const deliverDue: HqForgeRecords["Service"]["deliverDue"] = Effect.gen(function* () {
    // A run is on record before anything of its thread's goes out, so its times can be recorded
    // even when its thread ends in this pass.
    yield* reviewerRunDrain
      .withPermits(1)(drainReportedRuns)
      .pipe(Effect.mapError((cause) => failed("deliver", cause)));
    const rows = yield* pendingRows;
    const byThread = new Map<ThreadId, Array<Row>>();
    for (const row of rows) {
      const queued = byThread.get(row.threadId) ?? [];
      queued.push(row);
      byThread.set(row.threadId, queued);
    }
    for (const queued of byThread.values()) yield* deliverThread(queued);
  });

  /** How long the worker sleeps before looking again, never so briefly that it spins. */
  const waitMsBeforeNextAttempt = Effect.gen(function* () {
    const [next] = yield* sql<{ readonly at: number | null }>`
      SELECT MIN(next_attempt_at) AS at FROM hq_build_records WHERE status = 'pending'
    `;
    if (next?.at == null) return RETRY_MAX_MS;
    const now = yield* Clock.currentTimeMillis;
    return Math.min(Math.max(next.at - now, RETRY_BASE_MS), RETRY_MAX_MS);
  }).pipe(Effect.catch(() => Effect.succeed(RETRY_MAX_MS)));

  /** Makes every waiting row due again: what failed before may work under this process or HQ. */
  const retryWaitingNow = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE hq_build_records SET next_attempt_at = ${now}
      WHERE status = 'pending' AND next_attempt_at > ${now}`;
  });

  const start: HqForgeRecords["Service"]["start"] = Effect.fn("HqForgeRecords.start")(function* () {
    // Subscribed before the first pass runs, so a connection made while the queue is starting is
    // kept and wakes it.
    const connectionChanges = yield* Stream.toQueue(hq.connectionChanges, {
      capacity: "unbounded",
    });
    // A reviewer's run id reaches T3 only in the answer to its own call, and its thread may finish
    // before the next pass looks, so a report wakes the queue rather than waiting for it.
    const reportedRuns = yield* Stream.toQueue(hq.reportedRunChanges, { capacity: "unbounded" });
    // A reviewer is not given its run id until the run is on record: its own end may come before the
    // next pass looks, and Weave's run id reaches T3 nowhere else. The run is stamped on the report
    // here, once, so a write that cannot happen yet still names it when the pass that follows writes
    // it; the answer waits for every try but the last to fail.
    yield* hq.setRunReportedHook((report) =>
      Effect.gen(function* () {
        const t3RunId = yield* reportedRunIdOf(report.threadId);
        if (t3RunId !== null)
          yield* hq.stampReportedRun({
            threadId: report.threadId,
            runId: report.runId,
            t3RunId,
          });
        yield* recordReportedRunsBeforeAnswering;
      }).pipe(
        Effect.mapError((cause) => failed("deliver", cause)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a reviewer's Weave run", cause),
        ),
      ),
    );
    // A restart inherits rows whose backoff was timed for an outage this process knows nothing
    // about, so it tries them at once rather than after the row's remaining wait.
    yield* retryWaitingNow.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not resume Weave's Forge records", cause),
      ),
    );
    yield* forkParked(
      Effect.gen(function* () {
        while (true) {
          yield* deliverDue.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not deliver what a thread owes Weave", cause),
            ),
          );
          const wait = yield* waitMsBeforeNextAttempt;
          // Woken by a new record, a new HQ connection or a reported reviewer run, without waiting
          // out the sleep.
          const woke = yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(wait)).pipe(Effect.as("timer" as const)),
            Effect.raceFirst(
              Queue.take(wakeups).pipe(Effect.as("record" as const)),
              Effect.raceFirst(
                Queue.take(connectionChanges).pipe(Effect.as("connection" as const)),
                Queue.take(reportedRuns).pipe(Effect.as("report" as const)),
              ),
            ),
          );
          // Weave has just answered T3 twice over: a row waiting out an outage may work now.
          if (woke === "connection" || woke === "report")
            yield* retryWaitingNow.pipe(Effect.catchCause(() => Effect.void));
        }
      }),
    );
  });

  return HqForgeRecords.of({
    enqueue,
    outstanding,
    reviewerRuns,
    forgetThread,
    deliverDue,
    start,
  });
});

export const layer = Layer.effect(HqForgeRecords, make);
