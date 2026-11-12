import * as EnvironmentAdvice from "../../agents/AdviceService.ts";
import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as ExperimentService from "../../experiments/ExperimentService.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ReleaseApprovals from "../../releases/ReleaseApprovals.ts";
import * as ForgeWorkItems from "../../weave/ForgeWorkItems.ts";
import * as WeaveAgentConnections from "../../weave/WeaveAgentConnections.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpFailure,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  type CapturedTurn,
  makeCapturingCodexAdapter,
} from "../../orchestration-v2/testkit/CapturingCodexAdapter.ts";
import { awaitOrchestratorState } from "../../orchestration-v2/testkit/OrchestratorWait.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as WorkspaceProvider from "../../project/WorkspaceProvider.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as PeerMcpClient from "../PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "../PeerLinks.testkit.ts";
import * as RemoteDelegation from "../RemoteDelegation.ts";
import * as RemoteThreadWatches from "../RemoteThreadWatches.ts";
import * as HandoffGit from "./HandoffGit.ts";
import * as HandoffImport from "./HandoffImport.ts";
import * as ThreadHandoff from "./ThreadHandoff.ts";
import * as PeerLinkRequests from "../PeerLinkRequests.ts";

// A thread on the laptop moves to the box: both are real orchestrators, the
// box behind its real /mcp, OAuth and upload route, the laptop linked to it,
// and both with a real clone of the same repository. The thread arrives with
// its conversation and its git work, and only one copy stays live.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const git = (cwd: string, args: ReadonlyArray<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((processes) =>
      processes.run({
        operation: "ThreadHandoff.test",
        command: "git",
        cwd,
        args,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }),
    ),
    Effect.map((result) => result.stdout),
    Effect.orDie,
  );

/** An origin and the laptop's and the box's clones of it. */
const makeRepos = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-handoff-" });
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  yield* fileSystem.makeDirectory(seed);
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  yield* git(seed, ["init", "--quiet", "--initial-branch=main"]);
  yield* fileSystem.writeFileString(path.join(seed, "app.ts"), "export const version = 1;\n");
  yield* git(seed, ["add", "."]);
  yield* git(seed, ["commit", "--quiet", "-m", "start"]);
  yield* git(seed, ["remote", "add", "origin", origin]);
  yield* git(seed, ["push", "--quiet", "origin", "main"]);
  const laptopRepo = path.join(root, "laptop");
  const boxRepo = path.join(root, "box");
  yield* git(root, ["clone", "--quiet", origin, laptopRepo]);
  yield* git(root, ["clone", "--quiet", origin, boxRepo]);
  // Repository identity ignores local-path remotes; both clones name the same hosted one.
  for (const clone of [laptopRepo, boxRepo]) {
    yield* git(clone, ["remote", "add", "upstream", "https://github.com/example/app.git"]);
  }
  return { root, laptopRepo, boxRepo };
});

const projectAt = (id: string, workspaceRoot: string): Project => ({
  id: ProjectId.make(id),
  title: "app",
  workspaceRoot,
  // Blank, as a cold enrichment cache leaves it: both sides resolve the
  // clones' shared origin themselves.
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
});

/** One project, whose repository identity is read from its real checkout, as the service does. */
const layerProjects = (project: Project) =>
  Layer.effect(
    ProjectService.ProjectService,
    Effect.gen(function* () {
      const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      return ProjectService.ProjectService.of({
        getById: (id: ProjectId) =>
          Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
        snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
        listShells: () => Effect.succeed([]),
        listPage: () =>
          identities.resolve(project.workspaceRoot).pipe(
            Effect.map((repositoryIdentity) => ({
              projects: [{ ...project, repositoryIdentity }],
              nextCursor: null,
            })),
          ),
      } as unknown as ProjectService.ProjectService["Service"]);
    }),
  );

/** What each test runs on: a test HTTP server, git, and Node. */
const layerTestHost = Layer.mergeAll(
  NodeHttpServer.layerTest,
  VcsProcess.layer,
  NodeCrypto.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

/** A real orchestrator on an in-memory database, with a capturing provider. */
const layerOrchestration = (
  name: string,
  workspace: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  holdTurn?: Effect.Effect<void>,
) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(
    layerDatabase,
    EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    {
      name,
      runtimePolicyOverride: {
        cwd: workspace,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    ProviderAdapterRegistry.layerSingle(
      makeCapturingCodexAdapter(captured, {
        response: `${name} replied.`,
        modelSelection,
        ...(holdTurn === undefined ? {} : { holdTurn }),
      }),
    ),
    { databaseLayer: layerDatabase },
  );
  return ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    Layer.provideMerge(EventSink.layer.pipe(Layer.provide(layerStores))),
    Layer.provideMerge(layerStores),
  );
};

/** What the box's tools never use here, with its links as `links` answers them. */
const unusedServices = (
  links: Partial<PeerLinks.PeerLinks["Service"]> = {},
  forge: Partial<ForgeWorkItems.ForgeWorkItems["Service"]> = {},
) =>
  Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
    Layer.mock(PeerLinks.PeerLinks)(links),
    // The box takes moves; it never starts one.
    Layer.mock(ThreadHandoff.ThreadHandoff)({}),
    Layer.mock(ExperimentService.ExperimentService)({}),
    Layer.mock(ForgeWorkItems.ForgeWorkItems)(forge),
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
    Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
    Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({}),
  );

