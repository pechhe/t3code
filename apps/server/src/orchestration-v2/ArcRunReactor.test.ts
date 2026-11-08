import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { moveBlocker } from "../peer/handoff/ThreadHandoff.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ArcRunReactor from "./ArcRunReactor.ts";
import * as ForgeWatchReactor from "./ForgeWatchReactor.ts";
import {
  ARC_RUN_ANSWER,
  ARC_RUN_NO_PROGRESS_CAP,
  ARC_RUN_TURN_CEILING,
  decideArcRunWake,
} from "./arcRun.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { ARC_RUN_WAKE_MESSAGE_PREFIX, isServerContinuationRun } from "./serverContinuation.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as UnattendedReactor from "./UnattendedReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ArcRunReactor.layer,
  UnattendedReactor.layer,
  DelegatedTaskQuestionReactor.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      NodeCrypto.layer,
      ServerSettings.ServerSettingsService.layerTest(),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "arc-run" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

let arcNumbers = 7000;
let eventIds = 0;

const createThread = Effect.fn(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:arc-run"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const send = Effect.fn(function* (
  threadId: ThreadId,
  id: string,
  from: "client" | "server" = "client",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}:${id}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${id}`),
    text: `message ${id}`,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    ...(from === "client"
      ? { createdBy: "user" as const, creationSource: "web" as const }
      : { createdBy: "user" as const, creationSource: "server" as const }),
  });
});

const arcRunCommand = Effect.fn(function* (
  threadId: ThreadId,
  id: string,
  body: {
    readonly op: "start" | "checkpoint" | "pause" | "end";
    readonly arc?: { readonly number: number; readonly ref?: string };
    readonly specs?: ReadonlyArray<number>;
    readonly phase?: string;
  },
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "thread.arc-run",
    commandId: CommandId.make(`arc:${threadId}:${id}`),
    threadId,
    ...(body as { op: "start" }),
  } as never);
});

/** A thread that holds a run of its own Arc, with its first turn in progress. */
const setup = Effect.fn(function* (name: string, options: { readonly arc?: boolean } = {}) {
  const threadId = yield* createThread(name);
  const number = (arcNumbers += 1);
  if (options.arc !== false) {
    yield* arcRunCommand(threadId, "start", {
      op: "start",
      arc: { number, ref: `YS-ARC-${number}` },
    });
  }
  yield* send(threadId, "start");
  return { threadId, number, run: yield* latestRun(threadId) };
});

const records = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThreadRecords(threadId, ["runs", "messages"]),
  );

const latestRun = Effect.fn(function* (threadId: ThreadId) {
  const { runs } = yield* records(threadId);
  return runs.toSorted((a, b) => a.ordinal - b.ordinal).at(-1)!;
});

const wakes = (threadId: ThreadId) =>
  Effect.map(records(threadId), ({ messages }) =>
    messages.filter((message) => message.id.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX)),
  );

const arcRunOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    Effect.map(projections.getThread(threadId), (thread) => thread.arcRun),
  );

/** Records the run as ended and returns the event the reactor sees. */
const finish = Effect.fn(function* (
  run: OrchestrationV2Run,
  status: "completed" | "failed" | "interrupted" = "completed",
) {
  const now = yield* DateTime.now;
  const event = {
    id: EventId.make(`event:finish:${run.id}:${(eventIds += 1)}`),
    type: "run.updated",
    threadId: run.threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
  } satisfies OrchestrationV2DomainEvent;
  yield* (yield* EventSink.EventSinkV2).write({ events: [event] });
  return event;
});

/** Makes `childId` a Spec lead delegated by `parentId`, as T3's own delegation would record. */
const delegateTo = Effect.fn(function* (parentId: ThreadId, childId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const child = yield* projections.getThread(childId);
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`event:lineage:${childId}`),
        type: "thread.metadata-updated",
        threadId: childId,
        occurredAt: now,
        payload: {
          ...child,
          lineage: { ...child.lineage, parentThreadId: parentId, relationshipToParent: "subagent" },
          agentTask: {
            role: "lead",
            taskClass: "non-ui",
            workId: "T3-1",
            attemptId: "1",
            workspacePath: "/fixture/lead",
            sourceRevision: "revision-one",
            requestFingerprint: "a".repeat(64),
            policyHash: "b".repeat(64),
            policyRevision: "test",
            briefHash: "c".repeat(64),
            sourceAccess: "scoped-write",
            toolProfile: "implementation",
            requested: modelSelection,
            assigned: null,
            effective: modelSelection,
          },
        } as never,
      },
    ],
  });
});

/** Starts a real delegated task from the parent's run and marks it working. */
const delegateSpec = Effect.fn(function* (
  parentId: ThreadId,
  parentRun: OrchestrationV2Run,
  name: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const before = (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`delegate:${parentId}:${name}`),
    parentThreadId: parentId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: `Lead ${name}`,
    completionWake: "always",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const { subagents } = yield* projections.getThreadRecords(parentId, ["subagents"]);
  const task = subagents.find(
    (candidate) =>
      candidate.childThreadId !== null && !before.some((known) => known.id === candidate.id),
  )!;
  return yield* settleTask(task, "running");
});

const settleTask = Effect.fn(function* (
  task: OrchestrationV2Subagent,
  status: "running" | "completed" | "failed",
  delivery?: "pending" | "acknowledged",
) {
  const updated = {
    ...task,
    status,
    ...(delivery === undefined
      ? {}
      : { completionDelivery: { state: delivery, observedByRunId: null } }),
  } as OrchestrationV2Subagent;
  const parent = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThreadRecords(task.threadId, ["turnItems"], {
      turnItemTypes: ["subagent"],
      turnItemStatuses: ["pending", "running", "waiting"],
    }),
  );
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      ...(status === "running"
        ? []
        : parent.turnItems.map(
            (item) =>
              ({
                id: EventId.make(`event:task-item:${item.id}:${(eventIds += 1)}`),
                type: "turn-item.updated",
                threadId: task.threadId,
                runId: item.runId,
                occurredAt: now,
                payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
              }) as never,
          )),
      {
        id: EventId.make(`event:task:${task.id}:${(eventIds += 1)}`),
        type: "subagent.updated",
        threadId: task.threadId,
        occurredAt: yield* DateTime.now,
        payload: updated,
      } as never,
    ],
  });
  return updated;
});

const writeArcRunState = Effect.fn(function* (threadId: ThreadId, state: "paused" | "attention") {
  const thread = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThread(threadId),
  );
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`event:arc-state:${threadId}:${(eventIds += 1)}`),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...thread, arcRun: { ...thread.arcRun!, state } },
      },
    ],
  });
});

const watchForgeItem = (threadId: ThreadId, number: number) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      watching: true,
      target: { kind: "build_item", number, until: "unblocked" },
    }),
  );

/** The real Forge watch reactor, reading a Forge item from `read`; `null` is an unreadable item. */
const forgeWatchReactor = (read: () => { readonly holds: ReadonlyArray<string> } | null) =>
  Effect.service(ForgeWatchReactor.ForgeWatchReactor).pipe(
    Effect.provide(
      ForgeWatchReactor.layer.pipe(
        Layer.fresh,
        Layer.provide(
          Layer.mock(ForgeWorkItems.ForgeWorkItems)({
            mentions: ({ numbers }) =>
              Effect.sync(() => {
                const item = read();
                return {
                  items: numbers.map((number) => ({
                    number,
                    unavailable: item === null,
                    url: `#${number}`,
                    readAt: null,
                    item:
                      item === null
                        ? null
                        : { title: "Hold", ref: null, status: "ready", waits: [], ...item },
                  })),
                } as never;
              }),
          }),
        ),
      ),
    ),
  );

