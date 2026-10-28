import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import {
  delegation,
  leadThread,
  makeHqHarness,
  origin,
  otherDelegation,
  otherOrigin,
  reviewerThread,
} from "./HqAgentConnections.testkit.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";

const helperThread = ThreadId.make("thread-helper");
/** A helper of the root thread whose link Weave has to be read for. */
const unresolvedHelper = ThreadId.make("thread-unresolved-helper");
/** A root thread with a Ticket link, which Weave has to be read for. */
const unresolvedLead = ThreadId.make("thread-unresolved-lead");
const model = "claude-opus-5-5";
const leadSessionRef = "environment-hq/thread-lead";
const RETRY_CAP_MS = 5 * 60 * 1_000;

const usage = {
  kind: "usage" as const,
  recordKey: "usage:thread-1",
  threadId: reviewerThread,
  origin,
  specId: "spec-1",
  args: { inputTokens: 1_200, outputTokens: 300 },
};
const leadSession = {
  kind: "session" as const,
  threadId: leadThread,
  origin,
  specId: "spec-1",
  bind: { specId: "spec-1", workspacePath: "/workspace" },
  startSession: { specId: "spec-1", model },
};
/** A reviewer's turn, which names the T3 run it spent so its own report picks the Forge run. */
const reviewerUsageOf = (t3RunId: string) => ({
  kind: "usage" as const,
  recordKey: `usage:${reviewerThread}:${t3RunId}`,
  threadId: reviewerThread,
  origin,
  specId: "spec-1",
  t3RunId,
  args: { usageRef: `usage:${t3RunId}`, inputTokens: 1_200 },
});

/**
 * The queue over a real database and Weave's fake, with a projection that says who each thread acts
 * as and what it links. A test drives a pass itself, so nothing depends on when the worker happens
 * to wake.
 */
const harness = Effect.gen(function* () {
  const { hq, connections } = yield* makeHqHarness;
  const database = yield* Layer.build(SqlitePersistence.layerMemory);
  const sql = yield* Effect.service(SqlClient.SqlClient).pipe(
    Effect.provide(Layer.succeedContext(database)),
  );
  /** A read failure a test turns on, as a restart or a maintenance window would cause. */
  const projectionReads = { fail: false, calls: [] as Array<ThreadId> };
  /** The T3 run each thread is on, which a report records for the usage of that run. */
  const runs = { latestRunId: "t3-run-1" as string | null };
  const parentOf = (threadId: ThreadId) =>
    threadId === leadThread || threadId === unresolvedLead
      ? null
      : threadId === unresolvedHelper
        ? unresolvedLead
        : leadThread;
  const roleOf = (threadId: ThreadId) =>
    threadId === helperThread || threadId === unresolvedHelper
      ? "implementation-worker"
      : "spec-reviewer";
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThread: (threadId: ThreadId) =>
      Effect.suspend(() => {
        projectionReads.calls.push(threadId);
        return projectionReads.fail
          ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
          : Effect.succeed({
              id: threadId,
              lineage: { parentThreadId: parentOf(threadId) },
              ...(threadId === unresolvedLead
                ? { workItem: { itemId: "ticket-9", number: 9, origin } }
                : {}),
              ...(threadId === leadThread || threadId === unresolvedLead
                ? {}
                : { agentTask: { role: roleOf(threadId) } }),
              modelSelection: { model },
            } as never);
      }),
    getThreadShell: () =>
      Effect.succeed(projectionReads.fail ? null : ({ latestRunId: runs.latestRunId } as never)),
  });
  // Another process over the same database, as a restart is: its queue starts with nothing in memory.
  const openQueue = HqForgeRecords.layer.pipe(
    Layer.provide(ForgeSpecOfThread.layer),
    Layer.provide(Layer.succeed(HqAgentConnections.HqAgentConnections, connections)),
    Layer.provide(projections),
    Layer.provide(
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-hq")),
        } as ServerEnvironment.ServerEnvironment["Service"]),
      ),
    ),
    Layer.provide(Layer.succeedContext(database)),
  );
  const boot = Effect.service(HqForgeRecords.HqForgeRecords).pipe(Effect.provide(openQueue));
  return { hq, connections, boot, projectionReads, runs, sql };
});

/** Calls `weave_forge_run` as the thread's own agent, as a reviewer reporting its run does. */
const reportForgeRun = (
  connections: HqAgentConnections.HqAgentConnections["Service"],
  threadId: ThreadId,
  toolName = "weave_forge_run",
) =>
  Effect.gen(function* () {
    const connection = yield* connections.connection(threadId);
    const response = yield* connections.forward({
      authorization: connection!.authorizationHeader,
      body: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: toolName, arguments: { specId: "spec-1" } },
        }),
      ),
      contentType: "application/json",
      accept: "application/json, text/event-stream",
      protocolVersion: "2025-06-18",
    });
    assert.strictEqual(response.status, 200);
  });

/**
 * Runs a proxied call with a failed write's backoff costing no time: each wait moves the test clock
 * instead of the test, so what the reviewer waits for is still the whole of its own retry.
 */
const withoutWriteBackoff = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return yield* effect.pipe(
      Effect.provideService(Clock.Clock, {
        ...clock,
        sleep: (duration: Duration.Duration) => TestClock.adjust(duration),
      }),
    );
  });

it.effect(
  "a record queued twice is stored once and reaches Weave once with its own arguments",
  () =>
    Effect.gen(function* () {
      const { hq, boot } = yield* harness;
      const records = yield* boot;
      yield* records.enqueue(usage);
      yield* records.enqueue(usage);

      assert.deepStrictEqual(
        (yield* records.outstanding()).map((record) => record.recordKey),
        ["usage:thread-1"],
      );
      assert.deepStrictEqual(hq.toolCalls, []);

      yield* records.deliverDue;

      assert.deepStrictEqual(
        hq.toolCalls.map(({ name, args }) => ({ name, args })),
        [{ name: "weave_forge_record_usage", args: usage.args }],
      );
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);

it.effect("keeps trying while Weave is unreachable, backing off to five minutes", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue(usage);
    hq.state.unreachable = true;

    const attempts: Array<{ count: number; lastError: string | null; wait: number }> = [];
    for (let pass = 1; pass <= 12; pass++) {
      yield* records.deliverDue;
      const [row] = yield* records.outstanding();
      const now = yield* Clock.currentTimeMillis;
      attempts.push({
        count: row!.attempts,
        lastError: row!.lastError,
        wait: row!.nextAttemptAt - now,
      });
      // Nothing is tried again before it is due, however often the queue is looked at.
      yield* records.deliverDue;
      assert.strictEqual((yield* records.outstanding())[0]?.attempts, pass);
      yield* TestClock.adjust(Duration.millis(row!.nextAttemptAt - now));
    }

    assert.deepStrictEqual(
      attempts.slice(0, 3).map((attempt) => attempt.wait),
      [1_000, 2_000, 4_000],
    );
    assert.deepStrictEqual(
      attempts.map((attempt) => attempt.count),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    for (const attempt of attempts) assert.strictEqual(attempt.lastError, "unavailable");
    assert.strictEqual(attempts.at(-1)?.wait, RETRY_CAP_MS);
    assert.deepStrictEqual(hq.toolCalls, []);
    assert.strictEqual((yield* records.outstanding())[0]?.status, "pending");

    // Weave answers again: the row that waited out the outage goes out unchanged.
    hq.state.unreachable = false;
    yield* records.deliverDue;
    assert.deepStrictEqual(
      hq.toolCalls.map(({ name, args }) => ({ name, args })),
      [{ name: "weave_forge_record_usage", args: usage.args }],
    );
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a restart over the same database picks up what is still owed", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const before = yield* boot;
    yield* before.enqueue(usage);
    hq.state.unreachable = true;
    yield* before.deliverDue;
    assert.strictEqual((yield* before.outstanding())[0]?.attempts, 1);

    hq.state.unreachable = false;
    const delivered = yield* Deferred.make<void>();
    hq.tools.call = () => {
      Deferred.doneUnsafe(delivered, Effect.void);
      return { status: "succeeded", value: {} };
    };
    const after = yield* boot;
    assert.deepStrictEqual(
      (yield* after.outstanding()).map((record) => record.attempts),
      [1],
    );

    // The new process tries the row straight away, rather than waiting out the outage's backoff.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* after.start();
        yield* Deferred.await(delivered);
      }),
    );

    assert.deepStrictEqual(
      hq.toolCalls.map(({ name, args }) => ({ name, args })),
      [{ name: "weave_forge_record_usage", args: usage.args }],
    );
  }),
);

