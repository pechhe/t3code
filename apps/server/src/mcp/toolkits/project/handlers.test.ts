import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  ForgeWorkItemError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  ProviderDriverKind,
  type ServerProvider,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  delegation,
  makeWeaveHarness,
  origin,
} from "../../../weave/WeaveAgentConnections.testkit.ts";
import * as WeaveAgentConnections from "../../../weave/WeaveAgentConnections.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ForgeWorkItems from "../../../weave/ForgeWorkItems.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
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
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly launch?: ThreadLaunch.ThreadLaunchService["Service"]["launch"];
  readonly hostedAppUrl?: string;
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
    }),
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
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
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
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

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly hostedAppUrl?: string;
          readonly refusedByCeiling?: true;
        },
      ) {
        const { targeted, overrideModel, hostedAppUrl, refusedByCeiling, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
          ...(refusedByCeiling === undefined ? {} : { refusedByCeiling }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(WorkspaceProvider.layer),
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
          );
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](t3-thread://v2/environment/${belowCeiling.launched[0]?.threadId})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        hostedAppUrl: "https://t3.example.com",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://t3.example.com/threads/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
      });

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);

      // An administrator's ceiling the orchestrator enforces is named, not reported as unavailable.
      const managed = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        refusedByCeiling: true,
      });
      expect(managed.result).toMatchObject({
        code: "invalid_request",
        message: "Example Corp limits threads to Supervised.",
      });
    }),
);

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    // Pi offers no Auto; a mode a provider lacks would run as Supervised.
    const pi = ProviderInstanceId.make("pi");
    const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers: [
          {
            instanceId: pi,
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
        ],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          projectId,
          title: "Fix",
          modelSelection: { instanceId: pi, model: "pi-model" },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return { result: result.at(-1)?.result, launched };
    });

    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("a thread says why a new top-level thread beats a delegated task", () =>
  Effect.gen(function* () {
    const logs: Array<ReadonlyArray<unknown>> = [];
    const capture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) logs.push(message);
    });
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const caller = liveThreadShell(ThreadId.make("thread:caller"));
    const { dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      caller,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const launch = (params: Record<string, unknown>) =>
      toolkit
        .handle("t3_thread_launch", params as never)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(
            Layer.mergeAll(
              WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies)),
              Logger.layer([capture], { mergeWithExisting: false }),
            ),
          ),
        );

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

it.effect("a launch key of any length or content gives a short id and never a defect", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string) =>
      toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    // Percent-encoding would grow this six times; scratch folders are named from the id.
    yield* launch("\u00e9".repeat(256));
    expect(launched.map((input) => input.commandId)).toEqual([
      expect.stringMatching(/^mcp:launch:[0-9a-f]{64}$/),
    ]);

    const loneSurrogate = yield* launch("key-\ud800").pipe(Effect.exit);
    expect(Exit.isFailure(loneSurrogate) && Cause.hasDies(loneSurrogate.cause)).toBe(false);
    expect(launched).toHaveLength(1);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId: "fix-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
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
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
  environmentId: EnvironmentId.make("environment-weave"),
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

it.effect.each(["t3_weave_connection"] as const)(
  "%s: a connection one project's thread makes serves a thread in another project",
  (connectionTool) =>
    Effect.gen(function* () {
      const harness = yield* makeWeaveHarness;
      yield* harness.connections.disconnect;
      const call = (threadId: ThreadId, params: Record<string, unknown>) =>
        Effect.gen(function* () {
          const toolkit = yield* ProjectToolkit;
          const results = yield* toolkit
            .handle(connectionTool, params as never)
            .pipe(Stream.unwrap, Stream.runCollect);
          return results.at(-1)?.result as { connected: boolean; origin: string | null };
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  ThreadCommandExecutor.layer,
                  NodeCrypto.layer,
                  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
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
                  Layer.succeed(WeaveAgentConnections.WeaveAgentConnections, harness.connections),
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
  "a launch for a Build item binds the item's SlipJay workspace and refuses a workspaceStrategy",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-build-item-" });
      const slipjayRoot = path.join(root, "slipjay");
      yield* fileSystem.makeDirectory(path.join(slipjayRoot, ".jj"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(slipjayRoot, "slipjay.json"), "{}");

      const launchFor = (
        workspaceRoot: string,
        launched: Array<ThreadLaunch.ThreadLaunchInput>,
        params: {
          readonly workspaceStrategy?: { readonly type: "root" };
          readonly forgeItem?: number | string;
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
            .handle("t3_thread_launch", { title: "Filters", projectId, forgeItem: 3368, ...params })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
            );
        });

      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect((yield* launchFor(slipjayRoot, launched)).at(-1)?.result).not.toHaveProperty("code");
      expect(launched.map((launch) => [launch.workspaceStrategy, launch.rootIsDefault])).toEqual([
        [{ type: "worktree", baseRef: "HEAD", forgeItem: 3368 }, false],
      ]);

      // A friendly ref is resolved first: SlipJay's attach-issue gets the canonical number.
      const byRef: Array<ThreadLaunch.ThreadLaunchInput> = [];
      yield* launchFor(slipjayRoot, byRef, { forgeItem: "YS-12" });
      expect(byRef.map((launch) => launch.workspaceStrategy)).toEqual([
        { type: "worktree", baseRef: "HEAD", forgeItem: 3368 },
      ]);
      const unknownRef: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect(
        (yield* launchFor(slipjayRoot, unknownRef, { forgeItem: "YS-99" })).at(-1)?.result,
      ).toMatchObject({ code: "invalid_request" });
      expect(unknownRef).toEqual([]);

      const refused: Array<ThreadLaunch.ThreadLaunchInput> = [];
      expect(
        (yield* launchFor(slipjayRoot, refused, { workspaceStrategy: { type: "root" } })).at(-1)
          ?.result,
      ).toMatchObject({ code: "invalid_request" });
      expect(refused).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reports the launch service's Build item refusal as an invalid request", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      launch: (launch) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchForgeItemError({
            projectId: launch.projectId,
            forgeItem: 3368,
          }),
        ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(WorkspaceProvider.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Filters", projectId, forgeItem: 3368 })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(WorkspaceProvider.layer.pipe(Layer.provideMerge(dependencies))),
      );
    expect(result.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message:
        "forgeItem picks the item's SlipJay workspace: use it in a project with slipjay.json.",
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("a client launches with the fallback for an exhausted default", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const fallbackModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...(driver === "claudeAgent"
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
            },
          }
        : {}),
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      fallbackModel,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Fallback",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      modelSelection: fallbackModel,
    });
    expect(launched[0]?.modelSelection).toEqual(fallbackModel);
  }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(WorkspaceProvider.WorkspaceProvider)({})))),
);

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.succeed({
              id: input.projectId,
              title: "client-target",
              workspaceRoot: "/projects/client-target",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: "2026-01-01T00:00:00.000Z",
            }),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          discard: (projectId) => Effect.sync(() => void discarded.push(projectId)),
        }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(discarded).toEqual([harness.projectId]);
  }),
);

it.effect("an update the project refuses tells the agent why", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const detail = "Project monograms must contain at most two characters.";
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.fail(new Project.ProjectInvalidError({ projectId: input.projectId, detail })),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_update", {
        projectId: harness.projectId,
        projectIcon: { kind: "monogram", text: "ABC", color: "blue" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request", message: detail });
  }),
);