/** The box: its real tools on a real /mcp, with uploads, on its own repo. */
const serveBox = (
  boxRepo: string,
  stateDir: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  links: Partial<PeerLinks.PeerLinks["Service"]> = {},
  forge: Partial<ForgeWorkItems.ForgeWorkItems["Service"]> = {},
) =>
  Effect.gen(function* () {
    const core = yield* Layer.mergeAll(
      ThreadImportService.layer.pipe(
        Layer.provideMerge(layerOrchestration("box", boxRepo, captured)),
      ),
      VcsProcess.layer,
    ).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.build,
    );
    const layerCore = Layer.succeedContext(core);
    // Uploads are signed and stored for real, as on a box.
    const layerAssets = Layer.mergeAll(AssetSigner.layer, DocumentText.layer).pipe(
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provide(layerCore),
    );
    const tools = Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit.pipe(Layer.provide(EnvironmentAdvice.layer)),
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerAttachmentToolkit,
    ).pipe(
      Layer.provide(HandoffImport.layer.pipe(Layer.provide(HandoffGit.layer))),
      Layer.provide(
        layerProjects(projectAt("project:box", boxRepo)).pipe(
          Layer.provideMerge(RepositoryIdentityResolver.layer),
        ),
      ),
      Layer.provide(WorkspaceProvider.layerGitWorktree),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listWorktreePaths: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(unusedServices(links, forge)),
      Layer.provide(layerAssets),
      Layer.provide(layerCore),
    );
    // Upload URLs are signed and checked with the box's own secret store.
    const served = yield* servePeer(
      box,
      tools,
      ServerHttp.layerAttachmentUploadRoute.pipe(Layer.provide(layerAssets)),
      core,
    ).pipe(Effect.provide(Layer.merge(layerAssets, layerCore)));
    return {
      ...served,
      orchestrator: Context.get(core, Orchestrator.OrchestratorV2),
    };
  });

/** The laptop: a real orchestrator with a thread mid-conversation, linked to the box. */
const makeLaptop = (
  laptopRepo: string,
  captured: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  holdTurn?: Effect.Effect<void>,
  /** Stands between the laptop and the box, as a network that drops answers does. */
  interceptCalls?: (
    call: PeerMcpClient.PeerMcpClient["Service"]["call"],
  ) => PeerMcpClient.PeerMcpClient["Service"]["call"],
) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const core = yield* layerOrchestration("laptop", laptopRepo, captured, holdTurn).pipe(
      Layer.provideMerge(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-laptop-" }),
          ),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.build,
    );
    const layerPeers =
      interceptCalls === undefined
        ? Layer.empty
        : Layer.effect(
            PeerMcpClient.PeerMcpClient,
            Effect.map(PeerMcpClient.PeerMcpClient, (peers) =>
              PeerMcpClient.PeerMcpClient.of({ call: interceptCalls(peers.call) }),
            ),
          ).pipe(Layer.provide(Layer.succeedContext(linking)));
    const layerHere = ThreadHandoff.layer.pipe(
      Layer.provideMerge(RemoteThreadWatches.layer),
      Layer.provideMerge(PeerForwarding.layer.pipe(Layer.provide(layerPeers))),
      // Unanswered moves are rechecked as soon as asked.
      Layer.provide(Layer.succeed(ThreadHandoff.UnansweredMoveRecheck, Duration.zero)),
      Layer.provide(Layer.succeed(RemoteDelegation.FollowRetrySchedule, Schedule.forever)),
      Layer.provide(HandoffGit.layer),
      Layer.provide(
        layerProjects(projectAt("project:laptop", laptopRepo)).pipe(
          Layer.provideMerge(RepositoryIdentityResolver.layer),
        ),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(laptop.environmentId),
          getDescriptor: Effect.succeed(laptop),
        }),
      ),
      // The laptop's own database answers first, so the services above read its threads.
      Layer.provide(Layer.succeedContext(core)),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(VcsProcess.layer),
      Layer.provide(NodeCrypto.layer),
      // Uploads go to the box's own address, not the test server's.
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      orchestrator: Context.get(core, Orchestrator.OrchestratorV2),
      threads: Context.get(core, ThreadManagement.ThreadManagementService),
      handoff: Context.get(here, ThreadHandoff.ThreadHandoff),
      watches: Context.get(here, RemoteThreadWatches.RemoteThreadWatches),
    };
  });

const threadId = ThreadId.make("thread:laptop-login");

/** The laptop's thread: one finished turn about the bug, on the laptop's checkout. */
const createThread = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  laptopRepo: string,
) =>
  laptopEnv.orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:create:laptop-login"),
    threadId,
    projectId: ProjectId.make("project:laptop"),
    title: "Flaky login test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: laptopRepo,
  });