it.effect("a lead's session opens under the generation its bind returned", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_bind"
        ? { status: "succeeded", value: { generation: 3 } }
        : { status: "succeeded", value: {} };
    yield* records.enqueue(leadSession);

    yield* records.deliverDue;

    // Only Weave knows the generation the bind returned, so the session must be opened under it.
    assert.deepStrictEqual(
      hq.toolCalls.map(({ name, args }) => ({ name, args })),
      [
        { name: "weave_forge_bind", args: leadSession.bind },
        {
          name: "weave_forge_start_session",
          args: { ...leadSession.startSession, sessionRef: leadSessionRef, generation: 3 },
        },
      ],
    );
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a session whose Spec is not bindable yet waits instead of parking", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    let specStatus = "shaping";
    hq.tools.call = (name) => {
      if (name === "weave_forge_bind")
        return specStatus === "shaping"
          ? { status: "failed", code: "bind_status_invalid" }
          : { status: "succeeded", value: { generation: 3 } };
      if (name === "weave_forge_read")
        return {
          status: "succeeded",
          value: { id: "spec-1", kind: "spec", status: specStatus },
        };
      return { status: "succeeded", value: {} };
    };
    yield* records.enqueue(leadSession);

    yield* records.deliverDue;

    // The Spec can still reach Ready, so the session and what names it wait rather than being lost.
    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => [record.status, record.lastError]),
      [["pending", "spec_not_bindable"]],
    );
    assert.strictEqual(
      hq.toolCalls.some(({ name }) => name === "weave_forge_start_session"),
      false,
    );

    specStatus = "ready";
    yield* TestClock.adjust(Duration.millis(1_000));
    yield* records.deliverDue;

    assert.deepStrictEqual(yield* records.outstanding(), []);
    assert.strictEqual(
      hq.toolCalls.some(({ name }) => name === "weave_forge_start_session"),
      true,
    );
  }),
);

it.effect.each([
  ["could not be read", null],
  ["is already bindable", "ready"],
] as const)("a bind refused while the Spec's status %s still waits", ([, status]) =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_bind"
        ? { status: "failed", code: "bind_status_invalid" }
        : name === "weave_forge_read"
          ? status === null
            ? { status: "failed", code: "build_item_unavailable" }
            : { status: "succeeded", value: { id: "spec-1", kind: "spec", status } }
          : { status: "succeeded", value: {} };
    yield* records.enqueue(leadSession);

    yield* records.deliverDue;

    // Only a status that has passed the bindable ones says the refusal is permanent.
    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => [record.status, record.lastError]),
      [["pending", "spec_not_bindable"]],
    );
  }),
);

it.effect("a session whose Spec has already passed the bindable statuses is parked", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_bind"
        ? { status: "failed", code: "bind_status_invalid" }
        : name === "weave_forge_read"
          ? { status: "succeeded", value: { id: "spec-1", kind: "spec", status: "landed" } }
          : { status: "succeeded", value: {} };
    yield* records.enqueue(leadSession);

    yield* records.deliverDue;

    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => [record.status, record.lastError]),
      [["parked", "bind_status_invalid"]],
    );
  }),
);

