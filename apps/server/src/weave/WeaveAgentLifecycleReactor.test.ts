import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import { leadThread, makeWeaveHarness, reviewerThread } from "./WeaveAgentConnections.testkit.ts";
import * as WeaveAgentLifecycleReactor from "./WeaveAgentLifecycleReactor.ts";
import * as WeaveForgeRecords from "./WeaveForgeRecords.ts";
import * as WeaveForgeRecordingReactor from "./WeaveForgeRecordingReactor.ts";

const projectId = ProjectId.make("project-weave");
/** A Spec lead another thread delegated, the thread T3-685 is about. */
const delegatedLead = ThreadId.make("thread-delegated-lead");
const rawChild = ThreadId.make("thread-raw-child");

type Task = Pick<
  OrchestrationV2Subagent,
  "id" | "origin" | "childThreadId" | "completionDelivery" | "pausedByParentStop"
>;
const openTask = (childThreadId: ThreadId): Task => ({
  id: `task-${childThreadId}` as never,
  origin: "app_owned",
  childThreadId,
});
/** What `task_cancel` leaves: its completion disposed other than by a Stop. */
const closedTask = (childThreadId: ThreadId): Task => ({
  ...openTask(childThreadId),
  completionDelivery: { state: "disposed", observedByRunId: null },
});

/**
 * The reactor over the real agent connections and Weave's fake, which replaces an ended agent with
 * a new id. A queued end is delivered at once, so a test sees the identity Weave would give the
 * thread's next call; the queue's own ordering is WeaveForgeRecords' to prove.
 */
const withReactor = <A, E>(
  body: (input: {
    readonly reactor: WeaveAgentLifecycleReactor.WeaveAgentLifecycleReactor["Service"];
    readonly calls: Array<{
      readonly kind: "end" | "forget" | "records";
      readonly detail: unknown;
    }>;
    readonly tasks: Map<ThreadId, Task>;
    /** Holds every run's recording until the test lets it finish, as a slow Weave read would. */
    readonly recording: { gate: (runId: string) => Effect.Effect<void> };
    /** Each thread's runs as its projection holds them, latest last. */
    readonly runs: Map<ThreadId, Array<{ id: string; ordinal: number; status: string }>>;
    readonly weave: Effect.Success<typeof makeWeaveHarness>["weave"];
    /** Calls a Forge tool as the thread's provider would and answers the agent Weave saw. */
    readonly callTool: (threadId: ThreadId, name: string) => Effect.Effect<string | undefined>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { weave, connections } = yield* makeWeaveHarness;
    yield* connections.prepare({ threadId: delegatedLead, role: "lead", model: "claude-opus-5-5" });
    const calls: Array<{ readonly kind: "end" | "forget" | "records"; readonly detail: unknown }> =
      [];
    const tasks = new Map<ThreadId, Task>();
    const runs = new Map<ThreadId, Array<{ id: string; ordinal: number; status: string }>>();
    const recording = { gate: (_runId: string): Effect.Effect<void> => Effect.void };
    const reactor = yield* Effect.service(
      WeaveAgentLifecycleReactor.WeaveAgentLifecycleReactor,
    ).pipe(
      Effect.provide(
        WeaveAgentLifecycleReactor.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: (threadId: ThreadId) =>
                  Effect.succeed({
                    id: threadId,
                    projectId,
                    lineage: { parentThreadId: threadId === leadThread ? null : leadThread },
                    ...(threadId === reviewerThread
                      ? { agentTask: { role: "reviewer", review: { scope: "spec" } } }
                      : threadId === delegatedLead
                        ? { agentTask: { role: "lead" } }
                        : {}),
                  } as never),
                getSubagentByChildThread: (threadId: ThreadId) =>
                  Effect.succeed(tasks.get(threadId) as never),
                getThreadRecords: (threadId: ThreadId) =>
                  Effect.succeed({
                    runs: runs.get(threadId) ?? [],
                  } as never),
              }),
              Layer.succeed(WeaveAgentConnections.WeaveAgentConnections, {
                ...connections,
                forget: (agent) =>
                  Effect.sync(() => void calls.push({ kind: "forget", detail: agent })),
              }),
              Layer.mock(WeaveForgeRecords.WeaveForgeRecords)({
                enqueue: (record) =>
                  Effect.sync(() => void calls.push({ kind: "end", detail: { ...record } })).pipe(
                    Effect.andThen(
                      record.kind === "end"
                        ? connections.end({ threadId: record.threadId, role: record.role })
                        : Effect.void,
                    ),
                  ),
                forgetThread: () => Effect.void,
              }),
              Layer.mock(WeaveForgeRecordingReactor.WeaveForgeRecordingReactor)({
                recordCompletion: (threadId, run) =>
                  Effect.suspend(() => recording.gate(run.id)).pipe(
                    Effect.andThen(
                      Effect.sync(() => void calls.push({ kind: "records", detail: threadId })),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
    let nextId = 0;
    const callTool = (threadId: ThreadId, name: string) =>
      Effect.gen(function* () {
        const connection = yield* connections.connection(threadId);
        yield* connections.forward({
          authorization: connection!.authorizationHeader,
          body: new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: ++nextId,
              method: "tools/call",
              params: { name, arguments: { specId: "spec-1" } },
            }),
          ),
          contentType: "application/json",
          accept: "application/json, text/event-stream",
          protocolVersion: "2025-06-18",
        });
        return weave.toolCalls.findLast((call) => call.name === name)?.agentId;
      });
    return yield* body({ reactor, calls, tasks, recording, runs, weave, callTool });
  });

const runUpdated = (
  threadId: ThreadId,
  payload: Partial<OrchestrationV2Run>,
): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: "run-1", ...payload },
  }) as unknown as OrchestrationV2DomainEvent;
