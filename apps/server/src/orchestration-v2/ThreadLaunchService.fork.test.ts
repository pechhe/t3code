import { layerNonSlipJay } from "./testkit/runWorkspaceCustody.ts";
import * as RunCustody from "./RunWorkspaceCustody.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  AgentTaskBinding,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ProviderSessionWarmup from "./ProviderSessionWarmup.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const decodeAgentTaskBinding = Schema.decodeSync(AgentTaskBinding);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly getLaunchSettings?: ServerSettings.ServerSettingsService["Service"]["getSettings"];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  /** The project allocates its workspaces through SlipJay. */
  readonly slipjay?: boolean;
  readonly allocateWorkspace?: WorkspaceProvider.WorkspaceProvider["Service"]["allocate"];
  readonly dispatch?: (
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
    dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"],
  ) => ReturnType<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>;
  /** Records the provider warm-up a launch asks for, in order. */
  readonly warmupCalls?: Array<string>;
  /** Records custody admissions and endings, in order. */
  readonly custodyCalls?: Array<string>;
  /** Overrides individual custody operations; every other one succeeds. */
  readonly custody?: Partial<RunCustody.RunWorkspaceCustody["Service"]>;
  /** Signals each custody admission as it starts, and holds it until `gate` opens. */
  readonly admitHold?: {
    readonly started: Deferred.Deferred<void>;
    readonly gate: Deferred.Deferred<void>;
  };
  /** Runs after each recorded custody settle. */
  readonly onSettle?: Effect.Effect<void>;
  readonly isGitRepository?: CheckpointStore.CheckpointStore["Service"]["isGitRepository"];
}

type AllocateInput = Parameters<WorkspaceProvider.WorkspaceProvider["Service"]["allocate"]>[0];

const allocated = (
  workspacePath: string,
  created: boolean | null = true,
  issue: number | null = null,
) => ({
  workspacePath,
  created,
  issue,
  attemptId: `attempt:${workspacePath}`,
});

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const deleteLocalBranch = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const allocateWorkspace = vi.fn(
    options.allocateWorkspace ??
      ((_input: Parameters<WorkspaceProvider.WorkspaceProvider["Service"]["allocate"]>[0]) =>
        Effect.succeed(allocated("/slipjay/workspaces/build-the-feature"))),
  );
  const releaseWorkspace = vi.fn(
    (_input: Parameters<WorkspaceProvider.WorkspaceProvider["Service"]["release"]>[0]) =>
      Effect.void,
  );
  const recordForgeProjectMock = vi.fn(
    (_input: { projectRoot: string; workspacePath: string; forgeProject: string | null }) =>
      Effect.void,
  );
  const settleWorkspace = vi.fn((_attemptId: string) => Effect.void);
  const abandonWorkspace = vi.fn((_attemptId: string) => Effect.void);
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  // Workspaces exist unless a test releases them.
  const releasedPaths = new Set<string>();
  const recreatedPaths = new Set<string>();
  const layerExternalServices = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: (path) => Effect.sync(() => recreatedPaths.has(path) || !releasedPaths.has(path)),
    }),
    Path.layer,
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.mock(CheckpointStore.CheckpointStore)({
      isGitRepository: options.isGitRepository ?? (() => Effect.succeed(true)),
    }),
    Layer.succeed(ProjectService.ProjectService, {
      recordWeaveSync: () => Effect.die("unused"),
      recordWeaveUnregistered: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      workspaceScanDirectory: () => Effect.die("unused"),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(project.workspaceRoot),
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      currentBranch: () => Effect.succeed(null),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      listLocalBranchNames: () => Effect.succeed([]),
      removeWorktree,
      deleteLocalBranch,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.warmupCalls === undefined
      ? Layer.empty
      : Layer.succeed(ProviderSessionWarmup.ProviderSessionWarmup, {
          warm: (threadId, { captureBaseline }) =>
            Effect.sync(
              () =>
                void options.warmupCalls!.push(
                  `warm:${threadId}${captureBaseline ? ":with-baseline" : ""}`,
                ),
            ),
          release: (threadId) =>
            Effect.sync(() => void options.warmupCalls!.push(`release:${threadId}`)),
        }),
    Layer.succeed(WorkspaceProvider.WorkspaceProvider, {
      resolve: () => Effect.succeed(options.slipjay === true ? "slipjay" : "git-worktree"),
      allocate: allocateWorkspace,
      recordForgeProject: recordForgeProjectMock,
      settled: settleWorkspace,
      abandon: abandonWorkspace,
      reconcile: () => Effect.void,
      release: releaseWorkspace,
      contains: (_, workspacePath) => Effect.succeed(!releasedPaths.has(workspacePath)),
      remove: removeWorktree,
    }),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        scratchRoot: Effect.succeedNone,
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const custodyLog = options.custodyCalls ?? [];
  const interceptDispatch = options.dispatch;
  const layerLaunchThreads =
    interceptDispatch === undefined
      ? layerThreadManagement
      : Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            return ThreadManagement.ThreadManagementService.of({
              ...threads,
              dispatch: (command) => interceptDispatch(command, threads.dispatch),
            });
          }),
        ).pipe(Layer.provide(layerThreadManagement));
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      options.custodyCalls === undefined && options.custody === undefined
        ? layerNonSlipJay
        : Layer.succeed(RunCustody.RunWorkspaceCustody, {
            admit: ({ runId }) =>
              Effect.sync(() => void custodyLog.push(`admit:${runId}`)).pipe(
                Effect.andThen(
                  options.admitHold === undefined
                    ? Effect.void
                    : Deferred.succeed(options.admitHold.started, undefined).pipe(
                        Effect.andThen(Deferred.await(options.admitHold.gate)),
                      ),
                ),
              ),
            register: () => Effect.void,
            acknowledge: () => Effect.void,
            settle: (runId) =>
              Effect.sync(() => void custodyLog.push(`settle:${runId}`)).pipe(
                Effect.andThen(options.onSettle ?? Effect.void),
              ),
            endAdmission: (runId) => Effect.sync(() => void custodyLog.push(`end:${runId}`)),
            recover: () => Effect.void,
            reconcileDeliveries: Effect.void,
            ...options.custody,
          }),
    ),
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerLaunchThreads,
        layerReceipts,
        layerOrchestrator,
        IdAllocator.layer,
        options.getLaunchSettings === undefined
          ? Layer.empty
          : Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: options.getLaunchSettings,
            }),
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              hasCustomTitle: false,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              pinnedAt: null,
              archivedAt: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        layerExternalServices,
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    allocateWorkspace,
    releaseWorkspace,
    settleWorkspace,
    abandonWorkspace,
    releasedPaths,
    recreatedPaths,
    deleteLocalBranch,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  readonly agentTask?: AgentTaskBinding;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    // A client draft's root only means no checkout was chosen.
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    rootIsDefault: input.workspace === undefined,
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...(input.agentTask === undefined ? {} : { agentTask: input.agentTask }),
  };
}

