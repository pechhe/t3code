import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, RunId, NodeId, type AgentTaskBinding } from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Managed from "../agents/ManagedAgentService.ts";
import { snapshot, request, codex } from "../agents/agentPolicy.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as Scheduled from "../scheduledTasks/ScheduledTaskService.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as Settings from "../serverSettings.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect(
  "continues an owned idle task of any role and preserves each task and immutable binding",
  () =>
    Effect.gen(function* () {
      const parentId = ThreadId.make("advisor-parent");
      const childId = ThreadId.make("advisor-child");
      const originalId = NodeId.make("advisor-original");
      const childWorkspace = "/child-workspace";
      const binding: AgentTaskBinding = {
        ...request({
          role: "advisor",
          sourceRevision: "revision-one",
          workspacePath: childWorkspace,
        }),
        policyHash: snapshot().hash,
        policyRevision: "policy",
        briefHash: "b".repeat(64),
        requestFingerprint: "c".repeat(64),
        sourceAccess: "read-only",
        toolProfile: "source-reader",
        requested: { instanceId: codex.instanceId, model: "gpt-astra-test" },
        assigned: null,
        effective: { instanceId: codex.instanceId, model: "gpt-astra-test" },
      };
      let parent = idleThreadProjection(liveThreadShell(parentId));
      parent = {
        ...parent,
        // The lead has moved to a fresh checkout since this task was dispatched.
        thread: { ...parent.thread, worktreePath: "/lead-moved" },
        runs: [
          {
            id: RunId.make("parent-running"),
            status: "running",
            providerInstanceId: codex.instanceId,
            ordinal: 1,
            rootNodeId: NodeId.make("parent-node"),
          } as never,
        ],
        subagents: [
          {
            id: originalId,
            threadId: parentId,
            origin: "app_owned",
            childThreadId: childId,
            status: "completed",
            result: "Initial advice",
            completionDelivery: { state: "acknowledged" },
            providerInstanceId: codex.instanceId,
            model: binding.effective.model,
          } as never,
        ],
      };
      let child = idleThreadProjection(liveThreadShell(childId));
      child = {
        ...child,
        thread: { ...child.thread, agentTask: binding, archivedAt: null },
        runs: [
          {
            id: RunId.make("initial-advice"),
            status: "completed",
            ordinal: 1,
            delegatedTaskId: originalId,
          } as never,
        ],
      };
      let sends = 0;
      let lastSend: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0];
      let validations = 0;
      let revoked = false;
      const lock = yield* Semaphore.make(1);
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("advisor-env"),
        requestNamespace: "advisor-test",
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
        thread: {
          threadId: parentId,
          providerSessionId: "parent",
          providerInstanceId: codex.instanceId,
        },
        client: undefined,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Settings.layerTest(),
        Layer.mock(Managed.ManagedAgentService)({
          exclusive: (effect) => lock.withPermit(effect),
          validate: (input) =>
            Effect.gen(function* () {
              expect(input.binding.sourceRevision).toBe("revision-two");
              expect(input.binding.workspacePath).toBe(childWorkspace);
              expect(input.workspacePath).toBe("/lead-moved");
              expect(input.retainsWorkspace).toBe(true);
              validations++;
              if (revoked) return yield* new Managed.ManagedAgentError({ reason: "revoked" });
            }),
          handoff: () => Effect.succeed(undefined),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: (id) => Effect.succeed(id === parentId ? parent : child),
          listProjectThreads: () => Effect.succeed([]),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: () => Effect.succeed({} as never),
          sendToThread: (input) =>
            Effect.sync(() => {
              sends++;
              lastSend = input;
              const taskId = derive.delegatedTaskNode({ commandId: input.commandId });
              const runId = RunId.make(`consultation-${sends}`);
              parent = {
                ...parent,
                subagents: [
                  ...parent.subagents,
                  {
                    ...parent.subagents[0]!,
                    id: taskId,
                    result: null,
                    prompt: input.text,
                    status: "running",
                    completionDelivery: { state: "pending", observedByRunId: null },
                  },
                ],
              };
              child = {
                ...child,
                messages: [
                  ...child.messages,
                  { id: input.messageId, text: input.text, role: "user" } as never,
                ],
                runs: [
                  ...child.runs,
                  {
                    id: runId,
                    ordinal: sends + 1,
                    status: "running",
                    delegatedTaskId: taskId,
                  } as never,
                ],
              };
              return {} as never;
            }),
        }),
        Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
        Layer.mock(Adapters.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([codex.instanceId]),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: binding.workspacePath } as never)),
          listShells: () => Effect.succeed([{ workspaceRoot: binding.workspacePath } as never]),
        }),
        Layer.mock(Secrets.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(Scheduled.ScheduledTaskService)({}),
        Layer.mock(Launch.ThreadLaunchService)({}),
        Layer.mock(Git.GitVcsDriver)({}),
        Layer.mock(Experiments.ExperimentService)({ assignments: () => Effect.succeed([]) }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Mcp.OrchestratorMcpService;
        const input = {
          clientRequestId: "question-two",
          task: "Is the new approach sound?",
          followup: {
            taskId: originalId,
            sourceRevision: "revision-two",
            changes: "Changed the algorithm.",
          },
        };
        // The child can finish before terminal-event handling publishes its result.
        // A follow-up must not start during that interval, even though status can
        // derive the initial advice from the terminal child run.
        const publishedParent = parent;
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({ ...task, result: null })),
        };
        expect((yield* service.taskStatus(scope, originalId)).workState).toBe("result_available");
        expect((yield* service.delegateTask(scope, input).pipe(Effect.flip)).code).toBe(
          "invalid_request",
        );
        expect(sends).toBe(0);
        parent = publishedParent;
        const result = yield* service.delegateTask(scope, input);
        expect(result.childThreadId).toBe(childId);
        expect(result.taskId).not.toBe(originalId);
        expect(result.agentTask).toEqual(binding);
        const retry = yield* service.delegateTask(scope, input);
        expect(retry.taskId).toBe(result.taskId);
        expect(sends).toBe(1);
        expect(validations).toBe(1);
        expect(lastSend!.followupSourceRevision).toBe("revision-two");
        expect(
          (yield* service
            .delegateTask(scope, { ...input, task: "A different question" })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        expect(
          (yield* service
            .delegateTask(scope, { ...input, clientRequestId: "busy" })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        child = { ...child, runs: child.runs.map((run) => ({ ...run, status: "completed" })) };
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({
            ...task,
            status: "completed",
            result: "Advice",
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          })),
        };
        const another = yield* service.delegateTask(scope, {
          ...input,
          clientRequestId: "question-three",
          followup: { ...input.followup, taskId: result.taskId },
        });
        expect(another.childThreadId).toBe(childId);
        expect(sends).toBe(2);
        child = { ...child, runs: child.runs.map((run) => ({ ...run, status: "completed" })) };
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({
            ...task,
            status: "completed",
            result: "Advice",
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          })),
        };
        revoked = true;
        expect(
          (yield* service
            .delegateTask(scope, { ...input, clientRequestId: "revoked" })
            .pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        revoked = false;
        // A worker continues with its corrections in the same conversation.
        child = {
          ...child,
          thread: {
            ...child.thread,
            agentTask: {
              ...binding,
              role: "implementation-worker",
              sourceAccess: "scoped-write",
              toolProfile: "implementation",
            },
          },
        };
        const correction = yield* service.delegateTask(scope, {
          ...input,
          clientRequestId: "worker-correction",
          task: "Rename the helper as discussed.",
        });
        expect(correction.childThreadId).toBe(childId);
        expect(sends).toBe(3);
        expect(lastSend!.followupSourceRevision).toBe("revision-two");
        child = { ...child, runs: child.runs.map((run) => ({ ...run, status: "completed" })) };
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({
            ...task,
            status: "completed",
            result: "Done",
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          })),
        };
        // A reviewer or UI verifier that stopped partway continues in its own conversation too;
        // a new independent round is still a fresh delegate_task.
        for (const role of ["ticket-reviewer", "ui-verifier"] as const) {
          child = {
            ...child,
            thread: { ...child.thread, agentTask: { ...binding, role } },
          };
          const before = sends;
          const resumed = yield* service.delegateTask(scope, {
            ...input,
            clientRequestId: `resume-${role}`,
          });
          expect(resumed.childThreadId).toBe(childId);
          expect(sends).toBe(before + 1);
          child = { ...child, runs: child.runs.map((run) => ({ ...run, status: "completed" })) };
          parent = {
            ...parent,
            subagents: parent.subagents.map((task) => ({
              ...task,
              status: "completed",
              result: "Reviewed",
              completionDelivery: { state: "acknowledged", observedByRunId: null },
            })),
          };
        }
        // A server restart cancels the child's run and publishes that outcome; the task
        // stays open, so its lead continues the same conversation instead of a fresh one.
        child = { ...child, runs: child.runs.map((run) => ({ ...run, status: "cancelled" })) };
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({
            ...task,
            status: "cancelled",
            result: "Child task ended with status cancelled.",
            completionDelivery: { state: "claimed", observedByRunId: null },
          })),
        };
        const beforeRestart = sends;
        const afterRestart = yield* service.delegateTask(scope, {
          ...input,
          clientRequestId: "restart-cancelled",
        });
        expect(afterRestart.childThreadId).toBe(childId);
        expect(sends).toBe(beforeRestart + 1);
        child = { ...child, thread: { ...child.thread, agentTask: binding } };
        parent = {
          ...parent,
          subagents: parent.subagents.map((task) => ({
            ...task,
            completionDelivery: { state: "disposed", observedByRunId: null },
          })),
        };
        expect(
          (yield* service
            .delegateTask(scope, { ...input, clientRequestId: "closed" })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        expect(
          (yield* service
            .delegateTask(scope, {
              ...input,
              followup: { ...input.followup, taskId: NodeId.make("foreign") },
            })
            .pipe(Effect.flip)).code,
        ).toBe("task_not_found");
      }).pipe(
        Effect.provide(
          Layer.merge(
            Mcp.layer.pipe(
              Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
              Layer.provide(dependencies),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
            dependencies,
          ),
        ),
      );
    }),
);