const subagentUpdated = (task: Task): OrchestrationV2DomainEvent =>
  ({ type: "subagent.updated", threadId: leadThread, payload: task }) as never;
const threadEvent = (type: "thread.archived" | "thread.deleted", threadId: ThreadId) =>
  ({ type, threadId, payload: {} }) as unknown as OrchestrationV2DomainEvent;

it.effect("a delegated lead ends its own session as the agent that bound, turns later", () =>
  withReactor(({ reactor, calls, tasks, callTool }) =>
    Effect.gen(function* () {
      tasks.set(delegatedLead, openTask(delegatedLead));
      const bound = yield* callTool(delegatedLead, "weave_forge_bind");
      // Each turn that waits on a landing, a child or a watch finishes a run; a compaction or a
      // stopped provider can end one too, and the lead's first run carries no task id.
      yield* reactor.handle(
        runUpdated(delegatedLead, { id: "run-1" as never, status: "completed" }),
      );
      for (const status of ["completed", "failed", "cancelled"] as const)
        yield* reactor.handle(
          runUpdated(delegatedLead, {
            id: `run-${status}` as never,
            status,
            delegatedTaskId: "node-task" as never,
          }),
        );
      const ended = yield* callTool(delegatedLead, "weave_forge_end_session");
      const released = yield* callTool(delegatedLead, "weave_forge_release_bind");

      // Forge lets only the agent that bound end the session and release the bind.
      assert.isDefined(bound);
      assert.strictEqual(ended, bound);
      assert.strictEqual(released, bound);
      // Each finished run still queues what it owes Forge, and no end.
      assert.deepStrictEqual(
        calls.map((call) => call.kind),
        ["records", "records", "records", "records"],
      );
    }),
  ),
);