it.effect(
  "a session parked because its Spec was not bindable yet is retried when the queue starts",
  () =>
    Effect.gen(function* () {
      const { hq, boot, sql } = yield* harness;
      const before = yield* boot;
      yield* before.enqueue(leadSession);
      yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'bind_status_invalid'`;

      const after = yield* boot;
      // Hold the queue's first call open, so what start reopened is visible before it is sent.
      hq.state.toolCallsHang = true;
      yield* Effect.scoped(after.start());

      assert.deepStrictEqual(
        (yield* after.outstanding()).map((record) => [
          record.status,
          record.attempts,
          record.lastError,
        ]),
        [["pending", 0, null]],
      );
    }),
);

it.effect.each(["helper", "usage"] as const)(
  "backs off blocked %s reads over ten minutes without changing its record",
  (kind) =>
    Effect.gen(function* () {
      const { hq, boot, projectionReads } = yield* harness;
      const records = yield* boot;
      const threadId = kind === "helper" ? helperThread : leadThread;
      const record =
        kind === "helper"
          ? {
              kind,
              recordKey: "helper:blocked-ten-minutes",
              threadId,
              leadThreadId: leadThread,
              specId: "spec-1",
              args: { workId: "work-1" },
            }
          : {
              kind,
              recordKey: "usage:blocked-ten-minutes",
              threadId,
              specId: "spec-1",
              args: { inputTokens: 1_200 },
            };
      yield* records.enqueue(record);
      const before = yield* records.outstanding();
      yield* records.deliverDue;
      yield* Effect.forEach(
        Array.from({ length: 600 }),
        () => TestClock.adjust("1 second").pipe(Effect.andThen(records.deliverDue)),
        { discard: true },
      );
      assert.strictEqual(projectionReads.calls.filter((id) => id === threadId).length, 10);
      assert.deepStrictEqual(yield* records.outstanding(), before);
      assert.deepStrictEqual(hq.toolCalls, []);

      hq.tools.call = (name) =>
        name === "weave_forge_start_session"
          ? { status: "succeeded", value: { session: { id: "session-1" } } }
          : { status: "succeeded", value: {} };
      yield* records.enqueue(leadSession);
      yield* records.deliverDue;
      yield* records.deliverDue;
      const call = hq.toolCalls.find(
        ({ name }) =>
          name === (kind === "helper" ? "weave_forge_record_helper" : "weave_forge_record_usage"),
      );
      assert.deepStrictEqual(
        call?.args,
        kind === "helper"
          ? { workId: "work-1", parentSessionId: "session-1" }
          : { inputTokens: 1_200, sessionId: "session-1" },
      );
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);

it.effect("discovers a lead session written elsewhere within the five-minute backoff cap", () =>
  Effect.gen(function* () {
    const { hq, boot, projectionReads, sql } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue({
      kind: "helper",
      recordKey: "helper:external-session",
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      args: { workId: "work-1" },
    });
    yield* records.deliverDue;
    yield* Effect.forEach(
      [1, 2, 4, 8, 16, 32, 64, 128, 256],
      (seconds) =>
        TestClock.adjust(Duration.seconds(seconds)).pipe(Effect.andThen(records.deliverDue)),
      { discard: true },
    );
    yield* records.enqueue(leadSession);
    yield* sql`UPDATE hq_build_records
      SET status = 'delivered', result_json = '{"session":{"id":"external-session"}}'
      WHERE kind = 'session' AND thread_id = ${leadThread}`;
    yield* TestClock.adjust("299 seconds");
    yield* records.deliverDue;
    assert.strictEqual(projectionReads.calls.filter((id) => id === helperThread).length, 10);
    assert.deepStrictEqual(hq.toolCalls, []);
    yield* TestClock.adjust("1 second");
    yield* records.deliverDue;
    const helper = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.deepStrictEqual(helper?.args, { workId: "work-1", parentSessionId: "external-session" });
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a helper waits for its lead's session and then names it as its parent", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };
    // Queued before the lead's session, so the first pass meets it with no parent to name.
    yield* records.enqueue({
      kind: "helper",
      recordKey: "helper:thread-helper:run-1",
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      args: { workId: "work-1" },
    });
    yield* records.enqueue(leadSession);

    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls.map(({ name }) => name),
      ["weave_forge_bind", "weave_forge_start_session"],
    );
    const waiting = (yield* records.outstanding()).find((record) => record.kind === "helper");
    // Waiting is not failing: nothing is counted against it and it is never parked.
    assert.strictEqual(waiting?.status, "pending");
    assert.strictEqual(waiting?.attempts, 0);

    yield* records.deliverDue;

    const helper = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.deepStrictEqual(helper?.args, { workId: "work-1", parentSessionId: "session-1" });
    // The helper calls as its own agent, never as its lead's.
    assert.notStrictEqual(
      helper?.agentId,
      hq.toolCalls.find(({ name }) => name === "weave_forge_bind")?.agentId,
    );
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a thread's end is sent only after everything else it owes", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    // Queued first, so sending in plain insertion order would end the agent too early.
    yield* records.enqueue({ kind: "end", threadId: reviewerThread, role: "spec-reviewer" });
    yield* records.enqueue({ ...usage, args: { inputTokens: 5 } });
    yield* records.enqueue({
      kind: "runtimes",
      recordKey: "runtimes:thread-1",
      threadId: reviewerThread,
      origin,
      specId: "spec-1",
      args: { runId: "run-1", ms: 1_200 },
    });
    const seen: Array<{ name: string; endedBefore: boolean }> = [];
    hq.tools.call = (name) => {
      seen.push({ name, endedBefore: hq.agents.some((agent) => agent.ended) });
      return { status: "succeeded", value: {} };
    };

    yield* records.deliverDue;

    assert.deepStrictEqual(
      seen.map(({ name }) => name),
      ["weave_forge_record_usage", "weave_forge_record_run_times"],
    );
    // Each record reached Weave while its agent was still the one that made it.
    for (const call of seen) assert.isFalse(call.endedBefore);
    assert.isTrue(hq.agents.every((agent) => agent.ended));
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a refusal Weave states with a code parks the record and is never retried", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_record_helper"
        ? { status: "failed", code: "helper_reviewer_refused" }
        : name === "weave_forge_start_session"
          ? { status: "succeeded", value: { session: { id: "session-1" } } }
          : { status: "succeeded", value: {} };
    yield* records.enqueue(leadSession);
    yield* records.enqueue({
      kind: "helper",
      recordKey: "helper:thread-helper",
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      args: { workId: "work-1" },
    });

    yield* records.deliverDue;

    const parked = (yield* records.outstanding()).find((record) => record.kind === "helper");
    assert.strictEqual(parked?.status, "parked");
    assert.strictEqual(parked?.lastError, "helper_reviewer_refused");
    const attempts = parked!.attempts;

    yield* records.deliverDue;
    assert.strictEqual(
      hq.toolCalls.filter(({ name }) => name === "weave_forge_record_helper").length,
      1,
    );
    assert.strictEqual(
      (yield* records.outstanding()).find((record) => record.kind === "helper")?.attempts,
      attempts,
    );
  }),
);

it.effect(
  "a refused record is noted on the Spec by its thread, once, and a reviewer leaves no note",
  () =>
    Effect.gen(function* () {
      const { hq, boot } = yield* harness;
      const records = yield* boot;
      hq.tools.call = (name) =>
        name === "weave_forge_record_helper" || name === "weave_forge_record_usage"
          ? { status: "failed", code: "invalid_action_input" }
          : name === "weave_forge_start_session"
            ? { status: "succeeded", value: { session: { id: "session-1" } } }
            : { status: "succeeded", value: {} };
      yield* records.enqueue(leadSession);
      yield* records.enqueue({
        kind: "helper",
        recordKey: "helper:thread-helper",
        threadId: helperThread,
        leadThreadId: leadThread,
        specId: "spec-1",
        args: { workId: "work-1" },
      });
      yield* records.enqueue(reviewerUsageOf("run-1"));

      yield* records.deliverDue;
      yield* records.deliverDue;

      const notes = hq.toolCalls.filter(({ name }) => name === "weave_forge_record_contribution");
      assert.lengthOf(notes, 1);
      assert.strictEqual(notes[0]?.args.itemId, "spec-1");
      assert.include(String(notes[0]?.args.note), "invalid_action_input");
      assert.include(String(notes[0]?.args.note), `t3-thread://v1/${helperThread}`);
    }),
);

it.effect("records a reviewer's own Forge run from the answer its proxied call was given", () =>
  Effect.gen(function* () {
    const { hq, connections, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = () => ({
      status: "succeeded",
      value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
    });

    yield* reportForgeRun(connections, leadThread);
    yield* reportForgeRun(connections, reviewerThread);
    yield* records.deliverDue;

    // Only a reviewer's own run is its review; a lead's Forge run is not recorded.
    assert.deepStrictEqual(
      (yield* records.reviewerRuns).map(({ reviewerThreadId, runId, specId }) => ({
        reviewerThreadId,
        runId,
        specId,
      })),
      [{ reviewerThreadId: reviewerThread, runId: "run-7", specId: "spec-1" }],
    );
    // Reading it is not one-shot: it still names the run whose times are to be recorded.
    assert.lengthOf(yield* records.reviewerRuns, 1);
  }),
);

it.effect("a deleted thread's queued records go with it", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue(usage);
    yield* records.enqueue(leadSession);

    yield* records.forgetThread(reviewerThread);

    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => record.kind),
      ["session"],
    );
  }),
);