const seedThread = (
  laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>,
  laptopRepo: string,
  id: ThreadId = threadId,
) =>
  Effect.gen(function* () {
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${id}`),
      threadId: id,
      projectId: ProjectId.make("project:laptop"),
      title: "Flaky login test",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: laptopRepo,
    });
    yield* laptopEnv.orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:send:${id}`),
      threadId: id,
      messageId: MessageId.make(`message:${id}:1`),
      text: "LAPTOP_QUESTION: why does the login test flake?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    yield* idle(laptopEnv.orchestrator, id);
  });

const idle = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: ThreadId) =>
  awaitOrchestratorState(
    orchestrator,
    orchestrator.getThreadProjection(id),
    (projection: OrchestrationV2ThreadProjection) =>
      projection.runs.length > 0 &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting", "preparing"].includes(run.status),
      ),
  );

it.live("a thread moves to the box with its conversation and its git work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const boxTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const laptopTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), boxTurns);
      const a = yield* makeLaptop(laptopRepo, laptopTurns);
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);

      // The thread's work on the laptop: an unpushed commit, then uncommitted edits.
      yield* git(laptopRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 2;\n",
      );
      yield* git(laptopRepo, ["commit", "--quiet", "-am", "unpushed fix"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 3;\n",
      );
      yield* fileSystem.writeFileString(path.join(laptopRepo, "notes.md"), "# findings\n");

      expect(yield* a.handoff.options(threadId)).toEqual([
        { environmentId: box.environmentId, label: "Box", projectId: "project:box", reason: null },
      ]);
      const moved = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      expect(moved.state).toBe("departed");
      if (moved.state !== "departed") return;

      // On the box: the thread, its history, its first run with that context.
      const there = yield* idle(b.orchestrator, moved.threadId);
      expect(there.thread.historyOrigin).toBe("v1_import");
      expect(there.messages.some((message) => message.text.includes("LAPTOP_QUESTION"))).toBe(true);
      const [firstTurn] = yield* Ref.get(boxTurns);
      expect(firstTurn?.text).toContain("LAPTOP_QUESTION");
      expect(firstTurn?.text).toContain(
        `moved here from Laptop (environment ${laptop.environmentId}, thread ${threadId})`,
      );
      expect(firstTurn?.text).toContain("Continue where it left off.");
      // ...in a new worktree on the branch, with the commit and the edits.
      const worktree = there.thread.worktreePath!;
      expect(there.thread.branch).toBe("fix/login");
      expect((yield* git(worktree, ["log", "-1", "--format=%s"])).trim()).toBe("unpushed fix");
      expect(yield* fileSystem.readFileString(path.join(worktree, "app.ts"))).toBe(
        "export const version = 3;\n",
      );
      expect(yield* fileSystem.readFileString(path.join(worktree, "notes.md"))).toBe(
        "# findings\n",
      );

      // On the laptop: read-only, pointing at the box.
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "departed", threadId: moved.threadId });
      const refused = yield* a.orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:send:after-move"),
          threadId,
          messageId: MessageId.make("message:after-move"),
          text: "Still here?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      expect(refused.message).toBe("This thread moved to Box. Continue it there.");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a second thread on a branch that already moved gets a worktree of its own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* git(laptopRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 2;\n",
      );
      yield* git(laptopRepo, ["commit", "--quiet", "-am", "unpushed fix"]);

      const secondId = ThreadId.make("thread:laptop-login-2");
      yield* seedThread(a, laptopRepo);
      yield* seedThread(a, laptopRepo, secondId);
      const first = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      const second = yield* a.handoff.start({
        threadId: secondId,
        environmentId: box.environmentId,
      });
      expect([first.state, second.state]).toEqual(["departed", "departed"]);
      if (first.state !== "departed" || second.state !== "departed") return;

      const firstThere = (yield* idle(b.orchestrator, first.threadId)).thread.worktreePath!;
      const secondThere = (yield* idle(b.orchestrator, second.threadId)).thread.worktreePath!;
      expect(secondThere).not.toBe(firstThere);
      expect((yield* git(secondThere, ["log", "-1", "--format=%s"])).trim()).toBe("unpushed fix");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a move the box refuses releases the thread here, untouched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns);
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      // The box has its own commit on the branch the laptop's thread is on.
      yield* git(laptopRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(
        path.join(laptopRepo, "app.ts"),
        "export const version = 2;\n",
      );
      yield* git(laptopRepo, ["commit", "--quiet", "-am", "laptop fix"]);
      yield* git(boxRepo, ["checkout", "--quiet", "-b", "fix/login"]);
      yield* fileSystem.writeFileString(path.join(boxRepo, "box.ts"), "export const b = 1;\n");
      yield* git(boxRepo, ["add", "."]);
      yield* git(boxRepo, ["commit", "--quiet", "-m", "box fix"]);
      yield* git(boxRepo, ["checkout", "--quiet", "main"]);

      const failed = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(failed.message).toContain("commits the handed-off work lacks");
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "failed" });
      // Released: the thread takes turns here again.
      yield* a.orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:send:after-failure"),
        threadId,
        messageId: MessageId.make("message:after-failure"),
        text: "Keep going here then.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      // Nothing was created on the box.
      expect(
        (yield* b.orchestrator.getShellSnapshot()).threads.filter((shell) =>
          shell.title.includes("Flaky"),
        ),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

/** A laptop thread that holds a watch on another laptop thread and a parked time wait. */
const startWaiting = (laptopEnv: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  Effect.gen(function* () {
    const watched = ThreadId.make("thread:laptop-deploy");
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop-deploy"),
      threadId: watched,
      projectId: ProjectId.make("project:laptop"),
      title: "Deploy the fix",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make("command:watch:deploy"),
      threadId,
      target: { kind: "thread", threadId: watched },
      watching: true,
    });
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make("command:park:tonight"),
      threadId,
      target: { kind: "time", at: "2099-01-01T00:00:00.000Z" },
      watching: true,
      park: { note: "Check the nightly." },
    });
    yield* laptopEnv.orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("command:watch:pull-request"),
      threadId,
      host: "github.com",
      repository: "acme/app",
      number: 12,
      watching: true,
      link: { url: "https://github.com/acme/app/pull/12", source: "agent" },
    });
    return watched;
  });

