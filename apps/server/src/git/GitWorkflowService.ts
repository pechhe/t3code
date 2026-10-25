import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  SlipJayCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsSlipJayLandInput,
  type VcsSlipJayLandResult,
  type VcsSlipJayLandingDetailResult,
  type VcsSlipJayLandingLogInput,
  type VcsSlipJayLandingLogResult,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsDriverKind,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    /** A SlipJay landing's runner log, for the operation a workspace's status names. */
    readonly landSlipJay: (
      input: VcsSlipJayLandInput,
    ) => Effect.Effect<VcsSlipJayLandResult, SlipJayCommandError>;
    readonly readSlipJayLandingLog: (
      input: VcsSlipJayLandingLogInput,
    ) => Effect.Effect<VcsSlipJayLandingLogResult, SlipJayCommandError>;
    readonly readSlipJayLandingDetail: (
      input: VcsSlipJayLandingLogInput,
    ) => Effect.Effect<VcsSlipJayLandingDetailResult, SlipJayCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(otherVcsKind?: VcsDriverKind): VcsStatusLocalResult {
  return {
    isRepo: false,
    ...(otherVcsKind === undefined ? {} : { otherVcsKind }),
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(otherVcsKind?: VcsDriverKind): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(otherVcsKind),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const landings = yield* SlipJayLandings.SlipJayLandings;
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return handle;
  });

  const detectRepositoryForStatus = Effect.fn("GitWorkflowService.detectRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      return handle;
    },
  );

  // SlipJay removes a workspace once it lands. Its thread still shows what landed there,
  // without a workspace to land again, until its next message gets a fresh workspace.
  const missingCheckoutStatus = <Status extends VcsStatusLocalResult>(
    cwd: string,
    empty: (otherVcsKind?: VcsDriverKind) => Status,
  ) =>
    landings
      .removedWorkspaceLanding(cwd)
      .pipe(
        Effect.map((landing): Status =>
          landing === undefined
            ? empty()
            : { ...empty("jj"), slipJay: { integration: null, landing } },
        ),
      );

  const driverStatus = (handle: VcsDriverRegistry.VcsDriverHandle | null, input: VcsStatusInput) =>
    handle === null
      ? missingCheckoutStatus(input.cwd, nonRepositoryStatus)
      : handle.driver.getStatus === undefined
        ? Effect.succeed(nonRepositoryStatus(handle.kind))
        : handle.driver.getStatus(input).pipe(
            Effect.mapError(
              (cause) =>
                new GitManagerError({
                  operation: "GitWorkflowService.driverStatus",
                  cwd: input.cwd,
                  detail: "Failed to read repository status through its VCS driver.",
                  cause,
                }),
            ),
            // A SlipJay workspace also shows the landing of its change, if one is in view.
            Effect.flatMap((status) => {
              const slipJay = status.slipJay;
              return slipJay === undefined || slipJay.integration === null
                ? Effect.succeed(status)
                : landings
                    .landingFor(input.cwd, slipJay.integration)
                    .pipe(
                      Effect.map((landing) =>
                        landing === undefined
                          ? status
                          : { ...status, slipJay: { ...slipJay, landing } },
                      ),
                    );
            }),
          );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    isRepository: (cwd) =>
      registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      ),
    hasCommit: (input) =>
      ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      ),
    hasRefNamed: (input) =>
      // Pattern characters would widen the ref match.
      /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          ),
    status: (input) =>
      detectRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git" ? gitManager.status(input) : driverStatus(handle, input),
        ),
      ),
    localStatus: (input) =>
      detectRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle === null
            ? missingCheckoutStatus(input.cwd, nonRepositoryLocalStatus)
            : handle.kind === "git"
              ? gitManager.localStatus(input)
              : handle.driver.getStatus === undefined
                ? Effect.succeed(nonRepositoryLocalStatus(handle.kind))
                : driverStatus(handle, input),
        ),
      ),
    remoteStatus: (input, options) =>
      detectRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.remoteStatus(input, options)
            : handle?.driver.getStatus === undefined
              ? Effect.succeed(null)
              : driverStatus(handle, input).pipe(
                  Effect.map((status) => ({
                    hasUpstream: status.hasUpstream,
                    aheadCount: status.aheadCount,
                    behindCount: status.behindCount,
                    pr: status.pr,
                  })),
                ),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.featureBranch
            ? withCheckoutLease(
                handle.repository.rootPath,
                gitManager.runStackedAction(input, options),
              )
            : gitManager.runStackedAction(input, options),
        ),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: (input) =>
      ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.mode === "local"
            ? withCheckoutLease(
                handle.repository.rootPath,
                gitManager.preparePullRequestThread(input),
              )
            : gitManager.preparePullRequestThread(input),
        ),
      ),
    landSlipJay: (input) => landings.land(input),
    readSlipJayLandingLog: (input) => landings.readLog(input),
    readSlipJayLandingDetail: (input) => landings.readDetail(input),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input, options) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(gitManager.createWorktree(input, options)),
      ),
    listLocalBranchNames: (cwd) =>
      ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      ),
    fetchRemote: (input) =>
      ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    remoteExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      ),
    remoteBranchExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    resolveWorktreeBaseRemote: (input) =>
      ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
        Effect.andThen(git.resolveWorktreeBaseRemote(input)),
      ),
    fetchWorktreeBaseCommit: (input) =>
      ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
        Effect.andThen(git.fetchWorktreeBaseCommit(input)),
      ),
    removeWorktree: (input) =>
      workspaces.remove(input).pipe(
        Effect.mapError((cause) =>
          cause._tag === "GitCommandError"
            ? cause
            : new GitCommandError({
                operation: "GitWorkflowService.removeWorktree",
                command: "workspace-remove",
                cwd: input.cwd,
                detail: "Failed to remove workspace.",
                cause,
              }),
        ),
      ),
    pruneWorktrees: (input) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      ),
    deleteLocalBranch: (input) =>
      ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
