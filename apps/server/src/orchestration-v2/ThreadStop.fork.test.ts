import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect("a delegated task keeps the fingerprint of the request that created it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make("thread:fingerprint-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "parent", "start_immediately");
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate:fingerprinted"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "fingerprinted task",
      requestFingerprint: "f".repeat(64),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(projection.subagents[0]!.requestFingerprint, "f".repeat(64));
  }).pipe(Effect.provide(layerTest)),
);

// A task settles under its parent once the terminal reactor publishes its result.
const settledTask = (threadId: ThreadId, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.stream({ threadId, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "subagent.updated" &&
          event.payload.childThreadId === childThreadId &&
          event.payload.result !== null,
      ),
      Stream.take(1),
      Stream.runDrain,
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
      (task) => task.childThreadId === childThreadId && task.result !== null,
    )!;
  });

const resumeEffects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly thread_id: string; readonly command_id: string }>`
    SELECT thread_id, command_id FROM orchestration_v2_effect_outbox
    WHERE effect_type = 'delegated-tasks.resume'
  `;
});

it.effect("Stop pauses its tasks, and the next message a person sends resumes each of them", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:pause-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "paused child");
    const grandchildThreadId = yield* delegate(childThreadId, "paused grandchild");
    const liveRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.remote.request",
      commandId: CommandId.make("pause-remote-delegate"),
      parentThreadId,
      parentRunId: liveRun.id,
      parentNodeId: liveRun.rootNodeId!,
      task: "Run the suite there.",
      driver: ProviderDriverKind.make("remote"),
      modelSelection,
      remoteChild: {
        environmentId: EnvironmentId.make("environment:box"),
        threadId: ThreadId.make("thread:pause-on-the-box"),
        label: "Box",
      },
      completionWake: "always",
    });

    const stopCommandId = CommandId.make("pause-stop");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: stopCommandId,
      threadId: parentThreadId,
    });
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    const paused = yield* settledTask(parentThreadId, childThreadId);
    assert.equal(paused.status, "interrupted");
    assert.isTrue(paused.pausedByParentStop);
    assert.deepEqual(paused.completionDelivery, {
      state: "disposed",
      observedByRunId: null,
      stopped: true,
    });
    assert.isTrue((yield* settledTask(childThreadId, grandchildThreadId)).pausedByParentStop);
    // A task in a linked environment is stopped there, never paused or resumed here.
    const remoteTask = () =>
      orchestrator
        .getThreadProjection(parentThreadId)
        .pipe(Effect.map((p) => p.subagents.find((task) => task.remoteChild !== undefined)!));
    assert.isUndefined((yield* remoteTask()).pausedByParentStop);

    // Only a person coming back resumes the tasks; an agent's message on the thread does not.
    const before = (yield* resumeEffects).length;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("pause-agent-send"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:pause-agent-send"),
      text: "agent nudge",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.lengthOf(yield* resumeEffects, before);
    const nudge = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:pause:nudge-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    yield* send(parentThreadId, "carry on", "start_immediately");
    const resume = (yield* resumeEffects)[before];
    assert.equal(resume?.thread_id, parentThreadId);
    yield* threads.resumeDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make(resume!.command_id),
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs.at(-1)!;
    const continued = parent.subagents.find(
      (task) => task.childThreadId === childThreadId && task.id !== paused.id,
    )!;
    assert.equal(continued.runId, parentRun.id);
    assert.equal(continued.status, "running");
    assert.deepEqual(continued.completionDelivery, { state: "pending", observedByRunId: null });
    assert.isUndefined(continued.pausedByParentStop);
    assert.isUndefined(parent.subagents.find((task) => task.id === paused.id)?.pausedByParentStop);
    assert.lengthOf(
      parent.subagents.filter((task) => task.remoteChild !== undefined),
      1,
    );
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    assert.equal(child.runs.at(-1)?.delegatedTaskId, continued.id);
    assert.equal(child.runs.at(-1)?.status, "starting");

    // The resumed child resumes its own paused task in turn.
    const childResume = (yield* resumeEffects)
      .slice(before)
      .find((row) => row.thread_id === childThreadId);
    assert.isDefined(childResume);
    yield* threads.resumeDelegatedTasks({
      threadId: childThreadId,
      commandId: CommandId.make(childResume!.command_id),
    });
    const grandchild = yield* orchestrator.getThreadProjection(grandchildThreadId);
    assert.equal(grandchild.runs.at(-1)?.status, "starting");
    assert.isDefined(grandchild.runs.at(-1)?.delegatedTaskId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a waiting child stops with its parent, and cancelling a paused task closes it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:pause-waiting");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "waiting child");
    // Its turn ended, but its run still waits, with no background work.
    const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:pause-waiting:child-waiting"),
      type: "run.updated",
      threadId: childThreadId,
      runId: childRun.id,
      occurredAt: now,
      payload: { ...childRun, status: "waiting" },
    });

    const stopCommandId = CommandId.make("pause-waiting-stop");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: stopCommandId,
      threadId: parentThreadId,
    });
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
    const paused = yield* settledTask(parentThreadId, childThreadId);
    assert.equal(paused.status, "interrupted");
    assert.isTrue(paused.pausedByParentStop);

    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.dispose",
      commandId: CommandId.make("pause-waiting-cancel"),
      parentThreadId,
      taskId: paused.id,
    });
    const cancelled = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
      (task) => task.id === paused.id,
    )!;
    assert.isUndefined(cancelled.pausedByParentStop);
    assert.deepEqual(cancelled.completionDelivery, { state: "disposed", observedByRunId: null });

    yield* send(parentThreadId, "carry on", "start_immediately");
    yield* threads.resumeDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make("pause-waiting-resume"),
    });
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);
