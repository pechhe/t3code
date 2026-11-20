import { layerNonSlipJay, layerSyntheticWorkspaces } from "./testkit/runWorkspaceCustody.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AgentTaskBinding,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSyntheticWorkspaces),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
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
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
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

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
);

const layerTestWithCustody = (custodyLayer: Parameters<typeof RuntimeLayer.layerWithCustody>[0]) =>
  Layer.mergeAll(
    RuntimeLayer.layerWithCustody(custodyLayer),
    RuntimeLayer.layerEventSink,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
    EffectOutbox.layer,
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
        readRepositoryIdentity: () => Effect.succeed(null),
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        refreshRepositoryIdentity: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provideMerge(
      Layer.mock(ManagedAgent.ManagedAgentService)({
        repositoryRoots: () => Effect.succeed([]),
        validate: (input) =>
          Effect.sync(() => {
            assert.equal(input.binding.sourceRevision, "revision-two");
          }),
      }),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerPlatformTest),
  );

const layerTest = layerTestWithCustody(layerNonSlipJay);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "pending" | "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly workspaceRoot?: string;
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly parentRunStatus?: "running" | "completed";
  readonly siblingTasks?: ReadonlyArray<{
    readonly id: NodeId;
    readonly deliveryState: "delivered" | "claimed";
  }>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: input.workspaceRoot ?? `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: input.parentRunStatus ?? "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: input.parentRunStatus === "completed" ? input.now : null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        ...[
          { id: input.taskId, deliveryState: input.deliveryState },
          ...(input.siblingTasks ?? []),
        ].map((task) => ({
          id: EventId.make(`event:seed-task:${input.threadId}:${task.id}`),
          type: "subagent.updated" as const,
          threadId: input.threadId,
          runId: input.runId,
          nodeId: task.id,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: task.id,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: task.deliveryState,
              observedByRunId: task.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed" as const,
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        })),
      ],
    });
  });

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly runStatus?: "cancelled" | "completed";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

const seedDelegatedChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly parentNodeId: NodeId;
  readonly name: string;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const run = runEvent({
      threadId: childThreadId,
      runId: RunId.make(`run:${input.name}`),
      ordinal: 1,
      status: "running",
      now: input.now,
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            agentTask: {
              role: "implementer",
              taskClass: "ui",
              workId: input.name,
              attemptId: "1",
              workspacePath: `/fixture/${input.name}`,
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
            } as AgentTaskBinding,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.parentNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: "always",
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
        run,
      ],
    });
    return { taskId, childThreadId, run: run.payload };
  });

const rosterEvent = (input: {
  readonly childThreadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly description?: string;
    readonly awaited?: true;
    readonly kind: "command" | "monitor" | "subagent" | "background_task";
  }>;
  readonly key: string;
}) => ({
  id: EventId.make(`event:${input.key}:roster`),
  type: "provider-thread.updated" as const,
  threadId: input.childThreadId,
  driver,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: ProviderThreadId.make(`provider-thread:${input.key}`),
    driver,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: null,
    appThreadId: input.childThreadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    pendingBackgroundTasks: input.tasks,
  },
});

const childEnded = (
  child: {
    readonly childThreadId: ThreadId;
    readonly run: { readonly id: RunId; readonly ordinal: number };
  },
  now: DateTime.Utc,
) => {
  const event = runEvent({
    threadId: child.childThreadId,
    runId: child.run.id,
    ordinal: child.run.ordinal,
    status: "completed",
    now,
  });
  return {
    ...event,
    payload: { ...event.payload, status: "completed" as const, startedAt: now, completedAt: now },
  };
};

const sinkStream = (taskId: NodeId, afterSequence: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.status === "completed",
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  });

const seedLingeringParent = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const runId = RunId.make(`${threadId}:run`);
    const rootNodeId = NodeId.make(`${threadId}:root`);
    yield* seedParentWithTerminalTask({
      threadId,
      projectId,
      runId,
      rootNodeId,
      taskId: NodeId.make(`${threadId}:seed-task`),
      deliveryState: "acknowledged",
      now,
    });
    return { now, runId, rootNodeId };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect(
      "holds a managed follow-up's result while its awaited command runs, then publishes it once the command ends",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make("thread:followup-grace-parent");
          const projectId = ProjectId.make("project:followup-grace");
          const parentRunId = RunId.make("run:followup-grace-parent");
          const rootNodeId = NodeId.make("node:followup-grace-parent");
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make("node:followup-grace-seed"),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: "followup-grace-child",
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          assert.equal(original.status, "completed");
          const { thread } = yield* orchestrator.getThreadProjection(child.childThreadId);
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:followup-grace-pin"),
                type: "thread.metadata-updated",
                threadId: child.childThreadId,
                occurredAt: now,
                payload: {
                  ...thread,
                  agentTask: {
                    role: "advisor",
                    taskClass: "non-ui",
                    workId: "advisor-work",
                    attemptId: "1",
                    workspacePath: "/fixture/advisor",
                    sourceRevision: "revision-one",
                    requestFingerprint: "a".repeat(64),
                    policyHash: "b".repeat(64),
                    policyRevision: "test",
                    briefHash: "c".repeat(64),
                    sourceAccess: "read-only",
                    toolProfile: "source-reader",
                    requested: thread.modelSelection,
                    assigned: null,
                    effective: thread.modelSelection,
                  },
                },
              },
            ],
          });

          const messageId = MessageId.make("message:followup-grace");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("command:followup-grace"),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            followupSourceRevision: "revision-two",
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const followupRun = (yield* orchestrator.getThreadProjection(
            child.childThreadId,
          )).runs.find((run) => run.userMessageId === messageId)!;
          const followupTaskId = followupRun.delegatedTaskId!;
          assert.notEqual(followupTaskId, child.taskId);
          yield* sink.write({
            events: [
              rosterEvent({
                childThreadId: child.childThreadId,
                now,
                key: "followup-grace",
                tasks: [
                  {
                    taskId: "bmtw1af16",
                    description:
                      'while pgrep -f "check_changed_static" >/dev/null; do sleep 5; done',
                    awaited: true,
                    kind: "command",
                  },
                ],
              }),
            ],
          });
          yield* sink.write({
            events: [
              {
                ...runEvent({
                  threadId: child.childThreadId,
                  runId: followupRun.id,
                  ordinal: followupRun.ordinal,
                  status: "completed",
                  now,
                }),
                payload: {
                  ...followupRun,
                  status: "completed" as const,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const held = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === followupTaskId,
          )!;
          assert.isNull(held.result);
          assert.notEqual(held.status, "completed");

          yield* TestClock.adjust("2 hours");
          yield* orchestrator.sweepDelegatedTaskResults;
          const stillHeld = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.find((task) => task.id === followupTaskId)!;
          assert.isNull(stillHeld.result);

          yield* sink.write({
            events: [
              {
                ...rosterEvent({
                  childThreadId: child.childThreadId,
                  now,
                  key: "followup-grace",
                  tasks: [],
                }),
                id: EventId.make("event:followup-grace:roster-ended"),
              },
            ],
          });
          yield* orchestrator.sweepDelegatedTaskResults;
          const published = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.find((task) => task.id === followupTaskId)!;
          assert.equal(published.status, "completed");
          assert.notInclude(published.result ?? "", "Abandoned background work");
        }),
    );
  },
);

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect("wakes a parent when the restart cap stops continuing its child", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-cap-parent");
      const projectId = ProjectId.make("project:restart-cap-parent");
      const runId = RunId.make("run:restart-cap-parent");
      const rootNodeId = NodeId.make("node:restart-cap-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-cap-parent-settled"),
        deliveryState: "delivered",
        parentRunStatus: "completed",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-cap-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });
      const first = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
      const chain = [2, 3, 4].map((ordinal) => ({
        ...first,
        id: RunId.make(`run:restart-cap-child:${ordinal}`),
        ordinal,
        userMessageId: MessageId.make(`message:restart-cap-child:${ordinal}`),
        requestedAt: DateTime.add(now, { seconds: ordinal }),
      }));
      yield* eventSink.writeWithEffects({
        commandId: CommandId.make("command:restart-cap-child:chain"),
        events: chain.map((run, index) => ({
          id: EventId.make(`event:restart-cap-child:${run.id}`),
          type: "run.updated" as const,
          threadId: child.childThreadId,
          runId: run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...run,
            restartContinuationOfRunId: index === 0 ? child.childRunId : chain[index - 1]!.id,
          },
        })),
        effects: [
          {
            id: `effect:restart-continuation:${chain[chain.length - 1]!.id}`,
            commandId: CommandId.make("command:restart-cap-child:chain"),
            threadId: child.childThreadId,
            request: {
              type: "provider-runtime.continue",
              sourceRunId: chain[chain.length - 1]!.id,
            },
          },
        ],
      });

      const source = chain[chain.length - 1]!;
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");
      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: source.id,
      }).pipe(Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })));

      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.map((run) => run.id),
        [child.childRunId, ...chain.map((run) => run.id)],
      );
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
      assert.equal(
        task?.result,
        "Child task ended with status cancelled.\n\nStopped after T3 Code restarted this task too many times in a row, so it needs a follow-up.",
      );
    }),
  );

  it.effect("settles a failed child with a stale tool and queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          {
            id: EventId.make("event:failed-hold-child:tool"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:failed-hold-child:tool"),
              type: "dynamic_tool",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "running",
              title: "read",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              toolName: "read",
              input: { path: "/tmp/image.png" },
              output: null,
            },
          },
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "failed");
      assert.include(task?.result ?? "", "Provider failed.");
      yield* orchestrator.recoverDelegatedTasks;
      const woken = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        woken.runs.filter((run) => run.delegatedCompletion !== undefined),
        1,
      );
      assert.lengthOf(
        woken.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
        1,
      );
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect(
    "holds a managed child's result for an awaited command however long it runs, and publishes it once the command ends",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("grace-expired-parent");
        const parent = yield* seedLingeringParent(
          threadId,
          ProjectId.make("grace-expired-project"),
        );
        const blocked = yield* seedDelegatedChild({
          parentThreadId: threadId,
          projectId: ProjectId.make("grace-expired-project"),
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          name: "grace-expired-blocked",
          now: parent.now,
        });
        const barrier = yield* seedDelegatedChild({
          parentThreadId: threadId,
          projectId: ProjectId.make("grace-expired-project"),
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          name: "grace-expired-barrier",
          now: parent.now,
        });
        const beforeEnd = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            rosterEvent({
              childThreadId: blocked.childThreadId,
              now: parent.now,
              key: "grace-expired-blocked",
              tasks: [
                {
                  taskId: "bmtw1af16",
                  description: 'while pgrep -f "check_changed_static" >/dev/null; do sleep 5; done',
                  awaited: true,
                  kind: "command",
                },
              ],
            }),
          ],
        });
        yield* sink.write({ events: [childEnded(blocked, parent.now)] });
        yield* sink.write({ events: [childEnded(barrier, parent.now)] });
        yield* sinkStream(barrier.taskId, beforeEnd);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === blocked.taskId,
          )?.status,
          "running",
        );

        yield* TestClock.adjust("2 hours");
        yield* orchestrator.sweepDelegatedTaskResults;
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === blocked.taskId,
          )?.status,
          "running",
        );

        // The command ends, so nothing is left running to hold the result.
        yield* sink.write({
          events: [
            {
              ...rosterEvent({
                childThreadId: blocked.childThreadId,
                now: parent.now,
                key: "grace-expired-blocked",
                tasks: [],
              }),
              id: EventId.make("event:grace-expired-blocked:roster-ended"),
            },
          ],
        });
        yield* orchestrator.sweepDelegatedTaskResults;
        const published = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === blocked.taskId,
        );
        assert.equal(published?.status, "completed");
        assert.notInclude(published?.result ?? "", "Abandoned background work");
        assert.isNotNull(published?.completionDelivery);
      }),
  );

  it.effect(
    "publishes at once for a command the managed child did not await, naming it abandoned",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("dev-server-parent");
        const parent = yield* seedLingeringParent(threadId, ProjectId.make("dev-server-project"));
        const blocked = yield* seedDelegatedChild({
          parentThreadId: threadId,
          projectId: ProjectId.make("dev-server-project"),
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          name: "dev-server-blocked",
          now: parent.now,
        });
        const beforeEnd = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            rosterEvent({
              childThreadId: blocked.childThreadId,
              now: parent.now,
              key: "dev-server-blocked",
              tasks: [{ taskId: "web", description: "vp run dev", kind: "command" }],
            }),
          ],
        });
        yield* sink.write({ events: [childEnded(blocked, parent.now)] });
        yield* sinkStream(blocked.taskId, beforeEnd);
        const published = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === blocked.taskId,
        );
        assert.equal(published?.status, "completed");
        assert.include(published?.result ?? "", "Abandoned background work: web (vp run dev).");
      }),
  );
});
