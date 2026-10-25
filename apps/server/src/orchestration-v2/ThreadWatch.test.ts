import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadWatch, type ForgeWorkItemSummary } from "@t3tools/contracts";
import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as HqAgentConnections from "../hq/HqAgentConnections.ts";
import * as ForgeWatchReactor from "./ForgeWatchReactor.ts";
import * as LandingWatchReactor from "./LandingWatchReactor.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import type { TrackedLanding } from "../project/slipJayLandingState.ts";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadWatchReactor from "./ThreadWatchReactor.ts";
import { threadWatchRefusal } from "./threadWatch.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-thread-watch-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by thread watch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    listPools: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerRuntime = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(Layer.mock(ManagedAgent.ManagedAgentService)({})),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provideMerge(layerPlatformTest),
);

const layerTest = ThreadWatchReactor.layer.pipe(
  Layer.provide(ProjectionStore.layer),
  Layer.provideMerge(layerRuntime),
);

const now = DateTime.makeUnsafe("2026-10-16T10:00:00.000Z");
const rootNodeId = NodeId.make("node:thread-watch-root");

const createThread = (name: string, title = name) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectId = ProjectId.make(`project:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`command:project:${name}`),
      projectId,
      title,
      workspaceRoot: `/workspace/${name}`,
    });
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return threadId;
  });

const run = (
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(`${threadId}:run:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`${threadId}:prompt:${ordinal}`),
  rootNodeId,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "running" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});

/** Writes a run of the watched thread and, when given, its final assistant message. */
const seedRun = (
  threadId: ThreadId,
  input: {
    readonly ordinal?: number;
    readonly status: OrchestrationV2Run["status"];
    /** A run its queue holds, as a Stop leaves it: queued and never started. */
    readonly held?: boolean;
    readonly text?: string;
    readonly extra?: ReadonlyArray<OrchestrationV2DomainEvent>;
  },
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const seeded = {
      ...run(threadId, input.ordinal ?? 1, input.status),
      ...(input.held === true ? { queueHeld: true, startedAt: null, completedAt: null } : {}),
    };
    const scope = {
      threadId,
      runId: seeded.id,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
    };
    const message =
      input.text === undefined
        ? undefined
        : makeSubagentConversationArtifacts({
            messageId: MessageId.make(`${seeded.id}:answer`),
            turnItemId: TurnItemId.make(`${seeded.id}:answer`),
            threadId,
            rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            role: "assistant",
            text: input.text,
            ordinal: 1,
            now,
          });
    return yield* eventSink.write({
      commandId: CommandId.make(`command:seed:${seeded.id}:${input.status}`),
      events: [
        {
          ...scope,
          id: EventId.make(`event:${seeded.id}:${input.status}`),
          type: "run.updated",
          payload: seeded,
        },
        ...(message === undefined
          ? []
          : [
              {
                ...scope,
                id: EventId.make(`event:${seeded.id}:message`),
                type: "message.updated" as const,
                payload: { ...message.message, runId: seeded.id },
              },
              {
                ...scope,
                id: EventId.make(`event:${seeded.id}:item`),
                type: "turn-item.updated" as const,
                payload: { ...message.turnItem, runId: seeded.id },
              },
            ]),
        ...(input.extra ?? []),
      ],
    });
  });

/**
 * A monitor run: a wake T3 Code wrote for itself, such as a pull request watch. Its user message
 * carries the monitor notification that tells `delegatedTaskProgress` the run is not the thread's
 * own work. Written once, when the run starts.
 */
const seedMonitorRun = (
  threadId: ThreadId,
  input: {
    readonly ordinal: number;
    readonly status: OrchestrationV2Run["status"];
    readonly withWake?: boolean;
  },
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const monitor = run(threadId, input.ordinal, input.status);
    const scope = {
      threadId,
      runId: monitor.id,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
    };
    const wake =
      input.withWake === true
        ? makeSubagentConversationArtifacts({
            messageId: MessageId.make(`${monitor.id}:wake`),
            turnItemId: TurnItemId.make(`${monitor.id}:wake`),
            threadId,
            rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            role: "user",
            text: "Update on pull request #7, which T3 Code is watching for you.",
            ordinal: 1,
            now,
          })
        : undefined;
    return yield* eventSink.write({
      commandId: CommandId.make(`command:seed-monitor:${monitor.id}:${input.status}`),
      events: [
        {
          ...scope,
          id: EventId.make(`event:${monitor.id}:${input.status}`),
          type: "run.updated",
          payload: monitor,
        },
        ...(wake === undefined
          ? []
          : [
              {
                ...scope,
                id: EventId.make(`event:${monitor.id}:wake`),
                type: "message.updated" as const,
                payload: {
                  ...wake.message,
                  runId: monitor.id,
                  notification: {
                    source: { kind: "monitor" as const },
                    outcome: "updated" as const,
                    summary: "#7",
                  },
                },
              },
            ]),
      ],
    });
  });

