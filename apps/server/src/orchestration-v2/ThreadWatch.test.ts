import { layerNonSlipJay, layerSyntheticWorkspaces } from "./testkit/runWorkspaceCustody.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ParkedWaitTarget,
  type OrchestrationV2RemoteThreadWatchOutcome,
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
import {
  type AgentRole,
  type AgentTaskBinding,
  OrchestrationV2ThreadWatch,
  type ForgeWorkItemSummary,
  type SlipJayRunnerOverview,
} from "@t3tools/contracts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as WeaveAgentConnections from "../weave/WeaveAgentConnections.ts";
import * as ForgeWatchReactor from "./ForgeWatchReactor.ts";
import * as LandingWatchReactor from "./LandingWatchReactor.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import type { TrackedLanding } from "../project/slipJayLandingState.ts";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

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
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadWatchReactor from "./ThreadWatchReactor.ts";
import { threadWatchRefusal, watchTargetsEqual } from "./threadWatch.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSyntheticWorkspaces),
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

const layerRuntime = Layer.mergeAll(
  RuntimeLayer.layerWithCustody(layerNonSlipJay),
  RuntimeLayer.layerEventSink,
).pipe(
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
      refreshRepositoryIdentity: () => Effect.succeed(null),
      readRepositoryIdentity: () => Effect.succeed(null),
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

it("lets any live thread watch, a subagent or a Spec lead alike", () => {
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
  assert.isUndefined(threadWatchRefusal(thread, "thread:other"));
  assert.isUndefined(
    threadWatchRefusal(
      { ...thread, lineage: { ...thread.lineage, relationshipToParent: "fork" } },
      "thread:other",
    ),
  );
  const task = (role: AgentRole) => ({ role }) as AgentTaskBinding;
  assert.isUndefined(threadWatchRefusal({ ...thread, agentTask: task("scout") }, "thread:other"));
  assert.isUndefined(threadWatchRefusal({ ...thread, agentTask: task("lead") }, "thread:other"));
});

const UNREACHABLE_BUILD_NUMBER = 1000099;

const makeForgeHarness = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const state: {
    item: ForgeWorkItemSummary;
    reads: number;
    waits: number;
    resolutions: number;
    unreachable: boolean;
  } = {
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
    unreachable: false,
  };
  const connection = { origin: "https://weave.example", connection: "test-connection" };
  const weave = Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
    read: Effect.succeed(connection),
    buildWriteVersion: Effect.succeed(0),
    observe: (tool, args) =>
      Effect.sync(() => {
        if (tool === "weave_forge_waits") {
          state.waits++;
          return {
            ...connection,
            value: state.item.waits.map((wait) => ({
              required: wait.required,
              blocker: { number: wait.number, title: wait.title, status: wait.status },
            })),
          };
        }
        // An answer T3 cannot decode reads as Weave being unreachable for that number.
        if (args.number === UNREACHABLE_BUILD_NUMBER) return { ...connection, value: {} };
        if (args.number !== undefined) state.resolutions++;
        else state.reads++;
        if (state.unreachable && args.number === undefined) return { ...connection, value: {} };
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
    Effect.provide(ForgeWorkItems.layer.pipe(Layer.provide(weave))),
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
  return { state, build, reactor, restart, start, messages };
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
      assert.equal(wake?.id, MessageId.make(`message:${lead}:${started?.id}`));
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

  it.effect("a watch on a thread in another environment fires only with how it ended there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const lead = yield* createThread("remote-lead");
      const environmentId = EnvironmentId.make("environment-other");
      const remoteThread = ThreadId.make("thread:remote-worker");
      const start = yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:remote-watch"),
        threadId: lead,
        target: { kind: "thread", threadId: remoteThread, environmentId },
        title: "Fix the login there",
        watching: true,
      });
      yield* observe(start.storedEvents);
      const [started] = yield* watchesOf(lead);
      assert.deepEqual(started?.target, { kind: "thread", threadId: remoteThread, environmentId });
      // This environment has no such thread, and a sweep never reads it as gone.
      yield* reactor.sweep;
      assert.lengthOf(yield* wakes(lead), 0);
      assert.lengthOf(yield* watchesOf(lead), 1);
      // The same id here is another thread: it does not count as watching this one.
      assert.isFalse(
        watchTargetsEqual(started!.target, { kind: "thread", threadId: remoteThread }),
      );
      // Nothing fires without the other environment's word.
      yield* orchestrator.dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make("command:remote-fire-empty"),
        threadId: lead,
        watchId: started?.id ?? "",
      });
      assert.lengthOf(yield* wakes(lead), 0);

      yield* orchestrator.dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make("command:remote-fire"),
        threadId: lead,
        watchId: started?.id ?? "",
        remote: { kind: "finished", title: "Fix the login there", detail: "Landed abc123 there." },
      });
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.deepEqual(wake?.notification, {
        source: { kind: "thread", threadId: remoteThread, environmentId },
        outcome: "completed",
        summary: "Finished: Fix the login there",
      });
      assert.include(
        wake?.text,
        `[Fix the login there](t3-thread://v2/${environmentId}/${remoteThread})`,
      );
      assert.include(wake?.text, "> Landed abc123 there.");
      assert.lengthOf(yield* watchesOf(lead), 0);
      // A replayed answer wakes nobody twice.
      const replay = yield* orchestrator
        .dispatch({
          type: "thread.thread-watch.fire",
          commandId: CommandId.make("command:remote-fire-replay"),
          threadId: lead,
          watchId: started?.id ?? "",
          remote: { kind: "finished", title: "Fix the login there" },
        })
        .pipe(Effect.exit);
      assert.isTrue(replay._tag === "Failure");
      assert.lengthOf(yield* wakes(lead), 1);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(lead))?.endedThreadWatches?.map(
          (ended) => ended.environmentId,
        ),
        [environmentId],
      );
    }),
  );

  it.effect("unwatch ends a watch on a thread in another environment, never one here", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("unwatch-remote-lead");
      const environmentId = EnvironmentId.make("environment-other");
      const sameId = ThreadId.make("thread:same-id");
      const dispatchWatch = (
        watching: boolean,
        id: string,
        target: OrchestrationV2ParkedWaitTarget,
      ) =>
        orchestrator.dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make(`command:${id}`),
          threadId: lead,
          target,
          title: "Remote worker",
          watching,
        });
      yield* dispatchWatch(true, "remote-watch-1", {
        kind: "thread",
        threadId: sameId,
        environmentId,
      });
      // Unwatching the same id here is no stop for the thread there.
      yield* dispatchWatch(false, "unwatch-here", { kind: "thread", threadId: sameId });
      assert.lengthOf(yield* watchesOf(lead), 1);
      yield* dispatchWatch(false, "unwatch-there", {
        kind: "thread",
        threadId: sameId,
        environmentId,
      });
      assert.lengthOf(yield* watchesOf(lead), 0);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(lead))?.endedThreadWatches?.map(
          (ended) => ended.threadId,
        ),
        [sameId],
      );
    }),
  );

  it.effect(
    "a link or thread that is gone wakes once with why, and a question with its count",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const environmentId = EnvironmentId.make("environment-other");
        const watchRemote = (lead: ThreadId, thread: string, parked = false) =>
          orchestrator.dispatch({
            type: "thread.thread-watch",
            commandId: CommandId.make(`command:remote-watch:${lead}`),
            threadId: lead,
            target: { kind: "thread", threadId: ThreadId.make(thread), environmentId },
            title: "Remote worker",
            watching: true,
            ...(parked ? { park: { expectedMs: 600_000, note: "check back" } } : {}),
          });
        const fire = (
          lead: ThreadId,
          watchId: string,
          remote: OrchestrationV2RemoteThreadWatchOutcome,
        ) =>
          orchestrator.dispatch({
            type: "thread.thread-watch.fire",
            commandId: CommandId.make(`command:remote-fire:${lead}`),
            threadId: lead,
            watchId,
            remote,
          });

        const unreachable = yield* createThread("remote-unreachable");
        yield* watchRemote(unreachable, "thread:u");
        const [held] = yield* watchesOf(unreachable);
        yield* fire(unreachable, held?.id ?? "", {
          kind: "unreachable",
          reason: "The link to Box was revoked.",
        });
        const [gone] = yield* wakes(unreachable);
        assert.include(gone?.text, "can no longer be watched: The link to Box was revoked.");
        assert.equal(gone?.notification?.outcome, "unknown");

        const asking = yield* createThread("remote-asking");
        yield* watchRemote(asking, "thread:q", true);
        const [wait] = (yield* orchestrator.getThreadShell(asking))?.parkedWaits ?? [];
        assert.deepEqual(wait?.target, {
          kind: "thread",
          threadId: ThreadId.make("thread:q"),
          environmentId,
        });
        yield* fire(asking, wait?.id ?? "", {
          kind: "needs-input",
          title: "Remote worker",
          requestCount: 2,
          detail: "Which branch?",
        });
        const [question] = yield* wakes(asking);
        assert.include(question?.text, "it has 2 pending requests");
        assert.include(question?.text, `threadId thread:q and environmentId ${environmentId}`);
        assert.include(question?.text, "> Which branch?");
        assert.lengthOf((yield* orchestrator.getThreadShell(asking))?.parkedWaits ?? [], 0);
      }),
  );

  it.effect(
    "a thread that is moving takes no wake, and takes it once a failed move releases it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
        const lead = yield* createThread("moving-lead");
        const worker = yield* createThread("moving-worker", "Finish me");
        yield* watch(lead, worker);
        const handoff = {
          handoffId: "handoff-moving",
          environmentId: EnvironmentId.make("environment-box"),
          label: "Box",
        };
        const update = (
          expected: null | "departing",
          next:
            | { readonly state: "departing" }
            | { readonly state: "failed"; readonly lastError: string },
          id: string,
        ) =>
          orchestrator
            .dispatch({
              type: "thread.handoff.update",
              commandId: CommandId.make(`command:${id}`),
              threadId: lead,
              expected,
              handoff: { ...handoff, ...next },
            })
            .pipe(Effect.flatMap(({ storedEvents }) => observe(storedEvents)));
        yield* update(null, { state: "departing" }, "moving-departing");

        // The watched thread finishes mid-move: the departing copy neither wakes nor loses its watch.
        yield* observe(yield* seedRun(worker, { status: "completed", text: "Done mid-move." }));
        yield* reactor.sweep;
        assert.lengthOf(yield* wakes(lead), 0);
        assert.lengthOf(yield* watchesOf(lead), 1);

        // A move that fails releases the thread, and the watch wakes it, once.
        yield* update("departing", { state: "failed", lastError: "refused" }, "moving-failed");
        yield* reactor.sweep;
        assert.lengthOf(yield* wakes(lead), 1);
        assert.lengthOf(yield* watchesOf(lead), 0);
      }),
  );

  it.effect(
    "a watch follows the thread it watches to where it moved, and ends if that is itself",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
        const lead = yield* createThread("move-lead");
        const worker = yield* createThread("move-worker", "Move me");
        yield* watch(lead, worker);
        const environmentId = EnvironmentId.make("environment-box");
        const moved = ThreadId.make("thread:moved-worker");
        const handoff = {
          handoffId: "handoff-1",
          environmentId,
          label: "Box",
        };
        const update = (
          expected: "departing" | null,
          next:
            | { readonly state: "departing" }
            | { readonly state: "departed"; readonly threadId: ThreadId },
          id: string,
        ) =>
          orchestrator
            .dispatch({
              type: "thread.handoff.update",
              commandId: CommandId.make(`command:${id}`),
              threadId: worker,
              expected,
              handoff: { ...handoff, ...next },
            })
            .pipe(Effect.flatMap(({ storedEvents }) => observe(storedEvents)));
        // While it moves it still counts as working: nothing wakes the watcher.
        yield* update(null, { state: "departing" }, "move-departing");
        yield* reactor.sweep;
        assert.lengthOf(yield* wakes(lead), 0);
        assert.deepEqual((yield* watchesOf(lead))[0]?.target, { kind: "thread", threadId: worker });

        yield* update("departing", { state: "departed", threadId: moved }, "move-departed");
        assert.lengthOf(yield* wakes(lead), 0);
        const [followed] = yield* watchesOf(lead);
        assert.deepEqual(followed?.target, { kind: "thread", threadId: moved, environmentId });
        assert.deepEqual(yield* orchestrator.watchedThreadStanding(worker), {
          state: "moved",
          environmentId,
          threadId: moved,
        });

        // A remote answer that the thread came back to this environment makes the watch local again.
        yield* orchestrator.dispatch({
          type: "thread.thread-watch.fire",
          commandId: CommandId.make("command:remote-moved-home"),
          threadId: lead,
          watchId: followed?.id ?? "",
          remote: { kind: "moved", movedTo: { threadId: worker } },
        });
        assert.deepEqual((yield* watchesOf(lead))[0]?.target, { kind: "thread", threadId: worker });
        // ...and one that it moved to the watcher itself ends the watch without a wake.
        yield* orchestrator
          .dispatch({
            type: "thread.thread-watch.fire",
            commandId: CommandId.make("command:remote-moved-here"),
            threadId: lead,
            watchId: followed?.id ?? "",
            remote: { kind: "moved", movedTo: { threadId: lead } },
          })
          .pipe(Effect.exit);
        assert.lengthOf(yield* wakes(lead), 0);
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

  it.effect("wakes a watcher whose target thread can no longer be read", () =>
    Effect.gen(function* () {
      const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
      const sql = yield* SqlClient.SqlClient;
      const lead = yield* createThread("gone-lead");
      const worker = yield* createThread("gone-worker", "Vanishing");
      yield* watch(lead, worker);
      yield* reactor.sweep;
      assert.lengthOf(yield* wakes(lead), 0);
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${worker}`;
      yield* reactor.sweep;
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.include(wake?.text, "can no longer be read");
      assert.lengthOf(yield* watchesOf(lead), 0);
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
    "wakes Build watchers when dependencies clear, ignoring legacy holds and sharing Weave reads",
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
        for (const threadId of [first, second]) {
          const [message, ...rest] = yield* h.messages(threadId);
          assert.lengthOf(rest, 0);
          assert.include(message?.text, "Build #1000001");
          assert.include(message?.text, "Publish the candidate");
          assert.include(message?.text, "all dependency waits are clear");
          assert.lengthOf(yield* watchesOf(threadId), 0);
        }
        yield* TestClock.adjust("2 minutes");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(first), 1);
        assert.equal(h.state.reads, 2);
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

  it.effect(
    "an unblocked watch confirms a cached clear answer before waking, so a new dependency keeps it",
    () =>
      Effect.gen(function* () {
        const h = yield* makeForgeHarness;
        const watcher = yield* createThread("build-external-hold");
        // A card read caches the item clear; a dependency is then added through another Weave connection,
        // which T3's cache does not see, and watches straight away.
        h.state.item = { ...h.state.item, waits: [] };
        yield* h.build.mentions({ threadId: watcher, numbers: [1000001] });
        yield* TestClock.adjust("1 second");
        h.state.item = {
          ...h.state.item,
          waits: [{ number: 1000002, title: "Publication", status: "ready", required: "landed" }],
        };
        yield* h.start(watcher, "unblocked");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(watcher), 0);
        assert.lengthOf(yield* watchesOf(watcher), 1);
        // A confirmation Forge cannot answer wakes no one even once the dependency clears.
        h.state.item = { ...h.state.item, waits: [] };
        h.state.unreachable = true;
        yield* TestClock.adjust("1 minute");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(watcher), 0);
        assert.lengthOf(yield* watchesOf(watcher), 1);
        // Once Forge answers clear, the watch wakes once, after a restart too.
        h.state.unreachable = false;
        yield* TestClock.adjust("1 minute");
        const restarted = yield* h.restart();
        yield* restarted.sweep;
        yield* restarted.sweep;
        const [message, ...rest] = yield* h.messages(watcher);
        assert.lengthOf(rest, 0);
        assert.include(message?.text, "all dependency waits are clear");
        assert.lengthOf(yield* watchesOf(watcher), 0);
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

  it.effect("a Forge watch on an unreadable item wakes a thread that is not running an Arc", () =>
    Effect.gen(function* () {
      const h = yield* makeForgeHarness;
      const watcher = yield* createThread("build-unreadable");
      yield* h.start(watcher, "unblocked");
      h.state.unreachable = true;
      yield* h.reactor.sweep;
      yield* TestClock.adjust("61 minutes");
      yield* h.reactor.sweep;
      const [message, ...rest] = yield* h.messages(watcher);
      assert.lengthOf(rest, 0);
      assert.include(message?.text, "could not be read");
      assert.lengthOf(yield* watchesOf(watcher), 0);
    }),
  );

  it.effect(
    "legacy Forge holds do not ask the owner to clear them or keep the thread waiting",
    () =>
      Effect.gen(function* () {
        const h = yield* makeForgeHarness;
        const watcher = yield* createThread("build-retired-hold");
        yield* h.start(watcher, "unblocked");
        h.state.item = {
          ...h.state.item,
          waits: [],
          holds: [{ kind: "decision", note: "Old question" }],
        };
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(watcher), 1);
        assert.lengthOf(yield* watchesOf(watcher), 0);
        const shell = yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(watcher);
        assert.isUndefined(shell?.standing?.waitsOnPerson);
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
  const submit = (
    workspace: string,
    operationId = "op_1",
    overrides: Partial<TrackedLanding> = {},
  ): TrackedLanding => {
    const landing: TrackedLanding = {
      operationId,
      repo: "pechhe/t3code",
      changeId: `change-${operationId}`,
      status: "active",
      stage: "verifying",
      submittedBy: `${NodeOS.hostname()}:${workspace}`,
      spec: 5255,
      ...overrides,
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
        source: { kind: "landing", operationId: "op_1", spec: 5255 },
        outcome: "failed",
        summary: "Landing of Build #5255: failed",
      });
      assert.include(wake?.text, "operation op_1");
      assert.include(wake?.text, "failed at verifying");
      assert.include(wake?.text, "> tests failed");
      assert.include(wake?.text, "repair the change in the workspace that submitted it");
      assert.include(wake?.text, "slipjay repair op_1");
      assert.equal(wake?.id, MessageId.make(`message:${thread}:${armed?.id}`));
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

  it.effect("wakes on a cancelled or declined landing with that outcome", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      for (const status of ["cancelled", "declined"] as const) {
        const thread = yield* createWorkspaceThread(`landing-${status}`, `/workspaces/${status}`);
        h.roots.set(`ws-${status}`, `/workspaces/${status}`);
        h.submit(`ws-${status}`, `op_${status}`);
        yield* h.reactor.sweep;
        h.finish(`op_${status}`, { status });
        yield* h.reactor.sweep;
        const [wake, ...rest] = yield* h.messages(thread);
        assert.lengthOf(rest, 0);
        assert.equal(wake?.notification?.outcome, "cancelled");
        assert.include(wake?.text, status === "declined" ? "was declined" : "was cancelled");
      }
    }),
  );

  it.effect("a published landing wakes the thread with the published commit", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-published", "/workspaces/published");
      h.roots.set("ws-published", "/workspaces/published");
      h.submit("ws-published", "op_published");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
      const engine = yield* Orchestrator.OrchestratorV2;
      for (const watching of [false, true]) {
        yield* engine.dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make(`command:landing-rewatch-${watching}`),
          threadId: thread,
          target: { kind: "landing", operationId: "op_published" },
          watching,
        });
      }
      h.finish("op_published", { status: "landed", commitId: "abc1234" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 0);
      const [wake, ...rest] = yield* h.messages(thread);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.outcome, "completed");
      assert.include(wake?.text, "landed");
      assert.include(wake?.text, "Published commit: abc1234");
      assert.include(wake?.text, "Nothing needs repairing");
      const { turnItems } = yield* engine.getThreadRecords(thread, ["turnItems"], {
        turnItemTypes: ["notification"],
      });
      assert.deepEqual(
        turnItems.map((item) =>
          item.type === "notification"
            ? { runId: item.runId, source: item.source, outcome: item.outcome }
            : null,
        ),
        [
          {
            runId: null,
            source: { kind: "landing", operationId: "op_published" },
            outcome: "updated",
          },
          {
            // The published outcome now starts the wake run that carries it.
            runId: RunId.make("run:thread:thread%3Alanding-published:ordinal:1"),
            source: {
              kind: "landing",
              operationId: "op_published",
              spec: 5255,
              commitId: "abc1234",
            },
            outcome: "completed",
          },
        ],
      );
    }),
  );

  it.effect(
    "a leaf child's inherited copy of the parent's landing watch ends silently while the parent is woken",
    () =>
      Effect.gen(function* () {
        const h = yield* makeLandingHarness;
        const eventSink = yield* EventSink.EventSinkV2;
        const parent = yield* createWorkspaceThread("landing-twin-parent", "/workspaces/twin");
        h.roots.set("ws-twin", "/workspaces/twin");
        h.submit("ws-twin", "op_twin");
        yield* h.reactor.sweep;
        const armed = yield* watchesOf(parent);
        const parentThread = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.flatMap((store) => store.getThread(parent)),
          Effect.provide(ProjectionStore.layer),
        );
        const twin = makeSubagentChildThread({
          parentThread,
          childThreadId: ThreadId.make("thread:landing-twin-copy"),
          parentNodeId: NodeId.make("node:landing-twin"),
          activeProviderThreadId: null,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          title: "landing twin child",
          now,
          createdBy: "agent",
          creationSource: "provider",
        });
        // A child made before watches stopped being copied carries the parent's watch, id included.
        yield* eventSink.write({
          commandId: CommandId.make("command:seed-twin-watch"),
          events: [
            {
              id: EventId.make("event:seed-twin-watch"),
              type: "thread.created",
              threadId: twin.id,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...twin, threadWatches: armed },
            },
          ],
        });
        assert.equal((yield* watchesOf(twin.id))[0]?.id, armed[0]?.id);
        h.finish("op_twin", { status: "failed", reason: "tests failed" });
        yield* h.reactor.sweep;
        assert.lengthOf(yield* watchesOf(parent), 0);
        assert.lengthOf(yield* watchesOf(twin.id), 0);
        assert.lengthOf(yield* h.messages(parent), 1);
        assert.lengthOf(yield* h.messages(twin.id), 0);
      }),
  );

  it.effect(
    "an agent's own watch on a landing it submitted elsewhere wakes it, and survives a restart",
    () =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const h = yield* makeLandingHarness;
        // The thread has moved on to a fresh workspace, so nothing arms the watch for it.
        const thread = yield* createWorkspaceThread("landing-explicit", "/workspaces/next-task");
        h.roots.set("ws-landed-earlier", "/workspaces/landed-earlier");
        h.submit("ws-landed-earlier", "op_explicit");
        yield* engine.dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make("command:landing-explicit-watch"),
          threadId: thread,
          target: { kind: "landing", operationId: "op_explicit" },
          watching: true,
        });
        yield* h.reactor.sweep;
        const [watch, ...others] = yield* watchesOf(thread);
        assert.deepEqual(watch?.target, { kind: "landing", operationId: "op_explicit" });
        assert.lengthOf(others, 0);
        // A fresh reactor, as after a server restart, settles the stored watch.
        const restarted = yield* makeLandingHarness;
        restarted.landings.push(
          ...h.landings.map((landing) => ({
            ...landing,
            status: "failed" as const,
            stage: "verifying",
            reason: "tests failed",
          })),
        );
        yield* restarted.reactor.sweep;
        const [wake, ...rest] = yield* restarted.messages(thread);
        assert.lengthOf(rest, 0);
        assert.equal(wake?.notification?.outcome, "failed");
        assert.include(wake?.text, "operation op_explicit");
        assert.lengthOf(yield* watchesOf(thread), 0);
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

  it.effect(
    "arms the thread that ran `slipjay land`, whatever workspace it landed from or who shares it",
    () =>
      Effect.gen(function* () {
        const h = yield* makeLandingHarness;
        const other = yield* createWorkspaceThread("landing-ran-other", "/workspaces/ran-shared");
        const thread = yield* createWorkspaceThread("landing-ran", "/workspaces/ran-shared");
        const bystander = yield* createWorkspaceThread("landing-ran-by", "/workspaces/ran-by");
        // Two threads hold the checkout it landed from, and a third's checkout is unrelated.
        h.roots.set("ws-ran", "/workspaces/ran-shared");
        h.submit("ws-ran", "op_ran");
        // A second workspace the thread allocated itself, which SlipJay cannot place.
        h.submit("ws-allocated", "op_allocated");
        const command = (operationId: string) => ({
          id: TurnItemId.make(`turn-item:ran:${operationId}`),
          threadId: thread,
          runId: run(thread, 1, "completed").id,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          title: "slipjay land",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution" as const,
          input: "slipjay land --no-wait",
          output: `{"ok":true,"verdict":"submitted","operationId":"${operationId}"}`,
        });
        yield* seedRun(thread, {
          status: "completed",
          extra: ["op_ran", "op_allocated"].map((operationId) => ({
            id: EventId.make(`event:ran:${operationId}`),
            type: "turn-item.updated" as const,
            threadId: thread,
            runId: command(operationId).runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: command(operationId),
          })),
        });
        yield* h.reactor.sweep;
        assert.lengthOf(yield* watchesOf(other), 0);
        assert.lengthOf(yield* watchesOf(bystander), 0);
        assert.lengthOf(yield* watchesOf(thread), 2);
        h.finish("op_allocated", { status: "failed", reason: "tests failed" });
        h.finish("op_ran", { status: "landed", commitId: "abc1234" });
        yield* h.reactor.sweep;
        assert.deepEqual(
          (yield* h.messages(thread)).map((message) => message.notification?.outcome).toSorted(),
          ["completed", "failed"],
        );
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

  it.effect("arms nothing for a landing another host submitted", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-other-host", "/workspaces/other-host");
      h.roots.set("ws-other-host", "/workspaces/other-host");
      h.submit("ws-other-host", "op_elsewhere", { submittedBy: "another-host:ws-other-host" });
      h.submit("ws-other-host", "op_unlabelled", { submittedBy: "" });
      yield* h.reactor.sweep;
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 0);
      h.finish("op_elsewhere", { status: "failed", reason: "not this machine's landing" });
      h.finish("op_unlabelled", { status: "landed", commitId: "abc1234" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(thread), 0);
    }),
  );

  it.effect("skips a settled, archived or deleted thread holding the submitting checkout", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const blocked of ["settled", "archived", "deleted"] as const) {
        const h = yield* makeLandingHarness;
        const root = `/workspaces/skip-${blocked}`;
        const skip = yield* createWorkspaceThread(`landing-skip-${blocked}`, root);
        const live = yield* createWorkspaceThread(`landing-live-${blocked}`, root);
        h.roots.set(`ws-skip-${blocked}`, root);
        yield* orchestrator.dispatch({
          type:
            blocked === "settled"
              ? "thread.settle"
              : blocked === "archived"
                ? "thread.archive"
                : "thread.delete",
          commandId: CommandId.make(`command:landing-skip-${blocked}`),
          threadId: skip,
        });
        h.submit(`ws-skip-${blocked}`, `op_skip_${blocked}`);
        yield* h.reactor.sweep;
        const watches = yield* watchesOf(live);
        assert.lengthOf(watches, 1);
        assert.deepEqual(watches[0]?.target, {
          kind: "landing",
          operationId: `op_skip_${blocked}`,
        });
        if (blocked !== "deleted") assert.lengthOf(yield* watchesOf(skip), 0);
        h.finish(`op_skip_${blocked}`, { status: "failed", reason: "tests failed" });
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(live), 1);
        if (blocked !== "deleted") assert.lengthOf(yield* h.messages(skip), 0);
      }
    }),
  );

  it.effect("a subagent child holding the submitting checkout leaves its parent to be woken", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const root = "/workspaces/subagent-checkout";
      const parent = yield* createWorkspaceThread("landing-subagent-parent", root);
      const parentThread = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.flatMap((store) => store.getThread(parent)),
        Effect.provide(ProjectionStore.layer),
      );
      const child = makeSubagentChildThread({
        parentThread,
        childThreadId: ThreadId.make("thread:landing-subagent-child"),
        parentNodeId: NodeId.make("node:landing-subagent"),
        activeProviderThreadId: null,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        title: "landing subagent child",
        now,
        createdBy: "agent",
        creationSource: "provider",
      });
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:seed-landing-subagent"),
        events: [
          {
            id: EventId.make("event:landing-subagent-child:created"),
            type: "thread.created",
            threadId: child.id,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: child,
          },
        ],
      });
      h.roots.set("ws-subagent-checkout", root);
      h.submit("ws-subagent-checkout", "op_subagent");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(parent), 1);
      assert.lengthOf(yield* watchesOf(child.id), 0);
      h.finish("op_subagent", { status: "failed", reason: "tests failed" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(parent), 1);
      assert.lengthOf(yield* h.messages(child.id), 0);
    }),
  );

  it.effect("a watch armed before its thread settled wakes nobody", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread(
        "landing-settled-later",
        "/workspaces/settled-later",
      );
      h.roots.set("ws-settled-later", "/workspaces/settled-later");
      h.submit("ws-settled-later", "op_settled_later");
      yield* h.reactor.sweep;
      assert.lengthOf(yield* watchesOf(thread), 1);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:landing-settle-watcher"),
        threadId: thread,
      });
      assert.lengthOf(yield* watchesOf(thread), 0);
      h.finish("op_settled_later", { status: "landed", commitId: "abc1234" });
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(thread), 0);
    }),
  );

  it.effect(
    "the thread's own finished `slipjay land` naming the operation suppresses the wake",
    () =>
      Effect.gen(function* () {
        const h = yield* makeLandingHarness;
        const thread = yield* createWorkspaceThread("landing-output", "/workspaces/output");
        h.roots.set("ws-output", "/workspaces/output");
        h.submit("ws-output", "op_output");
        yield* h.reactor.sweep;
        assert.lengthOf(yield* watchesOf(thread), 1);
        const command = {
          id: TurnItemId.make("turn-item:output-watch"),
          threadId: thread,
          runId: run(thread, 1, "running").id,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          title: "slipjay land",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution" as const,
          input: "slipjay land",
          output: "[runner test] failed at verifying: tests failed\nslipjay runner log op_output",
        };
        yield* seedRun(thread, {
          status: "running",
          extra: [
            {
              id: EventId.make("event:output-watch:running"),
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
        h.finish("op_output", { status: "failed", reason: "tests failed" });
        yield* h.reactor.sweep;
        assert.lengthOf(yield* h.messages(thread), 0);
        assert.lengthOf(yield* watchesOf(thread), 0);
      }),
  );

  it.effect(
    "a no-wait submission, or another command naming the operation, still wakes its thread while the run goes on",
    () =>
      Effect.gen(function* () {
        const commands = [
          "cd /workspaces/no-wait && slipjay land --no-wait --session s1",
          "slipjay land \\\n  --no-wait",
          "slipjay runner log OP",
          "slipjay watch --json",
        ];
        for (const [index, template] of commands.entries()) {
          const operationId = `op_no_wait_${index}`;
          const input = template.replace("OP", operationId);
          const h = yield* makeLandingHarness;
          const thread = yield* createWorkspaceThread(
            `landing-no-wait-${index}`,
            `/workspaces/no-wait-${index}`,
          );
          h.roots.set(`ws-no-wait-${index}`, `/workspaces/no-wait-${index}`);
          h.submit(`ws-no-wait-${index}`, operationId);
          yield* h.reactor.sweep;
          assert.lengthOf(yield* watchesOf(thread), 1);
          const command = {
            id: TurnItemId.make(`turn-item:no-wait-land-${index}`),
            threadId: thread,
            runId: run(thread, 1, "running").id,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed" as const,
            title: input,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution" as const,
            input,
            output: '{"ok":true,"verdict":"submitted","operationId":operationId}',
          };
          // The agent's run goes on with its next task after the submission returned.
          yield* seedBusyThread(thread);
          yield* (yield* EventSink.EventSinkV2).write({
            commandId: CommandId.make(`command:no-wait-land:completed:${index}`),
            events: [
              {
                id: EventId.make(`event:no-wait-land:completed:${index}`),
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
          h.finish(operationId, { status: "failed", reason: "tests failed" });
          yield* h.reactor.sweep;
          const [wake, ...rest] = yield* h.messages(thread);
          assert.lengthOf(rest, 0, input);
          assert.equal(wake?.notification?.outcome, "failed", input);
          assert.lengthOf(yield* watchesOf(thread), 0);
        }
      }),
  );

  it.effect("an unknown terminal outcome wakes with the unknown outcome", () =>
    Effect.gen(function* () {
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("landing-unknown", "/workspaces/unknown");
      h.roots.set("ws-unknown", "/workspaces/unknown");
      h.submit("ws-unknown", "op_unknown_outcome");
      yield* h.reactor.sweep;
      h.finish("op_unknown_outcome", { status: "unknown" });
      yield* h.reactor.sweep;
      const [wake, ...rest] = yield* h.messages(thread);
      assert.lengthOf(rest, 0);
      assert.deepEqual(wake?.notification, {
        source: { kind: "landing", operationId: "op_unknown_outcome", spec: 5255 },
        outcome: "unknown",
        summary: "Landing of Build #5255: unknown",
      });
      assert.include(wake?.text, "ended without a recorded outcome at verifying");
      assert.include(wake?.text, "T3 Code has stopped watching this landing");
      assert.lengthOf(yield* watchesOf(thread), 0);
      yield* h.reactor.sweep;
      assert.lengthOf(yield* h.messages(thread), 1);
    }),
  );
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Parks `threadId` and feeds the stored events to the reactors, as their event streams would. */
const parkOn = (
  threadId: ThreadId,
  target: OrchestrationV2ParkedWaitTarget,
  park: { readonly expectedMs?: number; readonly note?: string },
  reactors: ReadonlyArray<{
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }> = [],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* orchestrator.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make(`command:park:${(watchCommands += 1)}`),
      threadId,
      target,
      watching: true,
      park,
    });
    yield* observe(result.storedEvents);
    for (const reactor of reactors) {
      for (const stored of result.storedEvents) yield* reactor.handle(stored.event);
    }
  });

const parkedOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadShell(threadId))?.parkedWaits ?? [];
  });

/** Wakes of parked waits, whatever their source: their ids name the wait. */
const parkedWakes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    return messages.filter((message) => message.id.startsWith(`message:${threadId}:parked-wait:`));
  });

/** Resolves once `threadId` has a parked wake: the deadline timer runs on its own fiber. */
const awaitParkedWake = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    return yield* engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.threadId === threadId &&
          event.type === "message.updated" &&
          event.payload.id.startsWith(`message:${threadId}:parked-wait:`),
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
  });

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    const result = yield* vcs.run({
      operation: "test.git",
      command: "git",
      cwd,
      args: ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  }).pipe(Effect.provide(VcsProcess.layer));

/** A real repository: root, then a, then b on main; `unrelated` shares no history with them. */
const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "t3-parked-production-" });
  yield* git(path, "init", "-q", "-b", "main");
  const commit = (message: string) =>
    git(path, "commit", "-q", "--allow-empty", "-m", message).pipe(
      Effect.andThen(git(path, "rev-parse", "HEAD")),
    );
  const root = yield* commit("root");
  const a = yield* commit("a");
  const b = yield* commit("b");
  yield* git(path, "checkout", "-q", "--orphan", "other");
  const unrelated = yield* commit("unrelated");
  return { path, root, a, b, unrelated };
});

const serving = (commitId: string | null, connected = true): SlipJayRunnerOverview =>
  ({
    connected,
    paused: false,
    serial: [],
    deploy: [],
    deploys: [],
    repositories: [
      {
        repo: "pechhe/t3code",
        screeningLanes: 0,
        today: { landed: 0, failedScreens: 0 },
        release: {
          integrationBranch: "main",
          candidate: null,
          stagingSkipped: true,
          production: {
            live:
              commitId === null
                ? null
                : { commitId, deployedAt: "2026-11-10T09:00:00.000Z", healthy: true },
            latestAttempt: null,
          },
          images: null,
          audit: null,
          waitingOn: { kind: "up_to_date", detail: null },
        },
      },
    ],
  }) satisfies SlipJayRunnerOverview;

const makeProductionHarness = Effect.gen(function* () {
  const runner = { current: serving(null) };
  const slipJay = Layer.mock(SlipJayLandings.SlipJayLandings)({
    landings: Effect.succeed([]),
    follow: Effect.void,
    changes: Stream.empty,
    runner: Stream.fromEffect(Effect.sync(() => runner.current)),
    repositoryOf: () => Effect.succeed("pechhe/t3code"),
    workspaceRoot: () => Effect.undefined,
  });
  const reactor = yield* Effect.service(LandingWatchReactor.LandingWatchReactor).pipe(
    Effect.provide(
      LandingWatchReactor.layer.pipe(Layer.provide(ProjectionStore.layer), Layer.provide(slipJay)),
    ),
  );
  return { runner, reactor };
});

const createProject = (name: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const projectId = ProjectId.make(`project:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`command:project:${name}`),
      projectId,
      title: name,
      workspaceRoot,
    });
    return projectId;
  });