it.effect("a new Weave connection wakes the worker instead of waiting out a row's backoff", () =>
  Effect.gen(function* () {
    const { hq, connections, boot } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue(usage);
    hq.state.unreachable = true;
    yield* records.deliverDue;
    yield* TestClock.adjust(Duration.millis(1_000));
    yield* records.deliverDue;
    // Twice failing, so the row now waits longer than the test clock will ever advance.
    assert.strictEqual((yield* records.outstanding())[0]?.attempts, 2);

    const delivered = yield* Deferred.make<void>();
    hq.tools.call = () => {
      Deferred.doneUnsafe(delivered, Effect.void);
      return { status: "succeeded", value: {} };
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        // Weave comes back on a new connection: the queue must try again at once.
        hq.state.unreachable = false;
        yield* connections.connect({ origin, delegation });
        yield* Deferred.await(delivered);
      }),
    );

    // The row reached Weave on the new connection, with no test-clock advance since the failure.
    assert.deepStrictEqual(
      hq.toolCalls.map(({ name }) => name),
      ["weave_forge_record_usage"],
    );
  }),
);

it.effect("a helper waiting on its lead's session keeps its own end unsent", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };
    // The helper finishes before its lead has opened the session its record names as its parent.
    yield* records.enqueue({
      kind: "helper",
      recordKey: "helper:thread-helper:run-1",
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { workId: "work-1" },
    });
    yield* records.enqueue({
      kind: "end",
      recordKey: "end:thread-helper:run-1",
      threadId: helperThread,
      role: "implementation-worker",
    });

    yield* records.deliverDue;

    // Ending the agent now would leave the waiting record to retry as a replacement identity.
    assert.isFalse(hq.agents.some((agent) => agent.ended));
    assert.deepStrictEqual(
      (yield* records.outstanding()).map(({ kind, status }) => [kind, status]),
      [
        ["helper", "pending"],
        ["end", "pending"],
      ],
    );

    yield* records.enqueue(leadSession);
    // One pass for the lead's session, and the next for the helper's record and then its end.
    yield* records.deliverDue;
    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls.map(({ name }) => name),
      ["weave_forge_bind", "weave_forge_start_session", "weave_forge_record_helper"],
    );
    const helperAgents = hq.agents.filter((agent) => agent.role === "implementation-worker");
    assert.isNotEmpty(helperAgents);
    assert.isTrue(helperAgents.every((agent) => agent.ended));
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("a row a transient failure put back keeps its thread's end unsent", () =>
  Effect.gen(function* () {
    const { hq, boot, projectionReads } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue({ ...usage, args: { inputTokens: 5 } });
    yield* records.enqueue({
      kind: "end",
      recordKey: "end:thread-reviewer:run-1",
      threadId: reviewerThread,
      role: "spec-reviewer",
    });
    // The thread's projection cannot be read for a moment, so its usage row has to be retried.
    projectionReads.fail = true;

    yield* records.deliverDue;

    // The record still to go is not lost: the agent that would send it has not been ended.
    assert.deepStrictEqual(
      (yield* records.outstanding()).map(({ kind, status }) => [kind, status]),
      [
        ["usage", "pending"],
        ["end", "pending"],
      ],
    );
    assert.deepStrictEqual(hq.toolCalls, []);

    projectionReads.fail = false;
    yield* TestClock.adjust(Duration.millis(1_000));
    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls.map(({ name }) => name),
      ["weave_forge_record_usage"],
    );
    assert.isTrue(hq.agents.every((agent) => agent.ended));
  }),
);

it.effect(
  "a run reported just before completion is on record, so its times survive a restart",
  () =>
    Effect.gen(function* () {
      const { hq, connections, boot } = yield* harness;
      const records = yield* boot;
      hq.tools.call = () => ({
        status: "succeeded",
        value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
      });
      yield* reportForgeRun(connections, reviewerThread);

      // Nothing has delivered anything yet: reading the runs is what records them, which is what a
      // finishing reviewer does before its own end is queued.
      const [run] = yield* records.reviewerRuns;
      assert.strictEqual(run?.reviewerThreadId, reviewerThread);
      assert.strictEqual(run?.runId, "run-7");

      yield* records.enqueue({
        kind: "runtimes",
        recordKey: `runtimes:${reviewerThread}:${run!.runId}`,
        threadId: reviewerThread,
        specId: "spec-1",
        origin,
        args: { runId: run!.runId, startedAt: 1, endedAt: 2 },
      });
      // Another process over the same database finds the run in the table, not in memory.
      const after = yield* boot;
      assert.deepStrictEqual(
        (yield* after.reviewerRuns).map(({ runId }) => runId),
        ["run-7"],
      );

      yield* records.deliverDue;

      assert.deepStrictEqual(
        hq.toolCalls.find(({ name }) => name === "weave_forge_record_run_times")?.args,
        { runId: "run-7", startedAt: 1, endedAt: 2 },
      );
    }),
);

it.effect(
  "a record queued while its Forge item could not be read resolves its Spec when sent",
  () =>
    Effect.gen(function* () {
      const { hq, boot } = yield* harness;
      const records = yield* boot;
      hq.tools.call = (name) =>
        name === "weave_forge_read"
          ? { status: "succeeded", value: { id: "ticket-9", kind: "ticket", parentId: "spec-4" } }
          : { status: "succeeded", value: {} };
      // Linked, but Weave could not be asked about the item when the row was queued.
      hq.state.unreachable = true;
      yield* records.enqueue({
        kind: "session",
        recordKey: `session:${unresolvedLead}:ticket-9`,
        threadId: unresolvedLead,
        origin,
        bind: {},
        startSession: { harness: "t3code" },
      });

      yield* records.deliverDue;

      const waiting = (yield* records.outstanding())[0];
      assert.strictEqual(waiting?.status, "pending");
      assert.isNull(waiting?.specId);

      hq.state.unreachable = false;
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* records.deliverDue;

      assert.deepStrictEqual(
        hq.toolCalls
          .filter(({ name }) => name !== "weave_forge_read")
          .map(({ name, args }) => ({ name, args })),
        [
          { name: "weave_forge_bind", args: { specId: "spec-4" } },
          {
            name: "weave_forge_start_session",
            args: {
              specId: "spec-4",
              harness: "t3code",
              sessionRef: "environment-hq/thread-unresolved-lead",
            },
          },
        ],
      );
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);

it.effect("a helper names the session of the Spec it counts toward, not its lead's latest", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name, args) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: `session-${String(args.specId)}` } } }
        : { status: "succeeded", value: {} };
    const sessionOf = (specId: string) => ({
      kind: "session" as const,
      recordKey: `session:${leadThread}:${specId}`,
      threadId: leadThread,
      origin,
      specId,
      bind: { specId },
      startSession: { specId, model },
    });
    yield* records.enqueue(sessionOf("spec-a"));
    yield* records.deliverDue;
    // The lead is relinked to another Spec before the first Spec's helper finishes.
    yield* records.enqueue(sessionOf("spec-b"));
    yield* records.deliverDue;
    yield* records.enqueue({
      kind: "helper",
      recordKey: "helper:thread-helper:run-1",
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-a",
      origin,
      args: { workId: "work-1" },
    });

    yield* records.deliverDue;

    const helper = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.deepStrictEqual(helper?.args, { workId: "work-1", parentSessionId: "session-spec-a" });
  }),
);