it.effect("threads stay distinct agents, each under the role it first took", () =>
  withReactor(({ reactor, weave, callTool }) =>
    Effect.gen(function* () {
      const lead = yield* callTool(leadThread, "weave_forge_read");
      const delegated = yield* callTool(delegatedLead, "weave_forge_read");
      const reviewer = yield* callTool(reviewerThread, "weave_forge_read");
      yield* reactor.handle(runUpdated(delegatedLead, { status: "completed" }));
      yield* reactor.handle(runUpdated(reviewerThread, { status: "completed" }));

      assert.strictEqual(new Set([lead, delegated, reviewer]).size, 3);
      assert.strictEqual(yield* callTool(delegatedLead, "weave_forge_read"), delegated);
      assert.strictEqual(yield* callTool(reviewerThread, "weave_forge_read"), reviewer);
      assert.deepStrictEqual(
        weave.agents.map(({ agentRef, role, ended }) => ({ agentRef, role, ended })),
        [
          { agentRef: "environment-weave/thread-lead", role: "lead", ended: false },
          { agentRef: "environment-weave/thread-delegated-lead", role: "lead", ended: false },
          { agentRef: "environment-weave/thread-reviewer", role: "spec-reviewer", ended: false },
        ],
      );
    }),
  ),
);

it.effect("a cancelled task's agent ends once its last run has stopped, after its records", () =>
  withReactor(({ reactor, calls, tasks, runs, weave, callTool }) =>
    Effect.gen(function* () {
      const before = yield* callTool(reviewerThread, "weave_forge_read");
      // task_cancel closes the task while its run is still stopping.
      runs.set(reviewerThread, [{ id: "run-1", ordinal: 1, status: "running" }]);
      tasks.set(reviewerThread, closedTask(reviewerThread));
      yield* reactor.handle(subagentUpdated(closedTask(reviewerThread)));
      assert.deepStrictEqual(calls, []);

      runs.set(reviewerThread, [{ id: "run-1", ordinal: 1, status: "cancelled" }]);
      yield* reactor.handle(
        runUpdated(reviewerThread, { status: "cancelled", delegatedTaskId: "node-task" as never }),
      );
      assert.deepStrictEqual(calls, [
        { kind: "records", detail: reviewerThread },
        { kind: "end", detail: { kind: "end", threadId: reviewerThread, role: "spec-reviewer" } },
      ]);
      assert.isTrue(weave.agents.find((agent) => agent.role === "spec-reviewer")?.ended);
      // Weave replaces an ended agent, so nothing can act as the cancelled task's agent again.
      assert.notStrictEqual(yield* callTool(reviewerThread, "weave_forge_read"), before);
    }),
  ),
);

it.effect("a task closed while its last run is still recording ends only after that record", () =>
  withReactor(({ reactor, calls, tasks, runs, recording }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      recording.gate = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      tasks.set(reviewerThread, closedTask(reviewerThread));
      runs.set(reviewerThread, [{ id: "run-1", ordinal: 1, status: "cancelled" }]);
      const finished = yield* Effect.forkChild(
        reactor.handle(
          runUpdated(reviewerThread, {
            status: "cancelled",
            delegatedTaskId: "node-task" as never,
          }),
        ),
      );
      yield* Deferred.await(entered);
      // The close reaches T3, and is handled as far as it can go, while the run's record is still
      // being prepared.
      const closed = yield* Effect.forkChild(
        reactor.handle(subagentUpdated(closedTask(reviewerThread))),
        { startImmediately: true },
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(finished);
      yield* Fiber.join(closed);

      // Each event queues the run's record before the end; the queue stores each once.
      const kinds = calls.map((call) => call.kind);
      assert.strictEqual(kinds[0], "records");
      assert.isBelow(kinds.indexOf("records"), kinds.indexOf("end"));
      assert.deepStrictEqual(kinds.toSorted(), ["end", "end", "records", "records"]);
    }),
  ),
);

