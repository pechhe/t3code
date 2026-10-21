import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2WorkspaceAttachment,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeMcpHandoffInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceAttachments from "../orchestration-v2/WorkspaceAttachments.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const environmentId = EnvironmentId.make("environment-worktree-test");
const threadId = ThreadId.make("thread-worktree-test");
const projectId = ProjectId.make("project-worktree-test");
const workspaceRoot = "/repo/project";

const makeScope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-worktree-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-worktree-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities,
  issuedAt: 1,
});

interface ThreadFixture {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly workspaceAttachments?: ReadonlyArray<OrchestrationV2WorkspaceAttachment>;
}

const otherProjectId = ProjectId.make("project-worktree-other");
const otherProject = {
  id: otherProjectId,
  title: "Other project",
  workspaceRoot: "/repo/other",
  scripts: [],
} as unknown as Project;

const makeProjection = (overrides: ThreadFixture = {}): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Worktree test thread",
      branch: null,
      worktreePath: null,
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    },
  }) as OrchestrationV2ThreadProjection;

const project: Project = {
  id: projectId,
  title: "Worktree test project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} as Project;

interface HarnessOptions {
  /** The project allocates its workspaces through SlipJay. */
  readonly slipjay?: boolean;
  readonly git?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly thread?: ThreadFixture | null;
  readonly threadReadError?: "projection" | "dispatch";
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly currentBranch?: string | null;
  readonly notARepo?: boolean;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly setupScript?: "started" | "no-script" | "fails" | "dies";
  readonly dispatchFails?: boolean;
  readonly dispatchDies?: boolean;
  readonly dispatchInterrupts?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
  readonly threadAttachedOnRecheck?: boolean;
  readonly threadArchivedOnRecheck?: boolean;
  readonly threadReadFailsOnRecheck?: boolean;
  readonly continuation?: "queued" | "fails" | "dies";
  readonly projectMissing?: boolean;
  readonly projectReadFails?: boolean;
  readonly existingBranchWorktreePath?: string | null;
  readonly createWorktreeFails?: boolean;
  readonly fetchWorktreeBaseFails?: boolean;
  readonly worktreeBaseMissing?: boolean;
  readonly removeWorktreeFails?: boolean;
  readonly deleteLocalBranchFails?: boolean;
  readonly createWorktreeGate?: Effect.Effect<void>;
  /** Whether a path is a checkout of the project's repository. */
  readonly contains?: boolean;
  /** Threads already holding the adopted path as an attachment. */
  readonly holders?: ReadonlyArray<ThreadId>;
  /** Another thread of the project that can attach through the same service. */
  readonly peerThreadId?: ThreadId;
  /** Holders are the other threads whose recorded attachments include the path. */
  readonly holdersFromAttachments?: boolean;
  /** Held open by the first holders lookup. */
  readonly holdersGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const thread = options.thread === undefined ? {} : options.thread;
  const scope = makeScope(options.capabilities ?? new Set(["preview", "worktree"]));
  // Attachments each thread holds, including those this test's attach commands recorded.
  const attachmentsByThread = new Map<ThreadId, Array<OrchestrationV2WorkspaceAttachment>>([
    [threadId, [...((thread === null ? undefined : thread.workspaceAttachments) ?? [])]],
  ]);
  const attachmentsOf = (id: ThreadId) => {
    const held = attachmentsByThread.get(id) ?? [];
    attachmentsByThread.set(id, held);
    return held;
  };
  const dispatch = vi.fn((command: unknown) =>
    Effect.sync(() => {
      const update = command as Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "thread.workspace-attachment.update" }
      >;
      if (update.type === "thread.workspace-attachment.update" && update.change.action === "attach")
        attachmentsOf(update.threadId).push({
          ...update.change.attachment,
          attachedAt: "2026-01-02T00:00:00.000Z",
          releasedAt: null,
        });
    }).pipe(
      Effect.andThen(options.dispatchGate ?? Effect.void),
      Effect.andThen(
        options.dispatchInterrupts
          ? (Effect.failCause(Cause.interrupt()) as never)
          : options.dispatchDies
            ? Effect.die(new Error("dispatch defect"))
            : options.dispatchFails
              ? (Effect.fail("simulated dispatch failure") as never)
              : Effect.succeed({ sequence: 1, storedEvents: [] }),
      ),
    ),
  );
  const withAttachments = (fixture: ThreadFixture, id: ThreadId) => {
    const attachments = attachmentsOf(id);
    return makeProjection(
      attachments.length === 0 ? fixture : { ...fixture, workspaceAttachments: attachments },
    );
  };
  const holders = vi.fn((input: { readonly workspacePath: string; readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      const found =
        options.holdersFromAttachments === true
          ? [...attachmentsByThread]
              .filter(
                ([id, held]) =>
                  id !== input.threadId &&
                  held.some((attachment) => attachment.workspacePath === input.workspacePath),
              )
              .map(([id]) => id)
          : (options.holders ?? []);
      // The first lookup answers from what it read before being held open.
      if (holders.mock.calls.length === 1) yield* options.holdersGate ?? Effect.void;
      return found;
    }),
  );
  const listLocalBranchNames = vi.fn((_: string) =>
    Effect.succeed(
      options.existingBranchWorktreePath === undefined
        ? ["dev"]
        : ["dev", "feature/taken", "feature/taken-idle"],
    ),
  );
  const getThreadRecords = vi.fn((id: ThreadId) => {
    if (options.threadReadError === "dispatch") {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:read"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (options.threadReadFailsOnRecheck === true && getThreadRecords.mock.calls.length > 1) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:recheck"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (
      options.threadAttachedOnRecheck === true &&
      getThreadRecords.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(
        makeProjection({ ...thread, worktreePath: "/worktrees/project/raced" }),
      );
    }
    if (
      options.threadArchivedOnRecheck === true &&
      getThreadRecords.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, archivedAt: "2026-01-02T00:00:00.000Z" }));
    }
    return (id === threadId || id === options.peerThreadId) && thread !== null
      ? Effect.succeed(withAttachments(thread, id))
      : Effect.fail(new OrchestratorProjectionError({ threadId: id }));
  });
  const sendToThread = vi.fn((_: unknown) => {
    switch (options.continuation ?? "queued") {
      case "fails":
        return Effect.fail(
          new ThreadManagementService.ThreadManagementThreadArchivedError({
            threadId,
          }),
        );
      case "dies":
        return Effect.die(new Error("send defect"));
      default:
        return Effect.succeed({
          delivery: "queued",
        } as ThreadManagementService.ThreadManagementSendResult);
    }
  });
  const getById = vi.fn((id: ProjectId) =>
    options.projectReadFails
      ? (Effect.fail("simulated project read failure") as never)
      : Effect.succeed(
          id === projectId && options.projectMissing !== true
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
  );
  const removeWorktree = vi.fn((_: unknown) =>
    options.removeWorktreeFails
      ? (Effect.fail("simulated worktree removal failure") as never)
      : Effect.void,
  );
  const deleteLocalBranch = vi.fn((_: unknown) =>
    options.deleteLocalBranchFails
      ? (Effect.fail("simulated local branch deletion failure") as never)
      : Effect.void,
  );
  const fetchWorktreeBaseCommit = vi.fn((_: unknown) =>
    options.fetchWorktreeBaseFails
      ? (Effect.fail("simulated fetch failure") as never)
      : options.worktreeBaseMissing
        ? Effect.succeed(null)
        : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly path: string | null }) =>
      options.createWorktreeFails
        ? (Effect.fail("simulated worktree creation failure") as never)
        : (options.createWorktreeGate ?? Effect.void).pipe(
            Effect.andThen(
              Effect.succeed({
                worktree: {
                  path: input.path ?? `/worktrees/project/${input.newRefName}`,
                  refName: input.newRefName ?? "detached",
                },
              }),
            ),
          ),
  );
  const listRefs = vi.fn((input: { readonly query?: string | undefined }) =>
    Effect.succeed({
      refs:
        options.existingBranchWorktreePath === undefined
          ? []
          : [
              {
                name: input.query ?? "",
                current: false,
                isDefault: false,
                worktreePath: options.existingBranchWorktreePath,
              },
            ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: options.existingBranchWorktreePath === undefined ? 0 : 1,
    }),
  );
  const localStatus = vi.fn((_: unknown) =>
    Effect.succeed({
      isRepo: options.notARepo !== true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: options.currentBranch === undefined ? "dev" : options.currentBranch,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
  );
  const refreshStatus = vi.fn((_: string) => Effect.die("refreshStatus stub"));
  const runForThread = vi.fn((input: { readonly worktreePath: string }) => {
    switch (options.setupScript ?? "started") {
      case "no-script":
        return Effect.succeed({ status: "no-script" } as const);
      case "dies":
        return Effect.die(new Error("setup runner defect"));
      case "fails":
        return Effect.fail(
          new ProjectSetupScriptRunner.ProjectSetupScriptProjectNotFoundError({
            threadId,
            worktreePath: input.worktreePath,
          }),
        );
      default:
        return Effect.succeed({
          status: "started",
          async: false,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup-terminal",
          cwd: input.worktreePath,
        } as const);
    }
  });

  const allocateWorkspace = vi.fn(
    (_input: Parameters<WorkspaceProvider.WorkspaceProvider["Service"]["allocate"]>[0]) =>
      Effect.succeed({
        workspacePath: "/slipjay/workspaces/feature-handoff",
        created: true,
        issue: null,
      }),
  );
  const releaseWorkspace = vi.fn(
    (_input: Parameters<WorkspaceProvider.WorkspaceProvider["Service"]["release"]>[0]) =>
      Effect.void,
  );

  const detachAttachment = vi.fn(
    (_input: Parameters<WorkspaceAttachments.WorkspaceAttachments["Service"]["detach"]>[0]) =>
      Effect.void,
  );

  const layer = WorktreeMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch,
          getThreadRecords,
          sendToThread,
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById,
          listShells: () => Effect.succeed([project, otherProject] as never),
        } satisfies Partial<ProjectService.ProjectService["Service"]>),
        ServerSettings.layerTest({
          newWorktreesStartFromOrigin: options.newWorktreesStartFromOrigin ?? false,
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listRefs,
          listLocalBranchNames,
          localStatus,
          fetchWorktreeBaseCommit,
          createWorktree,
          removeWorktree,
          deleteLocalBranch,
          ...options.git,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread,
        } satisfies Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]>),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus,
        } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
        Layer.succeed(WorkspaceProvider.WorkspaceProvider, {
          resolve: () => Effect.succeed(options.slipjay === true ? "slipjay" : "git-worktree"),
          allocate: allocateWorkspace,
          release: releaseWorkspace,
          // Each project's repository holds the paths under its root's name.
          contains: (root, path) =>
            Effect.succeed(
              options.contains ??
                (root === otherProject.workspaceRoot) === path.startsWith("/repo/other"),
            ),
          remove: removeWorktree,
        }),
        Layer.mock(WorkspaceAttachments.WorkspaceAttachments)({
          holders,
          markReleased: () => Effect.void,
          detach: detachAttachment,
        }),
        NodeServices.layer,
      ),
    ),
  );

  return {
    layer,
    scope,
    dispatch,
    holders,
    sendToThread,
    fetchWorktreeBaseCommit,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    localStatus,
    runForThread,
    allocateWorkspace,
    releaseWorkspace,
    detachAttachment,
  };
};