it.effect("a read of the reviewer runs racing the queue's own drain still finds the run", () =>
  Effect.gen(function* () {
    const { hq, connections, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = () => ({
      status: "succeeded",
      value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
    });
    yield* reportForgeRun(connections, reviewerThread);

    // A drain reads the clock between taking a reported run and storing it. Hold that read, so the
    // completion read below meets the run exactly where the queue has it and the table does not.
    const clock = yield* Clock.Clock;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null = { entered, release };
    const heldClock: Clock.Clock = {
      ...clock,
      get currentTimeMillis() {
        const current = hold;
        if (current === null) return clock.currentTimeMillis;
        return Effect.suspend(() => {
          hold = null;
          return Deferred.succeed(current.entered, undefined).pipe(
            Effect.andThen(Deferred.await(current.release)),
            Effect.andThen(clock.currentTimeMillis),
          );
        });
      },
    };
    const onHeldClock = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.provideService(effect, Clock.Clock, heldClock);

    const draining = yield* onHeldClock(records.deliverDue).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const reading = yield* onHeldClock(records.reviewerRuns).pipe(Effect.forkChild);
    // Let the read reach its own query before the held pass stores the run.
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    const [runs] = yield* Effect.all([Fiber.join(reading), Fiber.join(draining)]);

    // A run reported just before a reviewer finishes is never in neither place.
    assert.deepStrictEqual(
      runs.map((run) => run.runId),
      ["run-7"],
    );
  }),
);

it.effect("a reported run whose insert failed is still owed to the next drain", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, sql } = yield* harness;
    const records = yield* boot;
    hq.tools.call = () => ({
      status: "succeeded",
      value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
    });
    yield* reportForgeRun(connections, reviewerThread);
    // The table refuses the row for a moment, as a database that cannot be written would.
    yield* sql`CREATE TRIGGER hq_build_reviewer_runs_unwritable
      BEFORE INSERT ON hq_build_reviewer_runs
      BEGIN SELECT RAISE(ABORT, 'unwritable'); END`;

    assert.isTrue(Exit.isFailure(yield* Effect.exit(records.reviewerRuns)));

    yield* sql`DROP TRIGGER hq_build_reviewer_runs_unwritable`;
    // The run was not lost with the failed insert: the next drain stores it.
    assert.deepStrictEqual(
      (yield* records.reviewerRuns).map((run) => run.runId),
      ["run-7"],
    );
  }),
);

it.effect("a session queued with no repository takes the Spec's own when it is sent", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_read"
        ? {
            status: "succeeded",
            value: { id: "ticket-9", kind: "ticket", parentId: "spec-4", project: "pechhe/t3code" },
          }
        : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      recordKey: `session:${unresolvedLead}:ticket-9`,
      threadId: unresolvedLead,
      origin,
      bind: {},
      startSession: {
        harness: "t3code",
        workspaces: [{ repository: null, host: "agent-host", workspaceRef: "/workspace" }],
      },
    });

    yield* records.deliverDue;

    const started = hq.toolCalls.find(({ name }) => name === "weave_forge_start_session");
    assert.deepStrictEqual(started?.args.workspaces, [
      { repository: "pechhe/t3code", host: "agent-host", workspaceRef: "/workspace" },
    ]);
  }),
);

it.effect("a session the lead already started itself is adopted, not parked", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "failed", code: "session_reference_conflict" }
        : name === "weave_forge_sessions"
          ? {
              status: "succeeded",
              value: [
                { id: "other", harness: "t3code", sessionRef: "another-thread" },
                { id: "session-own", harness: "t3code", sessionRef: leadSessionRef },
              ],
            }
          : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });

    yield* records.deliverDue;

    assert.deepStrictEqual((yield* records.outstanding()).length, 0);
    yield* records.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { harness: "t3code" },
    });
    yield* records.deliverDue;
    const sent = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.strictEqual(sent?.args.parentSessionId, "session-own");
  }),
);

it.effect("a session the lead started itself under another harness is adopted", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "failed", code: "session_active" }
        : name === "weave_forge_sessions"
          ? {
              status: "succeeded",
              value: [{ id: "session-own", harness: "t3", sessionRef: leadSessionRef }],
            }
          : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });
    yield* records.enqueue({
      kind: "usage",
      recordKey: `usage:${leadThread}:turn-1`,
      threadId: leadThread,
      specId: "spec-1",
      origin,
      args: { harness: "t3code" },
    });

    yield* records.deliverDue;

    assert.deepStrictEqual((yield* records.outstanding()).length, 0);
    const sent = hq.toolCalls.find(({ name }) => name === "weave_forge_record_usage");
    assert.strictEqual(sent?.args.sessionId, "session-own");
  }),
);

it.effect("a session the lead has already ended is adopted once the Spec cannot be bound", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_bind"
        ? { status: "failed", code: "bind_status_invalid" }
        : name === "weave_forge_read"
          ? { status: "succeeded", value: { status: "landed" } }
          : name === "weave_forge_sessions"
            ? {
                status: "succeeded",
                value: [
                  {
                    id: "session-own",
                    harness: "t3",
                    sessionRef: leadSessionRef,
                    endedAt: "2026-10-28T20:46:07.842Z",
                  },
                ],
              }
            : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });

    yield* records.deliverDue;

    assert.deepStrictEqual((yield* records.outstanding()).length, 0);
    assert.strictEqual(
      hq.toolCalls.some(({ name }) => name === "weave_forge_start_session"),
      false,
    );
  }),
);

it.effect("a session parked as a reference conflict is tried again when the queue starts", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const before = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "failed", code: "session_reference_conflict" }
        : name === "weave_forge_sessions"
          ? {
              status: "succeeded",
              value: [{ id: "s-1", harness: "t3code", sessionRef: leadSessionRef }],
            }
          : { status: "succeeded", value: {} };
    // Parked by a server that did not yet adopt the lead's own session.
    yield* before.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });
    const { sql } = yield* harness;
    yield* sql`UPDATE hq_build_records SET status = 'parked', last_error = 'session_reference_conflict'`;

    const after = yield* boot;
    const delivered = yield* Deferred.make<void>();
    const original = hq.tools.call;
    hq.tools.call = (name, args) => {
      if (name === "weave_forge_sessions") Deferred.doneUnsafe(delivered, Effect.void);
      return original(name, args);
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* after.start();
        yield* Deferred.await(delivered);
      }),
    );

    assert.strictEqual(
      hq.toolCalls.some(({ name }) => name === "weave_forge_start_session"),
      true,
    );
  }),
);