/** A Claude background command: the turn ended, and the provider still lists the command. */
const seedBackgroundCommand = (worker: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(`provider-thread:${worker}`);
    const seeded = { ...run(worker, 1, "completed"), providerThreadId };
    const scope = {
      threadId: worker,
      runId: seeded.id,
      nodeId: rootNodeId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
    };
    return yield* eventSink.write({
      commandId: CommandId.make(`command:background-seed:${worker}`),
      events: [
        {
          ...scope,
          id: EventId.make(`event:background-seed:${worker}:provider-thread`),
          type: "provider-thread.updated",
          driver,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: worker,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [
              {
                taskId: "b7mkuzve3",
                description: "Wait 240 seconds in background",
                kind: "command",
              },
            ],
            contextUsage: null,
            nativeMetadata: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          ...scope,
          id: EventId.make(`event:background-seed:${worker}:node`),
          type: "node.updated",
          payload: {
            id: rootNodeId,
            threadId: worker,
            runId: seeded.id,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        },
        {
          ...scope,
          id: EventId.make(`event:background-seed:${worker}:provider-turn`),
          type: "provider-turn.updated",
          payload: {
            id: ProviderTurnId.make(`provider-turn:${worker}`),
            providerThreadId,
            nodeId: rootNodeId,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          ...scope,
          id: EventId.make(`event:background-seed:${worker}:run`),
          type: "run.updated",
          payload: seeded,
        },
      ],
    });
  });

const seedBusyThread = (lead: ThreadId) =>
  Effect.gen(function* () {
    const providerThreadId = ProviderThreadId.make(`provider-thread:${lead}`);
    const busy = { ...run(lead, 1, "running"), providerThreadId };
    yield* (yield* EventSink.EventSinkV2).write({
      commandId: CommandId.make(`command:queued-lead-busy:${lead}`),
      events: [
        {
          id: EventId.make(`event:queued-lead-busy:provider-thread:${lead}`),
          type: "provider-thread.updated",
          threadId: lead,
          runId: busy.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          driver,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: lead,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:queued-lead-busy:run:${lead}`),
          type: "run.updated",
          threadId: lead,
          runId: busy.id,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: busy,
        },
      ],
    });
  });

let watchCommands = 0;
const watch = (watcherId: ThreadId, watchedThreadId: ThreadId, watching = true) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
    const result = yield* orchestrator.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make(`command:watch:${(watchCommands += 1)}`),
      threadId: watcherId,
      target: { kind: "thread", threadId: watchedThreadId },
      watching,
    });
    // As the event stream would, so a watch on a thread that already finished fires at once.
    for (const stored of result.storedEvents) yield* reactor.handle(stored.event);
  });

/** Feeds what the event sink wrote to the reactor, as its event stream does. */
const observe = (stored: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>) =>
  Effect.gen(function* () {
    const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
    for (const { event } of stored) yield* reactor.handle(event);
  });

const wakes = (watcherId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadRecords(watcherId, ["messages"]);
    return messages.filter((message) => message.notification?.source.kind === "thread");
  });

const watchesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadShell(threadId))?.threadWatches ?? [];
  });

it("refuses a watch from a subagent, which its parent owns", () => {
  const thread = {
    id: ThreadId.make("thread:child"),
    lineage: {
      parentThreadId: ThreadId.make("thread:parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("thread:parent"),
    },
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
  assert.include(threadWatchRefusal(thread, "thread:other"), "subagent");
  assert.isUndefined(
    threadWatchRefusal(
      { ...thread, lineage: { ...thread.lineage, relationshipToParent: "fork" } },
      "thread:other",
    ),
  );
});

const UNREACHABLE_BUILD_NUMBER = 1000099;

const makeForgeHarness = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const state: { item: ForgeWorkItemSummary; reads: number; waits: number; resolutions: number } = {
    item: {
      kind: "ticket",
      title: "Publish the candidate",
      status: "in_progress",
      holds: [],
      waits: [{ number: 1000002, title: "Blocker", status: "in_progress", required: "landed" }],
    },
    reads: 0,
    waits: 0,
    resolutions: 0,
  };
  const connection = { origin: "https://hq.example", connection: "test-connection" };
  const hq = Layer.mock(HqAgentConnections.HqAgentConnections)({
    read: Effect.succeed(connection),
    buildWriteVersion: Effect.succeed(0),
    observe: (tool, args) =>
      Effect.sync(() => {
        if (tool === "hq_forge_waits") {
          state.waits++;
          return {
            ...connection,
            value: state.item.waits.map((wait) => ({
              required: wait.required,
              blocker: { number: wait.number, title: wait.title, status: wait.status },
            })),
          };
        }
        // An answer T3 cannot decode reads as HQ being unreachable for that number.
        if (args.number === UNREACHABLE_BUILD_NUMBER) return { ...connection, value: {} };
        if (args.number !== undefined) state.resolutions++;
        else state.reads++;
        return {
          ...connection,
          value: {
            ...state.item,
            id: "build-item",
            number: 1000001,
            holds: state.item.holds.map((hold) => ({ ...hold, clearedAt: null })),
          },
        };
      }),
  });
  const build = yield* Effect.service(ForgeWorkItems.ForgeWorkItems).pipe(
    Effect.provide(ForgeWorkItems.layer.pipe(Layer.provide(hq))),
  );
  const restart = () =>
    Effect.service(ForgeWatchReactor.ForgeWatchReactor).pipe(
      Effect.provide(
        ForgeWatchReactor.layer.pipe(
          Layer.provide(ProjectionStore.layer),
          Layer.provide(Layer.succeed(ForgeWorkItems.ForgeWorkItems, build)),
        ),
      ),
    );
  const reactor = yield* restart();
  const start = (threadId: ThreadId, until: "unblocked" | "closed", number = 1000001) =>
    engine.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make(`command:build-watch:${threadId}:${until}:${(watchCommands += 1)}`),
      threadId,
      target: { kind: "build_item", number, until },
      watching: true,
    });
  const messages = (threadId: ThreadId) =>
    engine
      .getThreadRecords(threadId, ["messages"])
      .pipe(
        Effect.map(({ messages }) =>
          messages.filter((message) => message.notification?.source.kind === "build_item"),
        ),
      );
  return { state, reactor, restart, start, messages };
});

const decodeWatch = Schema.decodeUnknownSync(OrchestrationV2ThreadWatch);

it("decodes a stored thread watch without a target", () => {
  const watch = decodeWatch({
    id: "legacy-watch",
    threadId: "legacy-thread",
    title: "Legacy",
    startedAt: "2026-10-16T10:00:00.000Z",
  });
  assert.deepEqual(watch.target, { kind: "thread", threadId: ThreadId.make("legacy-thread") });
});

it.layer(layerTest)("thread watches", (it) => {
  it.effect("wakes its watcher once with the outcome, link, title and final message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const lead = yield* createThread("finish-lead");
      const worker = yield* createThread("finish-worker", "Fix the login");
      yield* watch(lead, worker);
      const [started] = yield* watchesOf(lead);
      assert.deepEqual(started?.target, { kind: "thread", threadId: worker });
      assert.lengthOf(yield* wakes(lead), 0);
      // The watcher shows it is waiting, so it is not auto-settled.
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(lead))?.pendingBackgroundTasks?.map(
          (task) => task.description,
        ),
        ["Watching thread Fix the login"],
      );

      yield* observe(yield* seedRun(worker, { status: "running" }));
      assert.lengthOf(yield* wakes(lead), 0);
      yield* observe(yield* seedRun(worker, { status: "completed", text: "Landed abc123." }));

      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.deepEqual(wake?.notification, {
        source: { kind: "thread", threadId: worker },
        outcome: "completed",
        summary: "Finished: Fix the login",
      });
      assert.include(wake?.text, `[Fix the login](t3-thread://v1/${worker})`);
      assert.include(wake?.text, "> Landed abc123.");
      assert.equal(wake?.id, MessageId.make(`message:${started?.id}`));
      assert.lengthOf(yield* watchesOf(lead), 0);
      // The finished watch stays as Lineage history.
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(lead))?.endedThreadWatches?.map(
          (ended) => ended.threadId,
        ),
        [worker],
      );

      // Neither another look nor a replayed fire wakes it twice.
      yield* reactor.sweep;
      const replay = yield* orchestrator
        .dispatch({
          type: "thread.thread-watch.fire",
          commandId: CommandId.make("command:replayed-fire"),
          threadId: lead,
          watchId: started?.id ?? "",
        })
        .pipe(Effect.exit);
      assert.isTrue(replay._tag === "Failure");
      assert.lengthOf(yield* wakes(lead), 1);

      // Watching again starts a new watch, which wakes once more.
      yield* watch(lead, worker);
      assert.lengthOf(yield* wakes(lead), 2);
      // The second watch ended too, but the thread is listed once.
      assert.lengthOf((yield* orchestrator.getThreadShell(lead))?.endedThreadWatches ?? [], 1);
    }),
  );

  it.effect("does not wake while the watched thread still has work after its run ends", () =>
    Effect.gen(function* () {
      const lead = yield* createThread("pause-lead");
      const worker = yield* createThread("pause-worker");
      yield* watch(lead, worker);
      const command = {
        id: TurnItemId.make("turn-item:pause-tests"),
        threadId: worker,
        runId: run(worker, 1, "completed").id,
        nodeId: rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "running" as const,
        title: "vp test run",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution" as const,
        input: "vp test run",
      };
      const commandEvent = (status: "running" | "completed") => ({
        id: EventId.make(`event:pause-tests:${status}`),
        type: "turn-item.updated" as const,
        threadId: worker,
        runId: command.runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: { ...command, status, completedAt: status === "running" ? null : now },
      });
      yield* observe(
        yield* seedRun(worker, {
          status: "completed",
          text: "Tests are running.",
          extra: [commandEvent("running")],
        }),
      );
      assert.lengthOf(yield* wakes(lead), 0);

      const eventSink = yield* EventSink.EventSinkV2;
      yield* observe(
        yield* eventSink.write({
          commandId: CommandId.make("command:pause-tests-done"),
          events: [commandEvent("completed")],
        }),
      );
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.outcome, "completed");
    }),
  );

  it.effect("does not wake for an older result while a newer run waits in a held queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const lead = yield* createThread("held-lead");
      const worker = yield* createThread("held-worker", "Held worker");
      yield* seedRun(worker, { status: "completed", text: "The first pass landed abc123." });
      yield* seedRun(worker, { ordinal: 2, status: "queued", held: true });

      yield* watch(lead, worker);
      yield* reactor.sweep;
      assert.lengthOf(yield* wakes(lead), 0);
      const [started] = yield* watchesOf(lead);
      assert.isDefined(started);
      // A fire already in flight redecides under the watcher's lock, and still waits.
      const early = yield* orchestrator.dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make("command:held-fire"),
        threadId: lead,
        watchId: started?.id ?? "",
      });
      assert.lengthOf(early.storedEvents, 0);
      assert.lengthOf(yield* wakes(lead), 0);
      assert.lengthOf(yield* watchesOf(lead), 1);

      // The queue runs again and finishes, and the wake quotes that newer result.
      yield* observe(yield* seedRun(worker, { ordinal: 2, status: "running" }));
      assert.lengthOf(yield* wakes(lead), 0);
      yield* observe(
        yield* seedRun(worker, {
          ordinal: 2,
          status: "completed",
          text: "The second pass landed def456.",
        }),
      );
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.summary, "Finished: Held worker");
      assert.include(wake?.text, "> The second pass landed def456.");
      assert.notInclude(wake?.text, "abc123");
    }),
  );

  it.effect("does not wake for the older result while a monitor run is unfinished", () =>
    Effect.gen(function* () {
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const lead = yield* createThread("monitor-lead");
      const worker = yield* createThread("monitor-worker", "Monitored");
      yield* seedRun(worker, { status: "completed", text: "Landed abc123." });
      yield* seedMonitorRun(worker, { ordinal: 2, status: "running", withWake: true });
      yield* watch(lead, worker);
      yield* reactor.sweep;
      assert.lengthOf(yield* wakes(lead), 0);

      // The monitor's run is not the thread's own result, so the wake keeps the ordinary run's.
      yield* observe(yield* seedMonitorRun(worker, { ordinal: 2, status: "completed" }));
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.summary, "Finished: Monitored");
      assert.include(wake?.text, "> Landed abc123.");
    }),
  );

  it.effect("waits for a newer ordinary run in any unfinished state", () =>
    Effect.gen(function* () {
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      for (const status of ["starting", "queued", "running"] as const) {
        const lead = yield* createThread(`ordinary-lead-${status}`);
        const worker = yield* createThread(`ordinary-worker-${status}`);
        yield* seedRun(worker, { status: "completed", text: "The old result." });
        yield* seedRun(worker, { ordinal: 2, status });
        yield* watch(lead, worker);
        yield* reactor.sweep;
        assert.lengthOf(yield* wakes(lead), 0, status);

        yield* observe(
          yield* seedRun(worker, { ordinal: 2, status: "completed", text: "The new result." }),
        );
        const messages = yield* wakes(lead);
        assert.lengthOf(messages, 1, status);
        assert.include(messages[0]?.text, "> The new result.", status);
      }
    }),
  );

  it.effect("waits for a watched thread's pull request watch, not its thread watches", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("kinds-lead");
      const babysitter = yield* createThread("kinds-babysitter");
      const waiter = yield* createThread("kinds-waiter");
      yield* watch(lead, babysitter);
      yield* watch(lead, waiter);
      const pullRequest = { host: "github.com", repository: "pingdotgg/t3code", number: 9 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("command:kinds-pr-watch"),
        threadId: babysitter,
        ...pullRequest,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/9", source: "agent" },
      });
      // The waiter watches a thread that never runs, and has still finished its own work.
      yield* watch(waiter, lead);
      yield* observe(yield* seedRun(babysitter, { status: "completed", text: "Watching CI." }));
      yield* observe(yield* seedRun(waiter, { status: "completed", text: "Waiting on lead." }));
      assert.deepEqual(
        (yield* wakes(lead)).map((wake) => wake.notification?.source),
        [{ kind: "thread", threadId: waiter }],
      );
      // A watch on a thread that has never run waits for it.
      assert.lengthOf(yield* wakes(waiter), 0);

      const unwatched = yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("command:kinds-pr-unwatch"),
        threadId: babysitter,
        ...pullRequest,
        watching: false,
      });
      yield* observe(unwatched.storedEvents);
      assert.sameDeepMembers(
        (yield* wakes(lead)).map((wake) => wake.notification?.source),
        [
          { kind: "thread", threadId: waiter },
          { kind: "thread", threadId: babysitter },
        ],
      );
    }),
  );

  it.effect("reports failure, stopping, archiving and deleting with their outcomes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("outcome-lead");
      const failed = yield* createThread("outcome-failed", "Failing");
      const stopped = yield* createThread("outcome-stopped", "Stopping");
      const archived = yield* createThread("outcome-archived", "Archiving");
      const deleted = yield* createThread("outcome-deleted", "Deleting");
      for (const thread of [failed, stopped, archived, deleted]) yield* watch(lead, thread);
      yield* observe(yield* seedRun(failed, { status: "failed" }));
      yield* observe(yield* seedRun(stopped, { status: "interrupted", text: "Halfway." }));
      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:outcome-archive"),
        threadId: archived,
      });
      yield* observe(archive.storedEvents);
      const deletion = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:outcome-delete"),
        threadId: deleted,
      });
      yield* observe(deletion.storedEvents);
      assert.sameDeepMembers(
        (yield* wakes(lead)).map((wake) => [
          wake.notification?.outcome,
          wake.notification?.summary,
        ]),
        [
          ["failed", "Failed: Failing"],
          ["cancelled", "Stopped: Stopping"],
          ["cancelled", "Archived or deleted: Archiving"],
          ["cancelled", "Archived or deleted: Deleting"],
        ],
      );
    }),
  );

  it.effect("wakes for a question with the oldest request and the count", () =>
    Effect.gen(function* () {
      const lead = yield* createThread("input-lead");
      const worker = yield* createThread("input-worker", "Asking");
      yield* watch(lead, worker);
      const request = (id: string, at: string, question: string) => {
        const createdAt = DateTime.makeUnsafe(at);
        const scope = {
          threadId: worker,
          runId: run(worker, 1, "running").id,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: createdAt,
        };
        return [
          {
            ...scope,
            id: EventId.make(`event:request:${id}`),
            type: "runtime-request.updated" as const,
            payload: {
              id: RuntimeRequestId.make(id),
              nodeId: rootNodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input" as const,
              status: "pending" as const,
              responseCapability: { type: "message" as const },
              createdAt,
              resolvedAt: null,
            },
          },
          {
            ...scope,
            id: EventId.make(`event:request-item:${id}`),
            type: "turn-item.updated" as const,
            payload: {
              id: TurnItemId.make(`turn-item:${id}`),
              threadId: worker,
              runId: scope.runId,
              nodeId: rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 3,
              status: "waiting" as const,
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "user_input_request" as const,
              requestId: RuntimeRequestId.make(id),
              questions: [{ id: "q", header: "Choice", question, options: [] }],
            },
          },
        ];
      };
      yield* observe(
        yield* seedRun(worker, {
          status: "running",
          extra: [
            ...request("request:newer", "2026-10-16T10:05:00.000Z", "Which branch?"),
            ...request("request:older", "2026-10-16T10:01:00.000Z", "Which database?"),
          ],
        }),
      );
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.deepEqual(wake?.notification, {
        source: { kind: "thread", threadId: worker },
        outcome: "updated",
        summary: "Needs input: Asking",
      });
      assert.include(wake?.text, "2 pending requests");
      assert.include(wake?.text, "> Which database?");
    }),
  );

  it.effect("wakes two threads that watch each other as each finishes", () =>
    Effect.gen(function* () {
      const left = yield* createThread("mutual-left");
      const right = yield* createThread("mutual-right");
      yield* watch(left, right);
      yield* watch(right, left);
      yield* observe(yield* seedRun(right, { status: "completed", text: "Right done." }));
      assert.lengthOf(yield* wakes(left), 1);
      assert.lengthOf(yield* wakes(right), 0);
      // The wake starts the left thread's next run, and its finishing wakes the right thread.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { runs } = yield* orchestrator.getThreadRecords(left, ["runs"]);
      const [woken] = runs;
      assert.isDefined(woken);
      if (woken === undefined) return;
      yield* observe(
        yield* eventSink.write({
          commandId: CommandId.make("command:mutual-left-done"),
          events: [
            {
              id: EventId.make("event:mutual-left-done"),
              type: "run.updated",
              threadId: left,
              runId: woken.id,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...woken, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        }),
      );
      assert.lengthOf(yield* wakes(right), 1);
    }),
  );

  it.effect("wakes every watcher, once per watch, snoozed or not", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const first = yield* createThread("many-first");
      const second = yield* createThread("many-second");
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("command:many-snooze"),
        threadId: second,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      });
      const one = yield* createThread("many-one");
      const two = yield* createThread("many-two");
      yield* watch(first, one);
      yield* watch(second, one);
      yield* watch(first, two);
      yield* watch(first, one);
      assert.lengthOf(yield* watchesOf(first), 2);
      yield* observe(yield* seedRun(one, { status: "completed", text: "One." }));
      yield* observe(yield* seedRun(two, { status: "completed", text: "Two." }));
      assert.lengthOf(yield* wakes(first), 2);
      assert.lengthOf(yield* wakes(second), 1);
    }),
  );

  it.effect("fires after a restart for a thread that finished while the server was down", () =>
    Effect.gen(function* () {
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const lead = yield* createThread("restart-lead");
      const worker = yield* createThread("restart-worker");
      yield* watch(lead, worker);
      // Not observed: the reactor learns of it only from stored state.
      yield* seedRun(worker, { status: "completed", text: "Done offline." });
      assert.lengthOf(yield* wakes(lead), 0);
      yield* reactor.sweep;
      yield* reactor.sweep;
      assert.lengthOf(yield* wakes(lead), 1);
    }),
  );

  it.effect("ends without a wake when unwatched, stopped, archived or settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* createThread("end-worker");
      for (const ending of ["unwatch", "stop", "archive", "settle"] as const) {
        const lead = yield* createThread(`end-lead-${ending}`);
        yield* watch(lead, worker);
        assert.lengthOf(yield* watchesOf(lead), 1);
        const commandId = CommandId.make(`command:end-${ending}`);
        if (ending === "unwatch") yield* watch(lead, worker, false);
        else
          yield* orchestrator.dispatch({
            type:
              ending === "stop"
                ? "thread.stop"
                : ending === "archive"
                  ? "thread.archive"
                  : "thread.settle",
            commandId,
            threadId: lead,
          });
        assert.lengthOf(yield* watchesOf(lead), 0, ending);
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(lead))?.endedThreadWatches?.map(
            (ended) => ended.threadId,
          ),
          [worker],
          ending,
        );
      }
      yield* observe(yield* seedRun(worker, { status: "completed", text: "Done." }));
      for (const ending of ["unwatch", "stop", "archive", "settle"]) {
        assert.lengthOf(yield* wakes(ThreadId.make(`thread:end-lead-${ending}`)), 0);
      }
    }),
  );

  it.effect("drops a wake still queued behind its watcher's run when unwatched", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("queued-lead");
      const worker = yield* createThread("queued-worker");
      yield* seedBusyThread(lead);
      yield* watch(lead, worker);
      yield* observe(yield* seedRun(worker, { status: "completed", text: "Done." }));
      const [wake] = yield* wakes(lead);
      const wakeRun = () =>
        orchestrator
          .getThreadRecords(lead, ["runs"])
          .pipe(Effect.map(({ runs }) => runs.find((run) => run.userMessageId === wake?.id)));
      assert.equal((yield* wakeRun())?.status, "queued");

      yield* watch(lead, worker, false);
      assert.equal((yield* wakeRun())?.status, "cancelled");
    }),
  );

  it.effect("settles over background work only for a person, and tells watchers it stopped", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("settle-stops-lead");
      const worker = yield* createThread("settle-stops-worker", "Sleeper");
      yield* watch(lead, worker);
      yield* observe(yield* seedBackgroundCommand(worker));
      assert.lengthOf(yield* wakes(lead), 0);

      // An agent, or automatic settlement, is refused and told which work would stop.
      const refused = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("command:settle-stops-refused"),
          threadId: worker,
        })
        .pipe(Effect.flip);
      assert.include(String(refused.cause), "Wait 240 seconds in background");
      assert.isNull((yield* orchestrator.getThreadShell(worker))?.settledAt ?? null);

      // A person who confirmed it stops the work, and the stop is what the watcher hears.
      const settled = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:settle-stops-confirmed"),
        threadId: worker,
        stopBackgroundWork: true,
      });
      yield* observe(settled.storedEvents);
      const { runs } = yield* orchestrator.getThreadRecords(worker, ["runs"]);
      assert.deepEqual(runs[0]?.stoppedBackgroundWork, ["Wait 240 seconds in background"]);
      assert.isNotNull((yield* orchestrator.getThreadShell(worker))?.settledAt ?? null);
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.outcome, "cancelled");
      assert.equal(wake?.notification?.summary, "Stopped: Sleeper");
      assert.include(
        wake?.text ?? "",
        "Its background work was stopped with it: `Wait 240 seconds in background`.",
      );
    }),
  );

  it.effect("records the stop when archiving cuts a thread's background work short", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* createThread("archive-stops-worker");
      yield* seedBackgroundCommand(worker);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive-stops"),
        threadId: worker,
      });
      const { runs } = yield* orchestrator.getThreadRecords(worker, ["runs"]);
      assert.deepEqual(runs[0]?.stoppedBackgroundWork, ["Wait 240 seconds in background"]);
    }),
  );

  it.effect("refuses a watch on itself, from a settled thread, or of a deleted thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("refuse-lead");
      const other = yield* createThread("refuse-other");
      const refused = (watcherId: ThreadId, watchedThreadId: ThreadId) =>
        watch(watcherId, watchedThreadId).pipe(
          Effect.exit,
          Effect.map((exit) => exit._tag === "Failure"),
        );
      assert.isTrue(yield* refused(lead, lead));
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:refuse-delete"),
        threadId: other,
      });
      assert.isTrue(yield* refused(lead, other));
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:refuse-settle"),
        threadId: lead,
      });
      assert.isTrue(yield* refused(lead, yield* createThread("refuse-third")));
    }),
  );
  it.effect(
    "wakes Build unblocked watchers only after waits and holds clear, once, sharing HQ reads",
    () =>
      Effect.gen(function* () {
        const h = yield* makeForgeHarness;
        const first = yield* createThread("build-first");
        const second = yield* createThread("build-second");
        yield* h.start(first, "unblocked");
        yield* h.start(second, "unblocked");
        yield* h.start(first, "unblocked");
        assert.lengthOf(yield* watchesOf(first), 1);
        assert.include(
          (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(first))
            ?.pendingBackgroundTasks?.[0]?.description,
          "Build #1000001",
        );
        yield* h.reactor.sweep;
        yield* h.reactor.sweep;
        assert.equal(h.state.reads, 1);
        assert.equal(h.state.waits, 1);
        assert.equal(h.state.resolutions, 1);
        assert.lengthOf(yield* h.messages(first), 0);
        h.state.item = {
          ...h.state.item,
          waits: [],
          holds: [{ kind: "owner", note: "Wait for approval" }],
        };
        yield* TestClock.adjust("1 minute");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(first), 0);
        h.state.item = { ...h.state.item, holds: [] };
        // The cached blocked result still applies within its reread interval.
        yield* h.reactor.sweep;
        assert.equal(h.state.reads, 2);
        yield* TestClock.adjust("1 minute");
        yield* h.reactor.sweep;
        for (const threadId of [first, second]) {
          const [message, ...rest] = yield* h.messages(threadId);
          assert.lengthOf(rest, 0);
          assert.include(message?.text, "Build #1000001");
          assert.include(message?.text, "Publish the candidate");
          assert.include(message?.text, "all waits and holds are clear");
          assert.lengthOf(yield* watchesOf(threadId), 0);
        }
        yield* TestClock.adjust("2 minutes");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(first), 1);
        assert.equal(h.state.reads, 3);
      }),
  );

  it.effect(
    "Build closed watches wake once on Landed, Accepted or Dropped, including after restart",
    () =>
      Effect.gen(function* () {
        for (const status of ["landed", "accepted", "dropped"] as const) {
          const h = yield* makeForgeHarness;
          const watcher = yield* createThread(`build-closed-${status}`);
          yield* h.start(watcher, "closed");
          // A ready item with no blockers is still open.
          h.state.item = { ...h.state.item, status: "ready", waits: [], holds: [] };
          yield* h.reactor.sweep;
          assert.lengthOf(yield* h.messages(watcher), 0);
          h.state.item = { ...h.state.item, status };
          yield* TestClock.adjust("1 minute");
          const restarted = yield* h.restart();
          yield* restarted.sweep;
          yield* restarted.sweep;
          assert.lengthOf(yield* h.messages(watcher), 1);
          assert.lengthOf(yield* watchesOf(watcher), 0);
          assert.include(
            (yield* h.messages(watcher))[0]?.text,
            status === "dropped" ? "Dropped" : "closed",
          );
        }
      }),
  );

  it.effect("a restarted unblocked watch wakes on Dropped even with waits and holds", () =>
    Effect.gen(function* () {
      const h = yield* makeForgeHarness;
      const watcher = yield* createThread("build-dropped");
      yield* h.start(watcher, "unblocked");
      yield* h.reactor.sweep;
      h.state.item = {
        ...h.state.item,
        status: "dropped",
        holds: [{ kind: "owner", note: "Still held" }],
      };
      yield* TestClock.adjust("1 minute");
      const restarted = yield* h.restart();
      yield* restarted.sweep;
      yield* restarted.sweep;
      assert.lengthOf(yield* h.messages(watcher), 1);
      assert.include((yield* h.messages(watcher))[0]?.text, "Dropped");
    }),
  );

  it.effect("settling or unwatching a Build watcher prevents a wake", () =>
    Effect.gen(function* () {
      const h = yield* makeForgeHarness;
      const engine = yield* Orchestrator.OrchestratorV2;
      for (const action of ["settle", "unwatch"] as const) {
        const watcher = yield* createThread(`build-ended-${action}`);
        yield* h.start(watcher, "closed");
        if (action === "settle")
          yield* engine.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:build-settle"),
            threadId: watcher,
          });
        else
          yield* engine.dispatch({
            type: "thread.thread-watch",
            commandId: CommandId.make("command:build-unwatch"),
            threadId: watcher,
            target: { kind: "build_item", number: 1000001, until: "closed" },
            watching: false,
          });
        h.state.item = { ...h.state.item, status: "landed" };
        yield* TestClock.adjust("1 minute");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(watcher), 0);
      }
    }),
  );

  it.effect("unwatch cancels a Build wake queued behind the watcher's active run", () =>
    Effect.gen(function* () {
      const h = yield* makeForgeHarness;
      const watcher = yield* createThread("build-queued");
      const engine = yield* Orchestrator.OrchestratorV2;
      yield* seedBusyThread(watcher);
      yield* h.start(watcher, "closed");
      h.state.item = { ...h.state.item, status: "landed" };
      yield* h.reactor.sweep;
      const [message] = yield* h.messages(watcher);
      const wakeRun = () =>
        engine
          .getThreadRecords(watcher, ["runs"])
          .pipe(Effect.map(({ runs }) => runs.find((run) => run.userMessageId === message?.id)));
      assert.equal((yield* wakeRun())?.status, "queued");
      yield* engine.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:build-unwatch-queued"),
        threadId: watcher,
        target: { kind: "build_item", number: 1000001, until: "closed" },
        watching: false,
      });
      assert.equal((yield* wakeRun())?.status, "cancelled");
    }),
  );
  it.effect("one unreachable Build item does not hold back another watch on the same thread", () =>
    Effect.gen(function* () {
      const h = yield* makeForgeHarness;
      const watcher = yield* createThread("build-partial");
      yield* h.start(watcher, "unblocked");
      yield* h.start(watcher, "unblocked", UNREACHABLE_BUILD_NUMBER);
      h.state.item = { ...h.state.item, waits: [] };
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(watcher), 1);
    }),
  );

  it.effect(
    "the Build reactor's own polling wakes on the backed-off cadence without thread events",
    () =>
      Effect.gen(function* () {
        const h = yield* makeForgeHarness;
        const watcher = yield* createThread("build-periodic");
        const engine = yield* Orchestrator.OrchestratorV2;
        yield* h.start(watcher, "unblocked");
        const fired = yield* engine.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === watcher &&
              event.type === "message.updated" &&
              event.payload.notification?.source.kind === "build_item",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* h.reactor.start();
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(yield* h.messages(watcher), 0);
        h.state.item = { ...h.state.item, waits: [] };
        // The unchanged read at one minute backed the item off to two minutes.
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(yield* h.messages(watcher), 0);
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(yield* Fiber.join(fired), 1);
        assert.lengthOf(yield* h.messages(watcher), 1);
      }),
  );
});

