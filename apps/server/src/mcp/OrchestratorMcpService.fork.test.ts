import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ExternalAgentWork from "../agents/ExternalAgentWorkService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  ForgeWorkItemError,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { derive } from "@t3tools/provider-core/server/IdAllocator";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const orchestratorServiceWith = (build: Partial<ForgeWorkItems.ForgeWorkItems["Service"]>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)(build)),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(WorkspaceProvider.layerGitWorktree),
  );
const layerOrchestratorService = orchestratorServiceWith({
  connected: Effect.succeed({ connected: false, origin: null }),
});

describe("OrchestratorMcpService", () => {
  it.effect("refuses a Build watch without T3's Weave connection", () =>
    Effect.gen(function* () {
      const watcherId = ThreadId.make("thread:build-watch-refusal");
      const shell = liveThreadShell(watcherId);
      const dependencies = Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.mock(Experiments.ExperimentService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:watch"),
        requestNamespace: "watch-refusal",
        thread: {
          threadId: watcherId,
          providerSessionId: "watch-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .watchThread(
            scope,
            { target: { kind: "build_item", number: 1000001, until: "closed" } },
            true,
          )
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      assert.equal(result.code, "invalid_request");
      assert.include(result.message, "not connected to Weave");
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("refuses a Build watch on a number T3's Weave cannot see", () =>
    Effect.gen(function* () {
      const watcherId = ThreadId.make("thread:build-watch-unknown");
      const shell = liveThreadShell(watcherId);
      const dependencies = Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.mock(Experiments.ExperimentService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:watch"),
        requestNamespace: "watch-unknown",
        thread: {
          threadId: watcherId,
          providerSessionId: "watch-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .watchThread(
            scope,
            { target: { kind: "build_item", number: 1000001, until: "closed" } },
            true,
          )
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          orchestratorServiceWith({
            connected: Effect.succeed({ connected: true, origin: "https://weave.test" }),
            mentions: () => Effect.succeed({ items: [] }),
          }).pipe(Layer.provide(dependencies)),
        ),
      );
      assert.equal(result.code, "invalid_request");
      assert.include(result.message, "Build #1000001 is not a Spec or Ticket");
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("watches a Build item named by its ref, keeping the canonical number", () =>
    Effect.gen(function* () {
      const watcherId = ThreadId.make("thread:build-watch-ref");
      const shell = liveThreadShell(watcherId);
      const dispatched: Array<unknown> = [];
      const dependencies = Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.mock(Experiments.ExperimentService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:watch"),
        requestNamespace: "watch-ref",
        thread: {
          threadId: watcherId,
          providerSessionId: "watch-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.watchThread(
          scope,
          { target: { kind: "build_item", number: "ys-12", until: "closed" } },
          true,
        );
      }).pipe(
        Effect.provide(
          orchestratorServiceWith({
            connected: Effect.succeed({ connected: true, origin: "https://weave.test" }),
            resolve: (reference) =>
              Effect.succeed(
                reference === "ys-12"
                  ? { itemId: "item-1", number: 1000001, origin: "https://weave.test" }
                  : { itemId: "item-2", number: 2, origin: "https://weave.test" },
              ),
            mentions: () =>
              Effect.succeed({
                items: [
                  {
                    itemId: "item-1",
                    number: 1000001,
                    url: "https://weave.test/build/1000001",
                    item: {
                      kind: "spec",
                      ref: "YS-12",
                      title: "Friendly numbers",
                      status: "ready",
                      holds: [],
                      waits: [],
                    },
                    unavailable: false,
                    readAt: null,
                  },
                ],
              }),
          }).pipe(Layer.provide(dependencies)),
        ),
      );
      assert.deepEqual(result.target, { kind: "build_item", number: 1000001, until: "closed" });
      assert.equal(result.label, "YS-12");
      assert.include(JSON.stringify(dispatched), "1000001");
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("watches a SlipJay landing by its operation id without Weave", () =>
    Effect.gen(function* () {
      const watcherId = ThreadId.make("thread:landing-watch");
      const shell = liveThreadShell(watcherId);
      const dispatched: Array<{ target?: unknown; title?: unknown; watching?: unknown }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.mock(Experiments.ExperimentService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command as (typeof dispatched)[number]);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:watch"),
        requestNamespace: "watch-landing",
        thread: {
          threadId: watcherId,
          providerSessionId: "watch-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.watchThread(
          scope,
          { target: { kind: "landing", operationId: "op_42" } },
          true,
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      assert.deepEqual(result.target, { kind: "landing", operationId: "op_42" });
      assert.equal(result.watching, true);
      assert.equal(result.wasWatching, false);
      assert.deepEqual(dispatched[0]?.target, { kind: "landing", operationId: "op_42" });
      assert.equal(dispatched[0]?.title, "Landing op_42");
      assert.equal(dispatched[0]?.watching, true);
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("stops a Build watch by number without Weave, and by ref from the watched items", () =>
    Effect.gen(function* () {
      const watcherId = ThreadId.make("thread:build-unwatch");
      const shell = {
        ...liveThreadShell(watcherId),
        parkedWaits: [
          {
            id: "watch-1",
            target: { kind: "build_item", number: 1000001, until: "closed" },
            title: "Build #1000001",
            startedAt: "2026-10-20T00:00:00.000Z",
          },
        ],
      } as unknown as ReturnType<typeof liveThreadShell>;
      const dispatched: Array<{ target?: unknown; watching?: unknown }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.mock(Experiments.ExperimentService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command as never);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:watch"),
        requestNamespace: "unwatch",
        thread: {
          threadId: watcherId,
          providerSessionId: "watch-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const unwatch = (number: string, weaveDown: boolean) =>
        Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.watchThread(
            scope,
            { target: { kind: "build_item", number, until: "closed" } },
            false,
          );
        }).pipe(
          Effect.provide(
            orchestratorServiceWith({
              resolve: () =>
                Effect.fail(
                  new ForgeWorkItemError({ reason: "unavailable", message: "Weave down" }),
                ),
              mentions: () =>
                weaveDown
                  ? Effect.fail(
                      new ForgeWorkItemError({ reason: "unavailable", message: "Weave down" }),
                    )
                  : Effect.succeed({
                      items: [
                        {
                          itemId: "item-1",
                          number: 1000001,
                          url: "https://weave.test/build/1000001",
                          item: {
                            kind: "spec",
                            ref: "YS-12",
                            title: "Friendly numbers",
                            status: "ready",
                            holds: [],
                            waits: [],
                          },
                          unavailable: false,
                          readAt: null,
                        },
                      ],
                    }),
            }).pipe(Layer.provide(dependencies)),
          ),
        );
      const byNumber = yield* unwatch("#1000001", true);
      assert.deepEqual(byNumber.target, { kind: "build_item", number: 1000001, until: "closed" });
      assert.isTrue(byNumber.wasWatching);
      const byRef = yield* unwatch("ys-12", false);
      assert.equal(byRef.target.kind === "build_item" ? byRef.target.number : 0, 1000001);
      assert.isTrue(byRef.wasWatching);
      assert.isTrue(dispatched.every((command) => command.watching === false));
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect(
    "routes external delegate, status, wait, and cancel through the owned work service",
    () =>
      Effect.gen(function* () {
        const taskId = NodeId.make("node:external-mcp-route");
        const childThreadId = ThreadId.make("thread:external-mcp-route");
        const projectId = ProjectId.make("project:external-mcp-route");
        const calls: Array<string> = [];
        const result = {
          launchState: "accepted",
          taskId,
          childThreadId,
          childRunId: null,
          childNodeId: NodeId.make("node:external-mcp-route-child"),
          status: "running",
          workState: "working",
          hasPendingChildRuns: false,
          latestTerminalRunId: null,
          latestTerminalStatus: null,
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: null,
          summary: null,
          resultContextTransferId: null,
          waitTimedOut: false,
          agentTask: {
            externalOwner: {
              environmentId: EnvironmentId.make("environment:external-mcp-route"),
              clientSessionId: "oauth-session",
              externalSessionKey: "a".repeat(64),
              projectId,
              ceiling: "full-access",
            },
          },
        };
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:external-mcp-route"),
          requestNamespace: "client:oauth-session",
          thread: undefined,
          client: { sessionId: "oauth-session", label: "external client", access: "full-access" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const layerDependencies = Layer.mergeAll(
          Layer.merge(
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            Layer.mock(Experiments.ExperimentService)({
              assignForTask: () => Effect.succeed([]),
              assignments: () => Effect.succeed([]),
            }),
          ),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            waitForThread: () =>
              Effect.sync(() => calls.push("wait")).pipe(
                Effect.as({ run: undefined, timedOut: true } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const submitted: Array<unknown> = [];
        const externalWorkLayer = Layer.mock(ExternalAgentWork.ExternalAgentWorkService)({
          session: () => Effect.succeed({ workspacePath: "/session/workspace" } as never),
          submit: (_scope, input) =>
            Effect.sync(() => {
              calls.push("delegate");
              submitted.push(input.agentTask);
            }).pipe(Effect.as(result as never)),
          status: () => Effect.sync(() => calls.push("status")).pipe(Effect.as(result as never)),
          cancel: () =>
            Effect.sync(() => calls.push("cancel")).pipe(
              Effect.as({ taskId, status: "cancel_requested" } as never),
            ),
        });

        const outcomes = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const delegated = yield* service.delegateTask(scope, {
            task: "Route this through the owned work service.",
            externalSessionKey: "a".repeat(64),
            agentTask: { role: "scout", taskClass: "non-ui", workId: "work", attemptId: "one" },
            mode: "wait",
            timeoutMs: 5,
          });
          const waited = yield* service.taskStatus(scope, taskId, 5);
          const status = yield* service.taskStatus(scope, taskId);
          const cancelled = yield* service.cancelTask(scope, { taskId } as never);
          return [
            delegated.waitTimedOut,
            waited.waitTimedOut,
            status.taskId,
            cancelled.status,
          ] as const;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerOrchestratorService.pipe(Layer.provide(layerDependencies)),
              externalWorkLayer,
              Layer.mock(ManagedAgent.ManagedAgentService)({
                exclusive: () =>
                  Effect.die(
                    "External cancellation must not acquire the managed permit before the external permit",
                  ),
              }),
            ),
          ),
        );

        assert.deepEqual(outcomes, [true, true, taskId, "cancel_requested"]);
        // A task that names no workspace works in its session's.
        assert.deepEqual(submitted, [
          {
            role: "scout",
            taskClass: "non-ui",
            workId: "work",
            attemptId: "one",
            workspacePath: "/session/workspace",
          },
        ]);
        assert.deepEqual(calls, [
          "delegate",
          "wait",
          "status",
          "status",
          "wait",
          "status",
          "status",
          "cancel",
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("keeps external work private and refuses raw sends to its backing thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:external-mcp-owned");
      const environmentId = EnvironmentId.make("environment:external-mcp-owned");
      const projectId = ProjectId.make("project:external-mcp-owned");
      const ownerSessionId = "oauth-owner";
      const externalOwner = {
        environmentId,
        clientSessionId: ownerSessionId,
        externalSessionKey: "b".repeat(64),
        projectId,
        ceiling: "full-access" as const,
      };
      const shell = liveThreadShell(threadId);
      const projection = {
        ...idleThreadProjection(shell),
        thread: { ...idleThreadProjection(shell).thread, agentTask: { externalOwner } },
      } as unknown as OrchestrationV2ThreadProjection;
      const sent = yield* Ref.make(false);
      const layerDependencies = Layer.mergeAll(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.mock(Experiments.ExperimentService)({
            assignForTask: () => Effect.succeed([]),
            assignments: () => Effect.succeed([]),
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getRunCount: () => Effect.succeed(projection.runs.length),
          sendToThread: () => Ref.set(sent, true).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const caller = (sessionId: string): McpInvocationScope => ({
        environmentId,
        requestNamespace: `client:${sessionId}`,
        thread: undefined,
        client: { sessionId, label: "external client", access: "full-access" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      });

      const outcomes = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const foreignRead = yield* service
          .readThread(caller("oauth-foreign"), { threadId } as never)
          .pipe(Effect.flip);
        const foreignSend = yield* service
          .sendToThread(caller("oauth-foreign"), {
            threadId,
            message: "should be private",
            clientRequestId: "foreign-send",
          } as never)
          .pipe(Effect.flip);
        const ownerSend = yield* service
          .sendToThread(caller(ownerSessionId), {
            threadId,
            message: "start a fresh attempt instead",
            clientRequestId: "owner-send",
          } as never)
          .pipe(Effect.flip);
        return [foreignRead.code, foreignSend.code, ownerSend.code, ownerSend.message] as const;
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));

      assert.equal(outcomes[0], "task_not_found");
      assert.equal(outcomes[1], "task_not_found");
      assert.equal(outcomes[2], "invalid_request");
      assert.include(outcomes[3], "followup");
      assert.isFalse(yield* Ref.get(sent));
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect("lists, reads and waits on a thread with the standing the server sent", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment:mcp-standing");
      const states = ["working", "waiting", "stalled", "needs_you", "finished"] as const;
      const shells = states.map((state) => ({
        ...liveThreadShell(ThreadId.make(`thread:mcp-standing-${state}`), { activeRunId: null }),
        status: "completed" as const,
        standing: { state },
      }));
      const byId = new Map(shells.map((shell) => [shell.id, shell]));
      const layerDependencies = Layer.mergeAll(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.mock(Experiments.ExperimentService)({
            assignForTask: () => Effect.succeed([]),
            assignments: () => Effect.succeed([]),
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(byId.get(threadId) ?? null),
          listProjectThreads: () => Effect.succeed(shells),
          getShellSnapshot: (options) =>
            Effect.succeed({
              threads: shells.filter((shell) => options?.threadIds?.includes(shell.id) ?? true),
            } as never),
          getProjectThreadRecords: (input) =>
            Effect.succeed(idleThreadProjection(byId.get(input.threadId)!)),
          getRunCount: () => Effect.succeed(0),
          getThreadRecords: (threadId) =>
            Effect.succeed(idleThreadProjection(byId.get(threadId)!) as never),
          getTimelinePage: () =>
            Effect.succeed({ items: [], nextPosition: null, hasMore: false } as never),
          waitForThread: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              run: {
                id: RunId.make("run:mcp-standing"),
                ordinal: 1,
                status: "completed",
              } as never,
              timedOut: false,
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      );
      const caller: McpInvocationScope = {
        environmentId,
        requestNamespace: "client:mcp-standing",
        thread: undefined,
        client: { sessionId: "oauth-standing", label: "client", access: "full-access" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const listed = yield* service.listThreads(caller, { allProjects: true });
        for (const shell of shells) {
          const read = yield* service.readThread(caller, { threadId: shell.id } as never);
          const waited = yield* service.waitForThread(caller, { threadId: shell.id });
          assert.deepEqual(read.thread.standing, shell.standing);
          assert.deepEqual(waited.standing, shell.standing);
          assert.deepEqual(
            listed.threads.find((thread) => thread.threadId === shell.id)?.standing,
            shell.standing,
          );
          // A settled run alone never reads as the thread being done.
          assert.equal(waited.status, "completed");
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("lets the thread that owns a running managed task steer it, and refuses others", () =>
    Effect.gen(function* () {
      const parentId = ThreadId.make("thread:managed-steer-parent");
      const childId = ThreadId.make("thread:managed-steer-child");
      const taskId = NodeId.make("node:managed-steer-task");
      const parentShell = liveThreadShell(parentId);
      const childShell = liveThreadShell(childId);
      let parent = {
        ...idleThreadProjection(parentShell),
        runs: [
          {
            id: RunId.make("run:managed-steer-parent"),
            status: "running",
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as never,
        ],
        subagents: [
          {
            id: taskId,
            threadId: parentId,
            childThreadId: childId,
            origin: "app_owned",
            status: "running",
            result: null,
          } as never,
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      let child = {
        ...idleThreadProjection(childShell),
        thread: {
          ...idleThreadProjection(childShell).thread,
          agentTask: { role: "worker" },
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        },
        runs: [
          {
            id: RunId.make("run:managed-steer-child"),
            status: "running",
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as never,
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const sent: Array<Record<string, unknown>> = [];
      const dependencies = Layer.mergeAll(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.mock(Experiments.ExperimentService)({
            assignForTask: () => Effect.succeed([]),
            assignments: () => Effect.succeed([]),
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentId ? parentShell : threadId === childId ? childShell : null,
            ),
          getThreadRecords: (threadId) => Effect.succeed(threadId === parentId ? parent : child),
          getProjectThreadRecords: ({ threadId }) =>
            Effect.succeed(threadId === parentId ? parent : child),
          sendToThread: (input) =>
            Effect.sync(() => {
              sent.push(input as unknown as Record<string, unknown>);
              return {
                run: { id: RunId.make("run:managed-steer-child"), status: "running" },
                delivery: "steered",
              } as never;
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const caller = (threadId: ThreadId): McpInvocationScope => ({
        environmentId: EnvironmentId.make("environment:managed-steer"),
        requestNamespace: "mcp-managed-steer",
        thread: {
          threadId,
          providerSessionId: "parent",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      });

      const outcomes = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const steered = yield* service.sendToThread(caller(parentId), {
          threadId: childId,
          message: "Also cover the empty case.",
          mode: "steer",
          clientRequestId: "owner-steer",
        } as never);
        parent = { ...parent, subagents: [] };
        const notOwner = yield* service
          .sendToThread(caller(parentId), {
            threadId: childId,
            message: "Not mine to steer.",
            mode: "steer",
            clientRequestId: "not-owner-steer",
          } as never)
          .pipe(Effect.flip);
        parent = {
          ...parent,
          subagents: [
            {
              id: taskId,
              threadId: parentId,
              childThreadId: childId,
              origin: "app_owned",
              status: "running",
              result: null,
            } as never,
          ],
        };
        child = {
          ...child,
          runs: child.runs.map((run) => ({ ...run, status: "completed" })),
        } as unknown as OrchestrationV2ThreadProjection;
        const finished = yield* service
          .sendToThread(caller(parentId), {
            threadId: childId,
            message: "Continue the managed task instead.",
            mode: "auto",
            clientRequestId: "finished-send",
          } as never)
          .pipe(Effect.flip);
        return { steered, notOwner, finished } as const;
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));

      assert.equal(outcomes.steered.delivery, "steered");
      assert.equal(outcomes.steered.threadId, childId);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.mode, "steer");
      assert.equal(outcomes.notOwner.code, "invalid_request");
      assert.include(outcomes.notOwner.message, "followup");
      assert.equal(outcomes.finished.code, "invalid_request");
      assert.include(outcomes.finished.message, "followup");
    }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  it.effect(
    "releases the closed task's live provider session so its idle process frees the workspace (T3-264)",
    () =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-cancel-release-session-parent");
        const childThreadId = ThreadId.make("thread:mcp-cancel-release-session-child");
        const childRunId = RunId.make("run:mcp-cancel-release-session-child");
        const taskId = NodeId.make("node:mcp-cancel-release-session-task");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const parentProjection = {
          thread: {
            id: parentThreadId,
            lineage: { parentThreadId: null, relationshipToParent: null },
          },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              result: null,
              completionDelivery: { state: "pending" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const childProjection = {
          providerSessions: [
            { id: "provider-session:live", status: "ready" },
            { id: "provider-session:stopped", status: "stopped" },
          ],
          thread: { id: childThreadId, title: "Child" },
          runs: [{ id: childRunId, status: "completed" }],
          turnItems: [],
          providerTurns: [],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          Layer.merge(
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            Layer.mock(Experiments.ExperimentService)({
              assignForTask: () => Effect.succeed([]),
              assignments: () => Effect.succeed([]),
            }),
          ),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Effect.succeed({} as never)),
              ),
            cancelDelegatedTask: ({ command }) =>
              Ref.update(dispatched, (commands) => [...commands, command]),
            stopDelegatedTasks: () => Effect.void,
            delegatedTaskResultPending: () => Effect.succeed(false),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-cancel-release-session"),
          requestNamespace: "provider-session:mcp-cancel-release-session",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-cancel-release-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.cancelTask(scope, {
            taskId,
            clientRequestId: "cancel-release-session-task",
          });
          assert.equal(result.taskId, taskId);
          const detached = (yield* Ref.get(dispatched)).filter(
            (command) => (command as { type: string }).type === "provider-session.detach",
          );
          assert.deepEqual(
            detached.map((command) => (command as { providerSessionId: string }).providerSessionId),
            ["provider-session:live"],
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null },
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        worktreePath: "/tmp/mcp-parent-worktree",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    providerSessions: [],
    thread: { id: childThreadId, title: "Child" },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  it.effect.each([false, true])(
    "resolves a driverKind target and applies an assigned experiment: %s",
    (withExperiment) =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        let delegated = false;
        const layerDependencies = Layer.mergeAll(
          Layer.merge(
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            Layer.mock(Experiments.ExperimentService)({
              assignForTask: (input) =>
                Effect.succeed(
                  withExperiment
                    ? [
                        {
                          id: "assignment:test",
                          experimentId: "experiment:test",
                          revision: 1,
                          lever: "delegation",
                          unitKind: "task",
                          unitId: input.unitId,
                          threadId: input.threadId,
                          projectId: input.projectId,
                          taskCategory: "general",
                          boundaryRunId: null,
                          variant: {
                            id: "codex",
                            label: "Codex",
                            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
                          },
                          assignedModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
                          enrollment: "new",
                          assignmentMethod: "randomized",
                          assignedAt: "2026-10-14T12:00:00Z",
                          codeRevision: null,
                          briefRevision: null,
                          provenance: null,
                        },
                      ]
                    : [],
                ),
              assignments: () => Effect.succeed([]),
            }),
          ),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("antigravity") },
            mode: "async",
            clientRequestId: "delegate-antigravity-driver-1",
          });
          assert.equal(result.status, "running");
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(
            request.modelSelection.instanceId,
            withExperiment ? codexInstanceId : antigravityInstanceId,
          );
          assert.equal(request.modelSelection.model, withExperiment ? "gpt-5.4" : "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  describe("retrying delegate_task on a fresh MCP credential", () => {
    const issueScopes = Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1_000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(scope.environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const connect = (threadId: ThreadId) =>
        registry
          .issue({
            threadId,
            providerInstanceId: codexInstanceId,
            capabilities: new Set(["orchestration"]),
          })
          .pipe(
            Effect.flatMap((issued) =>
              registry.resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, "")),
            ),
            Effect.map((resolved) => resolved!),
          );
      return { connect };
    });

    // Each created task derives its id from the command, as the orchestrator does, and a
    // repeated command id replays the stored result, so `created` counts real executions.
    const harness = Effect.gen(function* () {
      const created = yield* Ref.make<ReadonlyArray<{ commandId: string; task: unknown }>>([]);
      const policyConfigured = yield* Ref.make(false);
      const taskFor = (
        commandId: CommandId,
        owner: ThreadId,
        prompt: string,
        requestFingerprint: string | undefined,
      ) => ({
        id: derive.delegatedTaskNode({ commandId }),
        threadId: owner,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt,
        requestFingerprint,
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      });
      const dependencies = Layer.mergeAll(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.mock(Experiments.ExperimentService)({
            assignForTask: () => Effect.succeed([]),
            assignments: () => Effect.succeed([]),
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: (commandId) =>
            Ref.get(created).pipe(
              Effect.map((all) => all.some((entry) => entry.commandId === commandId)),
            ),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Ref.get(created).pipe(
              Effect.map((all) =>
                threadId === childThreadId
                  ? childProjection
                  : {
                      ...parentProjection(all.map((entry) => entry.task)),
                      thread: { ...parentProjection([]).thread, id: threadId },
                    },
              ),
            ),
          dispatch: (command) =>
            Effect.gen(function* () {
              const delegation = command as Extract<
                OrchestrationV2ServerCommand,
                { readonly type: "delegated_task.request" }
              >;
              const prior = (yield* Ref.get(created)).find(
                (entry) => entry.commandId === delegation.commandId,
              );
              const task =
                prior?.task ??
                taskFor(
                  delegation.commandId,
                  delegation.parentThreadId,
                  delegation.task,
                  delegation.requestFingerprint,
                );
              if (prior === undefined)
                yield* Ref.update(created, (all) => [
                  ...all,
                  { commandId: delegation.commandId, task },
                ]);
              return {
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never;
            }),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );
      return {
        created,
        policyConfigured,
        layer: Layer.merge(
          layerOrchestratorService.pipe(Layer.provide(dependencies)),
          Layer.mock(ManagedAgent.ManagedAgentService)({
            configured: () => Ref.get(policyConfigured),
          }),
        ),
      };
    });

    const request = {
      task: "Review the change.",
      target: { driverKind: ProviderDriverKind.make("codex") },
      mode: "async",
      clientRequestId: "review-131-change-r1",
    } as const;

    it.effect(
      "replays an accepted raw task after policy configuration and refuses new raw work",
      () =>
        Effect.gen(function* () {
          const { created, policyConfigured, layer } = yield* harness;
          const { connect } = yield* issueScopes;
          const before = yield* connect(parentThreadId);
          // The response is lost and the agent reconnects on a fresh credential.
          const after = yield* connect(parentThreadId);
          assert.notEqual(before.thread.providerSessionId, after.thread.providerSessionId);

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const first = yield* service.delegateTask(before, request);
            yield* Ref.set(policyConfigured, true);
            const retry = yield* service.delegateTask(after, request);
            assert.equal(retry.taskId, first.taskId);
            assert.equal((yield* Ref.get(created)).length, 1);
            const newRequest = yield* service
              .delegateTask(after, { ...request, clientRequestId: "another-raw-task" })
              .pipe(Effect.flip);
            assert.equal(newRequest.code, "invalid_request");

            for (const changed of [
              { ...request, task: "Review something else." },
              { ...request, target: { providerInstanceId: codexInstanceId, model: "gpt-5.4" } },
              { ...request, title: "Another title" },
              { ...request, interactionMode: "plan" as const },
            ]) {
              const refused = yield* service.delegateTask(after, changed).pipe(Effect.flip);
              assert.equal(refused.code, "invalid_request");
            }
            assert.equal((yield* Ref.get(created)).length, 1);
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
    );

    it.effect("does not reuse another thread's task for the same textual id", () =>
      Effect.gen(function* () {
        const { created, layer } = yield* harness;
        const { connect } = yield* issueScopes;
        const owner = yield* connect(parentThreadId);
        const other = yield* connect(ThreadId.make("thread:mcp-providers-other"));

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(owner, request);
          const second = yield* service.delegateTask(other, request);
          assert.notEqual(second.taskId, first.taskId);
          assert.equal((yield* Ref.get(created)).length, 2);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
    );
  });

  it.live("delegates after an account handoff returns to an already attached session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "mcp-account-handoff";
        const cwd = yield* checkpointWorkspace(name);
        const alternate = ProviderInstanceId.make("codex-handoff");
        const driver = ProviderDriverKind.make("codex");
        const mcpRegistry = yield* McpSessionRegistry.__testing.make().pipe(
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(scope.environmentId),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
        const opened: ProviderInstanceId[] = [];
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
          [codexInstanceId, alternate].map((instanceId) => ({
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: (input) =>
              Effect.gen(function* () {
                opened.push(instanceId);
                const now = yield* DateTime.now;
                return {
                  instanceId,
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerSession: {
                    id: input.providerSessionId,
                    driver,
                    providerInstanceId: instanceId,
                    status: "ready" as const,
                    cwd,
                    model: "gpt-5.4",
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.never,
                  ensureThread: () => Effect.die("unused"),
                  resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                  startTurn: () => Effect.void,
                  steerTurn: () => Effect.void,
                  interruptTurn: () => Effect.void,
                  unloadThread: () => Effect.void,
                  respondToRuntimeRequest: () => Effect.void,
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                };
              }),
          })),
        );
        const databaseLayer = SqlitePersistence.layerMemory;
        const runtimeLayer = ProviderReplayHarness.layerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          layerRegistry,
          {
            databaseLayer,
            runEffectWorker: false,
            configureMcp: true,
            mcpSessionRegistryLayer: Layer.succeed(
              McpSessionRegistry.McpSessionRegistry,
              mcpRegistry,
            ),
          },
        );
        const settingsLayer = ServerSettings.layerTest({
          providerInstances: {
            [codexInstanceId]: { driver: "codex", enabled: true },
            [alternate]: { driver: "codex", enabled: true },
          },
        });
        const threadsLayer = ThreadManagementService.layer.pipe(
          Layer.provideMerge(runtimeLayer),
          Layer.provide(
            LegacyV1ThreadImporter.layer.pipe(
              Layer.provide(runtimeLayer),
              Layer.provide(databaseLayer),
            ),
          ),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer))),
          Layer.provide(settingsLayer),
        );
        const testLayer = layerOrchestratorService.pipe(
          Layer.provideMerge(threadsLayer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
              settingsLayer,
              layerRegistry,
              Layer.mock(Experiments.ExperimentService)({
                assignForTask: () => Effect.succeed([]),
                assignments: () => Effect.succeed([]),
              }),
              providerRegistryLayer(
                [codexInstanceId, alternate].map((instanceId) =>
                  providerSnapshot({ instanceId, driver, model: "gpt-5.4" }),
                ),
              ),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const sink = yield* EventSink.EventSinkV2;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const credentials = yield* McpProviderSessions.McpProviderSessions;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId: parentThreadId,
            projectId,
            title: name,
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          let previous: OrchestrationV2ThreadProjection["runs"][number] | undefined;
          let staleScope: McpInvocationScope | undefined;
          for (const [step, instanceId] of [
            codexInstanceId,
            alternate,
            codexInstanceId,
          ].entries()) {
            if (previous !== undefined) {
              const now = yield* DateTime.now;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make(`${name}:complete:${step}`),
                    type: "run.updated",
                    threadId: parentThreadId,
                    occurredAt: now,
                    payload: { ...previous, status: "completed", completedAt: now },
                  },
                ],
              });
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${name}:${step}`),
              threadId: parentThreadId,
              messageId: MessageId.make(`${name}:${step}`),
              text: "Continue",
              attachments: [],
              modelSelection: { instanceId, model: "gpt-5.4" },
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
            });
            const projection = yield* orchestrator.getThreadProjection(parentThreadId);
            previous = projection.runs.at(-1)!;
            assert.equal(previous.providerInstanceId, instanceId);
            const providerThread = projection.providerThreads.find(
              (thread) => thread.id === previous?.providerThreadId,
            )!;
            yield* manager.open({
              threadId: parentThreadId,
              providerSessionId: providerThread.providerSessionId!,
              modelSelection: previous.modelSelection,
              runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
            });
            const config = (yield* credentials.read(parentThreadId))!;
            const caller = (yield* mcpRegistry.resolve(
              config.authorizationHeader.replace(/^Bearer\s+/, ""),
            ))!;
            if (step === 1) {
              assert.isNotEmpty(projection.contextHandoffs);
              staleScope = caller;
            }
            if (step === 2) {
              assert.equal(
                (yield* mcp
                  .delegateTask(staleScope!, { task: "Stale account", mode: "async" })
                  .pipe(Effect.flip)).code,
                "parent_not_active",
              );
              const delegated = yield* mcp.delegateTask(caller, {
                task: "Verify ownership",
                mode: "async",
                clientRequestId: name,
              });
              assert.equal(delegated.providerInstanceId, codexInstanceId);
              assert.isDefined(delegated.childThreadId);
              assert.equal(caller.thread?.providerInstanceId, previous.providerInstanceId);
            }
          }
          assert.deepEqual(opened, [codexInstanceId, alternate]);
        }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(McpProviderSessions.layer))));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({})))),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    it.effect("lists only the named task within the requested project", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.merge(
                    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
                    Layer.mock(Experiments.ExperimentService)({
                      assignForTask: () => Effect.succeed([]),
                      assignments: () => Effect.succeed([]),
                    }),
                  ),
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );
  });

  describe("the workspace of an unbound scheduled task", () => {
    const projectId = ProjectId.make("project:scheduled-base");
    const workspaceRoot = "/repo/scheduled-base";
    const existing: ScheduledTask = {
      id: ScheduledTaskId.make("scheduled-task:base"),
      title: "Nightly",
      prompt: "Check the build",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled-base"),
      requestNamespace: "client:scheduled-base",
      thread: undefined,
      client: {
        sessionId: "scheduled-base",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
      saved: Ref.Ref<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>,
      task: ScheduledTask = existing,
      modes?: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput["threadMode"]>>,
      selections?: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>,
      enabledForProject = true,
      inputs?: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>,
      defaults: {
        readonly project: ScheduledTask["modelSelection"] | null;
        readonly environment?: ScheduledTask["modelSelection"];
      } = { project: existing.modelSelection },
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
        Layer.provide(
          Layer.mergeAll(
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  ...parentProjection([]),
                  thread: { ...parentProjection([]).thread, projectId },
                } as never),
              getThreadShell: () => Effect.succeed(null),
              isProviderInstanceEnabledForProject: () => Effect.succeed(enabledForProject),
            }),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: antigravityInstanceId,
                  driver: ProviderDriverKind.make("antigravity"),
                }),
                models: [
                  {
                    slug: "opus",
                    name: "Opus",
                    isCustom: false,
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "effort",
                          label: "Effort",
                          type: "select",
                          options: [{ id: "high", label: "High" }],
                        },
                      ],
                    },
                  },
                ],
              },
            ]),
            ServerSettings.layerTest(
              defaults.environment === undefined
                ? {}
                : { defaultModelSelection: defaults.environment },
            ),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([antigravityInstanceId]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  id: projectId,
                  workspaceRoot,
                  defaultModelSelection: defaults.project,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(Experiments.ExperimentService)({
              assignForTask: () => Effect.succeed([]),
              assignments: () => Effect.succeed([]),
            }),
            Layer.mock(ForgeWorkItems.ForgeWorkItems)({}),
            Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
            Layer.mock(WorkspaceProvider.WorkspaceProvider)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: [task] }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.andThen(
                    inputs === undefined
                      ? Effect.void
                      : Ref.update(inputs, (all) => [...all, input]),
                  ),
                  Effect.andThen(
                    selections === undefined
                      ? Effect.void
                      : Ref.update(selections, (all) => [...all, input]),
                  ),
                  Effect.as({
                    task: {
                      ...task,
                      modelSelection: input.modelSelection ?? task.modelSelection,
                      agentRole: input.agentRole === undefined ? task.agentRole : input.agentRole,
                    },
                  }),
                ),
            }),
          ),
        ),
      );
    const masterRepository: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: (cwd, remoteName) =>
        Effect.succeed(cwd === workspaceRoot && remoteName === "origin" ? "master" : null),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    };
    const schedule = { type: "interval", everyMs: 3_600_000 } as const;

    it.effect(
      "schedules an explicit model instead of the caller default and preserves ordinary updates",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const selections = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          const selection = {
            instanceId: antigravityInstanceId,
            model: "opus",
            options: [{ id: "effort", value: "high" }],
          };
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                { ...existing, agentRole: null, modelSelection: selection },
                undefined,
                selections,
              ),
            ),
          );
          const created = yield* mcp.scheduleTask(scope, {
            projectId,
            prompt: "Review weekly",
            schedule,
            purpose: "long_running",
            modelSelection: selection,
          });
          assert.equal(created.agentRole, null);
          assert.deepEqual(created.modelSelection, selection);
          const updated = yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            title: "Weekly review",
          });
          assert.deepEqual(updated.modelSelection, selection);
          yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            modelSelection: selection,
          });
          yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            agentRole: "reviewer",
          });
          const inputs = yield* Ref.get(selections);
          assert.equal(inputs[0]?.threadId, null);
          assert.deepEqual(
            inputs.map((input) => input.modelSelection),
            [selection, selection, selection, selection],
          );
          assert.deepEqual(
            inputs.map((input) => input.agentRole),
            [null, undefined, null, "reviewer"],
          );
        }),
    );

    it.effect(
      "rejects conflicting, unavailable, disabled and invalid explicit schedule selections",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const selections = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          for (const testCase of [
            {
              modelSelection: { instanceId: antigravityInstanceId, model: "opus" },
              agentRole: "reviewer" as const,
              code: "invalid_request",
            },
            {
              modelSelection: { instanceId: antigravityInstanceId, model: "missing" },
              code: "model_unavailable",
            },
            {
              modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "opus" },
              code: "provider_unavailable",
            },
            {
              modelSelection: {
                instanceId: antigravityInstanceId,
                model: "opus",
                options: [{ id: "effort", value: "unsupported" }],
              },
              code: "invalid_request",
            },
            {
              modelSelection: { instanceId: antigravityInstanceId, model: "opus" },
              enabledForProject: false,
              code: "provider_unavailable",
            },
          ]) {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
              Effect.provide(
                service(
                  masterRepository,
                  saved,
                  existing,
                  undefined,
                  selections,
                  testCase.enabledForProject,
                ),
              ),
            );
            const create = yield* mcp
              .scheduleTask(client, {
                projectId,
                prompt: "Review weekly",
                schedule,
                purpose: "long_running",
                modelSelection: testCase.modelSelection,
                agentRole: testCase.agentRole,
              })
              .pipe(Effect.result);
            const update = yield* mcp
              .updateScheduledTask(client, {
                scheduledTaskId: existing.id,
                modelSelection: testCase.modelSelection,
                agentRole: testCase.agentRole,
              })
              .pipe(Effect.result);
            assert(Result.isFailure(create));
            assert.equal(create.failure.code, testCase.code);
            assert(Result.isFailure(update));
            assert.equal(update.failure.code, testCase.code);
          }
          assert.deepEqual(yield* Ref.get(selections), []);
        }),
    );

    it.effect(
      "uses the project new-thread workspace default even when Git has another default branch",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(service(masterRepository, saved)),
          );
          yield* mcp.scheduleTask(client, {
            projectId,
            prompt: "Check the build",
            schedule,
            purpose: "long_running",
          });
          assert.deepEqual(yield* Ref.get(saved), [{ type: "root", rootIsDefault: true }]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Experiments.ExperimentService)({
                assignForTask: () => Effect.succeed([]),
                assignments: () => Effect.succeed([]),
              }),
              Layer.mock(ForgeWorkItems.ForgeWorkItems)({}),
              Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
              Layer.mock(WorkspaceProvider.WorkspaceProvider)({}),
            ),
          ),
        ),
    );
  });

  describe("resolveRuntimeMode", () => {
    it.effect(
      "applies the server default within the caller ceiling and preserves explicit refusals",
      () =>
        Effect.gen(function* () {
          assert.equal(
            yield* resolveRuntimeMode("full-access", undefined, undefined, "approval-required"),
            "approval-required",
          );
          assert.equal(
            yield* resolveRuntimeMode("auto", "inherit", undefined, "full-access"),
            "auto",
          );
          assert.equal(
            yield* resolveRuntimeMode("full-access", "auto-accept-edits", undefined, "auto"),
            "auto-accept-edits",
          );
          assert.equal(
            (yield* resolveRuntimeMode(
              "approval-required",
              "full-access",
              undefined,
              "approval-required",
            ).pipe(Effect.flip)).code,
            "runtime_mode_escalation_denied",
          );
        }),
    );
  });
});