it.effect("a parked legacy session sends the lead's current reference and adopts its session", () =>
  Effect.gen(function* () {
    const { hq, boot, sql } = yield* harness;
    const before = yield* boot;
    // A row queued by a build that stored the bare thread id.
    yield* before.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });
    yield* before.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { workId: "work-1" },
    });
    yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'bind_status_invalid'
      WHERE kind = 'session'`;

    const after = yield* boot;
    const adopted = yield* Deferred.make<void>();
    hq.tools.call = (name) => {
      if (name === "weave_forge_bind") return { status: "succeeded", value: { generation: 2 } };
      if (name === "weave_forge_start_session")
        return { status: "failed", code: "session_reference_conflict" };
      if (name === "weave_forge_sessions")
        return {
          status: "succeeded",
          value: [{ id: "lead-session", harness: "t3code", sessionRef: leadSessionRef }],
        };
      if (name === "weave_forge_record_helper") {
        Deferred.doneUnsafe(adopted, Effect.void);
        return { status: "succeeded", value: {} };
      }
      return { status: "succeeded", value: {} };
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* after.start();
        yield* Deferred.await(adopted);
      }),
    );

    const started = hq.toolCalls.find(({ name }) => name === "weave_forge_start_session");
    assert.strictEqual(started?.args.sessionRef, leadSessionRef);
    const helper = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.strictEqual(helper?.args.parentSessionId, "lead-session");
  }),
);

it.effect(
  "rows parked on a Weave error or an earlier build's refused shape are tried again when the queue starts",
  () =>
    Effect.gen(function* () {
      const { hq, boot, sql } = yield* harness;
      const before = yield* boot;
      yield* before.enqueue({
        kind: "helper",
        recordKey: `helper:${helperThread}:run-1`,
        threadId: helperThread,
        leadThreadId: leadThread,
        specId: "spec-1",
        origin,
        args: { harness: "t3code" },
      });
      yield* before.enqueue({
        kind: "helper",
        recordKey: `helper:${helperThread}:run-2`,
        threadId: helperThread,
        leadThreadId: leadThread,
        specId: "spec-1",
        origin,
        args: { harness: "t3code" },
      });
      yield* before.enqueue({
        kind: "helper",
        recordKey: `helper:${helperThread}:run-3`,
        threadId: helperThread,
        leadThreadId: leadThread,
        specId: "spec-1",
        origin,
        args: { harness: "t3code" },
      });
      yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'action_execution_failed'
      WHERE record_key LIKE '%run-1'`;
      yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'invalid_action_input'
      WHERE record_key LIKE '%run-2'`;
      yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'helper_reviewer_refused'
      WHERE record_key LIKE '%run-3'`;

      const after = yield* boot;
      yield* Effect.scoped(after.start());

      assert.deepStrictEqual(
        (yield* after.outstanding()).map((record) => [record.recordKey.slice(-5), record.status]),
        [
          ["run-1", "pending"],
          ["run-2", "pending"],
          ["run-3", "parked"],
        ],
      );
      assert.deepStrictEqual(hq.toolCalls, []);
    }),
);

it.effect("the rows a refused session parked are tried again with it when the queue starts", () =>
  Effect.gen(function* () {
    const { hq, boot, sql } = yield* harness;
    const before = yield* boot;
    yield* before.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { harness: "t3code" },
    });
    yield* sql`UPDATE hq_build_records SET status = 'parked', attempts = 1, last_error = 'lead_session_parked'`;

    const after = yield* boot;
    yield* Effect.scoped(after.start());

    assert.deepStrictEqual(
      (yield* after.outstanding()).map((record) => [record.status, record.attempts]),
      [["pending", 0]],
    );
    assert.deepStrictEqual(hq.toolCalls, []);
  }),
);

it.effect("adopts the lead's session that is still running when it started several", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "failed", code: "session_reference_conflict" }
        : name === "weave_forge_sessions"
          ? {
              status: "succeeded",
              value: [
                {
                  id: "ended",
                  harness: "t3code",
                  sessionRef: leadSessionRef,
                  endedAt: "2026-10-25T00:00:00.000Z",
                },
                { id: "running", harness: "t3code", sessionRef: leadSessionRef, endedAt: null },
              ],
            }
          : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code", sessionRef: leadThread },
    });
    yield* records.deliverDue;

    yield* records.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { harness: "t3code" },
    });
    yield* records.deliverDue;
    const sent = hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper");
    assert.strictEqual(sent?.args.parentSessionId, "running");
  }),
);

it.effect("a helper whose lead's session Weave refused is parked, so its end can go", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_bind"
        ? { status: "failed", code: "bind_status_invalid" }
        : name === "weave_forge_read"
          ? { status: "succeeded", value: { id: "spec-1", kind: "spec", status: "landed" } }
          : { status: "succeeded", value: {} };
    yield* records.enqueue({
      kind: "session",
      threadId: leadThread,
      specId: "spec-1",
      origin,
      bind: { specId: "spec-1" },
      startSession: { harness: "t3code" },
    });
    yield* records.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      args: { harness: "t3code" },
    });

    yield* records.deliverDue;

    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => [
        record.kind,
        record.status,
        record.lastError,
      ]),
      [
        ["session", "parked", "bind_status_invalid"],
        ["helper", "parked", "lead_session_parked"],
      ],
    );
  }),
);

it.effect("a session delivered with the Spec it resolved is found by the helper naming it", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name) =>
      name === "weave_forge_read"
        ? { status: "succeeded", value: { id: "ticket-9", kind: "ticket", parentId: "spec-4" } }
        : name === "weave_forge_start_session"
          ? { status: "succeeded", value: { session: { id: "session-spec-4" } } }
          : { status: "succeeded", value: {} };
    // The link could not be read when the session was queued, so its row carries no Spec.
    hq.state.unreachable = true;
    yield* records.enqueue({
      kind: "session",
      recordKey: `session:${unresolvedLead}:ticket-9`,
      threadId: unresolvedLead,
      origin,
      bind: {},
      startSession: { harness: "t3code" },
    });
    yield* records.deliverDue;
    hq.state.unreachable = false;
    yield* TestClock.adjust(Duration.millis(1_000));
    // The pass sends the session under the Spec it resolved.
    yield* records.deliverDue;
    assert.deepStrictEqual(
      hq.toolCalls
        .filter(({ name }) => name === "weave_forge_start_session")
        .map(({ name, args }) => ({ name, args })),
      [
        {
          name: "weave_forge_start_session",
          args: {
            specId: "spec-4",
            harness: "t3code",
            sessionRef: "environment-hq/thread-unresolved-lead",
          },
        },
      ],
    );

    // A helper queued against that Spec finds the session its row resolved to, which the row must
    // carry: the lookup filters by Spec, so a row left with none is never found.
    yield* records.enqueue({
      kind: "helper",
      recordKey: `helper:${helperThread}:run-1`,
      threadId: helperThread,
      leadThreadId: unresolvedLead,
      specId: "spec-4",
      origin,
      t3RunId: "run-1",
      args: { workId: "work-1" },
    });

    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper")?.args,
      { workId: "work-1", parentSessionId: "session-spec-4" },
    );
  }),
);

