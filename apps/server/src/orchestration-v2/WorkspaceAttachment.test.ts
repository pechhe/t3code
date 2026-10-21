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
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-workspace-attachment-",
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
  openSession: () => Effect.die("sessions are not used by workspace attachment tests"),
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

const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(layerRuntime));

const now = DateTime.makeUnsafe("2026-10-16T10:00:00.000Z");
const rootNodeId = NodeId.make("node:workspace-attachment-root");

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

/** Writes a run of the thread and, when given, its final assistant message. */
const seedRun = (
  threadId: ThreadId,
  input: {
    readonly ordinal?: number;
    readonly status: OrchestrationV2Run["status"];
    readonly text?: string;
    readonly extra?: ReadonlyArray<OrchestrationV2DomainEvent>;
  },
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const seeded = run(threadId, input.ordinal ?? 1, input.status);
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

const attach = (
  threadId: ThreadId,
  name: string,
  workspacePath: string,
  origin: "allocated" | "adopted" = "allocated",
  attempt = 1,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.workspace-attachment.update",
      commandId: CommandId.make(`command:attach:${threadId}:${workspacePath}:${attempt}`),
      threadId,
      change: {
        action: "attach",
        attachment: {
          projectId: ProjectId.make(`project:${name}`),
          workspacePath,
          branch: null,
          origin,
        },
      },
    });
  });

const change = (threadId: ThreadId, action: "release" | "detach", workspacePath: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.workspace-attachment.update",
      commandId: CommandId.make(`command:${action}:${threadId}:${workspacePath}`),
      threadId,
      change: { action, workspacePath },
    });
  });

const attachmentsOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* projections.getThread(threadId);
    return (thread.workspaceAttachments ?? []).map((attachment) => ({
      projectId: attachment.projectId,
      workspacePath: attachment.workspacePath,
      released: attachment.releasedAt !== null,
    }));
  });