function managedTaskBinding(workspacePath: string) {
  return decodeAgentTaskBinding({
    role: "implementer",
    taskClass: "non-ui",
    workId: "launch-managed-work",
    attemptId: "launch-managed-attempt",
    workspacePath,
    requestFingerprint: "a".repeat(64),
    policyHash: "b".repeat(64),
    policyRevision: "test-policy",
    briefHash: "c".repeat(64),
    sourceAccess: "scoped-write",
    toolProfile: "implementation",
    requested: modelSelection,
    assigned: modelSelection,
    effective: modelSelection,
  });
}

function waitForThreadProjection<E, R>(
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
  predicate: () => Effect.Effect<boolean, E, R>,
) {
  return Effect.gen(function* () {
    if (yield* predicate()) return;
    yield* threads
      .streamStoredEventsFrom({ threadId })
      .pipe(Stream.mapEffect(predicate), Stream.filter(Boolean), Stream.runHead);
  });
}

const forgeItemStrategy = { type: "worktree", baseRef: "HEAD", forgeItem: 42 } as const;

// The contract kept `buildItem` as the older name of `forgeItem`, so a saved client still sends it.
const legacyBuildItemStrategy = { type: "worktree", baseRef: "HEAD", buildItem: 42 } as const;

it.effect("reads a saved client's older buildItem as the Forge item it launches in", () => {
  const harness = makeHarness({
    slipjay: true,
    allocateWorkspace: allocateInTurn("/slipjay/workspaces/legacy-item"),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:legacy-build-item",
        thread: "thread:launch:legacy-build-item",
        message: "Work on the item",
        workspace: legacyBuildItemStrategy,
      }),
    );
    yield* waitForThreadProjection(threads, launched.threadId, () =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(Effect.map(({ thread }) => thread.worktreePath !== null)),
    );
    assert.deepEqual(
      harness.allocateWorkspace.mock.calls.map(([input]) => input.issue),
      [{ number: 42, mode: "resume" }],
    );
    const { thread } = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(thread.workspaceIssue, 42);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a saved client's older buildItem outside a SlipJay project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const error = yield* launches
      .launch(
        launchInput({
          command: "command:launch:legacy-build-item-plain",
          thread: "thread:launch:legacy-build-item-plain",
          workspace: legacyBuildItemStrategy,
        }),
      )
      .pipe(Effect.flip);
    assert.ok(error._tag === "ThreadLaunchForgeItemError");
    // The legacy key names the item T3 refuses to place.
    assert.equal(error.forgeItem, 42);
    assert.isNull(
      yield* threads.getThreadShell(ThreadId.make("thread:launch:legacy-build-item-plain")),
    );
    assert.isEmpty(harness.allocateWorkspace.mock.calls);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "gives a managed reader sent to a Scratch project's root the folder the launch allocated as its workspace",
  () => {
    const folder = "/scratch/folder";
    const harness = makeHarness({
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: (id) => Effect.succeed(id === projectId),
        folderForThread: () => Effect.succeedSome(folder),
      }),
    });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:scratch-reader",
          thread: "thread:launch:scratch-reader",
          message: "Explore only",
          agentTask: decodeAgentTaskBinding({
            ...managedTaskBinding(project.workspaceRoot),
            role: "advisor",
            sourceAccess: "read-only",
            toolProfile: "source-reader",
          }),
          workspace: { type: "root" },
        }),
      );
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.worktreePath, folder);
      assert.equal(projection.thread.agentTask?.workspacePath, folder);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("leaves a managed reader sent to a named project's root bound to that root", () => {
  const harness = makeHarness({});
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:root-reader",
        thread: "thread:launch:root-reader",
        message: "Explore only",
        agentTask: decodeAgentTaskBinding({
          ...managedTaskBinding(project.workspaceRoot),
          role: "advisor",
          sourceAccess: "read-only",
          toolProfile: "source-reader",
        }),
        workspace: { type: "root" },
      }),
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.isNull(projection.thread.worktreePath);
    assert.equal(projection.thread.agentTask?.workspacePath, project.workspaceRoot);
  }).pipe(Effect.provide(harness.layer));
});