const createWorkspaceThread = (name: string, worktreePath: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectId = ProjectId.make(`project:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`command:project:${name}`),
      projectId,
      title: name,
      workspaceRoot: `/workspace/${name}`,
    });
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
    });
    return threadId;
  });

const makeLandingHarness = Effect.gen(function* () {
  const landings: Array<TrackedLanding> = [];
  const roots = new Map<string, string>();
  const slipJay = Layer.mock(SlipJayLandings.SlipJayLandings)({
    landings: Effect.sync(() => [...landings]),
    follow: Effect.void,
    changes: Stream.empty,
    repositoryOf: () => Effect.succeed("pechhe/t3code"),
    workspaceRoot: ({ name }) => Effect.succeed(roots.get(name)),
  });
  const reactor = yield* Effect.service(LandingWatchReactor.LandingWatchReactor).pipe(
    Effect.provide(
      LandingWatchReactor.layer.pipe(Layer.provide(ProjectionStore.layer), Layer.provide(slipJay)),
    ),
  );
  const submit = (workspace: string, operationId = "op_1"): TrackedLanding => {
    const landing: TrackedLanding = {
      operationId,
      repo: "pechhe/t3code",
      changeId: `change-${operationId}`,
      status: "active",
      stage: "verifying",
      submittedBy: `${NodeOS.hostname()}:${workspace}`,
      spec: 5255,
    };
    landings.push(landing);
    return landing;
  };
  const finish = (operationId: string, patch: Partial<TrackedLanding>) => {
    const index = landings.findIndex((landing) => landing.operationId === operationId);
    landings[index] = { ...landings[index]!, ...patch };
  };
  const messages = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const { messages } = yield* engine.getThreadRecords(threadId, ["messages"]);
      return messages.filter((message) => message.notification?.source.kind === "landing");
    });
  return { landings, roots, reactor, submit, finish, messages };
});

it.layer(layerTest)("landing watches", (it) => {
  it.effect("wakes the thread that submitted a failed landing once, naming the failure", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const engine = yield* Orchestrator.OrchestratorV2;
      const thread = yield* createWorkspaceThread("landing-failed", "/workspaces/landing-failed");
      h.roots.set("ws-failed", "/workspaces/landing-failed");
      h.submit("ws-failed");
      yield* h.reactor.sweep;
      const [armed, ...others] = yield* watchesOf(thread);
      assert.deepEqual(armed?.target, { kind: "landing", operationId: "op_1" });
      assert.lengthOf(others, 0);
      assert.deepEqual(
        (yield* engine.getThreadShell(thread))?.pendingBackgroundTasks?.map(
          (task) => task.description,
        ),
        ["Watching landing Build #5255"],
      );
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
      assert.lengthOf(yield* h.messages(thread), 0);

      h.finish("op_1", { status: "failed", stage: "verifying", reason: "tests failed" });
      yield* h.reactor.sweep;
      const [wake, ...rest] = yield* h.messages(thread);
      assert.lengthOf(rest, 0);
      assert.deepEqual(wake?.notification, {
        source: { kind: "landing", operationId: "op_1" },
        outcome: "failed",
        summary: "Landing of Build #5255: failed",
      });
      assert.include(wake?.text, "operation op_1");
      assert.include(wake?.text, "failed at verifying");
      assert.include(wake?.text, "> tests failed");
      assert.include(wake?.text, "slipjay repair op_1");
      assert.equal(wake?.id, MessageId.make(`message:${armed?.id}`));
      assert.lengthOf(yield* watchesOf(thread), 0);

      // Another look, a restart's replay or a repeated fire never wakes it twice.
      yield* h.reactor.sweep;
      const replay = yield* engine
        .dispatch({
          type: "thread.thread-watch.fire",
          commandId: CommandId.make("command:landing-replayed-fire"),
          threadId: thread,
          watchId: armed?.id ?? "",
          landing: {
            operationId: "op_1",
            outcome: "failed",
            repository: "pechhe/t3code",
            stage: "verifying",
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(replay._tag === "Failure");
      assert.lengthOf(yield* h.messages(thread), 1);
    }),
  );

  it.effect("wakes on a landed, cancelled or declined landing with that outcome", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      for (const status of ["landed", "cancelled", "declined"] as const) {
        const thread = yield* createWorkspaceThread(`landing-${status}`, `/workspaces/${status}`);
        h.roots.set(`ws-${status}`, `/workspaces/${status}`);
        h.submit(`ws-${status}`, `op_${status}`);
        yield* h.reactor.sweep;
        h.finish(`op_${status}`, {
          status,
          ...(status === "landed" ? { commitId: "abc1234" } : {}),
        });
        yield* h.reactor.sweep;
        const [wake, ...rest] = yield* h.messages(thread);
        assert.lengthOf(rest, 0);
        assert.equal(wake?.notification?.outcome, status === "landed" ? "completed" : "cancelled");
        if (status === "landed") assert.include(wake?.text, "abc1234");
      }
    }),
  );

  it.effect("arms nothing when two threads hold the submitting checkout or none does", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const first = yield* createWorkspaceThread("landing-shared-a", "/workspaces/shared");
      const second = yield* createWorkspaceThread("landing-shared-b", "/workspaces/shared");
      h.roots.set("ws-shared", "/workspaces/shared");
      h.submit("ws-shared", "op_shared");
      h.submit("ws-unknown", "op_unknown");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(first), 0);
      assert.lengthOf(yield* watchesOf(second), 0);
    }),
  );

  it.effect("keeps looking for the submitting checkout until SlipJay can name it", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-retry", "/workspaces/retry");
      h.submit("ws-retry", "op_retry");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 0);
      h.roots.set("ws-retry", "/workspaces/retry");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
    }),
  );

  it.effect("a landing already finished when first seen wakes nobody", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-old", "/workspaces/old");
      h.roots.set("ws-old", "/workspaces/old");
      h.submit("ws-old", "op_old");
      h.finish("op_old", { status: "failed", reason: "old failure" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 0);
      assert.lengthOf(yield* h.messages(thread), 0);
    }),
  );

  it.effect("the thread's own running `slipjay land` gets the verdict without a second wake", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-own", "/workspaces/own");
      h.roots.set("ws-own", "/workspaces/own");
      h.submit("ws-own", "op_own");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
      const command = {
        id: TurnItemId.make("turn-item:own-land"),
        threadId: thread,
        runId: run(thread, 1, "running").id,
        nodeId: rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: "slipjay land",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution" as const,
        input: "slipjay land",
      };
      yield* seedRun(thread, {
        status: "running",
        extra: [
          {
            id: EventId.make("event:own-land:running"),
            type: "turn-item.updated",
            threadId: thread,
            runId: command.runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: command,
          },
        ],
      });
      h.finish("op_own", { status: "failed", reason: "tests failed" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(thread), 0);
      assert.lengthOf(yield* watchesOf(thread), 0);
    }),
  );

  it.effect("a watch whose landing the runner stopped tracking ends silently after hours", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-stale", "/workspaces/stale");
      h.roots.set("ws-stale", "/workspaces/stale");
      h.submit("ws-stale", "op_stale");
      yield* h.reactor.sweep;
      h.landings.length = 0;
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
      yield* TestClock.adjust("7 hours");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 0);
      assert.lengthOf(yield* h.messages(thread), 0);
    }),
  );
});