const buildWakes = (threadId: ThreadId) =>
  Effect.map(records(threadId), ({ messages }) =>
    messages.filter((message) => message.notification?.source.kind === "build_item"),
  );

it.layer(layerTest)("ArcRunReactor", (it) => {
  it.effect("wakes a completed Arc run with Away off, naming the Arc and its role", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, number, run } = yield* setup("wake");
      const event = yield* finish(run);
      yield* reactor.handle(event);
      const sent = yield* wakes(threadId);
      assert.equal(sent.length, 1);
      assert.include(sent[0]!.text, `YS-ARC-${number}`);
      assert.include(sent[0]!.text, "Arc lead");
      assert.include(sent[0]!.text, "Re-read");
      // A second look at the same ended turn changes nothing.
      yield* reactor.handle(event);
      assert.equal((yield* wakes(threadId)).length, 1);
    }),
  );

  it.effect("leaves a thread with no Arc run alone", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("no-arc", { arc: false });
      yield* reactor.handle(yield* finish(run));
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);
    }),
  );

  it.effect("waits while a queued message or a watch will bring the thread back", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const queued = yield* setup("queued");
      yield* send(queued.threadId, "follow-up", "server");
      yield* reactor.handle(yield* finish(queued.run));
      assert.equal((yield* wakes(queued.threadId)).length, 0);

      const watching = yield* setup("watching");
      const other = yield* createThread("watched");
      yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("watch:watching"),
        threadId: watching.threadId,
        watching: true,
        target: { kind: "thread", threadId: other },
      });
      yield* reactor.handle(yield* finish(watching.run));
      assert.equal((yield* wakes(watching.threadId)).length, 0);
    }),
  );

  it.effect("the watchdog stays quiet over a waiting run, then wakes it once that changes", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("quiet");
      yield* send(threadId, "behind", "server");
      yield* finish(run);
      const before = (yield* records(threadId)).runs.length;
      yield* reactor.sweep("watchdog");
      assert.equal((yield* records(threadId)).runs.length, before);
      assert.equal((yield* wakes(threadId)).length, 0);

      const queued = yield* latestRun(threadId);
      yield* finish(queued);
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 1);
    }),
  );

  it.effect("a failed run waits for the watchdog, and a startup pass finds an idle run", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const failed = yield* setup("failed");
      const event = yield* finish(failed.run, "failed");
      yield* reactor.handle(event);
      assert.equal((yield* wakes(failed.threadId)).length, 0);
      yield* reactor.sweep("watchdog");
      const sent = yield* wakes(failed.threadId);
      assert.equal(sent.length, 1);
      assert.include(sent[0]!.text, "failed");

      const idle = yield* setup("idle-through-restart");
      yield* finish(idle.run);
      yield* reactor.sweep("startup");
      assert.equal((yield* wakes(idle.threadId)).length, 1);
    }),
  );

  it.effect("needs attention after repeated wakes with no advancing checkpoint", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("cap");
      yield* arcRunCommand(threadId, "first", { op: "checkpoint", phase: "Implementing" });
      let current = run;
      for (let wake = 0; wake < ARC_RUN_NO_PROGRESS_CAP; wake += 1) {
        yield* reactor.handle(yield* finish(current));
        current = yield* latestRun(threadId);
        yield* TestClock.adjust("1 minute");
        // Checkpointing the same phase is not progress.
        yield* arcRunCommand(threadId, `same:${wake}`, { op: "checkpoint", phase: "Implementing" });
      }
      assert.equal((yield* wakes(threadId)).length, ARC_RUN_NO_PROGRESS_CAP);
      assert.equal((yield* arcRunOf(threadId))?.state, "active");
      yield* reactor.handle(yield* finish(current));
      assert.equal((yield* arcRunOf(threadId))?.state, "attention");
      const sent = yield* wakes(threadId);
      assert.equal(sent.length, ARC_RUN_NO_PROGRESS_CAP + 1);
      assert.isTrue(
        sent.some((message) => message.text.includes("last turn until the owner replies")),
      );
      // The report turn ends and nothing follows, from an event or the watchdog.
      yield* reactor.handle(yield* finish(yield* latestRun(threadId)));
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, ARC_RUN_NO_PROGRESS_CAP + 1);
      // The owner's message puts it back to work.
      yield* send(threadId, "owner");
      assert.equal((yield* arcRunOf(threadId))?.state, "active");
    }),
  );

  it.effect("an advancing checkpoint resets the no-progress count", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("advancing");
      let current = run;
      for (let wake = 0; wake < ARC_RUN_NO_PROGRESS_CAP + 2; wake += 1) {
        yield* reactor.handle(yield* finish(current));
        current = yield* latestRun(threadId);
        yield* TestClock.adjust("1 minute");
        yield* arcRunCommand(threadId, `phase:${wake}`, {
          op: "checkpoint",
          phase: `Spec ${wake}`,
        });
      }
      assert.equal((yield* arcRunOf(threadId))?.state, "active");
    }),
  );

  it.effect("Stop pauses the run through later events, and only the owner resumes it", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* setup("stop");
      const finished = yield* finish(run);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop:stop"),
        threadId,
      });
      assert.equal((yield* arcRunOf(threadId))?.state, "paused");
      yield* reactor.handle(finished);
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);

      // A server message marked as the user's is not the owner speaking.
      yield* send(threadId, "failover", "server");
      assert.equal((yield* arcRunOf(threadId))?.state, "paused");

      yield* send(threadId, "resume");
      const resumed = yield* arcRunOf(threadId);
      assert.equal(resumed?.state, "active");
      assert.equal(resumed?.resumed, true);
    }),
  );

  it.effect("Stop pauses a run whose turn is still going, and holds it through a sweep", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* setup("stop-live");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop:stop-live"),
        threadId,
      });
      assert.equal((yield* arcRunOf(threadId))?.state, "paused");
      yield* reactor.sweep("startup");
      assert.equal((yield* wakes(threadId)).length, 0);
    }),
  );

  it.effect("Stop and the owner's message both cancel a queued wake", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("stale-wake");
      yield* reactor.handle(yield* finish(run));
      const wakeRun = yield* latestRun(threadId);
      assert.isTrue(wakeRun.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX));
      yield* send(threadId, "owner");
      const { runs } = yield* records(threadId);
      const cancelled = runs.find((candidate) => candidate.id === wakeRun.id);
      assert.notEqual(cancelled?.status, "queued");

      const stopped = yield* setup("stale-wake-stop");
      yield* reactor.handle(yield* finish(stopped.run));
      const staleRun = yield* latestRun(stopped.threadId);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop:stale-wake-stop"),
        threadId: stopped.threadId,
      });
      const after = (yield* records(stopped.threadId)).runs.find(
        (candidate) => candidate.id === staleRun.id,
      );
      assert.notEqual(after?.status, "queued");
    }),
  );

  it.effect("only an explicit end finishes a run, and a Forge hold's watch keeps it quiet", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("end");
      // A final-sounding turn still gets woken.
      yield* reactor.handle(yield* finish(run));
      assert.equal((yield* wakes(threadId)).length, 1);
      yield* arcRunCommand(threadId, "end", { op: "end" });
      assert.isUndefined(yield* arcRunOf(threadId));
      yield* reactor.handle(yield* finish(yield* latestRun(threadId)));
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 1);
    }),
  );

  it.effect("a second thread cannot start a run on an Arc that has one", () =>
    Effect.gen(function* () {
      const first = yield* setup("owner-thread");
      const second = yield* createThread("second-thread");
      const refused = yield* Effect.exit(
        arcRunCommand(second, "start", { op: "start", arc: { number: first.number } }),
      );
      assert.isTrue(refused._tag === "Failure");
      assert.isUndefined(yield* arcRunOf(second));
    }),
  );

  it.effect("settling or archiving ends the run, and unsettling does not restart it", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* setup("settle");
      const finished = yield* finish(run);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:settle"),
        threadId,
      });
      assert.isUndefined(yield* arcRunOf(threadId));
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:settle"),
        threadId,
        reason: "user",
      });
      yield* reactor.handle(finished);
      assert.isUndefined(yield* arcRunOf(threadId));
      assert.equal((yield* wakes(threadId)).length, 0);
    }),
  );

  it.effect("automatic settlement leaves a thread with an Arc run alone", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* setup("no-auto-settle");
      yield* finish(run);
      assert.lengthOf(yield* projections.getSettlementCandidates(threadId), 0);
      yield* arcRunCommand(threadId, "end", { op: "end" });
      assert.lengthOf(yield* projections.getSettlementCandidates(threadId), 1);
    }),
  );

  it.effect("a running Arc blocks moving the thread until it is paused", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId } = yield* setup("move");
      assert.include(moveBlocker(yield* projections.getThread(threadId), null) ?? "", "Arc");
      yield* arcRunCommand(threadId, "pause", { op: "pause" });
      assert.isNull(moveBlocker(yield* projections.getThread(threadId), null));
    }),
  );

  it.effect("a Spec lead's turn-end goes to its Arc lead, with Away on, not back to itself", () =>
    Effect.gen(function* () {
      const unattended = yield* UnattendedReactor.UnattendedReactor;
      const parent = yield* setup("arc-parent");
      const child = yield* setup("spec-lead", { arc: false });
      yield* delegateTo(parent.threadId, child.threadId);
      yield* unattended.setAway(true);
      yield* unattended.handle(yield* finish(child.run));
      const { messages } = yield* records(child.threadId);
      assert.isFalse(messages.some((message) => message.id.includes("unattended-continuation")));
      yield* unattended.setAway(false);
    }),
  );

  it.effect("an Arc lead's own question is answered in words true with the owner present", () =>
    Effect.gen(function* () {
      const unattended = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("own-question");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const requestId = RuntimeRequestId.make("request:own-question");
      const sessionId = ProviderSessionId.make("session:own-question");
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:session:own-question"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      const requestEvent = {
        id: EventId.make("event:request:own-question"),
        type: "runtime-request.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: now,
          resolvedAt: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      yield* (yield* EventSink.EventSinkV2).write({ events: [requestEvent] });
      const item = {
        id: EventId.make("event:item:own-question"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          type: "user_input_request",
          id: TurnItemId.make("item:own-question"),
          threadId,
          runId: run.id,
          nodeId: NodeId.make("node:own-question"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId,
          questions: [{ id: "Which?", header: "Which", question: "Which?", options: [] }],
        },
      } satisfies OrchestrationV2DomainEvent;
      yield* (yield* EventSink.EventSinkV2).write({ events: [item] });
      yield* unattended.handle(requestEvent);
      const updated = yield* projections.getRuntimeRequest(threadId, requestId);
      assert.notEqual(updated?.status, "pending");
      assert.notInclude(ARC_RUN_ANSWER, "away");
    }),
  );

  it.effect("a Spec lead's question reaches the Arc lead, told to decide rather than ask", () =>
    Effect.gen(function* () {
      const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* setup("asking-parent");
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:asking"),
        parentThreadId: parent.threadId,
        parentRunId: parent.run.id,
        parentNodeId: parent.run.rootNodeId!,
        task: "Run the Spec",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { subagents } = yield* projections.getThreadRecords(parent.threadId, ["subagents"]);
      const task = subagents.find((candidate) => candidate.childThreadId !== null)!;
      const childId = task.childThreadId!;
      const childRun = yield* latestRun(childId);
      const now = yield* DateTime.now;
      const requestEvent = (kind: "user_input" | "command") =>
        ({
          id: EventId.make(`event:request:child:${kind}`),
          type: "runtime-request.updated",
          threadId: childId,
          runId: childRun.id,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:child:${kind}`),
            nodeId: childRun.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        }) as never as OrchestrationV2DomainEvent;
      const question = requestEvent("user_input");
      yield* (yield* EventSink.EventSinkV2).write({ events: [question] });
      yield* reactor.handle(question);
      const afterQuestion = (yield* records(parent.threadId)).messages;
      const wake = afterQuestion.find((message) => message.id.includes("delegated-task-question"));
      assert.include(wake?.text ?? "", "You answer for this Arc");
      assert.notInclude(wake?.text ?? "", "otherwise ask the user");

      const approval = requestEvent("command");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          approval,
          {
            id: EventId.make("event:item:child-approval"),
            type: "turn-item.updated",
            threadId: childId,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              type: "approval_request",
              id: TurnItemId.make("item:child-approval"),
              threadId: childId,
              runId: childRun.id,
              nodeId: childRun.rootNodeId!,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "waiting",
              title: null,
              requestKind: "command",
              prompt: "Run rm in the scratch folder?",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId: RuntimeRequestId.make("request:child:command"),
            },
          } as never,
        ],
      });
      yield* reactor.handle(approval);
      const told = (yield* records(parent.threadId)).messages.filter((message) =>
        message.text.includes("Only the owner can answer this"),
      );
      assert.equal(told.length, 1);
      assert.include(told[0]!.text, "Run rm in the scratch folder?");
    }),
  );

  it.effect("the watchdog tells the lead once about a silent child, and never touches it", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* setup("stall-parent");
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:stall"),
        parentThreadId: parent.threadId,
        parentRunId: parent.run.id,
        parentNodeId: parent.run.rootNodeId!,
        task: "Run the Spec",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { subagents } = yield* projections.getThreadRecords(parent.threadId, ["subagents"]);
      const task = subagents.find((candidate) => candidate.childThreadId !== null)!;
      const childId = task.childThreadId!;
      const childRun = yield* latestRun(childId);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:child:running"),
            type: "run.updated",
            threadId: childId,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...childRun, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:task:running"),
            type: "subagent.updated",
            threadId: parent.threadId,
            runId: parent.run.id,
            occurredAt: now,
            payload: { ...task, status: "running" },
          } as never,
        ],
      });
      const stalls = Effect.map(wakes(parent.threadId), (sent) =>
        sent.filter((message) => message.id.includes(":stall:")),
      );
      yield* reactor.sweep("watchdog");
      assert.equal((yield* stalls).length, 0);

      yield* TestClock.adjust("2 hours");
      yield* reactor.sweep("startup");
      assert.equal((yield* stalls).length, 0);
      yield* reactor.sweep("watchdog");
      const reported = yield* stalls;
      assert.equal(reported.length, 1);
      assert.include(reported[0]!.text, "silent for");
      // Nothing changed in the child, so the next pass has nothing new to say.
      yield* reactor.sweep("watchdog");
      assert.equal((yield* stalls).length, 1);
      assert.equal((yield* latestRun(childId)).status, "running");
    }),
  );

  it.effect(
    "a Forge watch that fired as unreadable wakes the lead instead of waiting forever",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { threadId } = yield* setup("unreadable");
        yield* orchestrator.dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make("watch:unreadable"),
          threadId,
          watching: true,
          target: { kind: "build_item", number: 42, until: "unblocked" },
        });
        const watch = (yield* projections.getThread(threadId)).threadWatches![0]!;
        yield* orchestrator.dispatch({
          type: "thread.thread-watch.fire",
          commandId: CommandId.make("fire:unreadable"),
          threadId,
          watchId: watch.id,
          build: { number: 42, title: "Held", url: "#42", condition: "unreadable" },
        });
        const after = yield* projections.getThread(threadId);
        assert.equal(after.threadWatches?.length ?? 0, 0);
        const { messages } = yield* records(threadId);
        assert.isTrue(messages.some((message) => message.text.includes("could not be read")));
      }),
  );

  it.effect("takes an Arc across two Specs, a failure, a restart and a hold with no human", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("journey");
      const humanMessages = Effect.map(records(threadId), ({ messages }) =>
        messages.filter((message) => message.role === "user" && message.createdBy === "user"),
      );
      const humansAtStart = (yield* humanMessages).length;
      const looks = { blocked: true };
      const forge = yield* forgeWatchReactor(() => ({ holds: looks.blocked ? ["hold"] : [] }));

      // Spec 1's lead is out, so the Arc lead's turn ending and the watchdog both stay quiet.
      const spec1 = yield* delegateSpec(threadId, run, "spec-1");
      yield* reactor.handle(yield* finish(run));
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);

      // Spec 1's lead fails. Its result is owed, then delivered, and only then is the lead woken.
      yield* settleTask(spec1, "failed", "pending");
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);
      yield* settleTask(spec1, "failed", "acknowledged");
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 1);

      // The lead re-reads, retries with a Spec 2 lead, and the provider's turn fails: no retry
      // storm from the event, and the watchdog is what brings it back.
      yield* TestClock.adjust("1 minute");
      yield* arcRunCommand(threadId, "spec-2", { op: "checkpoint", phase: "Spec 2" });
      const failing = yield* latestRun(threadId);
      const spec2 = yield* delegateSpec(threadId, failing, "spec-2");
      yield* settleTask(spec2, "completed", "acknowledged");
      yield* reactor.handle(yield* finish(failing, "failed"));
      assert.equal((yield* wakes(threadId)).length, 1);
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 2);

      // The server restarts with that turn just ended: a fresh reactor carries it on from durable
      // state alone.
      yield* finish(yield* latestRun(threadId));
      const restarted = yield* Effect.service(ArcRunReactor.ArcRunReactor).pipe(
        Effect.provide(Layer.fresh(ArcRunReactor.layer)),
      );
      yield* restarted.sweep("startup");
      assert.equal((yield* wakes(threadId)).length, 3);

      // Only a Forge hold remains: its watch keeps the run quiet without a model call.
      yield* TestClock.adjust("1 minute");
      yield* arcRunCommand(threadId, "held", { op: "checkpoint", phase: "Held on the owner" });
      yield* watchForgeItem(threadId, 99);
      yield* restarted.handle(yield* finish(yield* latestRun(threadId)));
      yield* restarted.sweep("watchdog");
      yield* forge.sweep;
      assert.equal((yield* wakes(threadId)).length, 3);
      assert.equal((yield* buildWakes(threadId)).length, 0);

      // The hold clears: Forge's own check wakes it, and it proves the outcome and ends the run.
      looks.blocked = false;
      yield* TestClock.adjust("1 minute");
      yield* forge.sweep;
      assert.equal((yield* buildWakes(threadId)).length, 1);
      yield* arcRunCommand(threadId, "done", { op: "end" });
      yield* restarted.sweep("watchdog");
      assert.isUndefined(yield* arcRunOf(threadId));
      assert.equal((yield* wakes(threadId)).length, 3);
      assert.equal((yield* humanMessages).length, humansAtStart);
    }),
  );

  it.effect("an open command is not reported at the short threshold", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("open-command");
      const task = yield* delegateSpec(threadId, run, "busy");
      const childId = task.childThreadId!;
      const childRun = yield* latestRun(childId);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:child:open-command"),
            type: "run.updated",
            threadId: childId,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...childRun, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:item:open-command"),
            type: "turn-item.updated",
            threadId: childId,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              type: "command_execution",
              id: TurnItemId.make("item:open-command"),
              threadId: childId,
              runId: childRun.id,
              nodeId: childRun.rootNodeId!,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              input: "long-build",
            },
          } as never,
        ],
      });
      const stalls = Effect.map(wakes(threadId), (sent) =>
        sent.filter((message) => message.id.includes(":stall:")),
      );
      yield* TestClock.adjust("2 hours");
      yield* reactor.sweep("watchdog");
      assert.equal((yield* stalls).length, 0);
      yield* TestClock.adjust("5 hours");
      yield* reactor.sweep("watchdog");
      const reported = yield* stalls;
      assert.equal(reported.length, 1);
      assert.include(reported[0]!.text, "still open");
    }),
  );

  it.effect("a Forge watch counts as unreadable only after an hour of failed reads", () =>
    Effect.gen(function* () {
      const { threadId, run } = yield* setup("unreadable-span");
      const reads = { readable: false };
      const forge = yield* forgeWatchReactor(() => (reads.readable ? { holds: ["hold"] } : null));
      yield* watchForgeItem(threadId, 77);
      yield* finish(run);

      // The watch is old, but this is the first failed read: Forge may just not be connected yet.
      yield* TestClock.adjust("3 hours");
      yield* forge.sweep;
      assert.equal((yield* buildWakes(threadId)).length, 0);

      // A good read starts the clock again.
      yield* TestClock.adjust("50 minutes");
      reads.readable = true;
      yield* forge.sweep;
      reads.readable = false;
      yield* TestClock.adjust("50 minutes");
      yield* forge.sweep;
      assert.equal((yield* buildWakes(threadId)).length, 0);

      yield* TestClock.adjust("61 minutes");
      yield* forge.sweep;
      const fired = yield* buildWakes(threadId);
      assert.equal(fired.length, 1);
      assert.include(fired[0]!.text, "could not be read");
    }),
  );

  it.effect("a held run keeps what it is sent until the owner replies", () =>
    Effect.gen(function* () {
      for (const held of ["paused", "attention"] as const) {
        const { threadId, run } = yield* setup(`held-${held}`);
        yield* finish(run);
        yield* writeArcRunState(threadId, held);
        yield* send(threadId, "from-server", "server");
        const heldRun = yield* latestRun(threadId);
        assert.equal(heldRun.status, "queued");
        assert.isTrue(heldRun.queueHeld);

        yield* send(threadId, "from-owner");
        const after = (yield* records(threadId)).runs.find((item) => item.id === heldRun.id)!;
        assert.notEqual(after.queueHeld, true);
        assert.equal((yield* arcRunOf(threadId))?.state, "active");
      }
    }),
  );

  it.effect("reaching a limit still gets the one report to the owner", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const { threadId, run } = yield* setup("held-report");
      yield* finish(run);
      for (let index = 0; index < ARC_RUN_NO_PROGRESS_CAP + 1; index += 1) {
        yield* reactor.sweep("watchdog");
        yield* finish(yield* latestRun(threadId));
      }
      assert.equal((yield* arcRunOf(threadId))?.state, "attention");
      const sent = yield* wakes(threadId);
      assert.isTrue(sent.some((message) => message.text.includes("stopped waking")));
      // Durable across a restart: a fresh reactor adds nothing, whatever the trigger.
      yield* finish(yield* latestRun(threadId));
      const restarted = yield* Effect.service(ArcRunReactor.ArcRunReactor).pipe(
        Effect.provide(Layer.fresh(ArcRunReactor.layer)),
      );
      yield* restarted.sweep("startup");
      assert.equal((yield* arcRunOf(threadId))?.state, "attention");
      assert.equal((yield* wakes(threadId)).length, sent.length);
      yield* send(threadId, "late-question", "server");
      assert.isTrue((yield* latestRun(threadId)).queueHeld);
      assert.equal((yield* wakes(threadId)).length, sent.length);
    }),
  );

  it.effect("a limit failure wakes the lead only when recovery is switched off", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { threadId, run } = yield* setup("limit");
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:limit-error"),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              type: "error",
              id: TurnItemId.make("item:limit-error"),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId!,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: { class: "usage_limit", message: "Limited.", code: null, retryable: null },
            },
          } as never,
        ],
      });
      yield* finish(run, "failed");
      yield* settings.updateSettings({ autoResumeLimitedThreads: true });
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);
      yield* settings.updateSettings({ autoResumeLimitedThreads: false });
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 1);
    }),
  );

  it.effect("a fixed-choice dialog is a hold: the lead is not woken to answer it", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, run } = yield* setup("fixed-choice");
      const requestId = RuntimeRequestId.make("request:fixed-choice");
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:request:fixed-choice"),
            type: "runtime-request.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: run.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: EventId.make("event:item:fixed-choice"),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              type: "user_input_request",
              id: TurnItemId.make("item:fixed-choice"),
              threadId,
              runId: run.id,
              nodeId: NodeId.make("node:fixed-choice"),
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId,
              questions: [
                {
                  id: "Resume?",
                  header: "Resume",
                  question: "Resume?",
                  options: [],
                  allowCustomAnswer: false,
                },
              ],
            },
          },
        ],
      });
      yield* reactor.handle(yield* finish(run));
      assert.equal((yield* wakes(threadId)).length, 0);
      assert.equal((yield* projections.getRuntimeRequest(threadId, requestId))?.status, "pending");
    }),
  );

  it.effect("a snoozed run hears nothing from the watchdog until the snooze ends", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* setup("snooze");
      yield* finish(run, "failed");
      const until = DateTime.add(yield* DateTime.now, { hours: 1 });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:arc"),
        threadId,
        snoozedUntil: DateTime.formatIso(until),
      } as never);
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 0);
      yield* TestClock.adjust("61 minutes");
      yield* reactor.sweep("watchdog");
      assert.equal((yield* wakes(threadId)).length, 1);
    }),
  );

  it.effect("a delegated task cannot run an Arc, and ending no run is not an error", () =>
    Effect.gen(function* () {
      const { threadId, run } = yield* setup("delegated-refusal");
      const childId = yield* delegateSpec(threadId, run, "refused").pipe(
        Effect.map((task) => task.childThreadId!),
      );
      const refused = yield* Effect.exit(
        arcRunCommand(childId, "start", { op: "start", arc: { number: 9_999 } }),
      );
      assert.isTrue(refused._tag === "Failure");
      const plain = yield* setup("no-run", { arc: false });
      const ended = yield* Effect.exit(arcRunCommand(plain.threadId, "end", { op: "end" }));
      assert.isTrue(ended._tag === "Success");
    }),
  );

  it.effect("starting again cannot re-arm a held run, or reset an active run's progress", () =>
    Effect.gen(function* () {
      const { threadId, number } = yield* setup("restart-held");
      const arc = { number };
      const before = (yield* arcRunOf(threadId))!;
      yield* TestClock.adjust("1 minute");
      yield* arcRunCommand(threadId, "again", { op: "start", arc });
      assert.equal((yield* arcRunOf(threadId))?.progressAt, before.progressAt);
      for (const held of ["paused", "attention"] as const) {
        yield* writeArcRunState(threadId, held);
        const refused = yield* Effect.exit(
          arcRunCommand(threadId, `re-arm-${held}`, { op: "start", arc }),
        );
        assert.isTrue(refused._tag === "Failure");
        assert.equal((yield* arcRunOf(threadId))?.state, held);
      }
    }),
  );

  it.effect("wakes from different turns run strictly one at a time, in order", () =>
    Effect.gen(function* () {
      const { threadId } = yield* setup("one-at-a-time");
      yield* send(threadId, "result-of-turn-1", "server");
      yield* send(threadId, "result-of-turn-2", "server");
      const { runs } = yield* records(threadId);
      const queued = runs.filter((run) => run.status === "queued");
      assert.equal(runs.length - queued.length, 1);
      const order = queued
        .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal))
        .map((run) => run.userMessageId)
        .filter((id) => id.includes("result-of-turn"));
      assert.deepEqual(
        order.map((id) => id.split(":").at(-1)),
        ["result-of-turn-1", "result-of-turn-2"],
      );
    }),
  );

  it.effect("threads can run separate Specs of one Arc, but not the same Specs or the whole", () =>
    Effect.gen(function* () {
      const reactor = yield* ArcRunReactor.ArcRunReactor;
      const number = (arcNumbers += 1);
      const first = yield* createThread("scope-first");
      const start = (threadId: ThreadId, id: string, specs?: ReadonlyArray<number>) =>
        Effect.exit(
          arcRunCommand(threadId, id, {
            op: "start",
            arc: { number, ref: `YS-ARC-${number}` },
            ...(specs === undefined ? {} : { specs }),
          }),
        );
      assert.equal((yield* start(first, "start", [101, 102]))._tag, "Success");

      const second = yield* createThread("scope-second");
      assert.equal((yield* start(second, "overlap", [102, 103]))._tag, "Failure");
      assert.equal((yield* start(second, "whole"))._tag, "Failure");
      assert.equal((yield* start(second, "separate", [103]))._tag, "Success");

      // A run's scope never changes silently: widening it means ending it first.
      assert.equal((yield* start(first, "same", [101, 102]))._tag, "Success");
      assert.equal((yield* start(first, "widen"))._tag, "Failure");
      assert.deepEqual((yield* arcRunOf(first))?.specs, [101, 102]);

      yield* send(first, "start");
      yield* reactor.handle(yield* finish(yield* latestRun(first)));
      const [wake] = yield* wakes(first);
      assert.include(wake!.text, "You lead Specs #101, #102 within Arc");
      assert.include(wake!.text, "not the rest of the Arc");
    }),
  );

  it.effect("two threads racing to start one Arc leave it one owner", () =>
    Effect.gen(function* () {
      const number = (arcNumbers += 1);
      const threads = yield* Effect.forEach(["race-a", "race-b"], createThread);
      const results = yield* Effect.forEach(
        threads,
        (threadId) =>
          Effect.exit(arcRunCommand(threadId, "start", { op: "start", arc: { number } })),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  );

  it("decideArcRunWake counts an undelivered result as a next trigger, and enforces the ceiling", () => {
    const now = DateTime.makeUnsafe("2026-11-08T12:00:00Z");
    const iso = DateTime.formatIso(now);
    const run = (ordinal: number, userMessageId = `message:${ordinal}`) =>
      ({
        id: `run:${ordinal}`,
        threadId: "thread:pure",
        ordinal,
        status: "completed",
        userMessageId,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
      }) as unknown as OrchestrationV2Run;
    const thread = {
      id: "thread:pure",
      activeProviderThreadId: null,
      arcRun: {
        arc: { number: 1 },
        state: "active",
        startedAt: iso,
        progressAt: iso,
        ceilingSince: iso,
      },
    } as never;
    const state = {
      thread,
      runs: [run(1)],
      subagents: [] as ReadonlyArray<OrchestrationV2Subagent>,
      providerThreads: [],
      turnItems: [],
    };
    assert.deepEqual(decideArcRunWake(state, "event"), { kind: "continue" });
    assert.isUndefined(
      decideArcRunWake(
        {
          ...state,
          subagents: [
            {
              origin: "app_owned",
              status: "completed",
              completionDelivery: { state: "pending", observedByRunId: null },
            } as never,
          ],
        },
        "event",
      ),
    );
    // Idle compaction is neither a turn to continue from nor one that counts.
    assert.deepEqual(
      decideArcRunWake(
        { ...state, runs: [run(1), run(2, "idle-compact:thread:pure:run:1")] },
        "event",
      ),
      { kind: "continue" },
    );
    assert.deepEqual(
      decideArcRunWake(
        {
          ...state,
          runs: Array.from({ length: ARC_RUN_TURN_CEILING }, (_, index) => run(index + 1)),
        },
        "event",
      ),
      { kind: "attention", reason: "ceiling" },
    );
    // A lead that always has a task out still spends turns.
    assert.deepEqual(
      decideArcRunWake(
        {
          ...state,
          runs: Array.from({ length: ARC_RUN_TURN_CEILING }, (_, index) => run(index + 1)),
          subagents: [{ origin: "app_owned", status: "running" } as never],
        },
        "event",
      ),
      { kind: "attention", reason: "ceiling" },
    );
  });

  it("an Arc wake does not count towards the restart continuation chain", () => {
    assert.isFalse(
      isServerContinuationRun({
        userMessageId: MessageId.make(`${ARC_RUN_WAKE_MESSAGE_PREFIX}continue:run:1`),
      }),
    );
  });
});
