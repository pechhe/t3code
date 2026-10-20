import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import { expect, it } from "@effect/vitest";
import {
  BuildWorkItemError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { delegation, makeHqHarness, origin } from "../../../hq/HqAgentConnections.testkit.ts";
import * as HqAgentConnections from "../../../hq/HqAgentConnections.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BuildWorkItems from "../../../hq/BuildWorkItems.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(BuildWorkItems.BuildWorkItems)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(layerDependencies))),
      );
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(BuildWorkItems.BuildWorkItems)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(layerDependencies))),
        );

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);
    // No strategy was given, so the project's default checkout applies.
    expect(launched[0]?.rootIsDefault).toBe(true);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(BuildWorkItems.BuildWorkItems)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(layerDependencies))),
        );

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(BuildWorkItems.BuildWorkItems)({
      resolve: (reference) =>
        reference === "YS-12"
          ? Effect.succeed({
              itemId: "build-item:3368",
              number: 3368,
              origin: "https://hq.example",
            })
          : Effect.fail(
              new BuildWorkItemError({
                reason: "not_found",
                message: `Build has no item ${reference} you can see.`,
              }),
            ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: modelSelection,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
        );

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(
      Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
    );
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
        );

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a colocated jj project binds its jj workspaces and its git worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-jj-" });
    const repo = path.join(root, "repo");
    const jjWorkspace = path.join(root, "jj-feature");
    const gitWorktree = path.join(root, "git-feature");
    yield* fileSystem.makeDirectory(repo);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const processes = yield* ProcessRunner.ProcessRunner.pipe(
      Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
    );
    for (const [command, args] of [
      ["git", ["init", "-b", "main"]],
      [
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ],
      ["jj", ["git", "init", "--colocate"]],
      ["jj", ["workspace", "add", jjWorkspace]],
      ["git", ["worktree", "add", "-b", "feature", gitWorktree]],
    ] as const) {
      const output = yield* processes.run({ command, args, cwd: repo, timeout: "30 seconds" });
      expect(output.code, `${command} ${args.join(" ")}`).toBe(0);
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
        );

    expect((yield* launchInto(jjWorkspace)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(gitWorktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(root)).at(-1)?.result).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
        );

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

const yardsmithThread = ThreadId.make("thread:yardsmith");
const t3codeThread = ThreadId.make("thread:t3code");
const projectOf = (threadId: ThreadId) =>
  ProjectId.make(threadId === yardsmithThread ? "project:yardsmith" : "project:t3code");
const delegationRef = SecretRef.make(`secret_${"r".repeat(43)}`);

const asCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-hq"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

it.effect("a connection one project's thread makes serves a thread in another project", () =>
  Effect.gen(function* () {
    const harness = yield* makeHqHarness;
    yield* harness.connections.disconnect;
    const call = (threadId: ThreadId, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        const toolkit = yield* ProjectToolkit;
        const results = yield* toolkit
          .handle("t3_hq_connection", params as never)
          .pipe(Stream.unwrap, Stream.runCollect);
        return results.at(-1)?.result as { connected: boolean; origin: string | null };
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ThreadCommandExecutor.layer,
                NodeCrypto.layer,
                NodeServices.layer,
                Layer.succeed(McpInvocationContext.McpInvocationContext, asCaller(threadId)),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadShell: (id) =>
                    Effect.succeed({ ...liveThreadShell(id), projectId: projectOf(id) }),
                }),
                // A secret ref is bound to the project of the thread that asked for it.
                Layer.mock(SecretRequests.SecretRequests)({
                  consume: ({ ref, projectId }) =>
                    ref === delegationRef && projectId === projectOf(yardsmithThread)
                      ? Effect.succeed(delegation)
                      : Effect.fail(new SecretRequestError({ reason: "invalid_ref" })),
                }),
                Layer.succeed(HqAgentConnections.HqAgentConnections, harness.connections),
                Layer.mock(Project.ProjectService)({}),
              ),
            ),
          ),
        ),
      );

    expect(yield* call(t3codeThread, { action: "read" })).toStrictEqual({
      connected: false,
      origin: null,
    });
    yield* call(yardsmithThread, { action: "connect", origin, delegation: delegationRef });
    expect(yield* call(t3codeThread, { action: "read" })).toStrictEqual({
      connected: true,
      origin,
    });
    yield* call(t3codeThread, { action: "disconnect" });
    expect(yield* call(yardsmithThread, { action: "read" })).toStrictEqual({
      connected: false,
      origin: null,
    });
  }),
);

it.effect(
  "a launch for a Build item binds the item's SlipJay workspace, only in a SlipJay project",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-build-item-" });
      const slipjayRoot = path.join(root, "slipjay");
      const plainRoot = path.join(root, "plain");
      yield* fileSystem.makeDirectory(path.join(slipjayRoot, ".jj"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(slipjayRoot, "slipjay.json"), "{}");
      yield* fileSystem.makeDirectory(plainRoot);

      const launchFor = (
        workspaceRoot: string,
        launched: Array<ThreadLaunch.ThreadLaunchInput>,
        params: {
          readonly workspaceStrategy?: { readonly type: "root" };
          readonly buildItem?: number | string;
        } = {},
      ) =>
        Effect.gen(function* () {
          const { projectId, dependencies } = clientLaunchHarness({
            runtimeModeCeiling: "auto",
            launched,
            workspaceRoot,
          });
          const toolkit = yield* ProjectToolkit.pipe(
            Effect.provide(
              McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
                Layer.provide(WorkspaceProvider.layer),
                Layer.provide(dependencies),
              ),
            ),
          );
          return yield* toolkit
            .handle("t3_thread_launch", { title: "Filters", projectId, buildItem: 3368, ...params })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
            );
        });

      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect((yield* launchFor(slipjayRoot, launched)).at(-1)?.result).not.toHaveProperty("code");
      expect(launched.map((launch) => [launch.workspaceStrategy, launch.rootIsDefault])).toEqual([
        [{ type: "worktree", baseRef: "HEAD", buildItem: 3368 }, false],
      ]);

      // A friendly ref is resolved first: SlipJay's attach-issue gets the canonical number.
      const byRef: Array<ThreadLaunch.ThreadLaunchInput> = [];
      yield* launchFor(slipjayRoot, byRef, { buildItem: "YS-12" });
      expect(byRef.map((launch) => launch.workspaceStrategy)).toEqual([
        { type: "worktree", baseRef: "HEAD", buildItem: 3368 },
      ]);
      const unknownRef: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect(
        (yield* launchFor(slipjayRoot, unknownRef, { buildItem: "YS-99" })).at(-1)?.result,
      ).toMatchObject({ code: "invalid_request" });
      expect(unknownRef).toEqual([]);

      const refused: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect((yield* launchFor(plainRoot, refused)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
      expect(
        (yield* launchFor(slipjayRoot, refused, { workspaceStrategy: { type: "root" } })).at(-1)
          ?.result,
      ).toMatchObject({ code: "invalid_request" });
      expect(refused).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