const createProjectThread = (projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
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
      worktreePath: null,
    });
    return threadId;
  });

it.layer(layerTest)("parked waits", (it) => {
  it.effect("a parked thread is finished, holds no watch, and wakes on its thread target", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* createThread("park-thread-lead");
      const worker = yield* createThread("park-thread-worker", "Fix the login");
      yield* seedRun(lead, { status: "completed", text: "Parked on the worker." });
      yield* parkOn(
        lead,
        { kind: "thread", threadId: worker },
        { expectedMs: HOUR_MS, note: "Review the fix." },
      );
      const shell = yield* orchestrator.getThreadShell(lead);
      assert.equal(shell?.standing?.state, "finished");
      assert.isUndefined(shell?.threadWatches);
      assert.lengthOf(shell?.pendingBackgroundTasks ?? [], 0);
      assert.deepEqual(
        shell?.parkedWaits?.map((wait) => wait.target),
        [{ kind: "thread", threadId: worker }],
      );

      yield* observe(yield* seedRun(worker, { status: "completed", text: "Landed abc123." }));
      const [wake, ...rest] = yield* wakes(lead);
      assert.lengthOf(rest, 0);
      assert.equal(wake?.notification?.summary, "Finished: Fix the login");
      assert.include(wake?.text, "> Landed abc123.");
      assert.include(wake?.text, "> Review the fix.");
      assert.lengthOf(yield* parkedOf(lead), 0);
    }),
  );

  it.effect(
    "wakes a Production wait once Production serves its commit or a descendant, decided in git",
    () =>
      // git runs as a real subprocess, so its timeouts need the live clock.
      TestClock.withLive(
        Effect.gen(function* () {
          const repo = yield* makeRepository;
          const h = yield* makeProductionHarness;
          const projectId = yield* createProject("park-production", repo.path);
          const thread = yield* createProjectThread(projectId, "park-production");
          const notes = (threadId: ThreadId) =>
            parkedWakes(threadId).pipe(
              Effect.map((messages) =>
                messages.filter((message) =>
                  message.notification?.summary.includes("reached Production"),
                ),
              ),
            );

          h.runner.current = serving(repo.unrelated);
          yield* parkOn(
            thread,
            { kind: "production", commitId: repo.a },
            { expectedMs: DAY_MS, note: "Tell Henry it is live." },
            [h.reactor],
          );
          assert.lengthOf(yield* notes(thread), 0);
          const [unrelated] = yield* parkedOf(thread);
          assert.include(unrelated?.lastKnown, `served ${repo.unrelated}, which does not include`);

          h.runner.current = serving(repo.root);
          yield* h.reactor.sweep;
          assert.lengthOf(yield* notes(thread), 0);

          h.runner.current = serving(repo.b);
          yield* h.reactor.sweep;
          yield* h.reactor.sweep;
          const [wake, ...rest] = yield* notes(thread);
          assert.lengthOf(rest, 0);
          assert.include(wake?.text, `Commit ${repo.a} has reached Production in pechhe/t3code`);
          assert.include(wake?.text, `serves ${repo.b}, which includes it`);
          assert.include(wake?.text, "> Tell Henry it is live.");
          assert.deepEqual(wake?.notification, {
            source: { kind: "system" },
            outcome: "completed",
            summary: `commit ${repo.a.slice(0, 7)} reached Production`,
            parked: "woke",
          });
          assert.lengthOf(yield* parkedOf(thread), 0);

          // Already served when parking: it wakes at once, without waiting for a sweep.
          const served = yield* createProjectThread(projectId, "park-production-served");
          yield* parkOn(
            served,
            { kind: "production", commitId: repo.root },
            { expectedMs: DAY_MS },
            [h.reactor],
          );
          assert.lengthOf(yield* notes(served), 1);

          // A commit no checkout holds cannot be decided: the wait stays, saying so.
          const unknown = yield* createProjectThread(projectId, "park-production-unknown");
          yield* parkOn(
            unknown,
            { kind: "production", commitId: "0123456789abcdef0123456789abcdef01234567" },
            { expectedMs: DAY_MS },
            [h.reactor],
          );
          assert.lengthOf(yield* notes(unknown), 0);
          const [undecided] = yield* parkedOf(unknown);
          assert.include(undecided?.lastKnown, "could not decide");

          h.runner.current = serving(repo.b, false);
          yield* h.reactor.sweep;
          assert.include(
            (yield* parkedOf(unknown))[0]?.lastKnown,
            "could not reach the SlipJay runner",
          );
        }),
      ),
  );

  it.effect("an event wait gives up once at twice its expected time, with what T3 last knew", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const h = yield* makeLandingHarness;
      const thread = yield* createWorkspaceThread("park-give-up", "/workspaces/park-give-up");
      h.submit("ws-unknown", "op_slow");
      yield* parkOn(
        thread,
        { kind: "landing", operationId: "op_slow" },
        { expectedMs: DAY_MS, note: "Repair it if it failed." },
      );
      yield* h.reactor.sweep;
      assert.equal(
        (yield* parkedOf(thread))[0]?.lastKnown,
        "Landing op_slow was still running, at verifying.",
      );
      assert.lengthOf(yield* watchesOf(thread), 0);

      const woken = yield* awaitParkedWake(thread);
      yield* TestClock.adjust("23 hours");
      yield* TestClock.adjust("24 hours");
      assert.lengthOf(yield* parkedWakes(thread), 0);
      yield* TestClock.adjust("1 hour");
      yield* Fiber.join(woken);
      const [wake, ...rest] = yield* parkedWakes(thread);
      assert.lengthOf(rest, 0);
      assert.include(wake?.text, "T3 Code gave up waiting for Landing op_slow");
      assert.include(wake?.text, "What T3 Code last knew: Landing op_slow was still running");
      assert.include(wake?.text, "> Repair it if it failed.");
      assert.deepEqual(wake?.notification, {
        source: { kind: "landing", operationId: "op_slow" },
        outcome: "unknown",
        summary: "Gave up waiting for Landing op_slow",
        parked: "gave_up",
      });
      assert.isUndefined((yield* orchestrator.getThreadShell(thread))?.parkedWaitWoke);
      assert.lengthOf(yield* parkedOf(thread), 0);
      assert.equal(
        (yield* orchestrator.getThreadShell(thread))?.parkedWaitGaveUp?.title,
        "Landing op_slow",
      );

      yield* h.reactor.sweep;
      yield* TestClock.adjust("2 days");
      assert.lengthOf(yield* parkedWakes(thread), 1);

      // The owner's next message clears the flag.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:park-give-up-reply"),
        threadId: thread,
        messageId: MessageId.make("message:park-give-up-reply"),
        text: "Thanks.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      assert.isUndefined((yield* orchestrator.getThreadShell(thread))?.parkedWaitGaveUp);
    }),
  );

  it.effect(
    "a check-back conversion parks an idle or settled thread once, and a past time wakes at once",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* ThreadWatchReactor.ThreadWatchReactor;
        const idle = yield* createThread("check-back-idle");
        const settled = yield* createThread("check-back-settled");
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("command:check-back-settle"),
          threadId: settled,
        });
        const later = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
        const convert = (threadId: ThreadId, at: string) =>
          orchestrator.dispatch({
            type: "thread.thread-watch",
            commandId: CommandId.make(`server:check-back-conversion:task-${threadId}`),
            threadId,
            target: { kind: "time", at },
            watching: true,
            park: { note: "Check the nightly build." },
          });
        for (const threadId of [idle, settled]) {
          const first = yield* convert(threadId, later);
          for (const stored of first.storedEvents) yield* reactor.handle(stored.event);
          // A repeated command id is answered from its receipt and parks nothing more.
          yield* convert(threadId, later);
          const waits = yield* parkedOf(threadId);
          assert.lengthOf(waits, 1);
          assert.equal(waits[0]?.note, "Check the nightly build.");
          assert.equal(waits[0]?.title, "check the nightly build");
        }
        assert.equal((yield* orchestrator.getThreadShell(settled))?.settledOverride, "settled");

        const overdue = yield* createThread("check-back-overdue");
        const past = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
        const parked = yield* convert(overdue, past);
        // The timer starts as the reactor indexes the wait and fires at once; a moment of test
        // time lets its dispatch finish, and moves no deadline that is not already due.
        for (const stored of parked.storedEvents) yield* reactor.handle(stored.event);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(yield* parkedWakes(overdue), 1);
        assert.lengthOf(yield* parkedOf(overdue), 0);
      }),
  );

  it.effect("a time wait wakes once at its time", () =>
    Effect.gen(function* () {
      const thread = yield* createThread("park-time");
      const at = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 3 }));
      yield* parkOn(thread, { kind: "time", at }, { note: "Check the nightly." });
      const [wait] = yield* parkedOf(thread);
      assert.isUndefined(wait?.givesUpAt);
      const woken = yield* awaitParkedWake(thread);
      yield* TestClock.adjust("179 minutes");
      assert.lengthOf(yield* parkedWakes(thread), 0);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(woken);
      const [wake, ...rest] = yield* parkedWakes(thread);
      assert.lengthOf(rest, 0);
      assert.include(wake?.text, `It is ${at}`);
      assert.include(wake?.text, "> Check the nightly.");
      assert.equal(wait?.title, "check the nightly");
      assert.deepEqual(wake?.notification, {
        source: { kind: "system" },
        outcome: "completed",
        summary: "Woke to check the nightly",
        parked: "woke",
      });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // The sidebar says what woke the thread while the wake's turn has not finished.
      const woke = (yield* orchestrator.getThreadShell(thread))?.parkedWaitWoke;
      assert.equal(woke?.title, "check the nightly");
      assert.equal(woke?.runId, (yield* orchestrator.getThreadShell(thread))?.latestRunId);
      const { runs } = yield* orchestrator.getThreadRecords(thread, ["runs"]);
      const wakeRun = runs.find((run) => run.userMessageId === wake?.id)!;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:park-time-finished"),
        events: [
          {
            id: EventId.make("event:park-time-finished"),
            type: "run.updated",
            threadId: thread,
            runId: wakeRun.id,
            occurredAt: now,
            payload: { ...wakeRun, status: "completed", completedAt: now },
          },
        ],
      });
      assert.isUndefined((yield* orchestrator.getThreadShell(thread))?.parkedWaitWoke);
      yield* TestClock.adjust("1 day");
      assert.lengthOf(yield* parkedWakes(thread), 1);
    }),
  );

  it.effect(
    "settling keeps a parked wait and drops a held one; the wake unsettles and starts a turn",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* createThread("park-settle-worker");
        for (const settle of ["hand", "auto"] as const) {
          const thread = yield* createThread(`park-settle-${settle}`);
          yield* seedRun(thread, { status: "completed", text: "Parked." });
          const at = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
          yield* parkOn(thread, { kind: "time", at }, {});
          assert.equal((yield* parkedOf(thread))[0]?.title, "check back");
          yield* watch(thread, worker);
          assert.lengthOf(yield* watchesOf(thread), 1);
          if (settle === "hand") {
            yield* orchestrator.dispatch({
              type: "thread.settle",
              commandId: CommandId.make(`command:park-settle-${settle}`),
              threadId: thread,
            });
          } else {
            const current = yield* orchestrator.getThreadShell(thread);
            yield* orchestrator.dispatch({
              type: "thread.auto-settle",
              commandId: CommandId.make(`command:park-settle-${settle}`),
              threadId: thread,
              snapshotAt: current!.updatedAt,
            });
          }
          const settled = yield* orchestrator.getThreadShell(thread);
          assert.equal(settled?.settledOverride, "settled", settle);
          assert.lengthOf(yield* watchesOf(thread), 0, settle);
          assert.lengthOf(yield* parkedOf(thread), 1, settle);

          const woken = yield* awaitParkedWake(thread);
          yield* TestClock.adjust("1 hour");
          const [wake] = Array.from(yield* Fiber.join(woken));
          const after = yield* orchestrator.getThreadShell(thread);
          assert.isNull(after?.settledOverride ?? null, settle);
          const { runs } = yield* orchestrator.getThreadRecords(thread, ["runs"]);
          assert.isDefined(
            runs.find(
              (run) => wake?.type === "message.updated" && run.userMessageId === wake.payload.id,
            ),
            settle,
          );
        }
      }),
  );

  it.effect("archiving ends a parked wait with no wake; a restart re-arms the others", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const archived = yield* createThread("park-archived");
      const restarted = yield* createThread("park-restarted");
      const at = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 2 }));
      yield* parkOn(archived, { kind: "time", at }, {});
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:park-archive"),
        threadId: archived,
      });
      assert.lengthOf(yield* parkedOf(archived), 0);

      // Parked while no reactor saw it, as across a restart: the new reactor's first sweep arms it.
      yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:park-before-restart"),
        threadId: restarted,
        target: { kind: "time", at },
        watching: true,
        park: {},
      });
      const fresh = yield* Effect.service(ThreadWatchReactor.ThreadWatchReactor).pipe(
        Effect.provide(ThreadWatchReactor.layer.pipe(Layer.provide(ProjectionStore.layer))),
      );
      yield* fresh.sweep;
      const woken = yield* awaitParkedWake(restarted);
      yield* TestClock.adjust("2 hours");
      yield* Fiber.join(woken);
      assert.lengthOf(yield* parkedWakes(restarted), 1);
      assert.lengthOf(yield* parkedWakes(archived), 0);
    }),
  );

  it.effect("unwatch cancels a parked wait by target or by id, and refuses an unparked time", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* createThread("park-cancel");
      const at = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
      const unparked = yield* orchestrator
        .dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make("command:park-unparked-time"),
          threadId: thread,
          target: { kind: "time", at },
          watching: true,
        })
        .pipe(Effect.exit);
      assert.isTrue(unparked._tag === "Failure");
      const noExpectation = yield* orchestrator
        .dispatch({
          type: "thread.thread-watch",
          commandId: CommandId.make("command:park-no-expectation"),
          threadId: thread,
          target: { kind: "landing", operationId: "op_x" },
          watching: true,
          park: {},
        })
        .pipe(Effect.exit);
      assert.isTrue(noExpectation._tag === "Failure");

      yield* parkOn(thread, { kind: "time", at }, {});
      yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:park-cancel-target"),
        threadId: thread,
        target: { kind: "time", at },
        watching: false,
      });
      assert.lengthOf(yield* parkedOf(thread), 0);

      yield* parkOn(thread, { kind: "landing", operationId: "op_x" }, { expectedMs: HOUR_MS });
      const [wait] = yield* parkedOf(thread);
      yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:park-cancel-id"),
        threadId: thread,
        watchId: wait!.id,
        watching: false,
      });
      assert.lengthOf(yield* parkedOf(thread), 0);
      yield* TestClock.adjust("1 day");
      assert.lengthOf(yield* parkedWakes(thread), 0);
    }),
  );

  it.effect("Build item and landing parked waits wake as their held watches do", () =>
    Effect.gen(function* () {
      const forge = yield* makeForgeHarness;
      const buildThread = yield* createThread("park-build");
      yield* parkOn(
        buildThread,
        { kind: "build_item", number: 1000001, until: "unblocked" },
        { expectedMs: DAY_MS, note: "Start the next step." },
      );
      yield* forge.reactor.sweep;
      assert.lengthOf(yield* forge.messages(buildThread), 0);
      assert.include((yield* parkedOf(buildThread))[0]?.lastKnown, "with 1 dependency waits");
      forge.state.item = { ...forge.state.item, waits: [] };
      yield* TestClock.adjust("1 minute");
      yield* forge.reactor.sweep;
      const [built, ...moreBuilt] = yield* forge.messages(buildThread);
      assert.lengthOf(moreBuilt, 0);
      assert.include(built?.text, "is unblocked");
      assert.include(built?.text, "> Start the next step.");

      const landing = yield* makeLandingHarness;
      const landingThread = yield* createWorkspaceThread(
        "park-landing",
        "/workspaces/park-landing",
      );
      landing.submit("ws-park-landing", "op_parked");
      yield* parkOn(
        landingThread,
        { kind: "landing", operationId: "op_parked" },
        {
          expectedMs: HOUR_MS,
        },
      );
      landing.finish("op_parked", { status: "landed", commitId: "abc1234" });
      yield* landing.reactor.sweep;
      yield* landing.reactor.sweep;
      const [landed, ...moreLanded] = yield* landing.messages(landingThread);
      assert.lengthOf(moreLanded, 0);
      assert.include(landed?.text, "Published commit: abc1234");
      assert.lengthOf(yield* parkedOf(landingThread), 0);
    }),
  );
});