const expectTypedFailure = (exit: Exit.Exit<unknown, unknown>, expected: object): void => {
  if (!Exit.isFailure(exit)) {
    expect.fail(`Expected a failure exit, got: ${JSON.stringify(exit)}`);
  }
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") {
    expect.fail(`Expected a typed Fail cause, got: ${reason?._tag ?? "no reason"}`);
  }
  expect(reason.error).toMatchObject(expected);
};

// Resolves the service once from the harness layer; used by tests that must
// make several calls against the SAME instance (the in-flight guard lives in
// the layer's closure, so a fresh layer per call would never see it).
const resolveService = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    return yield* WorktreeMcpService.WorktreeMcpService;
  }).pipe(Effect.provide(harness.layer));

const runHandoff = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService.WorktreeMcpService["Service"]["handoff"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.handoff(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runAttach = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService.WorktreeMcpService["Service"]["attach"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.attach(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runStatus = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.status(harness.scope);
  }).pipe(Effect.provide(harness.layer));

// Decodes tool arguments the way the MCP tool does before calling the service.
const decodeHandoffInput = Schema.decodeUnknownEffect(WorktreeMcpHandoffInput);

describe("t3_worktree_handoff", () => {
  it.effect("reports a continuation failure without failing the handoff", () => {
    const harness = makeHarness({ continuation: "fails" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue-fails",
        continuationPrompt: "Keep going.",
      });
      expect(result.continuation).toMatchObject({ status: "failed" });
      expect(result.worktreePath).toBe("/worktrees/project/feature/continue-fails");
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });

  it.effect("does not queue a continuation when the thread update fails", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, {
          branch: "feature/dispatch-fails-continue",
          continuationPrompt: "Keep going.",
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("uses the fetched commit and remote PR base for an explicit local alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "handoff-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote base"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "local only"]);
      const harness = makeHarness({
        git: {
          fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
          createWorktree: (input) => git.createWorktree({ ...input, cwd, path: worktreePath }),
        },
      });
      const result = yield* runHandoff(harness, {
        branch: "feature/from-remote",
        baseRef: "stable",
        startFromOrigin: true,
        runSetupScript: false,
      });

      expect(result.worktreePath).toBe(worktreePath);
      expect(result.startedFromOrigin).toBe(true);
      expect(result.setupScript).toEqual({ status: "skipped" });
      expect((yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
      const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
      const comparisonBase = preview.sources.find(
        (source) => source.kind === "branch-range",
      )!.baseRef;
      expect(
        (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
      ).toBe(remoteHead);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "handoff-remote-git-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("moves a thread that is already attached to a worktree", () => {
    const harness = makeHarness({
      thread: { branch: "feature/existing", worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/second" });
      expect(result.worktreePath).toBe("/worktrees/project/feature/second");
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: "/worktrees/project/feature/second",
          expectedWorktreePath: "/worktrees/project/existing",
        }),
      );
    });
  });

  it.effect("attaches a released SlipJay thread to a workspace it allocated itself", () => {
    const harness = makeHarness({
      slipjay: true,
      thread: { worktreePath: "/slipjay/workspaces/released" },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { worktreePath: "/slipjay/workspaces/ys-2333" });
      expect(result).toMatchObject({
        worktreePath: "/slipjay/workspaces/ys-2333",
        branch: null,
        setupScript: { status: "skipped" },
      });
      expect(harness.allocateWorkspace).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: "/slipjay/workspaces/ys-2333",
          branch: null,
          expectedWorktreePath: "/slipjay/workspaces/released",
        }),
      );
    });
  });

  it.effect("attaches an existing git worktree on its current branch", () => {
    const harness = makeHarness({ currentBranch: "feature/elsewhere" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { worktreePath: "/worktrees/project/elsewhere" });
      expect(result.branch).toBe("feature/elsewhere");
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("refuses to attach a path outside the project's repository", () => {
    const harness = makeHarness({ contains: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { worktreePath: "/elsewhere/repo" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("needs a branch or an existing worktree", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, {}));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
    });
  });

  it.effect("rejects an existing branch with an actionable error naming its checkout", () => {
    const harness = makeHarness({ existingBranchWorktreePath: "/elsewhere/checkout" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/taken" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      const reason = exit.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      const error = (reason as { readonly error: { code: string; message: string } }).error;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("feature/taken");
      expect(error.message).toContain("already exists");
      expect(error.message).toContain("/elsewhere/checkout");
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.fetchWorktreeBaseCommit).not.toHaveBeenCalled();
    });
  });

  it.effect("does not trip the pre-flight on similarly named branches", () => {
    const harness = makeHarness({ existingBranchWorktreePath: null });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/take" });
      expect(result.branch).toBe("feature/take");
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("propagates an interrupted dispatch without rolling back the worktree", () => {
    const harness = makeHarness({ dispatchInterrupts: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-int" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("falls back to the local base when no remote holds it", () => {
    const harness = makeHarness({ worktreeBaseMissing: true });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/local-fallback",
        baseRef: "dev",
        startFromOrigin: true,
      });
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ refName: "dev", baseRefName: "dev" }),
      );
      expect(result.startedFromOrigin).toBe(false);
    });
  });

  it.effect("removes the created worktree when the thread update dies with a defect", () => {
    const harness = makeHarness({ dispatchDies: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-defect" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/dispatch-defect",
        force: true,
      });
    });
  });

  it.effect("re-checks attachment after creating the worktree and backs out on a race", () => {
    const harness = makeHarness({ threadAttachedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/raced" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "handoff_in_progress" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/raced",
        force: true,
      });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/raced",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the recheck read fails", () => {
    const harness = makeHarness({ threadReadFailsOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/recheck-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/recheck-fails",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("backs out when the thread is archived during worktree creation", () => {
    const harness = makeHarness({ threadArchivedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/archived-race" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/archived-race",
        force: true,
      });
    });
  });

  it.effect("queues the continuation even when interrupted during the binding dispatch", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ dispatchGate: Deferred.await(gate) });

      const fiber = yield* Effect.forkChild(
        runHandoff(harness, {
          branch: "feature/interrupted",
          continuationPrompt: "Keep going in the worktree.",
        }),
      );
      yield* Effect.yieldNow;
      const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      yield* Fiber.join(interruption);

      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.sendToThread).toHaveBeenCalledTimes(1);
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("creates the worktree in the managed directory even when a call names a path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const input = yield* decodeHandoffInput({
        branch: "feature/elsewhere",
        path: "/home/user/.ssh/checkout",
      });
      const result = yield* runHandoff(harness, input);
      expect(harness.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: null }));
      expect(result.worktreePath).toBe("/worktrees/project/feature/elsewhere");
    });
  });

  it.effect("releases the per-thread guard after a failed handoff", () => {
    const harness = makeHarness({
      thread: { archivedAt: "2026-01-02T00:00:00.000Z" },
    });
    return Effect.gen(function* () {
      const service = yield* resolveService(harness);

      const first = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-1" }),
      );
      expectTypedFailure(first, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
    });
  });

  it.effect("serializes concurrent handoffs for the same thread", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ createWorktreeGate: Deferred.await(gate) });

      const service = yield* resolveService(harness);

      const first = yield* Effect.forkChild(
        Effect.exit(service.handoff(harness.scope, { branch: "feature/race-1" })),
      );
      yield* Effect.yieldNow;

      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/race-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "handoff_in_progress" });

      yield* Deferred.succeed(gate, undefined);
      const firstExit = yield* Fiber.join(first);
      expect(Exit.isSuccess(firstExit)).toBe(true);
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("allocates a SlipJay workspace named after the branch", () => {
    const harness = makeHarness({ slipjay: true });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/handoff" });

      expect(result).toMatchObject({
        worktreePath: "/slipjay/workspaces/feature-handoff",
        branch: null,
        baseRef: null,
        startedFromOrigin: false,
      });
      expect(harness.allocateWorkspace).toHaveBeenCalledWith({
        projectRoot: workspaceRoot,
        task: "feature/handoff",
      });
      expect(harness.localStatus).not.toHaveBeenCalled();
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          branch: null,
          worktreePath: "/slipjay/workspaces/feature-handoff",
        }),
      );
    });
  });

  it.effect("releases the SlipJay workspace when the thread update fails", () => {
    const harness = makeHarness({ slipjay: true, dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/handoff" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.releaseWorkspace).toHaveBeenCalledWith({
        projectRoot: workspaceRoot,
        path: "/slipjay/workspaces/feature-handoff",
      });
      expect(harness.removeWorktree).not.toHaveBeenCalled();
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
    });
  });

  it.effect("reports a setup script defect without failing the handoff", () => {
    const harness = makeHarness({ setupScript: "dies" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/setup-dies" });
      expect(result.setupScript).toEqual({ status: "failed", detail: "setup runner defect" });
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });
});