it.live("a move carries the thread's waits, and ends them on the copy left behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const boxTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      // The box is linked back to the laptop, so it can watch the laptop's thread.
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), boxTurns, {
        get: (environmentId) =>
          Effect.succeed(
            environmentId === laptop.environmentId ? Option.some({} as never) : Option.none(),
          ),
      });
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      const watched = yield* startWaiting(a);

      const moved = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      expect(moved.state).toBe("departed");
      if (moved.state !== "departed") return;

      // There: the same waits, the thread here now a thread in another environment.
      const there = yield* idle(b.orchestrator, moved.threadId);
      expect(there.thread.threadWatches?.map((watch) => watch.target)).toEqual([
        { kind: "thread", threadId: watched, environmentId: laptop.environmentId },
      ]);
      expect(there.thread.parkedWaits?.map((wait) => wait.target)).toEqual([
        { kind: "time", at: "2099-01-01T00:00:00.000Z" },
      ]);
      expect(there.thread.parkedWaits?.[0]?.note).toBe("Check the nightly.");
      expect(
        there.thread.pullRequests?.map((link) => [link.number, link.watch !== undefined]),
      ).toEqual([[12, true]]);
      const [firstTurn] = yield* Ref.get(boxTurns);
      expect(firstTurn?.text).toContain("Its waits moved with it");
      expect(firstTurn?.text).toContain("watching Deploy the fix");
      expect(firstTurn?.text).toContain("watching pull request #12");

      // Here: nothing left to wake the read-only copy.
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "departed" });
      expect(here.thread.threadWatches ?? []).toEqual([]);
      expect(here.thread.parkedWaits ?? []).toEqual([]);
      expect(here.thread.pullRequests?.some((link) => link.watch !== undefined)).toBe(false);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

/** The box links back to the laptop, and is as connected to Weave as `forge` says. */
const boxLinks = {
  get: (environmentId: typeof laptop.environmentId) =>
    Effect.succeed(
      environmentId === laptop.environmentId ? Option.some({} as never) : Option.none(),
    ),
};

