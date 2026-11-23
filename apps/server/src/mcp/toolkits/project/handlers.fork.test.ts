import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as ManagedAgent from "../../../agents/ManagedAgentService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  ForgeWorkItemError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ForgeWorkItems from "../../../weave/ForgeWorkItems.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";

import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly defaultThreadEnvMode?: "local" | "worktree";
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly launch?: ThreadLaunch.ThreadLaunchService["Service"]["launch"];
  readonly hostedAppUrl?: string;
  /** Whether a launch's first message was already accepted, for a retry. */
  readonly firstMessageAccepted?: { current: boolean };
  /** The thread calling the launch; omitted means an outside client with no thread. */
  readonly caller?: OrchestrationV2ThreadShell;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input.providers ?? []),
      refreshWorkspaceSnapshot: () => Effect.succeed(input.providers ?? []),
    }),
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.newWorktreesStartFromOrigin === undefined
        ? {}
        : { newWorktreesStartFromOrigin: input.newWorktreesStartFromOrigin }),
      ...(input.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread:
        input.caller === undefined
          ? undefined
          : {
              threadId: input.caller.id,
              providerSessionId: `provider:${input.caller.id}`,
              providerInstanceId: input.caller.providerInstanceId,
            },
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
        hostedAppUrl: input.hostedAppUrl,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ForgeWorkItems.ForgeWorkItems)({
      resolve: (reference) =>
        reference === "YS-12"
          ? Effect.succeed({
              itemId: "build-item:3368",
              number: 3368,
              origin: "https://weave.example",
            })
          : Effect.fail(
              new ForgeWorkItemError({
                reason: "not_found",
                message: `Build has no item ${reference} you can see.`,
              }),
            ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getMessagesById: (_threadId, messageIds) =>
        Effect.succeed(
          new Map(
            input.firstMessageAccepted?.current === true
              ? messageIds.map((id) => [id, {} as never])
              : [],
          ),
        ),
      // A thread exists once a launch started it.
      getThreadShell: (threadId) => {
        if (input.caller !== undefined && threadId === input.caller.id)
          return Effect.succeed(input.caller);
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: launch.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        if (input.launch !== undefined) return input.launch(launch);
        if (input.refusedByCeiling) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorRuntimeModeAboveCeilingError({
                commandId: launch.commandId,
                threadId: launch.threadId ?? ThreadId.make("thread:refused"),
                refused: "mode",
                runtimeMode: launch.runtimeMode,
                maxRuntimeMode: "approval-required",
                organization: "Example Corp",
              }),
            }),
          );
        }
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
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
          id === projectId || id === input.caller?.projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
      workspaceScanDirectory: Effect.succeed,
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    DocumentText.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { projectId, modelSelection, projectDefaults, dependencies: layerDependencies };
};

it.effect("a thread says why a new top-level thread beats a delegated task", () =>
  Effect.gen(function* () {
    const logs: Array<ReadonlyArray<unknown>> = [];
    const capture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) logs.push(message);
    });
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const caller = liveThreadShell(ThreadId.make("thread:caller"));
    const firstMessageAccepted = { current: false };
    const { dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      caller,
      firstMessageAccepted,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    let stance: "implement" | "orchestrate" | undefined;
    const launch = (params: Record<string, unknown>) =>
      toolkit.handle("t3_thread_launch", params as never).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies)),
            Logger.layer([capture], { mergeWithExisting: false }),
            stance === undefined
              ? Layer.empty
              : Layer.succeed(ManagedAgent.ManagedAgentService, {
                  assertLaunchAllowed: () =>
                    stance === "implement"
                      ? Effect.fail(new ManagedAgent.ManagedAgentError({ reason: "stance" }))
                      : Effect.void,
                } as unknown as ManagedAgent.ManagedAgentService["Service"]),
          ),
        ),
      );

    // A caller on Implement starts no separate thread, reason or not; Orchestrate still does.
    stance = "implement";
    const implementRefused = (yield* launch({
      title: "Fix",
      whyNotDelegated: "The user asked for a separate thread.",
      clientRequestId: "stance-key",
    })).at(-1)?.result;
    expect(implementRefused).toMatchObject({ code: "capability_denied" });
    expect((implementRefused as { message?: string }).message).toContain(
      "Delegation stance is implement",
    );
    expect(launched).toHaveLength(0);
    stance = "orchestrate";
    const orchestrated = (yield* launch({
      title: "Fix",
      whyNotDelegated: "The user asked for a separate thread.",
      clientRequestId: "stance-key",
    })).at(-1)?.result;
    expect(orchestrated).toMatchObject({ projectId: caller.projectId });
    expect(launched).toHaveLength(1);
    // A retry of that accepted launch replays under Implement, unless it brings a first message
    // not yet accepted.
    stance = "implement";
    expect(
      (yield* launch({ title: "Fix", clientRequestId: "stance-key" })).at(-1)?.result,
    ).toMatchObject({ projectId: caller.projectId });
    expect(
      (yield* launch({ title: "Fix", message: "Go.", clientRequestId: "stance-key" })).at(-1)
        ?.result,
    ).toMatchObject({ code: "capability_denied" });
    firstMessageAccepted.current = true;
    expect(
      (yield* launch({ title: "Fix", message: "Go.", clientRequestId: "stance-key" })).at(-1)
        ?.result,
    ).toMatchObject({ projectId: caller.projectId });
    firstMessageAccepted.current = false;
    launched.length = 0;
    stance = undefined;

    const refused = (yield* launch({ title: "Fix" })).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message?: string }).message).toContain("is better as a delegated task");
    expect((refused as { message?: string }).message).toContain("whyNotDelegated");
    const blank = (yield* launch({ title: "Fix", whyNotDelegated: "   " })).at(-1)?.result;
    expect(blank).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(0);

    const accepted = (yield* launch({
      title: "Fix",
      whyNotDelegated: "The user asked for a separate thread.",
    })).at(-1)?.result;
    // A thread's launch inherits its project.
    expect(accepted).toMatchObject({ projectId: caller.projectId });
    expect(launched).toHaveLength(1);
    expect(logs).toContainEqual([
      "orchestrator-mcp.thread.launched-instead-of-delegated",
      {
        launchedFrom: caller.id,
        threadId: launched[0]?.threadId,
        whyNotDelegated: "The user asked for a separate thread.",
      },
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("a caller with no thread launches without a reason", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
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
    const accepted = (yield* toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
      )).at(-1)?.result;
    expect(accepted).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
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
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