it.effect("each turn of a helper names the session of the run that spent it", () =>
  Effect.gen(function* () {
    const { hq, boot } = yield* harness;
    const records = yield* boot;
    hq.tools.call = (name, args) => {
      if (name === "weave_forge_start_session")
        return { status: "succeeded", value: { session: { id: "lead-session" } } };
      if (name === "weave_forge_record_helper")
        return {
          status: "succeeded",
          value: { session: { id: `session-${String(args.sessionRef)}` } },
        };
      return { status: "succeeded", value: {} };
    };
    const helperOf = (runId: string) => ({
      kind: "helper" as const,
      recordKey: `helper:${helperThread}:${runId}`,
      threadId: helperThread,
      leadThreadId: leadThread,
      specId: "spec-1",
      origin,
      t3RunId: runId,
      args: { workId: "work-1", sessionRef: runId },
    });
    const usageOf = (runId: string) => ({
      kind: "usage" as const,
      recordKey: `usage:${runId}`,
      threadId: helperThread,
      specId: "spec-1",
      origin,
      t3RunId: runId,
      args: { usageRef: `usage:${runId}`, harness: "t3code" },
    });
    yield* records.enqueue(leadSession);
    yield* records.deliverDue;
    // Two follow-up runs of one helper, each opening its own Forge session.
    yield* records.enqueue(helperOf("run-1"));
    yield* records.enqueue(helperOf("run-2"));
    yield* records.deliverDue;
    // The turns report out of order: each is attributed to its own run's record, never the latest.
    yield* records.enqueue(usageOf("run-2"));
    yield* records.enqueue(usageOf("run-1"));

    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls
        .filter(({ name }) => name === "weave_forge_record_usage")
        .map(({ args }) => [args.usageRef, args.sessionId, args.harness]),
      // Weave refuses a harness beside a session id, so only the session id goes.
      [
        ["usage:run-2", "session-run-2", undefined],
        ["usage:run-1", "session-run-1", undefined],
      ],
    );
  }),
);

it.effect("a row queued for one Weave waits while T3 is connected to another", () =>
  Effect.gen(function* () {
    const { hq, connections, boot } = yield* harness;
    const records = yield* boot;
    yield* records.enqueue(usage);
    yield* connections.connect({ origin: otherOrigin, delegation: otherDelegation });

    yield* records.deliverDue;

    assert.deepStrictEqual(hq.toolCalls, []);
    assert.strictEqual((yield* records.outstanding())[0]?.status, "pending");

    yield* connections.connect({ origin, delegation });
    yield* TestClock.adjust(Duration.millis(1_000));
    yield* records.deliverDue;

    assert.deepStrictEqual(
      hq.toolCalls.map(({ name, args }) => ({ name, args })),
      [{ name: "weave_forge_record_usage", args: usage.args }],
    );
    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect(
  "a helper queued while its link was unreadable names its lead's session instead of parking",
  () =>
    Effect.gen(function* () {
      const { hq, boot } = yield* harness;
      const records = yield* boot;
      hq.tools.call = (name) =>
        name === "weave_forge_read"
          ? { status: "succeeded", value: { id: "ticket-9", kind: "ticket", parentId: "spec-4" } }
          : name === "weave_forge_start_session"
            ? { status: "succeeded", value: { session: { id: "session-spec-4" } } }
            : { status: "succeeded", value: {} };
      // Queued while Weave could not be asked about the lead's item, so it carries neither the Spec
      // nor the lead: the row's Spec is resolved at delivery, and the lead with it.
      hq.state.unreachable = true;
      yield* records.enqueue({
        kind: "helper",
        recordKey: `helper:${unresolvedHelper}:run-1`,
        threadId: unresolvedHelper,
        origin,
        t3RunId: "run-1",
        args: { workId: "work-1" },
      });

      yield* records.deliverDue;
      assert.deepStrictEqual(hq.toolCalls, []);

      // Weave answers again: the attempt resolves the Spec and the lead, and waits for the session
      // the lead has not opened yet.
      hq.state.unreachable = false;
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* records.deliverDue;

      const waiting = (yield* records.outstanding())[0];
      assert.strictEqual(waiting?.status, "pending");
      assert.strictEqual(waiting?.specId, "spec-4");

      yield* records.enqueue({
        kind: "session",
        recordKey: `session:${unresolvedLead}:ticket-9`,
        threadId: unresolvedLead,
        origin,
        specId: "spec-4",
        bind: { specId: "spec-4" },
        startSession: { specId: "spec-4", harness: "t3code" },
      });
      // One pass opens the lead's session, the next names it as the helper's parent.
      yield* records.deliverDue;
      yield* records.deliverDue;

      assert.deepStrictEqual(
        hq.toolCalls.find(({ name }) => name === "weave_forge_record_helper")?.args,
        { workId: "work-1", parentSessionId: "session-spec-4" },
      );
      // The Spec the first attempt persisted left nothing else for the second to resolve, and the
      // helper is not parked: what it owes Weave reaches it.
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);

it.effect.each(["weave_forge_run", "hq_forge_run", "hq_build_run"])(
  "%s: a reviewer's run is on record by the time its proxied call answers",
  (toolName) =>
    Effect.gen(function* () {
      const { hq, connections, boot, runs } = yield* harness;
      const records = yield* boot;
      hq.tools.call = () => ({
        status: "succeeded",
        value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* records.start();
          yield* reportForgeRun(connections, reviewerThread, toolName);
          // The answer the reviewer was given has its run stored: another process over the same
          // database finds it, and so does the usage of the T3 run it was reported in.
          const restarted = yield* boot;
          assert.deepStrictEqual(
            (yield* restarted.reviewerRuns).map(({ runId, t3RunId }) => [runId, t3RunId]),
            [["run-7", runs.latestRunId]],
          );
        }),
      );
    }),
);

it.effect("a write that fails twice is retried before the reviewer is answered", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, runs, sql } = yield* harness;
    const records = yield* boot;
    hq.tools.call = () => ({
      status: "succeeded",
      value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
    });
    runs.latestRunId = "t3-run-a";
    // The table refuses a write for a moment, as a database caught mid-write would.
    yield* sql`CREATE TABLE hq_build_reviewer_run_writes (attempts INTEGER NOT NULL)`;
    yield* sql`CREATE TRIGGER hq_build_reviewer_runs_unwritable
      BEFORE INSERT ON hq_build_reviewer_runs
      WHEN (SELECT count(*) FROM hq_build_reviewer_run_writes) < 2
      BEGIN
        INSERT INTO hq_build_reviewer_run_writes (attempts) VALUES (1);
        SELECT RAISE(FAIL, 'unwritable');
      END`;

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        yield* withoutWriteBackoff(reportForgeRun(connections, reviewerThread));
      }),
    );

    // The answer was held until the row was durable, so a process that restarts now still has the
    // run, and nothing is left owed to a later drain.
    const stored = yield* sql<{ readonly runId: string; readonly t3RunId: string | null }>`
      SELECT run_id AS "runId", t3_run_id AS "t3RunId" FROM hq_build_reviewer_runs
    `;
    assert.deepStrictEqual(
      stored.map(({ runId, t3RunId }) => [runId, t3RunId]),
      [["run-7", "t3-run-a"]],
    );
    assert.deepStrictEqual(yield* connections.reportedRuns, []);
  }),
);