it.live("a Build item wait moves with the thread and one the box cannot read ends the move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const connected = yield* Ref.make(true);
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        boxLinks,
        { connected: Ref.get(connected).pipe(Effect.map((on) => ({ connected: on }) as never)) },
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      yield* a.orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:watch:build"),
        threadId,
        target: { kind: "build_item", number: 7, until: "closed" },
        title: "Build #7",
        watching: true,
      });

      // A box with no Weave connection cannot keep it: the move fails and the thread keeps its watch.
      yield* Ref.set(connected, false);
      const refused = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(refused.message).toContain("no Weave connection");
      expect(refused.message).toContain("Build #7");
      expect(
        (yield* a.orchestrator.getThreadProjection(threadId)).thread.threadWatches,
      ).toHaveLength(1);

      // Connected, the same move carries it, once, and ends it here.
      yield* Ref.set(connected, true);
      yield* a.orchestrator.dispatch({
        type: "thread.handoff.update",
        commandId: CommandId.make("command:clear-failed-handoff"),
        threadId,
        expected: "failed",
        handoff: null,
      });
      const moved = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      expect(moved.state).toBe("departed");
      if (moved.state !== "departed") return;
      const there = yield* idle(b.orchestrator, moved.threadId);
      expect(there.thread.threadWatches?.map((watch) => watch.target)).toEqual([
        { kind: "build_item", number: 7, until: "closed" },
      ]);
      expect(
        (yield* a.orchestrator.getThreadProjection(threadId)).thread.threadWatches ?? [],
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a wait on a third environment or on Production the box cannot follow ends the move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        boxLinks,
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      const clear = (id: string) =>
        a.orchestrator.dispatch({
          type: "thread.handoff.update",
          commandId: CommandId.make(`command:clear-failed-handoff:${id}`),
          threadId,
          expected: "failed",
          handoff: null,
        });

      yield* a.orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:watch:third"),
        threadId,
        target: {
          kind: "thread",
          threadId: ThreadId.make("thread:elsewhere"),
          environmentId: EnvironmentId.make("environment-third"),
        },
        title: "Deploy there",
        watching: true,
      });
      const thirdRefused = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(thirdRefused.message).toContain("not linked to environment-third");
      expect(thirdRefused.message).toContain("Deploy there");
      yield* clear("third");
      yield* a.orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:unwatch:third"),
        threadId,
        target: {
          kind: "thread",
          threadId: ThreadId.make("thread:elsewhere"),
          environmentId: EnvironmentId.make("environment-third"),
        },
        watching: false,
      });

      yield* a.orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:park:production"),
        threadId,
        target: { kind: "production", commitId: "abc1234" },
        title: "commit abc1234",
        watching: true,
        park: { expectedMs: 600_000 },
      });
      const productionRefused = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(productionRefused.message).toContain("commit abc1234");
      expect(productionRefused.message).toContain("SlipJay");
      expect((yield* a.orchestrator.getThreadProjection(threadId)).thread.parkedWaits).toHaveLength(
        1,
      );
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a wait the box could not recreate is named in the thread's first message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const boxTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), boxTurns, boxLinks);
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      // A thread of the box's that is gone there: the wait cannot be set up, and the thread is told.
      yield* a.orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("command:watch:gone-on-box"),
        threadId,
        target: {
          kind: "thread",
          threadId: ThreadId.make("thread:gone-on-box"),
          environmentId: box.environmentId,
        },
        title: "Fix the login on the box",
        watching: true,
      });
      const moved = yield* a.handoff.start({ threadId, environmentId: box.environmentId });
      expect(moved.state).toBe("departed");
      if (moved.state !== "departed") return;
      yield* idle(b.orchestrator, moved.threadId);
      const [firstTurn] = yield* Ref.get(boxTurns);
      expect(firstTurn?.text).toContain(
        "could not move with the thread and need setting up again: watching Fix the login on the box",
      );
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a wait the box cannot keep ends the move naming it, and the thread keeps its waits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      // The box has no link back to the laptop, so it cannot watch the laptop's thread.
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        { get: () => Effect.succeedNone },
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);
      yield* startWaiting(a);

      const failed = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(failed.message).toContain(`not linked to ${laptop.environmentId}`);
      expect(failed.message).toContain("Deploy the fix");
      const here = yield* a.orchestrator.getThreadProjection(threadId);
      expect(here.thread.handoff).toMatchObject({ state: "failed" });
      expect(here.thread.threadWatches).toHaveLength(1);
      expect(here.thread.parkedWaits).toHaveLength(1);
      // Nothing was created on the box.
      expect(
        (yield* b.orchestrator.getShellSnapshot()).threads.filter((shell) =>
          shell.title.includes("Flaky"),
        ),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

const boxWorker = ThreadId.make("thread:box-worker");

/** A thread on the box the laptop's thread watches, which does nothing until a message is sent to it. */
const createBoxWorker = (b: Effect.Success<ReturnType<typeof serveBox>>) =>
  b.orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:create:box-worker"),
    threadId: boxWorker,
    projectId: ProjectId.make("project:box"),
    title: "Fix the login on the box",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });

const sendToBoxWorker = (b: Effect.Success<ReturnType<typeof serveBox>>) =>
  b.orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:send:box-worker"),
    threadId: boxWorker,
    messageId: MessageId.make("message:box-worker:1"),
    text: "Fix it.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });

const watchBoxWorker = (a: Effect.Success<ReturnType<typeof makeLaptop>>, id = "box-worker") =>
  a.orchestrator.dispatch({
    type: "thread.thread-watch",
    commandId: CommandId.make(`command:watch:${id}`),
    threadId,
    target: { kind: "thread", threadId: boxWorker, environmentId: box.environmentId },
    title: "Fix the login on the box",
    watching: true,
  });

