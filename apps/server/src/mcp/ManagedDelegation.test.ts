import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentPolicyManifest,
  EnvironmentId,
  ProjectId,
  ThreadId,
  RunId,
  NodeId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Managed from "../agents/ManagedAgentService.ts";
import { snapshot, request, codex, claude } from "../agents/agentPolicy.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as Processes from "../processRunner.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Scheduled from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcs from "../vcs/GitVcsDriver.ts";
import * as Settings from "../serverSettings.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const persistence = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  persistence,
  Layer.succeed(Processes.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout: "source-pin\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  }),
);
const services = Layer.mergeAll(Managed.layer, Experiments.layer).pipe(
  Layer.provideMerge(dependencies),
);

it.layer(services)("managed delegation experiment boundary", (it) => {
  it.effect(
    "retains forbidden assignment and failure across retries without dispatching a child",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "managed-mcp-test-" });
        const root = yield* fs.realPath(temporary);
        yield* fs.makeDirectory(`${root}/roles`);
        yield* fs.makeDirectory(`${root}/.jj`);
        const policy = snapshot();
        yield* fs.writeFileString(
          `${root}/roles/policy.json`,
          yield* Schema.encodeEffect(Schema.fromJsonString(AgentPolicyManifest))(policy.manifest),
        );
        for (const role of Object.values(policy.manifest.roles))
          yield* fs.writeFileString(`${root}/${role.brief}`, "Independent role brief\n");
        const threadId = ThreadId.make("managed-parent");
        const projectId = ProjectId.make("managed-project");
        const parent = {
          thread: {
            id: threadId,
            projectId,
            title: "Parent",
            runtimeMode: "full-access",
            interactionMode: "default",
            worktreePath: root,
            modelSelection: { instanceId: codex.instanceId, model: codex.models[0]!.slug },
          },
          runs: [
            {
              id: RunId.make("parent-run"),
              ordinal: 1,
              status: "running",
              rootNodeId: NodeId.make("parent-node"),
              providerInstanceId: codex.instanceId,
            },
          ],
          contextTransfers: [],
          subagents: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("managed-environment"),
          requestNamespace: "managed-caller",
          thread: {
            threadId,
            providerSessionId: "parent-session",
            providerInstanceId: codex.instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        let dispatches = 0;
        const transportDependencies = Layer.mergeAll(
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parent),
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
                throw new Error("Forbidden dispatch reached");
              }),
          }),
          Layer.mock(Providers.ProviderRegistry)({
            getProviders: Effect.succeed([codex, claude]),
            refreshInstance: () => Effect.succeed([codex, claude]),
          }),
          Layer.mock(Adapters.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([codex.instanceId, claude.instanceId]),
          }),
          Layer.mock(Projects.ProjectService)({}),
          Layer.mock(Secrets.SecretRequests)({}),
          Layer.mock(Scheduled.ScheduledTaskService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(GitVcs.GitVcsDriver)({}),
          Settings.layerTest(),
        );
        const experiments = yield* Experiments.ExperimentService;
        const forbidden = {
          instanceId: codex.instanceId,
          model: codex.models[0]!.slug,
          options: [{ id: "reasoning", value: "medium" }],
        };
        yield* experiments.create({
          id: "forbidden-reviewer",
          title: "Fixture only",
          question: "Guard",
          lever: "reviewer",
          primaryOutcome: "Guard holds",
          variants: ["a", "b"].map((id) => ({ id, label: id, modelSelection: forbidden })),
          eligibility: { projectIds: [], models: [], taskCategories: ["reviewer"] },
          maxAssignments: 10,
          endsAt: "2999-01-01T00:00:00Z",
          stopConditions: ["Guard failure"],
          codeRevision: "fixture",
          briefRevision: null,
        });
        yield* experiments.transition({ experimentId: "forbidden-reviewer", status: "running" });
        yield* Effect.gen(function* () {
          const mcp = yield* Mcp.OrchestratorMcpService;
          const input = {
            task: "Review a pinned mixed change",
            clientRequestId: "one-attempt",
            agentTask: request({
              role: "reviewer",
              taskClass: "mixed",
              workspacePath: root,
              sourceRevision: "source-pin",
            }),
          };
          for (let retry = 0; retry < 2; retry++) {
            const result = yield* mcp.delegateTask(scope, input).pipe(Effect.flip);
            expect(result.code).toBe("capability_denied");
          }
          expect(dispatches).toBe(0);
          const report = yield* experiments.report({ experimentId: "forbidden-reviewer" });
          expect(report.assignments).toHaveLength(1);
          const entry = report.assignments[0]!;
          expect(entry.assignment.assignedModelSelection).toEqual(forbidden);
          expect(entry.assignment.agentTask?.role).toBe("reviewer");
          expect(entry.assignment.agentTask?.taskClass).toBe("mixed");
          expect(entry.outcomes).toHaveLength(1);
          expect(entry.outcomes[0]?.kind).toBe("failure");
          expect(entry.outcomes[0]?.actualModelSelection).toBeNull();
          expect(entry.outcomes[0]?.note).toContain("selection");
        }).pipe(
          Effect.provide(Mcp.layer.pipe(Layer.provide(transportDependencies))),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
          ),
        );
      }),
  );
});
