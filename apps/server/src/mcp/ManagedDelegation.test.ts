import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentPolicyManifest,
  EnvironmentId,
  ProjectId,
  ThreadId,
  RunId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type AgentTaskBinding,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Managed from "../agents/ManagedAgentService.ts";
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

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(AgentPolicyManifest));
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
          yield* encodeManifest(policy.manifest),
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
          Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
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
            agentTask: request({
              role: "ticket-reviewer",
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
          expect(entry.assignment.agentTask?.role).toBe("ticket-reviewer");
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
                role: "chore-worker",
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
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
          ),
        );
      }),
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
      readonly register?: ReadonlyArray<"foreign" | "twin">;
      readonly scratch?: boolean;
      /** The lead holds the other project's isolated workspace as a live attachment. */
      readonly attached?: boolean;
      /** The lead's own model, with whatever options its thread carries. */
      readonly parent?: ModelSelection;
      readonly providers?: ReadonlyArray<ServerProvider>;
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
        yield* encodeManifest(policy.manifest),
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
      const parent = {
        thread: {
          id: threadId,
          projectId,
          title: "Lead",
          runtimeMode: "full-access",
          interactionMode: "default",
          worktreePath: options.scratch ? scratchFolder : bound ? lead : null,
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
      const scope: McpInvocationScope = {
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
      const transport = Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parent),
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          listProjectThreads: (input) =>
            Effect.succeed(
              occupantsFor(helper, { projectId: input.projectId, foreign, foreignHelper }),
            ),
          dispatch: (command) =>
            Effect.suspend(() => {
              dispatched.push(command);
              locked.push(holding > 0);
              // Stop after capture: launching the child is the orchestrator's concern.
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
                Option.map((workspaceRoot) => ({ id, workspaceRoot }) as never),
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
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcs.GitVcsDriver)({}),
        Settings.layerTest(),
      );
      const delegate = (
        input: Parameters<Mcp.OrchestratorMcpService["Service"]["delegateTask"]>[1],
      ) =>
        Effect.gen(function* () {
          const mcp = yield* Mcp.OrchestratorMcpService;
          return yield* mcp.delegateTask(scope, input).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            Mcp.layer.pipe(
              Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
              Layer.provide(transport),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
          ),
          Effect.provideService(Managed.ManagedAgentService, counted),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: policyRoot }),
          ),
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
              Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
              Layer.provide(transport),
              Layer.provide(WorkspaceProvider.layerGitWorktree),
            ),
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: policyRoot }),
          ),
        );
      return {
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
        locked,
      };
    });

  it.effect(
    "discovers and dispatches a fresh explicit author-model review with truthful evidence",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const reviewer = (result: Effect.Success<ReturnType<typeof h.roles>>) =>
          result.roles.find((entry) => entry.role === "ticket-reviewer")!;
        expect(reviewer(yield* h.roles()).selection?.model).toBe(claudeModel);
        const explicit = reviewer(yield* h.roles(codexModel));
        expect(explicit.refusal).toBeNull();
        expect(explicit.selection?.model).toBe(codexModel);
        const review = request({
          role: "ticket-reviewer",
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
            role: "ticket-reviewer",
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
          { agentTask: { ...review, taskClass: "mixed" as const } },
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
      }),
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
            agentTask: request({ workspacePath: h.lead, readOnly: true }),
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
      }),
  );

  it.effect("requires a managed role where a policy is configured, even with a reason", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const raw = { task: "Do something", clientRequestId: "raw-1" };
      const refusal = yield* h.delegate(raw);
      expect(refusal.code).toBe("invalid_request");
      expect(refusal.message).toContain("agent_roles");
      expect(refusal.message).toContain("agentTask");
      expect(h.dispatched).toHaveLength(0);
      expect(
        (yield* h.delegate({ ...raw, offPolicyReason: "No canonical role fits a spike." })).code,
      ).toBe("invalid_request");
      expect(h.dispatched).toHaveLength(0);
      // A named but unreadable policy still refuses; an outage does not open free choice.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${h.policyRoot}/roles/policy.json`);
      expect((yield* h.delegate({ ...raw, clientRequestId: "raw-2" })).code).toBe(
        "invalid_request",
      );
      // Legacy reasons cannot override a managed role either.
      expect(
        (yield* h.delegate({
          ...raw,
          clientRequestId: "managed-1",
          offPolicyReason: "Prefer my model",
          agentTask: request({ workspacePath: h.lead }),
        })).code,
      ).toBe("invalid_request");
    }),
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
          role: "spec-reviewer",
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
        const discovered = (yield* h.roles()).roles.find(
          (entry) => entry.role === "spec-reviewer",
        )!;
        const own = {
          instanceId: claude.instanceId,
          model: claudeModel,
          options: [{ id: "effort", value: "medium" }],
        };
        expect(discovered.selection).toEqual(own);
        const attempts = [
          { label: "omitted target" },
          {
            label: "role options",
            target: { model: claudeModel, options: [{ id: "effort", value: "medium" }] },
          },
          { label: "empty options", target: { model: claudeModel, options: [] } },
          { label: "options only", target: { options: [{ id: "effort", value: "medium" }] } },
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
        expect(h.dispatched[4]).toMatchObject({
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
        expect(h.dispatched).toHaveLength(5);
        // Naming only an account: discovery and dispatch read it the same way.
        const named = (yield* h.roles(undefined, alternate.instanceId)).roles.find(
          (entry) => entry.role === "spec-reviewer",
        )!;
        expect(named.selection).toEqual({ ...own, instanceId: alternate.instanceId });
        yield* h.delegate({
          task: "Review the Spec",
          clientRequestId: "account-only",
          agentTask: review,
          target: { providerInstanceId: alternate.instanceId },
        });
        expect(h.dispatched[5]).toMatchObject({ modelSelection: named.selection });
        // Echoing the lead's own fastMode=false is inherited, not chosen: it is dropped and the
        // role starts with exactly its own options.
        yield* h.delegate({
          task: "Review the Spec",
          clientRequestId: "echoed-inherited",
          agentTask: review,
          target: { model: claudeModel, options: [{ id: "fastMode", value: false }] },
        });
        expect(h.dispatched[6]).toMatchObject({
          modelSelection: own,
          agentTask: { requested: own, effective: own },
        });
      }),
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
    }),
  );

  it.effect("launches an isolated helper in its own workspace and refuses a second writer", () =>
    Effect.gen(function* () {
      const isolatedTask = (path: string, workId = "importer") => ({
        task: "Implement the importer",
        clientRequestId: `isolated-${workId}`,
        agentTask: request({ workspacePath: path, workspaceAssignment: "isolated", workId }),
      });
      const h = yield* harness();
      yield* h.delegate(isolatedTask(h.helper));
      const command = h.dispatched[0] as { agentTask?: { workspacePath: string } };
      expect(command.agentTask?.workspacePath).toBe(h.helper);
      // The lead's own checkout is not an isolated workspace.
      expect((yield* h.delegate(isolatedTask(h.lead, "lead-path"))).code).toBe("capability_denied");
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
          lineage: { rootThreadId: "lead-thread" },
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
          role: "ticket-reviewer",
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
          role: "ticket-reviewer",
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
      });
      expect([...read.locked, ...free.locked]).toEqual([true, true, false]);
    }),
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
      }),
  );

  it.effect("asks which project when several are registered in the target repository", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign", "twin"] });
      const scout = (projectId?: string) => ({
        task: "Map the foreign code",
        clientRequestId: `twin-${projectId ?? "inferred"}`,
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
    }),
  );

  it.effect("lets a No project chat delegate into a registered project and its own folder", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign"], scratch: true });
      const commands = h.dispatched as Array<{ agentTask: AgentTaskBinding }>;
      yield* h.delegate({
        task: "Challenge the Spec",
        clientRequestId: "scratch-advisor",
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
        agentTask: request({
          role: "advisor",
          workId: "folder-advice",
          workspacePath: h.scratchFolder,
          readOnly: true,
        }),
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
    }),
  );
  it.effect("checks another project's workspaces for writers of every project there", () =>
    Effect.gen(function* () {
      const writer = (projectId: string, worktreePath: string | null) =>
        ({
          id: `writer-in-${projectId}`,
          projectId,
          lineage: { rootThreadId: "other-lead" },
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
    }),
  );

  it.effect("treats a workspace the lead attached in another project as its own checkout", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => [], true, { register: ["foreign"], attached: true });
      const commands = h.dispatched as Array<{ agentTask: AgentTaskBinding }>;
      // A writer shares the attached workspace, which names its project.
      yield* h.delegate({
        task: "Write in the attached workspace",
        clientRequestId: "attached-sharing",
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
    }),
  );

  it.effect("keeps helpers out of a workspace another lead holds as a live attachment", () =>
    Effect.gen(function* () {
      const holder = (helper: string, where: { readonly projectId: string }) =>
        where.projectId === "lead-project"
          ? [
              {
                id: "other-lead",
                projectId: "lead-project",
                lineage: { rootThreadId: "other-lead" },
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
    }),
  );
});