it.effect("an end waits for an earlier run's record that is still being queued", () =>
  withReactor(({ reactor, calls, tasks, runs, recording }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const recorded: Array<string> = [];
      recording.gate = (runId) =>
        (runId === "run-a"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(Effect.andThen(Effect.sync(() => void recorded.push(runId))));
      tasks.set(reviewerThread, closedTask(reviewerThread));
      runs.set(reviewerThread, [
        { id: "run-a", ordinal: 1, status: "completed" },
        { id: "run-b", ordinal: 2, status: "cancelled" },
      ]);
      const first = yield* Effect.forkChild(
        reactor.handle(runUpdated(reviewerThread, { id: "run-a" as never, status: "completed" })),
      );
      yield* Deferred.await(entered);
      // Run A's record is still being prepared when run B finishes and the task closes.
      const second = yield* Effect.forkChild(
        reactor.handle(runUpdated(reviewerThread, { id: "run-b" as never, status: "cancelled" })),
        { startImmediately: true },
      );
      const closed = yield* Effect.forkChild(
        reactor.handle(subagentUpdated(closedTask(reviewerThread))),
        { startImmediately: true },
      );
      assert.notInclude(
        calls.map((call) => call.kind),
        "end",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(closed);

      assert.deepStrictEqual(recorded.slice(0, 2), ["run-a", "run-b"]);
      assert.deepStrictEqual(
        calls.slice(0, 3).map((call) => call.kind),
        ["records", "records", "end"],
      );
    }),
  ),
);

it.effect(
  "a close handled before its last run's own event still queues that run's record first",
  () =>
    withReactor(({ reactor, calls, tasks, runs }) =>
      Effect.gen(function* () {
        // The run has stopped in the projection, but its run.updated is still behind the close.
        tasks.set(reviewerThread, closedTask(reviewerThread));
        runs.set(reviewerThread, [
          { id: "run-0", ordinal: 1, status: "completed" },
          { id: "run-1", ordinal: 2, status: "cancelled" },
        ]);
        yield* reactor.handle(subagentUpdated(closedTask(reviewerThread)));
        assert.deepStrictEqual(calls, [
          { kind: "records", detail: reviewerThread },
          { kind: "end", detail: { kind: "end", threadId: reviewerThread, role: "spec-reviewer" } },
        ]);
      }),
    ),
);

it.effect("closing an idle task ends its agent at once", () =>
  withReactor(({ reactor, calls, tasks }) =>
    Effect.gen(function* () {
      tasks.set(delegatedLead, closedTask(delegatedLead));
      yield* reactor.handle(subagentUpdated(closedTask(delegatedLead)));
      assert.deepStrictEqual(calls, [
        { kind: "end", detail: { kind: "end", threadId: delegatedLead, role: "lead" } },
      ]);
    }),
  ),
);

it.effect("a Stop, an archive or an interrupted run keeps the agent", () =>
  withReactor(({ reactor, calls, tasks }) =>
    Effect.gen(function* () {
      // A Stop's disposal leaves the task open to a follow-up.
      const stopped: Task = {
        ...openTask(delegatedLead),
        completionDelivery: { state: "disposed", observedByRunId: null, stopped: true },
      };
      tasks.set(delegatedLead, stopped);
      yield* reactor.handle(subagentUpdated(stopped));
      yield* reactor.handle(runUpdated(delegatedLead, { status: "completed" }));
      yield* reactor.handle(
        runUpdated(reviewerThread, {
          status: "interrupted",
          delegatedTaskId: "node-task" as never,
        }),
      );
      yield* reactor.handle(runUpdated(leadThread, { status: "completed" }));
      yield* reactor.handle(threadEvent("thread.archived", leadThread));
      assert.deepStrictEqual(calls, [{ kind: "records", detail: delegatedLead }]);
    }),
  ),
);

it.effect("deleting a thread drops its connection", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(threadEvent("thread.deleted", leadThread));
      assert.deepStrictEqual(calls, [
        { kind: "forget", detail: { threadId: leadThread, role: "lead" } },
      ]);
    }),
  ),
);

it.effect("a raw delegated child never had a Weave agent, so nothing is ended", () =>
  withReactor(({ reactor, calls, tasks }) =>
    Effect.gen(function* () {
      tasks.set(rawChild, closedTask(rawChild));
      yield* reactor.handle(
        runUpdated(rawChild, { status: "completed", delegatedTaskId: "node-task" as never }),
      );
      yield* reactor.handle(subagentUpdated(closedTask(rawChild)));
      yield* reactor.handle(threadEvent("thread.archived", rawChild));
      yield* reactor.handle(threadEvent("thread.deleted", rawChild));
      assert.deepStrictEqual(calls, []);
    }),
  ),
);