const launchSlipJayRun = (thread: string, workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy) =>
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: `command:${thread}`,
        thread,
        message: "Start",
        ...(workspace === undefined ? {} : { workspace }),
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    return {
      commandId: CommandId.make(`command:${thread}:released`),
      threadId: launched.threadId,
      runId: projection.runs[0]!.id,
    };
  });

const allocateInTurn = (...outcomes: ReadonlyArray<string | null>) => {
  let calls = 0;
  return (input: AllocateInput) => {
    const outcome = outcomes[calls++];
    return outcome === null || outcome === undefined
      ? Effect.fail(
          new WorkspaceProvider.WorkspaceProviderError({
            operation: "allocate",
            projectRoot: project.workspaceRoot,
          }),
        )
      : Effect.succeed(allocated(outcome, true, input.issue?.number ?? null));
  };
};

const forgeItem = { itemId: "build-item:42", number: 42, origin: "https://weave.example" };

/**
 * A SlipJay thread working on Build item 42 whose first run ended, so it is idle: linked to
 * the item in Weave, or launched for it in a project without a Weave server connection.
 */
const idleSlipJayThread = (thread: string, via: "link" | "launch" = "link") =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const first = yield* launchSlipJayRun(
      thread,
      via === "launch" ? { type: "worktree", baseRef: "HEAD", forgeItem: 42 } : undefined,
    );
    if (via === "link")
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`command:${thread}:work-item`),
        threadId: first.threadId,
        workItem: forgeItem,
      });
    yield* threads.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`command:${thread}:interrupt`),
      threadId: first.threadId,
      runId: first.runId,
    });
    yield* waitForThreadProjection(threads, first.threadId, () =>
      threads
        .getThreadProjection(first.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]?.status === "interrupted")),
    );
    return first.threadId;
  });