describe("t3_worktree_status", () => {
  it.effect("reports an attached thread's worktree and branch", () => {
    const harness = makeHarness({
      thread: {
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
      },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
        defaultStartFromOrigin: false,
      });
    });
  });
});

describe("WorktreeMcpHandoffInput schema", () => {
  const decode = Schema.decodeUnknownEffect(WorktreeMcpHandoffInput);

  it.effect("rejects a blank branch or a relative worktreePath", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(decode({ branch: "   " })))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(decode({ worktreePath: "ws/x" })))).toBe(true);
    }),
  );

  describe("attached workspaces", () => {
    const held = (workspacePath: string): OrchestrationV2WorkspaceAttachment => ({
      projectId: otherProjectId,
      workspacePath,
      branch: null,
      origin: "allocated",
      attachedAt: "2026-01-01T00:00:00.000Z",
      releasedAt: null,
    });

    it.effect("allocates a SlipJay workspace in another project and attaches it", () => {
      const harness = makeHarness({ slipjay: true });
      return Effect.gen(function* () {
        const result = yield* runAttach(harness, { projectId: otherProjectId, branch: "api" });
        expect(harness.allocateWorkspace).toHaveBeenCalledWith({
          projectRoot: "/repo/other",
          task: "api",
        });
        expect(result.attachment).toMatchObject({
          projectId: otherProjectId,
          workspacePath: "/slipjay/workspaces/feature-handoff",
          origin: "allocated",
        });
        expect(result.setupScript).toMatchObject({ status: "started" });
        const status = yield* runStatus(harness);
        expect(status.attachments.map((attachment) => attachment.workspacePath)).toEqual([
          "/slipjay/workspaces/feature-handoff",
        ]);
      });
    });

    it.effect("adopts an existing checkout, finding its project from the path", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const result = yield* runAttach(harness, { worktreePath: "/repo/other-checkout" });
        expect(result.attachment).toMatchObject({
          projectId: otherProjectId,
          workspacePath: "/repo/other-checkout",
          origin: "adopted",
        });
        expect(result.setupScript).toEqual({ status: "skipped" });
        expect(harness.createWorktree).not.toHaveBeenCalled();
      });
    });

    it.effect("refuses the thread's own project, a second live workspace, and a held one", () => {
      const own = makeHarness();
      const twice = makeHarness({ thread: { workspaceAttachments: [held("/repo/other-1")] } });
      const taken = makeHarness({ holders: [ThreadId.make("thread-other-lead")] });
      return Effect.gen(function* () {
        const home = yield* Effect.flip(runAttach(own, { projectId, branch: "x" }));
        expect(home.message).toContain("t3_worktree_handoff");
        const second = yield* Effect.flip(
          runAttach(twice, { projectId: otherProjectId, branch: "y" }),
        );
        expect(second.message).toContain("already holds /repo/other-1");
        const holder = yield* Effect.flip(runAttach(taken, { worktreePath: "/repo/other-2" }));
        expect(holder.message).toContain("attached to another thread");
        expect([...own.dispatch.mock.calls, ...twice.dispatch.mock.calls]).toEqual([]);
        expect(taken.dispatch).not.toHaveBeenCalled();
      });
    });

    it.effect("lets only one of two threads adopting a checkout at once attach it", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const lookupStarted = yield* Deferred.make<void>();
        const peer = ThreadId.make("thread-peer-lead");
        const harness = makeHarness({
          peerThreadId: peer,
          holdersFromAttachments: true,
          holdersGate: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
          ),
        });
        const peerScope = {
          ...harness.scope,
          thread: { ...harness.scope.thread!, threadId: peer },
        } as McpInvocationContext.McpInvocationScope;
        const input = { worktreePath: "/repo/other-2" };
        yield* Effect.gen(function* () {
          const service = yield* WorktreeMcpService.WorktreeMcpService;
          const first = yield* Effect.forkChild(Effect.exit(service.attach(harness.scope, input)), {
            startImmediately: true,
          });
          // The first adoption holds its lookup open; the peer's must not run beside it.
          yield* Deferred.await(lookupStarted);
          const second = yield* Effect.forkChild(Effect.exit(service.attach(peerScope, input)), {
            startImmediately: true,
          });
          yield* Deferred.succeed(gate, undefined);
          const exits = [yield* Fiber.join(first), yield* Fiber.join(second)];
          expect(exits.map((exit) => exit._tag)).toEqual(["Success", "Failure"]);
          expect(String(Exit.isFailure(exits[1]!) ? exits[1].cause : "")).toContain(
            "attached to another thread",
          );
        }).pipe(Effect.provide(harness.layer));
        expect(harness.dispatch).toHaveBeenCalledTimes(1);
      }),
    );

    it.effect("detaches through the attachment service and reports a release", () => {
      const harness = makeHarness({ thread: { workspaceAttachments: [held("/repo/other-1")] } });
      return Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const service = yield* WorktreeMcpService.WorktreeMcpService;
          return yield* service.detach(harness.scope, { workspacePath: "/repo/other-1" });
        }).pipe(Effect.provide(harness.layer));
        expect(result).toEqual({ released: true });
        expect(harness.detachAttachment).toHaveBeenCalledWith({
          threadId,
          workspacePath: "/repo/other-1",
        });
      });
    });
  });
});