/** The wakes the laptop's thread has had from a thread on the box. */
const boxWakes = (a: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  a.orchestrator
    .getThreadRecords(threadId, ["messages"])
    .pipe(
      Effect.map(({ messages }) =>
        messages.filter((message) => message.notification?.source.kind === "thread"),
      ),
    );

const awaitBoxWake = (a: Effect.Success<ReturnType<typeof makeLaptop>>) =>
  awaitOrchestratorState(a.orchestrator, boxWakes(a), (wakes) => wakes.length > 0);

it.live("a thread wakes once when the thread it watches on the box finishes there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "read-only");
      yield* seedThread(a, laptopRepo);
      yield* createBoxWorker(b);
      yield* watchBoxWorker(a);
      // A server that restarted finds the watch it saved.
      yield* a.watches.start();
      expect(yield* boxWakes(a)).toEqual([]);

      yield* sendToBoxWorker(b);
      const [wake] = yield* awaitBoxWake(a);
      expect(wake?.text).toContain(
        `[Fix the login on the box](t3-thread://v2/${box.environmentId}/${boxWorker})`,
      );
      expect(wake?.text).toContain("> box replied.");
      expect(wake?.notification).toMatchObject({
        source: { kind: "thread", threadId: boxWorker, environmentId: box.environmentId },
        outcome: "completed",
      });
      expect((yield* a.orchestrator.getThreadShell(threadId))?.threadWatches ?? []).toEqual([]);
      expect(yield* boxWakes(a)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live(
  "a thread that finished before it was watched wakes at once, started before the watch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { root, laptopRepo, boxRepo } = yield* makeRepos;
        const b = yield* serveBox(
          boxRepo,
          path.join(root, "box-state"),
          yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        );
        const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
        yield* linkTo(a.links, b, "read-only");
        yield* seedThread(a, laptopRepo);
        yield* createBoxWorker(b);
        yield* sendToBoxWorker(b);
        yield* idle(b.orchestrator, boxWorker);
        yield* a.watches.start();
        yield* watchBoxWorker(a);
        const [wake] = yield* awaitBoxWake(a);
        expect(wake?.text).toContain("has finished");
        expect(yield* boxWakes(a)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layerTestHost)),
);

it.live("a dropped link never wakes early, and the watch carries on when it returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
      );
      // The box does not answer until the test lets it, after three calls have failed.
      const restored = yield* Deferred.make<void>();
      const failedThrice = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const a = yield* makeLaptop(
        laptopRepo,
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
        undefined,
        (call) => (request) =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(restored)) return yield* call(request);
            if ((yield* Ref.updateAndGet(calls, (count) => count + 1)) >= 3) {
              yield* Deferred.succeed(failedThrice, undefined);
            }
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The box is not answering.",
            });
          }),
      );
      yield* linkTo(a.links, b, "read-only");
      yield* seedThread(a, laptopRepo);
      yield* createBoxWorker(b);
      yield* sendToBoxWorker(b);
      yield* idle(b.orchestrator, boxWorker);
      yield* watchBoxWorker(a);
      yield* a.watches.start();
      // It keeps trying while the box is down, and has woken nobody.
      yield* Deferred.await(failedThrice);
      expect(yield* boxWakes(a)).toEqual([]);
      expect((yield* a.orchestrator.getThreadShell(threadId))?.threadWatches).toHaveLength(1);

      yield* Deferred.succeed(restored, undefined);
      yield* awaitBoxWake(a);
      expect(yield* boxWakes(a)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a forgotten link or a deleted thread wakes once with why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const b = yield* serveBox(
        boxRepo,
        path.join(root, "box-state"),
        yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
      );
      const a = yield* makeLaptop(laptopRepo, yield* Ref.make<ReadonlyArray<CapturedTurn>>([]));
      yield* linkTo(a.links, b, "read-only");
      yield* seedThread(a, laptopRepo);
      yield* a.watches.start();

      // A thread that is not on the box can never report.
      yield* watchBoxWorker(a);
      const [gone] = yield* awaitBoxWake(a);
      expect(gone?.text).toContain("can no longer be read");
      expect(gone?.notification?.outcome).toBe("unknown");

      // A link forgotten here can never answer.
      yield* createBoxWorker(b);
      yield* a.links.unlink(box.environmentId);
      yield* watchBoxWorker(a, "after-unlink");
      const wakes = yield* awaitOrchestratorState(
        a.orchestrator,
        boxWakes(a),
        (messages) => messages.length > 1,
      );
      expect(wakes[1]?.text).toContain("can no longer be watched");
      expect(wakes).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("an agent's own move waits for its turn to end, and a message before then cancels it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      // The laptop's turns stay open until the test lets one finish; each
      // release lets exactly one waiting turn end.
      const releases = yield* Queue.unbounded<void>();
      const hold = Queue.take(releases);
      const releaseTurn = Queue.offer(releases, undefined);
      const a = yield* makeLaptop(laptopRepo, turns, hold);
      yield* linkTo(a.links, b, "full-access");
      yield* a.handoff.start_();
      yield* createThread(a, laptopRepo);
      const send = (id: string, text: string) =>
        a.orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:send:${id}`),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
      const handoffState = a.orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.thread.handoff?.state ?? null));
      // The agent asks from inside the thread, so the move waits for its turn.
      const askToMove = a.handoff.start({
        callerThreadId: threadId,
        environmentId: box.environmentId,
        continuationPrompt: "SELF_HANDOFF_CONTINUE: run the e2e suite there.",
      });

      // Mid-turn, the agent asks to move: nothing moves yet.
      yield* send("turn-1", "Wrap up and move this to the box.");
      yield* awaitOrchestratorState(
        a.orchestrator,
        a.orchestrator.getThreadProjection(threadId),
        (projection) => projection.runs.some((run) => run.status === "running"),
      );
      expect((yield* askToMove).state).toBe("pending");
      // An agent the user works through steers the same turn before it ends:
      // new instructions win.
      yield* awaitOrchestratorState(
        a.orchestrator,
        a.orchestrator.getThreadProjection(threadId),
        (projection) => projection.providerTurns.some((turn) => turn.status === "running"),
      );
      const running = (yield* a.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "running",
      );
      if (running === undefined) return yield* Effect.die("no running turn");
      yield* a.orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "web",
        commandId: CommandId.make("command:send:steer"),
        threadId,
        messageId: MessageId.make("message:steer"),
        text: "Actually, stay here.",
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: running.id },
      });
      yield* releaseTurn;
      yield* awaitOrchestratorState(a.orchestrator, handoffState, (state) => state === null);
      yield* idle(a.orchestrator, threadId);
      expect(yield* handoffState).toBe(null);

      // Every run that ends settles its thread: with no move, that reads none of its records.
      const readRecords = a.threads.getThreadRecords;
      let recordReads = 0;
      Object.assign(a.threads, {
        getThreadRecords: (...args: Parameters<typeof readRecords>) => {
          recordReads++;
          return readRecords(...args);
        },
      });
      yield* a.handoff.settle(threadId);
      Object.assign(a.threads, { getThreadRecords: readRecords });
      expect(recordReads).toBe(0);

      // Asked again, with nothing after it: it moves once the turn ends.
      yield* send("turn-3", "Now move it.");
      yield* awaitOrchestratorState(
        a.orchestrator,
        a.orchestrator.getThreadProjection(threadId),
        (projection) => projection.runs.some((run) => run.status === "running"),
      );
      expect((yield* askToMove).state).toBe("pending");
      // Settling it while the turn still runs, as a restart's sweep does, leaves it waiting.
      yield* a.handoff.settle(threadId);
      expect(yield* handoffState).toBe("pending");
      yield* releaseTurn;
      yield* awaitOrchestratorState(a.orchestrator, handoffState, (state) => state === "departed");
      const moved = (yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff;
      if (moved?.state !== "departed") return yield* Effect.die("not departed");
      yield* idle(b.orchestrator, moved.threadId);
      // The box's first turn is the agent's own continuation.
      expect((yield* Ref.get(turns)).at(-1)?.text).toContain("SELF_HANDOFF_CONTINUE");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live(
  "a message queued before an agent's move cancels it once the turn ends, and then runs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { root, laptopRepo, boxRepo } = yield* makeRepos;
        const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
        const releases = yield* Queue.unbounded<void>();
        const a = yield* makeLaptop(laptopRepo, turns, Queue.take(releases));
        yield* linkTo(a.links, b, "full-access");
        yield* a.handoff.start_();
        yield* createThread(a, laptopRepo);
        const send = (
          id: string,
          dispatchMode: { readonly type: "start_immediately" | "queue_after_active" },
        ) =>
          a.orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:send:${id}`),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            dispatchMode,
          });

        yield* send("turn-1", { type: "start_immediately" });
        yield* awaitOrchestratorState(
          a.orchestrator,
          a.orchestrator.getThreadProjection(threadId),
          (projection) => projection.runs.some((run) => run.status === "running"),
        );
        // A message already waits behind the turn when the agent asks to move.
        yield* send("queued-turn", { type: "queue_after_active" });
        const pending = yield* a.handoff.start({
          callerThreadId: threadId,
          environmentId: box.environmentId,
        });
        expect(pending.state).toBe("pending");
        yield* Queue.offer(releases, undefined);
        // The queued message wins over the move when the turn ends, and then runs.
        const projection = yield* awaitOrchestratorState(
          a.orchestrator,
          a.orchestrator.getThreadProjection(threadId),
          (current) =>
            current.thread.handoff === undefined &&
            current.runs.filter((run) => run.status !== "queued").length === 2,
        );
        expect(projection.runs.some((run) => run.status === "queued")).toBe(false);
        yield* Queue.offer(releases, undefined);
      }),
    ).pipe(Effect.provide(layerTestHost)),
);