it.effect("a run whose write failed is kept for the next drain", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, sql } = yield* harness;
    const records = yield* boot;
    hq.tools.call = () => ({
      status: "succeeded",
      value: { run: { id: "run-7" }, spec: { id: "spec-1" } },
    });
    // The table refuses the row for a moment, as a database that cannot be written would, and says
    // how often the row was tried.
    yield* sql`CREATE TABLE hq_build_reviewer_run_writes (attempts INTEGER NOT NULL)`;
    yield* sql`CREATE TRIGGER hq_build_reviewer_runs_unwritable
      BEFORE INSERT ON hq_build_reviewer_runs
      BEGIN
        INSERT INTO hq_build_reviewer_run_writes (attempts) VALUES (1);
        SELECT RAISE(FAIL, 'unwritable');
      END`;

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        yield* withoutWriteBackoff(reportForgeRun(connections, reviewerThread));
      }),
    );

    // The reviewer's answer waited for its run to be recorded, and the write that failed did not
    // take the run with it: it is still reported, for the drain that follows.
    const writes = yield* sql<{ readonly attempts: number }>`
      SELECT attempts FROM hq_build_reviewer_run_writes
    `;
    assert.isAtLeast(writes.length, 1);
    assert.deepStrictEqual(
      (yield* connections.reportedRuns).map((run) => run.runId),
      ["run-7"],
    );

    yield* sql`DROP TRIGGER hq_build_reviewer_runs_unwritable`;
    const restarted = yield* boot;
    assert.deepStrictEqual(
      (yield* restarted.reviewerRuns).map((run) => run.runId),
      ["run-7"],
    );
  }),
);

it.effect("a report written after its thread moved on names the run it was made in", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, runs, sql } = yield* harness;
    const records = yield* boot;
    let round = 0;
    hq.tools.call = (name) =>
      name === "weave_forge_run"
        ? {
            status: "succeeded",
            value: { run: { id: `run-${String(++round)}` }, spec: { id: "spec-1" } },
          }
        : { status: "succeeded", value: {} };
    // The first round's write fails for as long as its outage lasts.
    yield* sql`CREATE TRIGGER hq_build_reviewer_runs_unwritable
      BEFORE INSERT ON hq_build_reviewer_runs
      BEGIN SELECT RAISE(FAIL, 'unwritable'); END`;

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        runs.latestRunId = "t3-run-a";
        yield* withoutWriteBackoff(reportForgeRun(connections, reviewerThread));

        // The reviewer's next round reports from another T3 run, and the table takes writes again.
        yield* sql`DROP TRIGGER hq_build_reviewer_runs_unwritable`;
        runs.latestRunId = "t3-run-b";
        yield* withoutWriteBackoff(reportForgeRun(connections, reviewerThread));
      }),
    );

    // The earlier round's run is stored against the T3 run it was made in, not the one its thread
    // had moved on to by the time the write succeeded.
    const stored = yield* sql<{ readonly runId: string; readonly t3RunId: string | null }>`
      SELECT run_id AS "runId", t3_run_id AS "t3RunId" FROM hq_build_reviewer_runs
    `;
    assert.deepStrictEqual(
      stored.map(({ runId, t3RunId }) => [runId, t3RunId]),
      [
        ["run-1", "t3-run-a"],
        ["run-2", "t3-run-b"],
      ],
    );
  }),
);

it.effect("a delayed usage of an earlier reviewer round names that round's run", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, runs } = yield* harness;
    const records = yield* boot;
    const delivered = yield* Deferred.make<Record<string, unknown>>();
    let round = 0;
    hq.tools.call = (name, args) => {
      if (name === "weave_forge_run")
        return {
          status: "succeeded",
          value: { run: { id: `run-${String(++round)}` }, spec: { id: "spec-1" } },
        };
      if (name === "weave_forge_record_usage") Deferred.doneUnsafe(delivered, Effect.succeed(args));
      return { status: "succeeded", value: {} };
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        runs.latestRunId = "t3-run-a";
        yield* reportForgeRun(connections, reviewerThread);
        // A follow-up round reports before the first round's usage reaches the queue.
        runs.latestRunId = "t3-run-b";
        yield* reportForgeRun(connections, reviewerThread);

        yield* records.enqueue(reviewerUsageOf("t3-run-a"));

        const args = yield* Deferred.await(delivered);
        assert.strictEqual(args.runId, "run-1");
      }),
    );
  }),
);

it.effect("a reviewer's usage waits for the report of its own run and then names it", () =>
  Effect.gen(function* () {
    const { hq, connections, boot, runs } = yield* harness;
    const records = yield* boot;
    runs.latestRunId = "t3-run-a";
    const delivered = yield* Deferred.make<Record<string, unknown>>();
    hq.tools.call = (name, args) => {
      if (name === "weave_forge_run")
        return { status: "succeeded", value: { run: { id: "run-7" }, spec: { id: "spec-1" } } };
      if (name === "weave_forge_record_usage") Deferred.doneUnsafe(delivered, Effect.succeed(args));
      return { status: "succeeded", value: {} };
    };
    // Queued before the reviewer's own call has answered, so there is no run of it to name yet.
    yield* records.enqueue(reviewerUsageOf("t3-run-a"));
    yield* records.deliverDue;

    assert.deepStrictEqual(hq.toolCalls, []);
    const waiting = (yield* records.outstanding())[0];
    // Waiting is not failing: nothing is counted against the row, which the end will not pass.
    assert.strictEqual(waiting?.status, "pending");
    assert.strictEqual(waiting?.attempts, 0);

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* records.start();
        yield* reportForgeRun(connections, reviewerThread);

        const args = yield* Deferred.await(delivered);
        assert.strictEqual(args.runId, "run-7");
      }),
    );
  }),
);

it.effect(
  "a reviewer's usage with no report is sent without ids once its run's end is queued",
  () =>
    Effect.gen(function* () {
      const { hq, boot } = yield* harness;
      const records = yield* boot;
      const byRun = reviewerUsageOf("t3-run-a");
      yield* records.enqueue(byRun);
      yield* records.deliverDue;

      // A report of that run may still be on its way, and another run's would be the wrong answer.
      assert.deepStrictEqual(hq.toolCalls, []);
      assert.strictEqual((yield* records.outstanding())[0]?.status, "pending");

      yield* records.enqueue({
        kind: "end",
        recordKey: `end:${reviewerThread}:t3-run-a`,
        threadId: reviewerThread,
        role: "spec-reviewer",
      });
      yield* records.deliverDue;

      // The end says no report can follow, so the usage goes without ids, and the end after it.
      assert.deepStrictEqual(
        hq.toolCalls.map(({ name, args }) => ({ name, args })),
        [{ name: "weave_forge_record_usage", args: byRun.args }],
      );
      assert.isTrue(hq.agents.every((agent) => agent.ended));
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);