it.layer(layerTest)("workspace attachments", (it) => {
  it.effect("holds one live workspace per other project and frees it on release", () =>
    Effect.gen(function* () {
      const lead = yield* createThread("lead-hold");
      yield* createThread("api-hold");
      yield* attach(lead, "api-hold", "/workspaces/api-1");

      const second = yield* Effect.exit(attach(lead, "api-hold", "/workspaces/api-2"));
      assert.isTrue(second._tag === "Failure");
      const home = yield* Effect.exit(attach(lead, "lead-hold", "/workspaces/lead-1"));
      assert.isTrue(home._tag === "Failure");

      yield* change(lead, "release", "/workspaces/api-1");
      yield* attach(lead, "api-hold", "/workspaces/api-2", "allocated", 2);
      assert.deepEqual(yield* attachmentsOf(lead), [
        {
          projectId: ProjectId.make("project:api-hold"),
          workspacePath: "/workspaces/api-2",
          released: false,
        },
      ]);

      yield* change(lead, "detach", "/workspaces/api-2");
      assert.deepEqual(yield* attachmentsOf(lead), []);
    }),
  );

  it.effect("a project move promotes the held workspace, and Undo restores it", () =>
    Effect.gen(function* () {
      const chat = yield* createThread("chat-move");
      yield* createThread("api-move");
      yield* createThread("web-move");
      yield* seedRun(chat, { status: "completed", text: "done" });
      yield* attach(chat, "api-move", "/workspaces/api-move");
      yield* attach(chat, "web-move", "/workspaces/web-move", "adopted");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const record = (
        id: string,
        change:
          | { readonly action: "revert" }
          | {
              readonly action: "apply";
              readonly fromProjectId: ProjectId;
              readonly projectId: ProjectId;
              readonly worktreePath: string | null;
              readonly branch: string | null;
              readonly workspaceIssue: null;
              readonly pendingWorkspace: boolean;
            },
      ) =>
        orchestrator.dispatch({
          type: "thread.project-move.record",
          commandId: CommandId.make(`command:${id}:chat-move`),
          threadId: chat,
          change,
        });
      yield* record("move", {
        action: "apply",
        fromProjectId: ProjectId.make("project:chat-move"),
        projectId: ProjectId.make("project:api-move"),
        worktreePath: "/workspaces/api-move",
        branch: null,
        workspaceIssue: null,
        pendingWorkspace: false,
      });

      const moved = yield* projections.getThread(chat);
      assert.equal(moved.projectId, ProjectId.make("project:api-move"));
      assert.equal(moved.worktreePath, "/workspaces/api-move");
      assert.equal(moved.projectMove?.fromProjectId, ProjectId.make("project:chat-move"));
      assert.equal(moved.projectMove?.runCount, 1);
      assert.deepEqual(yield* attachmentsOf(chat), [
        {
          projectId: ProjectId.make("project:web-move"),
          workspacePath: "/workspaces/web-move",
          released: false,
        },
      ]);

      yield* record("undo", { action: "revert" });
      const restored = yield* projections.getThread(chat);
      assert.equal(restored.projectId, ProjectId.make("project:chat-move"));
      assert.isNull(restored.worktreePath);
      assert.isNull(restored.projectMove);
      assert.deepEqual(
        (yield* attachmentsOf(chat)).map((attachment) => attachment.workspacePath).toSorted(),
        ["/workspaces/api-move", "/workspaces/web-move"],
      );
    }),
  );

  it.effect("Undo is refused once the moved chat has run in the project", () =>
    Effect.gen(function* () {
      const chat = yield* createThread("chat-ran");
      yield* createThread("api-ran");
      yield* seedRun(chat, { status: "completed", text: "done" });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.project-move.record",
        commandId: CommandId.make("command:move:chat-ran"),
        threadId: chat,
        change: {
          action: "apply",
          fromProjectId: ProjectId.make("project:chat-ran"),
          projectId: ProjectId.make("project:api-ran"),
          worktreePath: null,
          branch: null,
          workspaceIssue: null,
          pendingWorkspace: false,
        },
      });
      yield* seedRun(chat, { ordinal: 2, status: "completed", text: "in the project" });
      const undo = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.project-move.record",
          commandId: CommandId.make("command:undo:chat-ran"),
          threadId: chat,
          change: { action: "revert" },
        }),
      );
      assert.isTrue(undo._tag === "Failure");
    }),
  );

  it.effect("a second move recorded against the chat's old project is refused", () =>
    Effect.gen(function* () {
      const chat = yield* createThread("chat-race");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const apply = (id: string, projectId: string) =>
        orchestrator.dispatch({
          type: "thread.project-move.record",
          commandId: CommandId.make(`command:${id}:chat-race`),
          threadId: chat,
          change: {
            action: "apply",
            fromProjectId: ProjectId.make("project:chat-race"),
            projectId: ProjectId.make(projectId),
            worktreePath: null,
            branch: null,
            workspaceIssue: null,
            pendingWorkspace: true,
          },
        });
      yield* apply("first", "project:api-race");
      const second = yield* Effect.exit(apply("second", "project:web-race"));
      assert.isTrue(second._tag === "Failure");
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(chat);
      assert.equal(thread.projectId, ProjectId.make("project:api-race"));
    }),
  );

  it.effect("a move that promotes nothing keeps the chat's attachments in that project", () =>
    Effect.gen(function* () {
      const chat = yield* createThread("chat-keep");
      yield* createThread("api-keep");
      yield* attach(chat, "api-keep", "/workspaces/api-keep");
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.project-move.record",
        commandId: CommandId.make("command:move:chat-keep"),
        threadId: chat,
        change: {
          action: "apply",
          fromProjectId: ProjectId.make("project:chat-keep"),
          projectId: ProjectId.make("project:api-keep"),
          worktreePath: null,
          branch: null,
          workspaceIssue: null,
          pendingWorkspace: true,
        },
      });
      assert.deepEqual(yield* attachmentsOf(chat), [
        {
          projectId: ProjectId.make("project:api-keep"),
          workspacePath: "/workspaces/api-keep",
          released: false,
        },
      ]);
    }),
  );

  it.effect("binding a workspace settles the one a move left to prepare", () =>
    Effect.gen(function* () {
      const chat = yield* createThread("chat-bind");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.project-move.record",
        commandId: CommandId.make("command:move:chat-bind"),
        threadId: chat,
        change: {
          action: "apply",
          fromProjectId: ProjectId.make("project:chat-bind"),
          projectId: ProjectId.make("project:api-bind"),
          worktreePath: null,
          branch: null,
          workspaceIssue: null,
          pendingWorkspace: true,
        },
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.isTrue((yield* projections.getThread(chat)).projectMove?.pendingWorkspace);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:bind:chat-bind"),
        threadId: chat,
        branch: null,
        worktreePath: "/workspaces/api-bind",
      });
      const bound = yield* projections.getThread(chat);
      assert.equal(bound.worktreePath, "/workspaces/api-bind");
      assert.isFalse(bound.projectMove?.pendingWorkspace);
    }),
  );

  it.effect("an ordinary fork does not take the source's attachments", () =>
    Effect.gen(function* () {
      const source = yield* createThread("fork-plain");
      yield* createThread("api-plain");
      yield* seedRun(source, { status: "completed", text: "done" });
      yield* attach(source, "api-plain", "/workspaces/api-plain");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fork = ThreadId.make("thread:fork-plain:fork");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("command:fork:fork-plain"),
        sourceThreadId: source,
        targetThreadId: fork,
        sourcePoint: { type: "latest_finished" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.deepEqual(yield* attachmentsOf(fork), []);
      assert.equal((yield* attachmentsOf(source)).length, 1);
    }),
  );
});