/**
 * The box's answer to the first import never reaches the laptop, as a dropped
 * connection loses it: that import runs once `landed` opens, if ever. Later
 * imports go through.
 */
const dropFirstImportAnswer = (landed: Deferred.Deferred<void>) => {
  let dropped = false;
  return (call: PeerMcpClient.PeerMcpClient["Service"]["call"]): typeof call =>
    (input) => {
      if (input.tool !== "t3_thread_import" || dropped) return call(input);
      dropped = true;
      return Effect.forkDetach(Deferred.await(landed).pipe(Effect.andThen(call(input)))).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            }),
          ),
        ),
      );
    };
};

const flakyThreadsOn = (orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  orchestrator
    .getShellSnapshot()
    .pipe(
      Effect.map((snapshot) => snapshot.threads.filter((shell) => shell.title.includes("Flaky"))),
    );

it.live("a move whose answer was lost stays put until the box shows the thread arrived", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const landed = yield* Deferred.make<void>();
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns, undefined, dropFirstImportAnswer(landed));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);

      const lost = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(lost.message).toBe("The linked environment stopped answering.");
      // The box may still be importing, so the thread here neither runs nor is released.
      expect((yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff).toMatchObject({
        state: "departing",
        lastError: "The linked environment stopped answering.",
      });
      const refused = yield* a.orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:send:while-unanswered"),
          threadId,
          messageId: MessageId.make("message:while-unanswered"),
          text: "Still here?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      expect(refused.message).toContain("Box");

      // The import finishes there; the next check finds it.
      yield* Deferred.succeed(landed, undefined);
      yield* awaitOrchestratorState(
        b.orchestrator,
        flakyThreadsOn(b.orchestrator),
        (found) => found.length > 0,
      );
      yield* a.handoff.settle(threadId);
      const here = (yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff;
      const there = yield* flakyThreadsOn(b.orchestrator);
      expect(there).toHaveLength(1);
      expect(here).toMatchObject({ state: "departed", threadId: there[0]!.id });
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a move whose answer was lost is sent again once the box shows it never arrived", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const never = yield* Deferred.make<void>();
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns, undefined, dropFirstImportAnswer(never));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);

      yield* a.handoff.start({ threadId, environmentId: box.environmentId }).pipe(Effect.flip);
      expect(yield* flakyThreadsOn(b.orchestrator)).toEqual([]);
      yield* a.handoff.settle(threadId);
      const here = (yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff;
      const there = yield* flakyThreadsOn(b.orchestrator);
      expect(there).toHaveLength(1);
      expect(here).toMatchObject({ state: "departed", threadId: there[0]!.id });
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("unlinking the box releases a move it never answered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const never = yield* Deferred.make<void>();
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns, undefined, dropFirstImportAnswer(never));
      yield* linkTo(a.links, b, "full-access");
      yield* seedThread(a, laptopRepo);

      yield* a.handoff.start({ threadId, environmentId: box.environmentId }).pipe(Effect.flip);
      yield* a.links.unlink(box.environmentId);
      yield* a.handoff.settle(threadId);
      const handoff = (yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff;
      expect(handoff?.state).toBe("failed");
      expect(handoff?.state === "failed" ? handoff.lastError : "").toContain("was unlinked");
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

it.live("a link without full access offers no move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, laptopRepo, boxRepo } = yield* makeRepos;
      const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const b = yield* serveBox(boxRepo, path.join(root, "box-state"), turns);
      const a = yield* makeLaptop(laptopRepo, turns);
      yield* linkTo(a.links, b, "auto");
      yield* seedThread(a, laptopRepo);

      const [option] = yield* a.handoff.options(threadId);
      expect(option?.reason).toContain("needs full access");
      const refused = yield* a.handoff
        .start({ threadId, environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(refused.message).toContain("needs full access");
      expect((yield* a.orchestrator.getThreadProjection(threadId)).thread.handoff).toBeUndefined();
    }),
  ).pipe(Effect.provide(layerTestHost)),
);

describe("moveBlocker", () => {
  const thread = {
    agentTask: undefined,
    lineage: { relationshipToParent: null },
    threadWatches: [],
    pullRequests: [],
  } as unknown as Parameters<typeof ThreadHandoff.moveBlocker>[0];

  it("lets a thread with nothing that wakes it move", () => {
    expect(ThreadHandoff.moveBlocker(thread, { pendingBackgroundTasks: [] })).toBe(null);
  });

  it("keeps a delegated task's thread with the thread waiting on it", () => {
    expect(
      ThreadHandoff.moveBlocker(
        { ...thread, lineage: { relationshipToParent: "subagent" } } as typeof thread,
        null,
      ),
    ).toContain("delegated task");
  });

  it("moves with its waits, and names only the work that cannot follow it", () => {
    const watchMirror = {
      kind: "monitor",
      taskId: "thread-watch:w1",
      description: "Watching thread deploy",
    };
    const prMirror = {
      kind: "monitor",
      taskId: "pull-request-watch:github.com/acme/app#12",
      description: "Watching pull request #12",
    };
    const waiting = {
      ...thread,
      threadWatches: [{ title: "deploy", target: { kind: "thread", threadId: "t" } }],
      parkedWaits: [{ title: "tonight", target: { kind: "time", at: "2026-11-12T22:00:00Z" } }],
    } as unknown as typeof thread;
    expect(
      ThreadHandoff.moveBlocker(waiting, {
        pendingBackgroundTasks: [watchMirror, prMirror] as unknown as ReadonlyArray<never>,
      }),
    ).toBe(null);

    const blocked = ThreadHandoff.moveBlocker(
      {
        ...waiting,
        threadWatches: [
          ...(waiting.threadWatches ?? []),
          { title: "SlipJay landing", target: { kind: "landing", operationId: "op" } },
        ],
      } as unknown as typeof thread,
      {
        pendingBackgroundTasks: [
          watchMirror,
          { kind: "command", taskId: "t1", description: "vp test" },
          { kind: "subagent", taskId: "t2", description: "review the diff" },
        ] as unknown as ReadonlyArray<never>,
      },
    );
    expect(blocked).toContain("background command vp test");
    expect(blocked).toContain("delegated task review the diff");
    expect(blocked).toContain('landing "SlipJay landing"');
    expect(blocked).not.toContain("deploy");
    expect(blocked).not.toContain("tonight");
  });
});

describe("continuationMessage", () => {
  it("says where the thread came from, how to resume owned work, then the prompt", () => {
    const message = ThreadHandoff.continuationMessage({
      fromLabel: "Mac",
      fromEnvironmentId: EnvironmentId.make("environment-mac"),
      fromThreadId: ThreadId.make("thread:mac"),
      prompt: "Run the e2e suite.",
    });
    expect(message).toContain(
      "moved here from Mac (environment environment-mac, thread thread:mac)",
    );
    expect(message).toContain("re-claim it from this thread");
    expect(message.endsWith("Run the e2e suite.")).toBe(true);
  });
});
