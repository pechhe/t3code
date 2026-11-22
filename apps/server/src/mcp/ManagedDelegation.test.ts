import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Champions from "../champions/ChampionService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ContextRemoteDelegation from "../peer/RemoteDelegation.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DecisionRoutingError,
  OrchestratorMcpDelegateTaskInput,
  ProviderThreadId,
  type ChampionInvestigationBranchAttempt,
  type ChampionFinding,
  type CommandId,
} from "@t3tools/contracts";
import { derive as deriveIds } from "@t3tools/provider-core/server/IdAllocator";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentPolicyManifest as AgentPolicyManifestType,
  AgentPolicyManifest,
  EnvironmentId,
  ProjectId,
  ThreadId,
  RunId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type AgentTaskBinding,
  type DelegationStanceChoice,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Managed from "../agents/ManagedAgentService.ts";
import * as Shadow from "../agents/DelegationModelShadow.ts";
import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import { withRetiredFields } from "../agents/retiredRequestFields.ts";
import {
  snapshot,
  request,
  codex,
  claude,
  codexModel,
  claudeModel,
  changeReview,
  provider,
} from "../agents/agentPolicy.testkit.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as Processes from "../processRunner.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as Scheduled from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcs from "../vcs/GitVcsDriver.ts";
import * as Settings from "../serverSettings.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/** A full commit id the pinned-reader check also accepts, as the parent of an empty working copy. */
const publishedPin = "d".repeat(40);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(AgentPolicyManifest));
const encodeDelegateTaskFingerprint = Schema.encodeSync(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
);
const persistence = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const dependencies = Layer.mergeAll(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  persistence,
  Layer.succeed(Processes.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout: `source-pin ${publishedPin}\n`,
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

const unlistedCodex = provider("codex", codex.instanceId, [
  ...codex.models.map((model) => model.slug),
  "gpt-unlisted-test",
  "gpt-premium-test",
]);

/** A task that names no workspace, so the caller's own is used. */
const unnamed = (overrides: Parameters<typeof request>[0] = {}) => {
  const { workspacePath: _, ...task } = request(overrides);
  return task;
};

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
          yield* encodeManifest(policy.manifest),
        );
        for (const role of Object.values(policy.manifest.roles))
          yield* fs.writeFileString(`${root}/${role.brief}`, "Independent role brief\n");
        const threadId = ThreadId.make("managed-parent");
        const projectId = ProjectId.make("managed-project");
        const parent = {
          thread: {
            id: threadId,
            lineage: { parentThreadId: null, relationshipToParent: null },
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
            getProviders: Effect.succeed([unlistedCodex, claude]),
            refreshInstance: () => Effect.succeed([unlistedCodex, claude]),
          }),
          Layer.mock(Adapters.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([codex.instanceId, claude.instanceId]),
          }),
          Layer.mock(Projects.ProjectService)({}),
          Layer.mock(Secrets.SecretRequests)({}),
          Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
          Layer.mock(Scheduled.ScheduledTaskService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(GitVcs.GitVcsDriver)({}),
          Settings.layerTest(),
        );
        const experiments = yield* Experiments.ExperimentService;
        const forbidden = {
          instanceId: codex.instanceId,
          // A trial may move a job to any model the policy lists, but never to one it does not.
          model: "gpt-unlisted-test",
          options: [{ id: "reasoning", value: "medium" }],
        };
        yield* experiments.create({
          id: "forbidden-reviewer",
          title: "Fixture only",
          question: "Guard",
          lever: "reviewer",
          primaryOutcome: "Guard holds",
          variants: [
            { id: "a", label: "a", modelSelection: forbidden },
            {
              id: "b",
              label: "b",
              modelSelection: { ...forbidden, options: [{ id: "reasoning", value: "high" }] },
            },
          ],
          eligibility: {
            projectIds: [],
            models: [],
            taskCategories: ["review"],
            reviewScopes: ["change"],
          },
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
            target: { model: codexModel },
            agentTask: request({
              role: "reviewer",
              taskClass: "mixed",
              workspacePath: root,
              sourceRevision: "source-pin",
              review: changeReview,
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
          // The canonical role, not the legacy coarse kind, chooses the reviewer lever: a
          // chore-worker sent as role:"review" is not enrolled in the reviewer trial.
          yield* mcp
            .delegateTask(scope, {
              task: "Chore that mislabels itself as a review",
              role: "review",
              clientRequestId: "chore-attempt",
              agentTask: request({
                role: "implementer",
                taskClass: "non-ui",
                workId: "chore-work",
                workspacePath: root,
              }),
            })
            .pipe(Effect.exit);
          const after = yield* experiments.report({ experimentId: "forbidden-reviewer" });
          expect(after.assignments).toHaveLength(1);
          yield* experiments.transition({ experimentId: "forbidden-reviewer", status: "stopped" });
        }).pipe(
          Effect.provide(
            Mcp.layer.pipe(
              Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
              Layer.provide(transportDependencies),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
          ),
          Effect.provideService(HostProcess.Environment, { T3CODE_AGENT_POLICY_ROOT: root }),
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  /**
   * A codex lead in a jj workspace, with a captured dispatch and configurable occupants.
   * `register` adds registered projects in the foreign repository (`twin` a second one, in a
   * subdirectory of it); `scratch` makes the lead a No project chat in a plain folder.
   */
  const harness = (
    occupantsFor: (
      helper: string,
      where: {
        readonly projectId: string;
        readonly foreign: string;
        readonly foreignHelper: string;
      },
    ) => ReadonlyArray<OrchestrationV2ThreadShell> = () => [],
    bound = true,
    options: {
      /** The command is accepted, so the delegation counts as admitted; it still yields no child. */
      readonly accepts?: boolean;
      readonly champion?: boolean;
      /** The champion's check stays live, with no report and so no finding yet. */
      readonly liveCheck?: boolean;
      /** The tests share one database, so a champion that leaves a check behind needs its own. */
      readonly championId?: string;
      readonly register?: ReadonlyArray<"foreign" | "twin">;
      readonly scratch?: boolean;
      /** The lead holds the other project's isolated workspace as a live attachment. */
      readonly attached?: boolean;
      /** The lead's own model, with whatever options its thread carries. */
      readonly parent?: ModelSelection;
      readonly providers?: ReadonlyArray<ServerProvider>;
      /** The lead is itself a delegated task with this binding, such as a Spec lead. */
      readonly parentTask?: Partial<AgentTaskBinding>;
      readonly parentLineage?: {
        readonly parentThreadId: string | null;
        readonly relationshipToParent: "subagent" | "fork" | null;
      };
      readonly ancestors?: ReadonlyArray<{
        readonly id: string;
        readonly lineage: {
          readonly parentThreadId: string | null;
          readonly relationshipToParent: "subagent" | "fork" | null;
        };
      }>;
      readonly readOnlyCaller?: boolean;
      /** The stance someone chose for the lead's thread; Orchestrate when unset. */
      readonly parentStance?: DelegationStanceChoice;
      /** The repository Forge says a Forge item belongs to, when a lead names one. */
      readonly itemProject?: string | null;
      /** Each accepted command yields a running child task, so a delegation succeeds. */
      readonly children?: boolean;
      /** Edits the saved policy. */
      readonly policy?: (manifest: AgentPolicyManifestType) => AgentPolicyManifestType;
    } = {},
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "managed-workspace-test-" }),
      );
      const policyRoot = `${base}/policy`;
      const lead = `${base}/lead`;
      const helper = `${base}/helper`;
      yield* fs.makeDirectory(`${policyRoot}/roles`, { recursive: true });
      yield* fs.makeDirectory(`${lead}/.jj/repo`, { recursive: true });
      yield* fs.makeDirectory(`${helper}/.jj`, { recursive: true });
      yield* fs.writeFileString(`${helper}/.jj/repo`, `${lead}/.jj/repo`);
      // A workspace of a different repository, which no helper of this lead may use.
      const foreign = `${base}/foreign`;
      yield* fs.makeDirectory(`${foreign}/.jj/repo`, { recursive: true });
      yield* fs.makeDirectory(`${foreign}/packages/app`, { recursive: true });
      const foreignHelper = `${base}/foreign-helper`;
      yield* fs.makeDirectory(`${foreignHelper}/.jj`, { recursive: true });
      yield* fs.writeFileString(`${foreignHelper}/.jj/repo`, `${foreign}/.jj/repo`);
      // A No project chat's own folder, in no repository.
      const scratchRoot = `${base}/scratch`;
      const scratchFolder = `${scratchRoot}/chat`;
      yield* fs.makeDirectory(scratchFolder, { recursive: true });
      const policy = snapshot();
      yield* fs.writeFileString(
        `${policyRoot}/roles/policy.json`,
        yield* encodeManifest(options.policy?.(policy.manifest) ?? policy.manifest),
      );
      for (const role of Object.values(policy.manifest.roles))
        yield* fs.writeFileString(`${policyRoot}/${role.brief}`, "Role brief\n");
      const threadId = ThreadId.make("lead-thread");
      const projectId = ProjectId.make(options.scratch ? "scratch-project" : "lead-project");
      const projectRoots = new Map<string, string>([
        [projectId, options.scratch ? scratchRoot : lead],
        ...(options.register?.includes("foreign") ? [["foreign-project", foreign] as const] : []),
        ...(options.register?.includes("twin")
          ? [["twin-project", `${foreign}/packages/app`] as const]
          : []),
      ]);
      // Each project's Weave repository, so a Forge item's project can be compared with it.
      const projectRepositories = new Map<string, string>([
        [projectId, options.scratch ? "pechhe/scratch" : "pechhe/lead"],
        ...(options.register?.includes("foreign")
          ? [["foreign-project", "pechhe/foreign"] as const]
          : []),
        ...(options.register?.includes("twin")
          ? [["twin-project", "pechhe/foreign"] as const]
          : []),
      ]);
      let parent = {
        thread: {
          id: threadId,
          lineage: options.parentLineage ?? { parentThreadId: null, relationshipToParent: null },
          projectId,
          title: "Lead",
          runtimeMode: "full-access",
          interactionMode: "default",
          worktreePath: options.scratch ? scratchFolder : bound ? lead : null,
          ...(options.parentTask === undefined ? {} : { agentTask: options.parentTask }),
          // A lead that hands out writers orchestrates; Implement, the default, refuses them.
          stanceChoice: options.parentStance ?? { stance: "orchestrate", chosenBy: "owner" },
          modelSelection: options.parent ?? {
            instanceId: codex.instanceId,
            model: codex.models[0]!.slug,
          },
          ...(options.attached
            ? {
                workspaceAttachments: [
                  {
                    projectId: ProjectId.make("foreign-project"),
                    workspacePath: foreignHelper,
                    branch: null,
                    origin: "allocated",
                    attachedAt: "2026-10-19T09:00:00.000Z",
                    releasedAt: null,
                  },
                ],
              }
            : {}),
        },
        runs: [
          {
            id: RunId.make("lead-run"),
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make("lead-node"),
            providerInstanceId: codex.instanceId,
          },
        ],
        contextTransfers: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("managed-environment"),
        requestNamespace: "lead-caller",
        thread: {
          threadId,
          providerSessionId: "lead-session",
          providerInstanceId: codex.instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const catalog = options.providers ?? [codex, claude];
      const dispatched: Array<unknown> = [];
      const continued: Array<unknown> = [];
      // Whether each dispatch ran inside the managed workspace lock.
      const locked: Array<boolean> = [];
      let holding = 0;
      const managed = yield* Managed.ManagedAgentService;
      const counted = Managed.ManagedAgentService.of({
        ...managed,
        exclusive: (effect) =>
          managed.exclusive(
            Effect.acquireUseRelease(
              Effect.sync(() => holding++),
              () => effect,
              () => Effect.sync(() => holding--),
            ),
          ),
      });
      let championLaunched = false;
      // Set once a test marks a dispatched task accepted, so a retry of it replays instead.
      let accepted = false;
      const children = new Map<ThreadId, OrchestrationV2ThreadShell>();
      const childRecords = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      const listedOccupants = new Map<ThreadId, OrchestrationV2ThreadShell>();
      const transport = Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: (id) => Effect.succeed(childRecords.get(id) ?? parent),
          getThreadShell: (id) =>
            Effect.succeed(
              id === parent.thread.id && (!options.champion || championLaunched)
                ? (parent.thread as unknown as OrchestrationV2ThreadShell)
                : (children.get(id) ??
                    ((options.ancestors?.find((thread) => thread.id === id) ??
                      null) as OrchestrationV2ThreadShell | null)),
            ),
          sendToThread: (input) =>
            Effect.suspend(() => {
              continued.push(input);
              locked.push(holding > 0);
              return Effect.fail(new Error("captured followup") as never);
            }),
          getReceipt: () => Effect.succeedNone,
          hasReceipt: () => Effect.succeed(accepted),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          listProjectThreads: (input) =>
            Effect.sync(() => {
              const threads = occupantsFor(helper, {
                projectId: input.projectId ?? projectId,
                foreign,
                foreignHelper,
              });
              for (const thread of threads) listedOccupants.set(thread.id, thread);
              return threads;
            }),
          getShellSnapshot: (options) => {
            const threads = [...listedOccupants.values()].filter(
              (thread) => options?.threadIds?.includes(thread.id) ?? true,
            );
            return Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: options?.location === "archive" ? [] : threads,
              archivedThreads: [],
            });
          },
          dispatch: (command) =>
            Effect.suspend(() => {
              if (options.champion && command.type !== "delegated_task.request")
                return Effect.succeed({ sequence: 1, storedEvents: [] } as never);
              dispatched.push(command);
              locked.push(holding > 0);
              if (options.children === true) {
                const index = dispatched.length;
                const task = {
                  id: NodeId.make(`node:task:${index}`),
                  threadId: parent.thread.id,
                  runId: RunId.make("lead-run"),
                  parentNodeId: NodeId.make("lead-node"),
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: "codex",
                  providerInstanceId: (command as { modelSelection: ModelSelection }).modelSelection
                    .instanceId,
                  providerThreadId: null,
                  childThreadId: ThreadId.make(`child-${index}`),
                  nativeTaskRef: null,
                  prompt: "Review",
                  title: null,
                  model: (command as { modelSelection: ModelSelection }).modelSelection.model,
                  status: "running",
                  result: null,
                  startedAt: null,
                  completedAt: null,
                };
                childRecords.set(task.childThreadId, {
                  ...parent,
                  thread: { ...parent.thread, id: task.childThreadId },
                  runs: [],
                  messages: [],
                  nodes: [],
                  turnItems: [],
                  providerTurns: [],
                  contextTransfers: [],
                  subagents: [],
                  runtimeRequests: [],
                  providerThreads: [],
                } as unknown as OrchestrationV2ThreadProjection);
                parent = {
                  ...parent,
                  subagents: [...parent.subagents, task],
                } as unknown as OrchestrationV2ThreadProjection;
                return Effect.succeed({
                  sequence: index,
                  storedEvents: [
                    {
                      sequence: index,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never);
              }
              // Stop after capture: launching the child is the orchestrator's concern.
              if (options.accepts === true)
                return Effect.succeed({ sequence: 1, storedEvents: [] } as never);
              return Effect.fail(new Error("captured") as never);
            }),
        }),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.succeed(catalog),
          refreshInstance: () => Effect.succeed(catalog),
        }),
        Layer.mock(Adapters.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(catalog.map((provider) => provider.instanceId)),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.fromNullishOr(projectRoots.get(id)).pipe(
                Option.map(
                  (workspaceRoot) =>
                    ({
                      id,
                      workspaceRoot,
                      weaveRepositoryKey: projectRepositories.get(id) ?? null,
                      repositoryIdentity: null,
                    }) as never,
                ),
              ),
            ),
          listShells: () =>
            Effect.succeed(
              [...projectRoots].map(([id, workspaceRoot]) => ({ id, workspaceRoot }) as never),
            ),
        }),
        Layer.mock(Secrets.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(Scheduled.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              championLaunched = true;
              const providerThreadId = ProviderThreadId.make("champion-provider");
              parent = {
                ...parent,
                thread: {
                  ...parent.thread,
                  id: input.threadId!,
                  activeRunId: RunId.make("lead-run"),
                  activeProviderThreadId: providerThreadId,
                  archivedAt: null,
                  deletedAt: null,
                },
                runs: [
                  {
                    ...parent.runs[0]!,
                    userMessageId: input.initialMessage!.messageId!,
                    providerThreadId,
                    modelSelection: parent.thread.modelSelection,
                  },
                ],
                providerThreads: [
                  { id: providerThreadId, providerSessionId: "runtime:lead-session" },
                ],
              } as unknown as OrchestrationV2ThreadProjection;
              return { threadId: input.threadId!, projection: parent, resumed: false };
            }),
        }),
        Layer.mock(GitVcs.GitVcsDriver)({}),
        Settings.layerTest(),
      );
      let champion:
        | { service: Champions.ChampionService["Service"]; finding: ChampionFinding }
        | undefined;
      if (options.champion) {
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions.pipe(
          Effect.provide(McpProviderSessions.layer),
        );
        const service = yield* Champions.ChampionService.pipe(
          Effect.provide(
            Champions.layer.pipe(
              Layer.provide(transport),
              Layer.provide(Layer.succeed(McpProviderSessions.McpProviderSessions, mcpSessions)),
              Layer.provide(NodeCrypto.layer),
              Layer.provide(Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void })),
            ),
          ),
        );
        yield* service.setModels({
          advice: { model: { instanceId: claude.instanceId, model: "claude-fable-test" } },
          checks: { model: parent.thread.modelSelection },
        });
        const doc = yield* service.upsert({
          id: options.championId ?? "managed-champion",
          projectId,
          name: "Managed health",
          purpose: "Own improvements",
          schedule: { type: "interval", everyMs: 60000 },
          charter: {
            maxConcurrentRepairs: 1,
            maxRepairsPerDay: 3,
            instructions: "Use normal managed roles",
          },
        });
        scope = { ...scope, thread: { ...scope.thread!, threadId: doc.champion.ownerThreadId } };
        parent = { ...parent, thread: { ...parent.thread, id: doc.champion.ownerThreadId } };
        yield* service.changeMetrics({
          id: doc.champion.id,
          reason: "Measure health",
          metrics: [
            {
              id: "errors",
              name: "Errors",
              description: "",
              unit: "count",
              source: "fixture",
              context: "",
              direction: "lower",
              minimum: null,
              maximum: 0,
            },
          ],
        });
        yield* service.setLifecycle({ id: doc.champion.id, lifecycle: "active" });
        yield* service.runCheck({ id: doc.champion.id });
        yield* mcpSessions.set({
          environmentId: scope.environmentId,
          threadId: scope.thread!.threadId,
          providerSessionId: scope.thread!.providerSessionId,
          providerInstanceId: scope.thread!.providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: "Bearer fixture",
          browserToolsAvailable: false,
        });
        const frozenContext = yield* service.checkContext(scope.thread);
        if (options.liveCheck === true)
          champion = { service, finding: undefined as unknown as ChampionFinding };
        else {
          const report = yield* service.report(scope.thread, {
            samples: [
              {
                metricId: "errors",
                version: frozenContext.metrics[0]!.version,
                unit: "count",
                status: "measured",
                value: 1,
                observedAt: "1970-01-01T00:00:00Z",
                source: "fixture",
                evidence: "One observed error",
                revision: null,
              },
            ],
            findings: [],
            summary: "Own the finding",
          });
          champion = { service, finding: report.findings[0]! };
        }
      }
      const championSelections: Array<ModelSelection | undefined> = [];
      const championLayer =
        champion === undefined
          ? Layer.empty
          : Layer.succeed(
              Champions.ChampionService,
              Champions.ChampionService.of({
                ...champion.service,
                guardDelegation: (input) =>
                  champion.service
                    .guardDelegation(input)
                    .pipe(
                      Effect.tap((selection) =>
                        Effect.sync(() => championSelections.push(selection)),
                      ),
                    ),
              }),
            );
      const forgeWorkItems = Layer.mock(ForgeWorkItems.ForgeWorkItems)({
        // Forge names the item's repository; most tests have no item to read.
        projectOf: () => Effect.succeed(Option.fromNullishOr(options.itemProject)),
      });
      const delegate = (
        input: Parameters<Mcp.OrchestratorMcpService["Service"]["delegateTask"]>[1],
      ) =>
        Effect.gen(function* () {
          const mcp = yield* Mcp.OrchestratorMcpService;
          return yield* mcp
            .delegateTask(
              options.readOnlyCaller === true ? { ...scope, endpointKey: "reader" } : scope,
              input,
            )
            .pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            Mcp.layer.pipe(
              Layer.provide(forgeWorkItems),
              Layer.provide(transport),
              Layer.provide(championLayer),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
          ),
          Effect.provideService(Managed.ManagedAgentService, counted),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_AGENT_POLICY_ROOT: policyRoot,
          }),
        );
      const roles = (model?: string, providerInstanceId?: ProviderInstanceId) =>
        Effect.gen(function* () {
          const mcp = yield* Mcp.OrchestratorMcpService;
          return yield* mcp.agentRoles(scope, {
            taskClass: "non-ui",
            readOnly: true,
            sourceRevision: "source-pin",
            authorModel: codexModel,
            ...(model === undefined ? {} : { model }),
            ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
          });
        }).pipe(
          Effect.provide(
            Mcp.layer.pipe(
              Layer.provide(forgeWorkItems),
              Layer.provide(transport),
              Layer.provide(championLayer),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
          ),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_AGENT_POLICY_ROOT: policyRoot,
          }),
        );
      return {
        champion,
        championSelections,
        completeBranch: (attempt: ChampionInvestigationBranchAttempt, foreign = false) => {
          const shell = {
            ...parent.thread,
            id: attempt.childThreadId,
            agentTask: attempt.binding,
            modelSelection: attempt.resolvedSelection,
            activeRunId: null,
            worktreePath: attempt.workspacePath,
            ...(foreign ? { projectId: ProjectId.make("foreign-project") } : {}),
          } as unknown as OrchestrationV2ThreadShell;
          children.set(shell.id, shell);
          childRecords.set(shell.id, {
            ...parent,
            thread: shell,
            runs: [
              {
                id: RunId.make(`run:${attempt.id}`),
                ordinal: 1,
                status: "completed",
                delegatedTaskId: attempt.taskId,
                userMessageId: attempt.messageId,
                modelSelection: attempt.resolvedSelection,
                providerInstanceId: attempt.resolvedSelection.instanceId,
                completedAt: "2026-11-05T12:00:00.000Z",
              },
            ],
            messages: [],
            nodes: [],
            turnItems: [],
            providerTurns: [],
            contextTransfers: [],
            subagents: [],
            runtimeRequests: [],
            providerThreads: [],
          } as unknown as OrchestrationV2ThreadProjection);
          parent = {
            ...parent,
            subagents: [
              ...parent.subagents.filter((t) => t.id !== attempt.taskId),
              {
                id: attempt.taskId,
                threadId: parent.thread.id,
                origin: "app_owned",
                childThreadId: shell.id,
                status: "completed",
                result: "Branch evidence",
                runId: RunId.make(`run:${attempt.id}`),
                prompt: "Investigate the hypothesis read-only",
                createdAt: "2026-11-05T12:00:00.000Z",
              } as unknown as OrchestrationV2ThreadProjection["subagents"][number],
            ],
          };
        },
        scope,
        addOpenSpecLead: (workId: string) => {
          const id = ThreadId.make(`open-spec-lead:${workId}`);
          childRecords.set(id, {
            thread: {
              id,
              lineage: { parentThreadId: null, relationshipToParent: null },
              agentTask: { role: "lead", workId },
            },
          } as never);
          parent = {
            ...parent,
            subagents: [
              ...parent.subagents,
              {
                id: NodeId.make(`node:open-spec-lead:${workId}`),
                origin: "app_owned",
                childThreadId: id,
                status: "running",
                result: null,
              } as (typeof parent.subagents)[number],
            ],
          };
        },
        /** The task the last dispatch created is now accepted, bound with `binding`. */
        acceptDispatchedTask: (binding: AgentTaskBinding) => {
          const command = dispatched[dispatched.length - 1] as {
            readonly commandId: CommandId;
            readonly agentTask: AgentTaskBinding;
          };
          const taskId = deriveIds.delegatedTaskNode({ commandId: command.commandId });
          const threadId = deriveIds.delegatedTaskThread({ commandId: command.commandId });
          accepted = true;
          childRecords.set(threadId, {
            thread: { ...parent.thread, id: threadId, agentTask: binding },
            runs: [],
            messages: [],
            nodes: [],
            turnItems: [],
            providerTurns: [],
            providerThreads: [],
            contextTransfers: [],
            subagents: [],
            runtimeRequests: [],
          } as unknown as OrchestrationV2ThreadProjection);
          parent = {
            ...parent,
            subagents: [
              ...parent.subagents,
              {
                id: taskId,
                threadId: parent.thread.id,
                origin: "app_owned",
                childThreadId: threadId,
                status: "running",
                result: null,
              } as unknown as OrchestrationV2ThreadProjection["subagents"][number],
            ],
          };
        },
        addChild: (finding: ChampionFinding, role: string) => {
          const id = ThreadId.make(`champion-child:${role}`);
          children.set(id, {
            id,
            projectId,
            agentTask: { workId: finding.workId, attemptId: finding.attemptId, role },
          } as OrchestrationV2ThreadShell);
          parent = {
            ...parent,
            subagents: [
              ...parent.subagents,
              {
                origin: "app_owned",
                childThreadId: id,
                status: "completed",
                result: "Challenge completed",
              } as (typeof parent.subagents)[number],
            ],
          };
        },
        lead,
        helper,
        foreign,
        foreignHelper,
        scratchFolder,
        base,
        policyRoot,
        delegate,
        roles,
        dispatched,
        continued,
        locked,
      };
    });

  it.effect(
    "discovers and dispatches a fresh explicit author-model review with truthful evidence",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const reviewer = (result: Effect.Success<ReturnType<typeof h.roles>>) =>
          result.roles.find((entry) => entry.role === "reviewer")!;
        expect(reviewer(yield* h.roles()).selection).toBeNull();
        expect(reviewer(yield* h.roles()).refusal).toContain("choose a model");
        const explicit = reviewer(yield* h.roles(codexModel));
        expect(explicit.refusal).toBeNull();
        expect(explicit.selection?.model).toBe(codexModel);
        const review = request({
          role: "reviewer",
          workspacePath: h.lead,
          readOnly: true,
          sourceRevision: "source-pin",
          review: changeReview,
          authorModel: codexModel,
        });
        // A failed first dispatch does not change the author's identity or grant
        // a wider pool for the next, independently requested review.
        yield* h.delegate({
          task: "Review the pinned candidate",
          clientRequestId: "review-sonnet",
          agentTask: review,
          target: { model: claudeModel },
        });
        yield* h.delegate({
          task: "Review the pinned candidate",
          clientRequestId: "review-sol",
          agentTask: { ...review, attemptId: "same-model-attempt" },
          target: { model: codexModel },
        });
        expect(h.dispatched).toHaveLength(2);
        const commands = h.dispatched as Array<{
          type: string;
          commandId: string;
          agentTask: AgentTaskBinding;
          modelSelection: ModelSelection;
          task: string;
        }>;
        expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
        expect(commands[1]).toMatchObject({
          type: "delegated_task.request",
          modelSelection: explicit.selection,
          agentTask: {
            role: "reviewer",
            authorModel: codexModel,
            sourceRevision: "source-pin",
            sourceAccess: "read-only",
            toolProfile: "source-reader",
            requested: explicit.selection,
            assigned: null,
            effective: explicit.selection,
          },
        });
        expect(commands[1]!.task.trim().split(/\n+/)).toEqual([
          "Role brief",
          "Review the pinned candidate",
        ]);
        for (const [index, invalid] of [
          { target: { model: "gpt-astra-test" } },
          { agentTask: { ...review, sourceRevision: "wrong-pin" } },
          { agentTask: { ...review, workspacePath: h.foreign } },
          { target: { model: codexModel, options: [{ id: "reasoning", value: "high" }] } },
        ].entries()) {
          expect(
            (yield* h.delegate({
              task: "Review the pinned candidate",
              clientRequestId: `refused-${index}`,
              agentTask: review,
              target: { model: codexModel },
              ...invalid,
            })).code,
          ).toBe("capability_denied");
        }
        expect(h.dispatched).toHaveLength(2);
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect(
    "dispatches read-only work from an unbound thread at its project root but refuses writers",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(() => [], false);
        expect(
          (yield* h.delegate({
            task: "Read package metadata",
            clientRequestId: "root-reader",
            agentTask: unnamed({ readOnly: true }),
            target: { model: codexModel },
          })).code,
        ).toBe("orchestration_error");
        expect(h.dispatched).toHaveLength(1);
        const command = h.dispatched[0] as {
          agentTask: { workspacePath: string; sourceAccess: string };
        };
        expect(command.agentTask.workspacePath).toBe(h.lead);
        expect(command.agentTask.sourceAccess).toBe("read-only");
        expect(
          (yield* h.delegate({
            task: "Change package metadata",
            clientRequestId: "root-writer",
            agentTask: request({ workspacePath: h.lead }),
          })).code,
        ).toBe("capability_denied");
        expect(h.dispatched).toHaveLength(1);
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect("hands the shadow pick the role's eligible list and the model the agent chose", () => {
    const observed: Array<{ observation: Shadow.ShadowObservation; offered: string[] }> = [];
    return Effect.gen(function* () {
      const h = yield* harness(() => [], false, { accepts: true });
      yield* h.delegate({
        task: "Read package metadata",
        clientRequestId: "shadow-reader",
        agentTask: request({ workspacePath: h.lead, readOnly: true }),
        target: { model: codexModel },
      });
      const command = h.dispatched[0] as { modelSelection: ModelSelection };
      expect(observed).toHaveLength(1);
      expect(observed[0]!.observation).toMatchObject({
        role: "implementer",
        chosenModel: command.modelSelection.model,
        reassigned: false,
      });
      expect(observed[0]!.offered).toContain(command.modelSelection.model);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}),
          Layer.mock(Shadow.DelegationModelShadow)({
            // Reads the list as the real recorder would, inside the delegation's own context.
            observe: (observation) =>
              observation.eligible.pipe(
                Effect.map((models) => models.map((entry) => entry.model)),
                Effect.tap((offered) =>
                  Effect.sync(() => void observed.push({ observation, offered })),
                ),
                Effect.ignore,
              ),
          }),
        ),
      ),
    );
  });

  it.effect("observes nothing for a delegation that was not admitted", () => {
    const observed: Array<Shadow.ShadowObservation> = [];
    return Effect.gen(function* () {
      const h = yield* harness(() => [], false);
      yield* h.delegate({
        task: "Read package metadata",
        clientRequestId: "shadow-refused",
        agentTask: request({ workspacePath: h.lead, readOnly: true }),
        target: { model: codexModel },
      });
      expect(h.dispatched).toHaveLength(1);
      expect(observed).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}),
          Layer.mock(Shadow.DelegationModelShadow)({
            observe: (observation) => Effect.sync(() => void observed.push(observation)),
          }),
        ),
      ),
    );
  });

  it.effect.each(["unreachable", "timeout", "rate-limited"] as const)(
    "prepares and starts a delegation identically when the decision provider is %s",
    (code) =>
      Effect.gen(function* () {
        const start = (clientRequestId: string) =>
          Effect.gen(function* () {
            const h = yield* harness(() => [], false, { accepts: true });
            const result = yield* h.delegate({
              task: "Read package metadata",
              clientRequestId,
              agentTask: request({ workspacePath: h.lead, readOnly: true }),
              target: { model: codexModel },
            });
            // A workspace path feeds the request fingerprint, so only that hash differs between runs.
            return JSON.stringify([result.code, h.dispatched])
              .replaceAll(h.lead, "LEAD")
              .replace(/[0-9a-f]{64}/g, "HASH");
          });
        const without = yield* start(`shadow-identical-${code}`);
        const done = yield* Deferred.make<void>();
        let asked = 0;
        // The real recorder, forked as in production, signalling once its row is written.
        const recorder = Layer.effect(
          Shadow.DelegationModelShadow,
          Effect.gen(function* () {
            const real = yield* Shadow.DelegationModelShadow;
            return Shadow.DelegationModelShadow.of({
              ...real,
              observe: (observation) =>
                real
                  .record(observation)
                  .pipe(
                    Effect.ensuring(Deferred.succeed(done, undefined)),
                    Effect.forkDetach,
                    Effect.asVoid,
                  ),
            });
          }),
        ).pipe(
          Layer.provide(
            Shadow.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  Layer.mock(DecisionRouter.DecisionRouter)({
                    decide: () =>
                      Effect.suspend(() => {
                        asked++;
                        return Effect.fail(new DecisionRoutingError({ provider: "jev", code }));
                      }),
                  }),
                  Settings.ServerSettingsService.layerTest({ delegation: { modelShadow: true } }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        );
        const withShadow = yield* Effect.gen(function* () {
          yield* runMigrations();
          const started = yield* start(`shadow-identical-${code}`);
          yield* Deferred.await(done);
          const rows = yield* (yield* SqlClient.SqlClient)<{
            status: string;
            error_code: string;
            pick_model: string | null;
          }>`SELECT status, error_code, pick_model FROM delegation_model_shadow WHERE error_code = ${code}`;
          // The provider was asked and its failure recorded, with no pick.
          expect(asked).toBe(1);
          expect(rows).toEqual([{ status: "failed", error_code: code, pick_model: null }]);
          return started;
        }).pipe(Effect.provide(recorder));
        expect(withShadow).toBe(without);
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect(
    "requires a managed role where a policy is configured, allowing offPolicyReason only as an explicit fallback",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(() => [], true, {
          providers: [unlistedCodex, claude],
          policy: (manifest) => ({
            ...manifest,
            models: {
              ...manifest.models,
              premium: { driverKind: codex.driver, model: "gpt-premium-test", listedOnly: true },
            },
          }),
        });
        const raw = { task: "Do something", clientRequestId: "raw-1" };
        const refusal = yield* h.delegate(raw);
        expect(refusal.code).toBe("invalid_request");
        expect(refusal.message).toContain("agent_roles");
        expect(refusal.message).toContain("agentTask");
        expect(h.dispatched).toHaveLength(0);

        // Managed task with an off-list model is refused without offPolicyReason,
        // and offPolicyReason with agentTask requires target.model.
        expect(
          (yield* h.delegate({
            ...raw,
            clientRequestId: "off-list-no-reason",
            agentTask: request({ workspacePath: h.lead }),
            target: { model: "gpt-unlisted-test" },
          })).code,
        ).toBe("capability_denied");
        expect(
          (yield* h.delegate({
            ...raw,
            clientRequestId: "managed-reason-no-model",
            offPolicyReason: "Prefer another model",
            agentTask: request({ workspacePath: h.lead }),
          })).code,
        ).toBe("invalid_request");
        expect(h.dispatched).toHaveLength(0);

        // Managed task with off-list target.model + offPolicyReason keeps the role binding.
        const offListReason = "User explicitly requested gpt-unlisted-test for this task.";
        yield* h.delegate({
          ...raw,
          clientRequestId: "off-list-with-reason",
          offPolicyReason: offListReason,
          agentTask: request({ workspacePath: h.lead }),
          target: { model: "gpt-unlisted-test" },
        });
        expect(h.dispatched).toHaveLength(1);
        expect((h.dispatched[0] as { modelSelection: ModelSelection }).modelSelection.model).toBe(
          "gpt-unlisted-test",
        );
        expect(
          (h.dispatched[0] as { agentTask?: AgentTaskBinding }).agentTask?.offPolicyReason,
        ).toBe(offListReason);

        // A model the policy keeps to its lists is never an off-list fallback, managed or not.
        const listedOnlyReason = "Every listed model is unavailable.";
        const managedPremium = yield* h.delegate({
          ...raw,
          clientRequestId: "off-list-listed-only",
          offPolicyReason: listedOnlyReason,
          agentTask: request({ workspacePath: h.lead }),
          target: { model: "gpt-premium-test" },
        });
        expect(managedPremium.code).toBe("capability_denied");
        expect(managedPremium.message).toContain("never uses this model off a list");
        expect(
          (yield* h.delegate({
            ...raw,
            clientRequestId: "raw-listed-only",
            offPolicyReason: listedOnlyReason,
            target: { model: "gpt-premium-test" },
          })).code,
        ).toBe("capability_denied");
        // Nor through a linked environment, whose plain thread launch has no policy to ask.
        expect(
          (yield* h.delegate({
            ...raw,
            clientRequestId: "remote-listed-only",
            offPolicyReason: listedOnlyReason,
            target: { model: "gpt-premium-test", environmentId: EnvironmentId.make("linked-box") },
          })).code,
        ).toBe("capability_denied");
        expect(h.dispatched).toHaveLength(1);

        // Unmanaged fallback succeeds when offPolicyReason explains why no role fits.
        yield* h.delegate({
          ...raw,
          clientRequestId: "raw-with-reason",
          offPolicyReason: "No canonical role fits a spike.",
        });
        expect(h.dispatched).toHaveLength(2);

        // A named but unreadable policy still refuses bare unmanaged requests without offPolicyReason.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${h.policyRoot}/roles/policy.json`);
        expect((yield* h.delegate({ ...raw, clientRequestId: "raw-2" })).code).toBe(
          "invalid_request",
        );
        // An unreadable policy cannot say which models it keeps to its lists, so none starts off-list.
        expect(
          (yield* h.delegate({
            ...raw,
            clientRequestId: "raw-unreadable-off-list",
            offPolicyReason: "No canonical role fits a spike.",
            target: { model: "gpt-unlisted-test" },
          })).code,
        ).toBe("capability_denied");
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect("dispatches a Spec review to one independent reviewer", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, {
        providers: [codex, claude],
      });
      const review = request({
        role: "reviewer",
        workspacePath: h.lead,
        readOnly: true,
        sourceRevision: "source-pin",
        authorModel: codexModel,
        review: {
          scope: "spec",
          baseRevision: "base-commit",
          includedChanges: ["reviewed-commit"],
          coverage: "complete",
          specRef: "#1",
          specRevision: "3",
        },
      });
      const sat = yield* h.delegate({
        task: "Review the Spec",
        clientRequestId: "one-reviewer",
        agentTask: review,
        target: { model: claudeModel },
      });
      expect(sat.code).toBe("orchestration_error");
      expect(h.dispatched).toHaveLength(1);
      const dispatched = h.dispatched[0] as { agentTask: { review: object } };
      expect(dispatched.agentTask.review).not.toHaveProperty("councilSeat");
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect(
    "dispatches a role on the lead's own instance and model with exactly the role's options",
    () =>
      Effect.gen(function* () {
        const lead = {
          instanceId: claude.instanceId,
          model: claudeModel,
          options: [
            { id: "effort", value: "medium" },
            { id: "fastMode", value: false },
          ],
        };
        const alternate = provider("claudeAgent", "claude-alternate", [claudeModel]);
        const h = yield* harness(() => [], true, {
          parent: lead,
          providers: [codex, claude, alternate],
        });
        const review = request({
          role: "reviewer",
          workspacePath: h.lead,
          readOnly: true,
          sourceRevision: "source-pin",
          authorModel: codexModel,
          review: {
            scope: "spec",
            baseRevision: "base-commit",
            includedChanges: ["reviewed-commit"],
            coverage: "complete",
            specRef: "#1",
            specRevision: "3",
          },
        });
        const discovered = (yield* h.roles(claudeModel)).roles.find(
          (entry) => entry.role === "reviewer",
        )!;
        const own = {
          instanceId: claude.instanceId,
          model: claudeModel,
          pinned: true,
          options: [{ id: "effort", value: "medium" }],
        };
        expect(discovered.selection).toEqual(own);
        for (const [index, target] of [
          undefined,
          { providerInstanceId: claude.instanceId },
          { options: [{ id: "effort", value: "medium" }] },
        ].entries()) {
          const omitted = yield* h.delegate({
            task: "Review the Spec",
            clientRequestId: `own-omitted-${index}`,
            agentTask: review,
            ...(target === undefined ? {} : { target }),
          });
          expect(omitted.code).toBe("capability_denied");
          expect(omitted.message).toContain("choose a model");
          expect(h.dispatched).toHaveLength(0);
        }
        const attempts = [
          {
            label: "role options",
            target: { model: claudeModel, options: [{ id: "effort", value: "medium" }] },
          },
          { label: "empty options", target: { model: claudeModel, options: [] } },
          {
            label: "options accompany model",
            target: { model: claudeModel, options: [{ id: "effort", value: "medium" }] },
          },
        ];
        for (const [index, attempt] of attempts.entries()) {
          const result = yield* h.delegate({
            task: "Review the Spec",
            clientRequestId: `own-${index}`,
            agentTask: review,
            ...(attempt.target === undefined ? {} : { target: attempt.target }),
          });
          expect(result.code, attempt.label).toBe("orchestration_error");
          expect(h.dispatched, attempt.label).toHaveLength(index + 1);
          expect(h.dispatched[index], attempt.label).toMatchObject({
            modelSelection: own,
            agentTask: { requested: own, effective: own },
          });
        }
        // An explicitly chosen eligible account keeps the same complete selection.
        yield* h.delegate({
          task: "Review the Spec",
          clientRequestId: "alternate",
          agentTask: review,
          target: { providerInstanceId: alternate.instanceId, model: claudeModel },
        });
        expect(h.dispatched[3]).toMatchObject({
          modelSelection: { ...own, instanceId: alternate.instanceId },
        });
        // A genuinely unsupported option is refused by name and value, with the correction.
        for (const [index, [option, stated]] of [
          [{ id: "fastMode", value: true }, "fastMode=true"],
          [{ id: "effort", value: "high" }, "effort=high"],
        ].entries()) {
          const refused = yield* h.delegate({
            task: "Review the Spec",
            clientRequestId: `unsupported-${index}`,
            agentTask: review,
            target: { model: claudeModel, options: [option as never] },
          });
          expect(refused.code).toBe("capability_denied");
          expect(refused.message).toContain(`option ${stated}`);
          expect(refused.message).toContain("which is effort=medium");
        }
        expect(h.dispatched).toHaveLength(4);
        // Naming only an account: discovery and dispatch read it the same way.
        const named = (yield* h.roles(claudeModel, alternate.instanceId)).roles.find(
          (entry) => entry.role === "reviewer",
        )!;
        expect(named.selection).toEqual({ ...own, instanceId: alternate.instanceId });
        yield* h.delegate({
          task: "Review the Spec",
          clientRequestId: "account-only",
          agentTask: review,
          target: { providerInstanceId: alternate.instanceId, model: claudeModel },
        });
        expect(h.dispatched[4]).toMatchObject({ modelSelection: named.selection });
        // Echoing the lead's own fastMode=false is inherited, not chosen: it is dropped and the
        // role starts with exactly its own options.
        yield* h.delegate({
          task: "Review the Spec",
          clientRequestId: "echoed-inherited",
          agentTask: review,
          target: { model: claudeModel, options: [{ id: "fastMode", value: false }] },
        });
        expect(h.dispatched[5]).toMatchObject({
          modelSelection: own,
          agentTask: { requested: own, effective: own },
        });
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect("refuses with the current state when an account changed since discovery", () =>
    Effect.gen(function* () {
      const lead = { instanceId: claude.instanceId, model: claudeModel };
      const gone = { ...claude, installed: false };
      const h = yield* harness(() => [], true, { parent: lead, providers: [codex, gone] });
      const refused = yield* h.delegate({
        task: "Review the Spec",
        clientRequestId: "changed",
        agentTask: request({ role: "advisor", workspacePath: h.lead, readOnly: true }),
        target: { providerInstanceId: claude.instanceId, model: "claude-fable-test" },
      });
      expect(refused.code).toBe("capability_denied");
      expect(refused.message).toContain(
        `claude-fable-test on ${claude.instanceId}: provider-not-installed`,
      );
      expect(h.dispatched).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect(
    "champion advice uses its explicit stronger selection through managed policy, and its Spec lead requests normal isolated allocation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(undefined, false, { champion: true });
        const { service, finding } = h.champion!;
        const advice = {
          task: "Challenge this larger improvement",
          clientRequestId: "champion-advice",
          agentTask: request({
            role: "advisor",
            workId: finding.workId,
            attemptId: finding.attemptId,
            workspacePath: h.lead,
            readOnly: true,
            sourceRevision: "source-pin",
          }),
        };
        const refused = yield* h.delegate({
          ...advice,
          target: { providerInstanceId: codex.instanceId, model: codexModel },
        });
        expect(refused.code).toBe("capability_denied");
        expect(h.dispatched).toHaveLength(0);
        yield* h.delegate(advice);
        expect(h.dispatched).toHaveLength(1);
        const advisory = h.dispatched[0] as {
          modelSelection: ModelSelection;
          agentTask: AgentTaskBinding;
        };
        expect(advisory.modelSelection).toMatchObject({
          instanceId: claude.instanceId,
          model: "claude-fable-test",
        });
        expect(advisory.agentTask.role).toBe("advisor");
        h.addChild(finding, "advisor");
        yield* service.updateDelivery(h.scope.thread, {
          findingId: finding.id,
          action: "diagnosis",
          diagnosis: "The cause spans two services.",
          route: "spec",
          evidence: "More than one bounded repair",
        });
        yield* service.updateDelivery(h.scope.thread, {
          findingId: finding.id,
          action: "spec",
          specUrl: "forge://9",
          evidence: "Advisor challenged and owner shaped the Spec",
        });
        const leadFailure = yield* h.delegate({
          task: "Run shaped Spec 9",
          clientRequestId: "champion-spec",
          target: { model: codexModel },
          forgeItem: 9,
          agentTask: request({
            role: "lead",
            taskClass: "mixed",
            workId: finding.workId,
            attemptId: finding.attemptId,
            workspacePath: h.lead,
          }),
        });
        expect(h.dispatched, leadFailure.message).toHaveLength(2);
        const lead = h.dispatched[1] as { workspaceStrategy: unknown; agentTask: AgentTaskBinding };
        expect(lead.agentTask.role).toBe("lead");
        expect(lead.workspaceStrategy).toEqual({ type: "worktree", baseRef: "HEAD", forgeItem: 9 });
      }).pipe(Effect.provide(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
  );

  it.effect("answers a second start of the same Spec with the Spec lead already open", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.addOpenSpecLead("T3-9");
      const again = (workId: string) =>
        h.delegate({
          task: "Run T3-9",
          clientRequestId: `again-${workId}`,
          target: { model: codexModel },
          forgeItem: 9,
          agentTask: request({
            role: "lead",
            taskClass: "mixed",
            workspacePath: h.lead,
            workId,
          }),
        });
      yield* again("T3-9");
      expect(h.dispatched).toHaveLength(0);
      yield* again("T3-10");
      expect(h.dispatched).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
  );

  it.effect("starts a Spec lead in its Forge item's workspace, and lets it delegate leaves", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const specLead = (
        role: "lead" | "implementer",
        extra: { readonly forgeItem?: number; readonly workspaceAssignment?: "isolated" } = {},
      ) => ({
        task: "Run T3-9",
        clientRequestId: `spec-${role}-${extra.forgeItem ?? "none"}-${extra.workspaceAssignment ?? ""}`,
        target: { model: codexModel },
        agentTask: request({
          role,
          taskClass: "mixed",
          workspacePath: h.lead,
          workId: `T3-9-${role}`,
          ...(extra.workspaceAssignment === undefined
            ? {}
            : { workspaceAssignment: extra.workspaceAssignment }),
        }),
        ...(extra.forgeItem === undefined ? {} : { forgeItem: extra.forgeItem }),
      });
      expect((yield* h.delegate(specLead("lead"))).code).toBe("invalid_request");
      // forgeItem hands a whole Spec only to the writing role.
      const scoutWithItem = {
        task: "Map the importer",
        clientRequestId: "scout-with-item",
        agentTask: request({ role: "scout", workspacePath: h.lead }),
        forgeItem: 9,
      };
      expect((yield* h.delegate(scoutWithItem)).code).toBe("invalid_request");
      // A Spec owner works in the Spec's own workspace, however it is asked for.
      for (const role of ["lead", "implementer"] as const)
        expect(
          (yield* h.delegate(specLead(role, { forgeItem: 9, workspaceAssignment: "isolated" })))
            .code,
        ).toBe("invalid_request");
      expect(h.dispatched).toHaveLength(0);
      // `implementer` with forgeItem starts the same Spec owner `lead` does; `lead` still works.
      yield* h.delegate(specLead("lead", { forgeItem: 9 }));
      yield* h.delegate(specLead("implementer", { forgeItem: 9 }));
      expect(h.dispatched).toHaveLength(2);
      for (const dispatched of h.dispatched) {
        const command = dispatched as {
          workspaceStrategy?: unknown;
          title?: string;
          agentTask?: { role: string; workspaceAssignment?: string };
        };
        expect(command.agentTask?.role).toBe("lead");
        expect(command.title).toBe("Spec lead · Run T3-9");
        expect(command.workspaceStrategy).toEqual({
          type: "worktree",
          baseRef: "HEAD",
          forgeItem: 9,
        });
      }
      const binding = (command: unknown) => {
        const {
          workId: _workId,
          requestFingerprint: _fingerprint,
          ...rest
        } = (command as { agentTask: AgentTaskBinding }).agentTask;
        return rest;
      };
      expect(binding(h.dispatched[1])).toEqual(binding(h.dispatched[0]));
      // agent_roles offers the one writing role; a Spec owner's model still comes from its `lead` row.
      const offered = (yield* h.roles()).roles.map((entry) => entry.role);
      expect(offered).toContain("implementer");
      expect(offered).not.toContain("lead");

      // Only a top-level thread hands out a whole Spec: a delegated task builds it or hands out a piece.
      for (const parentTask of [{ role: "lead" }, { role: "implementer" }] as const) {
        const nested = yield* harness(undefined, true, {
          parentTask,
          parentLineage: { parentThreadId: "top-level", relationshipToParent: "subagent" },
          ancestors: [
            { id: "top-level", lineage: { parentThreadId: null, relationshipToParent: null } },
          ],
        });
        const refused = yield* nested.delegate({
          ...specLead("implementer", { forgeItem: 9 }),
          agentTask: request({ taskClass: "mixed", workspacePath: nested.lead, workId: "T3-9" }),
        });
        expect(refused.code).toBe("capability_denied");
        expect(refused.message).toContain("top-level");
        expect(nested.dispatched).toHaveLength(0);
      }

      // A Spec lead delegates its own leaves.
      const child = yield* harness(undefined, true, { parentTask: { role: "lead" } });
      yield* child.delegate({
        task: "Implement the importer",
        clientRequestId: "lead-worker",
        target: { model: codexModel },
        agentTask: request({ workspacePath: child.lead }),
      });
      expect(child.dispatched).toHaveLength(1);
      const leaf = yield* harness(undefined, true, {
        parentTask: { role: "implementer" },
      });
      const leafAttempt = yield* leaf.delegate({
        task: "Implement the importer",
        clientRequestId: "leaf-worker",
        target: { model: codexModel },
        agentTask: request({ workspacePath: leaf.lead }),
      });
      expect(leafAttempt.code).not.toBe("capability_denied");

      // Two delegations below a top-level thread: refused with what to do, counted from lineage.
      const deepWorker = { task: "Implement", clientRequestId: "deep-worker" };
      const twoDeep = {
        parentTask: { role: "implementer" },
        parentLineage: { parentThreadId: "spec-lead", relationshipToParent: "subagent" },
        ancestors: [
          {
            id: "spec-lead",
            lineage: { parentThreadId: "top-level", relationshipToParent: "subagent" },
          },
          { id: "top-level", lineage: { parentThreadId: null, relationshipToParent: null } },
        ],
      } as const;
      const atLimit = yield* harness(undefined, true, twoDeep);
      const refused = yield* atLimit.delegate({
        ...deepWorker,
        agentTask: request({ workspacePath: atLimit.lead }),
      });
      expect(refused.code).toBe("capability_denied");
      expect(refused.message).toContain("delegation limit");
      // Sending it to a linked environment is refused here too, before any remote route.
      const remote = yield* atLimit.delegate({
        ...deepWorker,
        clientRequestId: "deep-worker-remote",
        target: { environmentId: EnvironmentId.make("linked") },
        agentTask: request({ workspacePath: atLimit.lead }),
      });
      expect(remote.message).toContain("delegation limit");
      // A fork sits at its source's depth, so it can't reset the count.
      const forked = yield* harness(undefined, true, {
        ...twoDeep,
        parentLineage: { parentThreadId: "worker", relationshipToParent: "fork" },
        ancestors: [{ id: "worker", lineage: twoDeep.parentLineage }, ...twoDeep.ancestors],
      });
      expect(
        (yield* forked.delegate({
          ...deepWorker,
          agentTask: request({ workspacePath: forked.lead }),
        })).message,
      ).toContain("delegation limit");
      // A lineage it can't read is refused rather than counted as shallow.
      const unknown = yield* harness(undefined, true, {
        ...twoDeep,
        ancestors: [],
      });
      expect(
        (yield* unknown.delegate({
          ...deepWorker,
          agentTask: request({ workspacePath: unknown.lead }),
        })).code,
      ).toBe("orchestration_error");

      // A read-only agent starts only read-only roles, and nothing on a linked environment.
      const reader = yield* harness(undefined, true, {
        parentTask: { role: "reviewer", sourceAccess: "read-only" },
        readOnlyCaller: true,
      });
      for (const attempt of [
        { ...deepWorker, agentTask: request({ workspacePath: reader.lead }) },
        { task: "Raw", clientRequestId: "raw-reader" },
        {
          ...deepWorker,
          target: { environmentId: EnvironmentId.make("linked") },
          agentTask: request({ role: "scout", workspacePath: reader.lead, readOnly: true }),
        },
      ]) {
        const denied = yield* reader.delegate(attempt);
        expect(denied.code).toBe("capability_denied");
        expect(denied.message).toContain("read-only");
      }
      const scout = yield* reader.delegate({
        task: "Find it",
        clientRequestId: "reader-scout",
        agentTask: request({ role: "scout", workspacePath: reader.lead }),
      });
      expect(scout.message ?? "").not.toContain("read-only agent");

      // A thread on Implement starts no writing role, read-only request or not, and still starts a reader.
      const implementing = yield* harness(undefined, true, {
        parentStance: { stance: "implement", chosenBy: "owner" },
      });
      for (const readOnly of [false, true]) {
        const denied = yield* implementing.delegate({
          task: "Implement",
          clientRequestId: `implement-writer-${readOnly}`,
          target: { model: codexModel },
          agentTask: request({
            workspacePath: implementing.lead,
            ...(readOnly ? { readOnly } : {}),
          }),
        });
        expect(denied.code).toBe("capability_denied");
        expect(denied.message).toContain("Delegation stance is implement");
      }
      expect(implementing.dispatched).toHaveLength(0);
      const implementScout = yield* implementing.delegate({
        task: "Find it",
        clientRequestId: "implement-scout",
        agentTask: request({ role: "scout", workspacePath: implementing.lead }),
      });
      expect(implementScout.message ?? "").not.toContain("Delegation stance");
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );
  it.effect("launches an isolated helper in its own workspace and refuses a second writer", () =>
    Effect.gen(function* () {
      const isolatedTask = (path: string, workId = "importer") => ({
        task: "Implement the importer",
        clientRequestId: `isolated-${workId}`,
        agentTask: request({ workspacePath: path, workspaceAssignment: "isolated", workId }),
        target: { model: codexModel },
      });
      const h = yield* harness();
      yield* h.delegate(isolatedTask(h.helper));
      const command = h.dispatched[0] as { agentTask?: { workspacePath: string } };
      expect(command.agentTask?.workspacePath).toBe(h.helper);
      // The lead's own checkout is not an isolated workspace.
      expect((yield* h.delegate(isolatedTask(h.lead, "lead-path"))).code).toBe("capability_denied");
      // Nor is a default: an isolated task names the workspace allocated for it.
      const unallocated = yield* h.delegate({
        ...isolatedTask(h.helper, "unallocated"),
        agentTask: unnamed({ workspaceAssignment: "isolated", workId: "unallocated" }),
      });
      expect(unallocated.message).toContain("pass it as agentTask.workspacePath");
      // A Spec lead is never isolated, which its own refusal says.
      const isolatedLead = yield* h.delegate({
        ...isolatedTask(h.helper, "isolated-lead"),
        forgeItem: 7,
        agentTask: unnamed({ workspaceAssignment: "isolated", workId: "isolated-lead" }),
      });
      expect(isolatedLead.message).toContain("omit workspaceAssignment");
      // A T3-created worktree would not be the workspace the binding validated.
      const worktree = yield* h.delegate({
        ...isolatedTask(h.helper, "t3-worktree"),
        isolation: "worktree",
      });
      expect(worktree.code).toBe("invalid_request");
      expect(h.dispatched).toHaveLength(1);
      // Another thread is already writing in the helper workspace; a reader is fine.
      const occupant = (sourceAccess: "scoped-write" | "read-only") => (helper: string) => [
        {
          id: "sibling-helper",
          lineage: {
            rootThreadId: "lead-thread",
            parentThreadId: null,
            relationshipToParent: null,
          },
          worktreePath: helper,
          status: "running",
          agentTask: { workId: "someone-else", sourceAccess },
        } as unknown as OrchestrationV2ThreadShell,
      ];
      const contested = yield* harness(occupant("scoped-write"));
      expect((yield* contested.delegate(isolatedTask(contested.helper))).code).toBe(
        "capability_denied",
      );
      expect(contested.dispatched).toHaveLength(0);
      const shared = yield* harness(occupant("read-only"));
      expect((yield* shared.delegate(isolatedTask(shared.helper))).code).toBe("capability_denied");
      const reading = yield* harness(occupant("read-only"));
      yield* reading.delegate({
        ...isolatedTask(reading.helper, "review"),
        agentTask: request({
          role: "reviewer",
          workId: "review",
          workspacePath: reading.helper,
          workspaceAssignment: "isolated",
          sourceRevision: "source-pin",
          review: changeReview,
        }),
      });
      expect(reading.dispatched).toHaveLength(1);
      // A pinned reviewer sent to another workspace without the isolated assignment is
      // checked against the writers there too.
      const pinnedReview = (helper: string) => ({
        ...isolatedTask(helper, "pinned-review"),
        agentTask: request({
          role: "reviewer",
          workId: "pinned-review",
          workspacePath: helper,
          sourceRevision: "source-pin",
          review: changeReview,
        }),
      });
      const written = yield* harness(occupant("scoped-write"));
      expect((yield* written.delegate(pinnedReview(written.helper))).code).toBe(
        "capability_denied",
      );
      expect(written.dispatched).toHaveLength(0);
      const read = yield* harness(occupant("read-only"));
      yield* read.delegate(pinnedReview(read.helper));
      expect(read.dispatched).toHaveLength(1);
      // Both launch under the lock that keeps the occupancy they checked true; work in the
      // lead's own checkout needs no lock.
      const free = yield* harness();
      yield* free.delegate(isolatedTask(free.helper));
      yield* free.delegate({
        task: "Implement the exporter",
        clientRequestId: "lead-exporter",
        agentTask: request({ workspacePath: free.lead, workId: "exporter" }),
        target: { model: codexModel },
      });
      expect([...read.locked, ...free.locked]).toEqual([true, true, false]);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );
  it.effect("stops a caller that goes away while it waits for the isolated launch lock", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const managed = yield* Managed.ManagedAgentService;
      const release = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        managed.exclusive(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(held);
      const caller = yield* Effect.forkChild(
        h.delegate({
          task: "Implement the importer",
          clientRequestId: "interrupted-while-queued",
          agentTask: request({
            workspacePath: h.helper,
            workspaceAssignment: "isolated",
            workId: "importer",
          }),
          target: { model: codexModel },
        }),
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      // The lock is still held, so the caller is queued behind it and must still be stoppable.
      const stopped = yield* Fiber.interrupt(caller).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(2));
      expect(Option.isSome(yield* Fiber.join(stopped))).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(h.dispatched).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("keeps a retry that names no workspace on its task after the checkout moved", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const delegated = {
        task: "Read the importer",
        clientRequestId: "unnamed-retry",
        agentTask: unnamed({ workId: "unnamed-retry", readOnly: true }),
        target: { model: codexModel },
      };
      yield* h.delegate(delegated);
      const first = h.dispatched[0] as { commandId: CommandId; agentTask: AgentTaskBinding };
      expect(first.agentTask.workspacePath).toBe(h.lead);
      // The fingerprint is the caller's own text, without the path the server filled in.
      const text = encodeDelegateTaskFingerprint({
        ...delegated,
        mode: undefined,
        timeoutMs: undefined,
      });
      expect(first.agentTask.requestFingerprint).toBe(
        Hex.encode(
          yield* (yield* Digest.Digest).digest(
            Digest.sha256,
            new TextEncoder().encode(withRetiredFields(text)[0]!),
          ),
        ),
      );
      h.acceptDispatchedTask({ ...first.agentTask, workspacePath: "/moved/checkout" });
      const retry = yield* h.delegate(delegated).pipe(Effect.flip);
      expect(h.dispatched).toHaveLength(1);
      expect(retry).toMatchObject({
        taskId: deriveIds.delegatedTaskNode({ commandId: first.commandId }),
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("sends a linked task without resolving a project only that environment has", () => {
    const sent: Array<unknown> = [];
    return Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.delegate({
        task: "Read it there",
        clientRequestId: "linked-unnamed",
        target: { environmentId: EnvironmentId.make("linked") },
        agentTask: unnamed({
          role: "scout",
          readOnly: true,
          projectId: ProjectId.make("project-only-there"),
        }),
      });
      expect(result.message).toBe("reached the link");
      expect(sent).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Layer.mock(ContextRemoteDelegation.RemoteDelegation)({
          delegate: (_scope, input) => {
            sent.push(input);
            return Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "reached the link",
              }),
            );
          },
        }),
      ),
    );
  });

  it.effect(
    "matches a managed task fingerprinted while the retired demanding flag was recorded",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const delegated = {
          task: "Implement the importer",
          clientRequestId: "demanding-retry",
          agentTask: request({ workspacePath: h.lead }),
          target: { model: codexModel },
        };
        yield* h.delegate(delegated);
        const first = h.dispatched[0] as { commandId: CommandId; agentTask: AgentTaskBinding };
        // A task bound before `demanding` was retired kept the fingerprint of text that still held
        // the flag, which a retry now decodes away before the service hashes it.
        const fingerprintText = encodeDelegateTaskFingerprint({
          ...delegated,
          mode: undefined,
          timeoutMs: undefined,
        });
        const saved = Hex.encode(
          yield* (yield* Digest.Digest).digest(
            Digest.sha256,
            new TextEncoder().encode(withRetiredFields(fingerprintText)[1]!),
          ),
        );
        h.acceptDispatchedTask({ ...first.agentTask, requestFingerprint: saved });
        const retry = yield* h.delegate(delegated).pipe(Effect.flip);
        expect(h.dispatched).toHaveLength(1);
        expect(retry).toMatchObject({
          taskId: deriveIds.delegatedTaskNode({ commandId: first.commandId }),
          agentTask: { requestFingerprint: saved },
        });
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );
  it.effect(
    "sends pinned readers and isolated writers to another registered project, never a sharing writer",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(() => [], true, { register: ["foreign"] });
        const commands = h.dispatched as Array<{
          agentTask: AgentTaskBinding;
        }>;
        const scout = (workspacePath: string, attemptId = "scout") => ({
          task: "Map the foreign code",
          clientRequestId: `foreign-${attemptId}`,
          agentTask: request({
            role: "advisor",
            attemptId,
            workspacePath,
            readOnly: true,
            sourceRevision: "source-pin",
          }),
          target: { model: "claude-fable-test" },
        });
        yield* h.delegate(scout(h.foreign));
        expect(commands[0]?.agentTask).toMatchObject({
          workspacePath: h.foreign,
          projectId: "foreign-project",
        });
        // An isolated writer works in its own workspace of that repository and hands back.
        yield* h.delegate({
          task: "Implement it there",
          clientRequestId: "foreign-isolated",
          agentTask: request({
            workId: "foreign-work",
            workspacePath: h.foreignHelper,
            workspaceAssignment: "isolated",
          }),
          target: { model: codexModel },
        });
        expect(commands[1]?.agentTask).toMatchObject({
          workspacePath: h.foreignHelper,
          projectId: "foreign-project",
          sourceAccess: "scoped-write",
        });
        // Both claimed their workspace under the occupancy lock.
        expect(h.locked).toEqual([true, true]);
        // The lead holds no workspace there for a writer to share, and the project's main
        // checkout is never an isolated workspace.
        const sharing = yield* h.delegate({
          task: "Write in the foreign checkout",
          clientRequestId: "foreign-sharing",
          agentTask: request({ workId: "sharing", workspacePath: h.foreign }),
          target: { model: codexModel },
        });
        expect(sharing.code).toBe("capability_denied");
        expect(sharing.message).toContain("no workspace of its own in that project");
        expect(
          (yield* h.delegate({
            task: "Write in the foreign main checkout",
            clientRequestId: "foreign-root-isolated",
            agentTask: request({
              workId: "root-isolated",
              workspacePath: h.foreign,
              workspaceAssignment: "isolated",
            }),
            target: { model: codexModel },
          })).code,
        ).toBe("capability_denied");
        // Naming a project that is not registered is refused.
        expect(
          (yield* h.delegate({
            ...scout(h.foreign, "unknown-project"),
            agentTask: {
              ...scout(h.foreign, "unknown-project").agentTask,
              projectId: ProjectId.make("missing-project"),
            },
          })).message,
        ).toContain("is not registered");
        expect(h.dispatched).toHaveLength(2);
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect(
    "runs a Spec lead as a child in its Forge item's workspace of another registered project",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(() => [], true, {
          register: ["foreign"],
          itemProject: "pechhe/foreign",
        });
        const commands = h.dispatched as Array<{
          type: string;
          parentThreadId: ThreadId;
          agentTask: AgentTaskBinding;
          workspaceStrategy?: unknown;
        }>;
        yield* h.delegate({
          task: "Run YS-9",
          clientRequestId: "foreign-spec-lead",
          target: { model: codexModel },
          forgeItem: 9,
          // The caller holds no checkout there, so it names a path in that project; the launch
          // replaces it with the item's own workspace.
          agentTask: request({
            role: "lead",
            taskClass: "mixed",
            workId: "YS-9",
            workspacePath: h.foreign,
          }),
        });
        expect(commands).toHaveLength(1);
        // Still the calling thread's child, belonging to the other project.
        expect(commands[0]?.type).toBe("delegated_task.request");
        expect(commands[0]?.parentThreadId).toBe(h.scope.thread?.threadId);
        expect(commands[0]?.agentTask).toMatchObject({
          role: "lead",
          workspacePath: h.foreign,
          projectId: "foreign-project",
        });
        expect(commands[0]?.workspaceStrategy).toEqual({
          type: "worktree",
          baseRef: "HEAD",
          forgeItem: 9,
        });
        // The allocation claimed the item's workspace under the lock.
        expect(h.locked).toEqual([true]);
        // The lead exception is theirs alone: a writer of the calling project is still refused.
        const sharing = yield* h.delegate({
          task: "Write in the foreign checkout",
          clientRequestId: "foreign-worker",
          agentTask: request({ workId: "foreign-worker", workspacePath: h.foreign }),
        });
        expect(sharing.message).toContain("no workspace of its own in that project");
        // A lead still names a checkout of the project it runs in, not one of another.
        const elsewhere = yield* h.delegate({
          task: "Run YS-10",
          clientRequestId: "foreign-spec-lead-elsewhere",
          forgeItem: 10,
          agentTask: {
            ...request({
              role: "lead",
              taskClass: "mixed",
              workId: "YS-10",
              workspacePath: h.lead,
            }),
            projectId: ProjectId.make("foreign-project"),
          },
        });
        expect(elsewhere.message).toContain("is not a checkout of the project's repository");
        expect(commands).toHaveLength(1);
        // The item names its own project: another one is refused before anything is launched.
        const mismatched = yield* harness(() => [], true, {
          register: ["foreign"],
          itemProject: "pechhe/elsewhere",
        });
        const misplaced = yield* mismatched.delegate({
          task: "Run YS-11",
          clientRequestId: "foreign-spec-lead-mismatch",
          forgeItem: 11,
          agentTask: request({
            role: "lead",
            taskClass: "mixed",
            workId: "YS-11",
            workspacePath: mismatched.foreign,
          }),
        });
        expect(misplaced.message).toContain("belongs to pechhe/elsewhere");
        expect(misplaced.message).toContain("runs in its item's own project");
        expect(mismatched.dispatched).toHaveLength(0);
        expect(mismatched.locked).toEqual([]);
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
      ),
  );

  it.effect("starts a same-project Spec lead in its own repository's workspace, unlocked", () =>
    Effect.gen(function* () {
      const h = yield* harness(undefined, true, { itemProject: "pechhe/lead" });
      yield* h.delegate({
        task: "Run T3-9",
        clientRequestId: "spec-lead-own-project",
        target: { model: codexModel },
        forgeItem: 9,
        agentTask: request({
          role: "lead",
          taskClass: "mixed",
          workId: "T3-9",
          workspacePath: h.lead,
        }),
      });
      const command = h.dispatched[0] as {
        agentTask: AgentTaskBinding;
        workspaceStrategy?: unknown;
      };
      expect(command.agentTask).toMatchObject({
        role: "lead",
        workspacePath: h.lead,
      });
      expect(command.agentTask.projectId).toBeUndefined();
      expect(command.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "HEAD",
        forgeItem: 9,
      });
      expect(h.locked).toEqual([false]);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("asks which project when several are registered in the target repository", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign", "twin"] });
      const scout = (projectId?: string) => ({
        task: "Map the foreign code",
        clientRequestId: `twin-${projectId ?? "inferred"}`,
        target: { model: "claude-fable-test" },
        agentTask: request({
          role: "advisor",
          attemptId: projectId ?? "inferred",
          workspacePath: h.foreign,
          readOnly: true,
          sourceRevision: "source-pin",
          ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
        }),
      });
      const ambiguous = yield* h.delegate(scout());
      expect(ambiguous.code).toBe("capability_denied");
      expect(ambiguous.message).toContain("pass agentTask.projectId");
      yield* h.delegate(scout("foreign-project"));
      expect(h.dispatched).toHaveLength(1);
      expect((h.dispatched[0] as { agentTask: AgentTaskBinding }).agentTask.projectId).toBe(
        "foreign-project",
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("lets a No project chat delegate into a registered project and its own folder", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign"], scratch: true });
      const commands = h.dispatched as Array<{ agentTask: AgentTaskBinding }>;
      yield* h.delegate({
        task: "Challenge the Spec",
        clientRequestId: "scratch-advisor",
        target: { model: "claude-fable-test" },
        agentTask: request({
          role: "advisor",
          workspacePath: h.foreign,
          readOnly: true,
          sourceRevision: "source-pin",
        }),
      });
      expect(commands[0]?.agentTask).toMatchObject({ projectId: "foreign-project" });
      // Work that needs no repository runs in the chat's own folder.
      yield* h.delegate({
        task: "Advise on the approach",
        clientRequestId: "scratch-folder-advisor",
        target: { model: "claude-fable-test" },
        agentTask: unnamed({ role: "advisor", workId: "folder-advice", readOnly: true }),
      });
      expect(commands[1]?.agentTask.workspacePath).toBe(h.scratchFolder);
      expect(commands[1]?.agentTask.projectId).toBeUndefined();
      // A writer sharing a checkout needs the chat to hold a workspace there.
      expect(
        (yield* h.delegate({
          task: "Write in the foreign checkout",
          clientRequestId: "scratch-writer",
          agentTask: request({ workId: "scratch-writer", workspacePath: h.foreign }),
        })).message,
      ).toContain("no workspace of its own in that project");
      expect(h.dispatched).toHaveLength(2);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );
  it.effect("checks another project's workspaces for writers of every project there", () =>
    Effect.gen(function* () {
      const writer = (projectId: string, worktreePath: string | null) =>
        ({
          id: `writer-in-${projectId}`,
          projectId,
          lineage: { rootThreadId: "other-lead", parentThreadId: null, relationshipToParent: null },
          worktreePath,
          status: "running",
          agentTask: { workId: "other-work", sourceAccess: "scoped-write" },
        }) as unknown as OrchestrationV2ThreadShell;
      // A live writer in the other project's main checkout keeps a pinned reader out of it.
      const root = yield* harness(
        (_, where) =>
          where.projectId === "foreign-project" ? [writer(where.projectId, where.foreign)] : [],
        true,
        { register: ["foreign"] },
      );
      const rootReader = {
        task: "Read the foreign main checkout",
        clientRequestId: "foreign-root-reader",
        agentTask: request({
          role: "advisor",
          workspacePath: root.foreign,
          readOnly: true,
          sourceRevision: "source-pin",
        }),
      };
      expect((yield* root.delegate(rootReader)).message).toContain("another thread is working in");
      // So does a writer working there unbound, as an ordinary thread at the project root does.
      const unbound = yield* harness(
        (_, where) =>
          where.projectId === "foreign-project" ? [writer(where.projectId, null)] : [],
        true,
        { register: ["foreign"] },
      );
      expect(
        (yield* unbound.delegate({
          ...rootReader,
          agentTask: { ...rootReader.agentTask, workspacePath: unbound.foreign },
        })).message,
      ).toContain("another thread is working in");
      // A writer registered under a second project of the same repository still occupies
      // its workspace when the task names the first project.
      const twin = yield* harness(
        (_, where) =>
          where.projectId === "twin-project" ? [writer(where.projectId, where.foreignHelper)] : [],
        true,
        { register: ["foreign", "twin"] },
      );
      const helper = yield* twin.delegate({
        task: "Implement it there",
        clientRequestId: "twin-occupied",
        agentTask: request({
          workId: "foreign-work",
          workspacePath: twin.foreignHelper,
          workspaceAssignment: "isolated",
          projectId: ProjectId.make("foreign-project"),
        }),
      });
      expect(helper.message).toContain("another thread is working in");
      expect([...root.dispatched, ...unbound.dispatched, ...twin.dispatched]).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("treats a workspace the lead attached in another project as its own checkout", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign"], attached: true });
      const commands = h.dispatched as Array<{ agentTask: AgentTaskBinding }>;
      // A writer shares the attached workspace, which names its project.
      yield* h.delegate({
        task: "Write in the attached workspace",
        clientRequestId: "attached-sharing",
        target: { model: codexModel },
        agentTask: request({ workId: "attached-work", workspacePath: h.foreignHelper }),
      });
      expect(commands[0]?.agentTask).toMatchObject({
        workspacePath: h.foreignHelper,
        projectId: "foreign-project",
        sourceAccess: "scoped-write",
      });
      // Only the attached workspace is the lead's there, not the project's main checkout.
      const elsewhere = yield* h.delegate({
        task: "Write in the foreign main checkout",
        clientRequestId: "attached-root-sharing",
        agentTask: request({ workId: "attached-root", workspacePath: h.foreign }),
      });
      expect(elsewhere.message).toContain(`must use ${h.foreignHelper}`);
      expect(h.dispatched).toHaveLength(1);
      // Naming only the project, a task works in the lead's workspace there.
      yield* h.delegate({
        task: "Read in the attached workspace",
        clientRequestId: "attached-default",
        target: { model: codexModel },
        agentTask: unnamed({
          workId: "attached-default",
          projectId: ProjectId.make("foreign-project"),
          readOnly: true,
        }),
      });
      expect(commands[1]?.agentTask.workspacePath).toBe(h.foreignHelper);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );

  it.effect("keeps helpers out of a workspace another lead holds as a live attachment", () =>
    Effect.gen(function* () {
      const holder = (helper: string, where: { readonly projectId: string }) =>
        where.projectId === "lead-project"
          ? [
              {
                id: "other-lead",
                projectId: "lead-project",
                lineage: {
                  rootThreadId: "other-lead",
                  parentThreadId: null,
                  relationshipToParent: null,
                },
                worktreePath: null,
                status: "running",
                workspaceAttachments: [
                  {
                    projectId: "foreign-project",
                    workspacePath: helper,
                    branch: null,
                    origin: "allocated",
                    attachedAt: "2026-10-19T09:00:00.000Z",
                    releasedAt: null,
                  },
                ],
              } as unknown as OrchestrationV2ThreadShell,
            ]
          : [];
      const h = yield* harness((_, where) => holder(where.foreignHelper, where), true, {
        register: ["foreign"],
      });
      const refused = yield* h.delegate({
        task: "Implement it there",
        clientRequestId: "attached-occupied",
        agentTask: request({
          workId: "foreign-work",
          workspacePath: h.foreignHelper,
          workspaceAssignment: "isolated",
        }),
      });
      expect(refused.message).toContain("another thread is working in");
      expect(h.dispatched).toHaveLength(0);
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
    ),
  );
  it.effect(
    "admits an owner's first audit on its live check through managed validation and final admission, then a different-model reviewer",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(undefined, true, {
          champion: true,
          liveCheck: true,
          championId: "managed-audit",
        });
        const { service } = h.champion!;
        const owner = h.scope.thread!;
        const checkId = (yield* service.checkContext(owner)).checkId;
        const measurements = () =>
          service.runtimeState({ id: "managed-audit" }).pipe(Effect.map((s) => s.measurements!));
        const start = (over: Record<string, unknown>) =>
          service.startMeasurementFromOwner(owner, {
            id: "managed-audit",
            checkId,
            measurementId: "ui-browser",
            role: "browser",
            sourceRevision: publishedPin,
            metrics: [{ metricId: "errors", version: 1 }],
            observedRuntime: "combined preview",
            ...over,
          } as never);
        const plan = yield* start({});
        const audit = {
          task: "Audit the sampled screens read-only",
          clientRequestId: "audit-browser",
          agentTask: request({
            role: "browser",
            taskClass: "ui",
            workId: plan.workId,
            attemptId: plan.attemptId,
            workspacePath: h.lead,
            readOnly: true,
            sourceRevision: publishedPin,
          }),
        };
        // The owner's own path never reaches the post-repair gate, so there is no finding to wait for.
        expect((yield* service.get({ id: "managed-audit" })).findings).toHaveLength(0);
        // A pin other than the plan's, or one the checkout is not at, dispatches nothing.
        for (const [index, wrong] of ["e".repeat(40), "source-pin"].entries()) {
          expect(
            (yield* h.delegate({
              ...audit,
              clientRequestId: `wrong-pin-${index}`,
              agentTask: { ...audit.agentTask, sourceRevision: wrong },
            })).code,
          ).toBe("capability_denied");
        }
        expect(h.dispatched).toHaveLength(0);
        expect((yield* measurements())[0]!.admission).toBeNull();
        const admittedAudit = yield* h.delegate(audit);
        expect(h.dispatched, admittedAudit.message).toHaveLength(1);
        const first = (yield* measurements())[0]!;
        expect(first.state).toBe("unknown");
        expect(first.admission!.binding).toMatchObject({
          role: "browser",
          sourceRevision: publishedPin,
          sourceAccess: "read-only",
          executionBoundary: "read-only",
          readOnly: true,
        });
        expect(first.observedRuntime).toBe("combined preview");
        // A retry is the same admission: one entry, the recorded binding, nothing charged again.
        yield* h.delegate(audit);
        const replayed = yield* measurements();
        expect(replayed).toHaveLength(1);
        expect(replayed[0]!.admission!.admittedAt).toBe(first.admission!.admittedAt);
        expect(h.dispatched[1]).toMatchObject({
          modelSelection: first.admission!.resolvedSelection,
        });
        // A reviewer waits for the browser audit to complete.
        const reviewBody = {
          measurementId: "ui-review",
          role: "reviewer",
          browserMeasurementId: "ui-browser",
        };
        expect(yield* Effect.flip(start(reviewBody))).toMatchObject({ reason: "conflict" });
        h.completeBranch({
          ...first.admission!,
          id: first.measurementId,
        } as unknown as ChampionInvestigationBranchAttempt);
        const review = yield* start(reviewBody);
        const confirm = {
          task: "Confirm the audit against the same source",
          clientRequestId: "audit-review",
          agentTask: request({
            role: "reviewer",
            workId: review.workId,
            attemptId: review.attemptId,
            workspacePath: h.lead,
            readOnly: true,
            sourceRevision: publishedPin,
            review: changeReview,
          }),
        };
        yield* h.delegate(confirm);
        expect(h.dispatched).toHaveLength(3);
        const settled = yield* measurements();
        const browser = settled.find((m) => m.measurementId === "ui-browser")!;
        const reviewer = settled.find((m) => m.measurementId === "ui-review")!;
        expect(browser.state).toBe("completed");
        expect(reviewer.admission!.binding.sourceRevision).toBe(browser.sourceRevision);
        expect(reviewer.admission!.resolvedSelection.model).not.toBe(
          browser.admission!.resolvedSelection.model,
        );
        // Both entries count as admitted attempts; a third audit still fits the two-running bound.
        const third = yield* start({ measurementId: "ui-third" });
        yield* h.delegate({
          ...audit,
          clientRequestId: "audit-third",
          agentTask: { ...audit.agentTask, workId: third.workId, attemptId: third.attemptId },
        });
        expect(h.dispatched).toHaveLength(4);
        // The report closes the check: nothing more is planned or admitted for it.
        const late = yield* start({ measurementId: "ui-late" });
        yield* service.report(owner, {
          samples: [
            {
              metricId: "errors",
              version: 1,
              unit: "count",
              status: "measured",
              value: 0,
              observedAt: "1970-01-01T00:00:00Z",
              source: "fixture",
              evidence: "Audited screens show no errors",
              revision: null,
            },
          ],
          findings: [],
          summary: "Reported",
        });
        expect(
          (yield* h.delegate({
            ...audit,
            clientRequestId: "audit-late",
            agentTask: { ...audit.agentTask, workId: late.workId, attemptId: late.attemptId },
          })).code,
        ).toBe("capability_denied");
        expect(h.dispatched).toHaveLength(4);
        expect(yield* Effect.flip(start({ measurementId: "ui-after" }))).toMatchObject({
          reason: "unauthorized",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}),
            Settings.layerTest({
              enableAgentBrowserAccess: true,
              agentBrowserBackends: { enabled: ["integrated"], default: "integrated" },
            }),
          ),
        ),
      ),
  );
  it.effect(
    "admits Champion investigations only after resolved managed validation, freezes unknown replay and keeps refusal free",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(undefined, true, { champion: true, register: ["foreign"] });
        const { service, finding } = h.champion!;
        const receipt = yield* service.learningQuery({
          id: "managed-champion",
          topic: "errors",
          observations: [],
        });
        const investigation = yield* service.startInvestigation({
          id: "managed-champion",
          findingId: finding.id,
          investigationId: "managed-investigation",
          question: "Compare collectors",
          topic: "errors",
          retrievalReceiptId: receipt.receiptId,
          alternatives: [
            {
              id: "a",
              role: "advisor",
              hypothesis: "Structured logs",
              evidenceNeeds: "Error samples",
            },
            {
              id: "b",
              role: "advisor",
              hypothesis: "Runtime counters",
              evidenceNeeds: "Counter samples",
            },
          ],
        });
        const branch = investigation.branches[0]!;
        const input = {
          task: "Investigate the hypothesis read-only",
          clientRequestId: "investigation-a",
          agentTask: request({
            role: "advisor",
            workId: branch.workId,
            attemptId: branch.attemptId,
            readOnly: true,
            sourceRevision: "source-pin",
            workspacePath: h.lead,
          }),
        };
        yield* h.delegate({
          ...input,
          clientRequestId: "foreign-investigation",
          agentTask: { ...input.agentTask, workspacePath: h.foreignHelper },
        });
        expect(h.dispatched).toHaveLength(0);
        expect(
          (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!.attempts,
        ).toHaveLength(0);
        const admitted = yield* h.delegate(input);
        expect(h.dispatched, admitted.message).toHaveLength(1);
        expect(h.locked).toEqual([true]);
        const first = (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!
          .attempts[0]!;
        expect(first.state).toBe("unknown");
        expect(first.binding.executionBoundary).toBe("read-only");
        const fs = yield* FileSystem.FileSystem;
        const policy = snapshot().manifest;
        yield* fs.writeFileString(
          `${h.policyRoot}/roles/policy.json`,
          yield* encodeManifest({
            ...policy,
            lists: {
              ...policy.lists,
              advisor: [
                { model: "sol", effort: "medium" },
                { model: "fable", effort: "medium" },
                { model: "astra", effort: "medium" },
              ],
            },
            roles: { ...policy.roles, advisor: { ...policy.roles.advisor!, callers: {} } },
          }),
        );
        const replayResult = yield* h.delegate(input);
        expect(h.dispatched, replayResult.message).toHaveLength(2);
        const replay = (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!
          .attempts;
        expect(replay).toHaveLength(1);
        expect(replay[0]!.admittedAt).toBe(first.admittedAt);
        expect(replay[0]!.binding.policyHash).toBe(first.binding.policyHash);
        expect(h.dispatched[1]).toMatchObject({ modelSelection: first.resolvedSelection });
        h.completeBranch(first);
        const followup = {
          task: "Compare one more sample",
          clientRequestId: "investigation-followup",
          followup: {
            taskId: first.taskId,
            sourceRevision: "source-pin",
            changes: "More samples available",
          },
        };
        const continued = yield* h.delegate(followup);
        expect(h.continued, continued.message).toHaveLength(1);
        expect(h.championSelections.at(-1)).toEqual(first.resolvedSelection);
        const charged = (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!
          .attempts;
        expect(charged).toHaveLength(2);
        const followupAttempt = charged.find(
          (a) => a.clientRequestId === followup.clientRequestId,
        )!;
        expect(followupAttempt.followup).toBe(true);
        expect(followupAttempt.binding.effective).toEqual(first.binding.effective);
        const repeated = yield* h.delegate(followup);
        expect(h.continued, repeated.message).toHaveLength(2);
        expect(
          (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!.attempts,
        ).toHaveLength(2);
        h.completeBranch(first, true);
        yield* h.delegate({ ...followup, clientRequestId: "foreign-child-followup" });
        expect(h.continued).toHaveLength(2);
        h.completeBranch(first);
        yield* fs.writeFileString(
          `${h.policyRoot}/roles/policy.json`,
          yield* encodeManifest({
            ...policy,
            lists: { ...policy.lists, advisor: [{ model: "sol", effort: "medium" }] },
            roles: { ...policy.roles, advisor: { ...policy.roles.advisor!, callers: {} } },
          }),
        );
        yield* h.delegate({ ...followup, clientRequestId: "revoked-followup" });
        expect(h.continued).toHaveLength(2);
        expect(
          (yield* service.runtimeState({ id: "managed-champion" })).investigations[0]!.attempts,
        ).toHaveLength(2);
        const nextBranch = investigation.branches[1]!;
        yield* h.delegate({
          ...input,
          clientRequestId: "new-policy-branch",
          agentTask: {
            ...input.agentTask,
            workId: nextBranch.workId,
            attemptId: nextBranch.attemptId,
          },
        });
        expect(h.dispatched).toHaveLength(3);
        const fresh = (yield* service.runtimeState({
          id: "managed-champion",
        })).investigations[0]!.attempts.find((a) => a.clientRequestId === "new-policy-branch")!;
        expect(fresh.resolvedSelection.model).toBe(codexModel);
        expect(fresh.resolvedSelection).not.toEqual(first.resolvedSelection);
      }).pipe(Effect.provide(Layer.mock(ContextRemoteDelegation.RemoteDelegation)({}))),
  );
});