it.effect("opens a terminal that lost the recovery race in the checkout the turn bound", () =>
  Effect.gen(function* () {
    const terminalAllocating = yield* Deferred.make<void>();
    const terminalAllocated = yield* Deferred.make<void>();
    let calls = 0;
    const harness = makeHarness({
      slipjay: true,
      allocateWorkspace: (input) => {
        const call = calls++;
        const issue = input.issue?.number ?? null;
        if (call === 0) return Effect.succeed(allocated("/slipjay/workspaces/first", true, issue));
        if (call === 1)
          return Deferred.succeed(terminalAllocating, undefined).pipe(
            Effect.andThen(Deferred.await(terminalAllocated)),
            Effect.as(allocated("/slipjay/workspaces/terminal", true, issue)),
          );
        return Effect.succeed(allocated("/slipjay/workspaces/turn", true, issue));
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const threadId = yield* idleSlipJayThread("thread:launch:terminal-loses-race");
      harness.releasedPaths.add("/slipjay/workspaces/first");
      harness.releasedPaths.add("/slipjay/workspaces/first/.jj");

      const terminal = yield* Effect.forkChild(
        launches.terminalCwd({
          threadId,
          cwd: "/slipjay/workspaces/first/apps/web",
          worktreePath: "/slipjay/workspaces/first",
        }),
      );
      yield* Deferred.await(terminalAllocating);
      // The turn recovers the same workspace and binds the thread first.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make("command:terminal-loses-race:next"),
        threadId,
        messageId: MessageId.make("message:terminal-loses-race:next"),
        text: "Next turn",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const next = (yield* threads.getThreadProjection(threadId)).runs.at(-1)!;
      assert.isTrue(
        yield* launches.prepareReleasedWorkspace({
          commandId: CommandId.make("command:terminal-loses-race:released"),
          threadId,
          runId: next.id,
        }),
      );
      yield* waitForThreadProjection(threads, threadId, () =>
        threads
          .getThreadProjection(threadId)
          .pipe(Effect.map(({ thread }) => thread.worktreePath === "/slipjay/workspaces/turn")),
      );
      yield* Deferred.succeed(terminalAllocated, undefined);

      assert.deepEqual(yield* Fiber.join(terminal), {
        cwd: "/slipjay/workspaces/turn/apps/web",
        worktreePath: "/slipjay/workspaces/turn",
      });
      // The loser releases only its own redundant allocation, and settles it.
      assert.deepEqual(
        harness.releaseWorkspace.mock.calls.map(([input]) => input.path),
        ["/slipjay/workspaces/terminal"],
      );
      assert.sameMembers(
        harness.settleWorkspace.mock.calls.map(([attemptId]) => attemptId),
        [
          "attempt:/slipjay/workspaces/first",
          "attempt:/slipjay/workspaces/terminal",
          "attempt:/slipjay/workspaces/turn",
        ],
      );
      assert.equal(
        (yield* threads.getThreadProjection(threadId)).thread.worktreePath,
        "/slipjay/workspaces/turn",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([true, false, null])(
  "returns an allocation receipt before rolling back cancellation during SlipJay preparation, releasing only a workspace it created: %s",
  (created) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const allowReceipt = yield* Deferred.make<void>();
      const harness = makeHarness({
        slipjay: true,
        allocateWorkspace: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, yield* Effect.fiber);
            yield* Deferred.await(allowReceipt);
            return allocated("/slipjay/workspaces/build-the-feature", created);
          }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: "command:cancel-slipjay-during-allocation",
            thread: "thread:cancel-slipjay-during-allocation",
            message: "Start",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        const preparing = yield* Deferred.await(entered);
        yield* Effect.sync(() => preparing.interruptUnsafe());
        yield* Deferred.succeed(allowReceipt, undefined);
        yield* Fiber.await(preparing);
        assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
        assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath);
        // A resumed Build item workspace predates the launch, so it stays.
        assert.deepEqual(
          harness.releaseWorkspace.mock.calls.map(([input]) => input.path),
          created === true ? ["/slipjay/workspaces/build-the-feature"] : [],
        );
        // A checkout the launch did not make for certain goes back through its attempt, where
        // SlipJay keeps one it resumed; one it removed by path is already settled.
        const attemptId = "attempt:/slipjay/workspaces/build-the-feature";
        assert.deepEqual(
          harness.abandonWorkspace.mock.calls.map(([id]) => id),
          created === true ? [] : [attemptId],
        );
        assert.deepEqual(
          harness.settleWorkspace.mock.calls.map(([id]) => id),
          created === true ? [attemptId] : [],
        );
        assert.isEmpty(harness.createWorktree.mock.calls);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "binds a managed Spec lead to its allocated Spec checkout before its provider turn starts",
  () => {
    const assigned = "/slipjay/workspaces/spec-42";
    const harness = makeHarness({
      slipjay: true,
      allocateWorkspace: () => Effect.succeed(allocated(assigned, true, 42)),
      runSetup: () => Effect.die("A managed Spec lead must not run shared-root setup"),
    });
    const agentTask = { ...managedTaskBinding(project.workspaceRoot), role: "lead" as const };
    return Effect.gen(function* () {
      const launch = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const result = yield* launch.launch(
        launchInput({
          command: "champion:spec-lead",
          thread: "champion:spec-thread",
          message: "Run Spec 42",
          workspace: forgeItemStrategy,
          agentTask,
        }),
      );
      yield* waitForThreadProjection(threads, result.threadId, () =>
        threads
          .getThreadProjection(result.threadId)
          .pipe(Effect.map((p) => p.runs[0]?.status === "starting")),
      );
      const projection = yield* threads.getThreadProjection(result.threadId);
      assert.equal(projection.thread.worktreePath, assigned);
      assert.equal(projection.thread.agentTask?.workspacePath, assigned);
      assert.notEqual(projection.thread.agentTask?.workspacePath, project.workspaceRoot);
      const allocation = harness.allocateWorkspace.mock.calls[0]?.[0];
      assert.isDefined(allocation);
      assert.equal(allocation!.issue?.number, 42);
    }).pipe(Effect.provide(harness.layer));
  },
);

const failedRun = (threads: ThreadManagement.ThreadManagementService["Service"], id: ThreadId) =>
  waitForThreadProjection(threads, id, () =>
    threads
      .getThreadProjection(id)
      .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
  );

it.effect(
  "retries a preparation whose custody admission failed, under the retry's own command",
  () => {
    const admissions: Array<string | undefined> = [];
    const recovered: Array<string> = [];
    const harness = makeHarness({
      slipjay: true,
      allocateWorkspace: allocateInTurn("/slipjay/workspaces/first", "/slipjay/workspaces/second"),
      custody: {
        admit: ({ admissionId }) => {
          admissions.push(admissionId);
          return admissions.length === 1
            ? Effect.fail(
                new RunCustody.RunWorkspaceCustodyError({
                  runId: "run",
                  operation: "admit",
                  cause: "SlipJay refused",
                }),
              )
            : Effect.void;
        },
        recover: (_runId, reason) => Effect.sync(() => void recovered.push(reason)),
      },
    });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:admit-retry",
          thread: "thread:launch:admit-retry",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* failedRun(threads, launched.threadId);
      // The abandoned checkout is released through its attempt, so SlipJay sees no live claim.
      assert.deepEqual(
        harness.releaseWorkspace.mock.calls.map(([input]) => [input.path, input.attemptId]),
        [["/slipjay/workspaces/first", "attempt:/slipjay/workspaces/first"]],
      );
      harness.releasedPaths.add("/slipjay/workspaces/first");
      const failed = yield* threads.getThreadProjection(launched.threadId);
      yield* launches.retryPreparation({
        commandId: CommandId.make("command:launch:admit-retry:1"),
        threadId: launched.threadId,
        runId: failed.runs[0]!.id,
      });
      yield* waitForThreadProjection(threads, launched.threadId, () =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status === "starting")),
      );
      assert.deepEqual(admissions, ["command:launch:admit-retry", "command:launch:admit-retry:1"]);
      // Nothing was registered before the admission failed, so nothing needs stop proof.
      assert.isEmpty(recovered);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each([
  { name: "stopped", completion: Effect.succeed({ exitCode: 1, durationMs: 1 }) },
  { name: "unproven", completion: Effect.die("lost completion") },
])("fails preparation when the setup script is $name", ({ name, completion }) => {
  const calls: Array<string> = [];
  const harness = makeHarness({
    slipjay: true,
    runSetup: () =>
      Effect.succeed({
        status: "started" as const,
        async: false,
        scriptId: "setup",
        scriptName: "Setup",
        scriptCommand: "vp install",
        terminalId: "setup",
        cwd: "/slipjay/workspaces/build-the-feature",
        completion,
      }),
    custody: {
      acknowledge: (_runId, id) => Effect.sync(() => void calls.push(`ack:${id.split(":")[0]}`)),
      settle: () => Effect.sync(() => void calls.push("settle")),
      recover: (_runId, reason) => Effect.sync(() => void calls.push(`recover:${reason}`)),
    },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: `command:launch:setup-${name}`,
        thread: `thread:launch:setup-${name}`,
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* failedRun(threads, launched.threadId);
    // Proof the script stopped settles the run's custody; without it protection stays.
    assert.deepEqual(
      calls,
      name === "stopped"
        ? ["ack:preparation", "ack:admission", "settle"]
        : ["recover:workspace-preparation-stop-proof-unavailable"],
    );
  }).pipe(Effect.provide(harness.layer));
});
