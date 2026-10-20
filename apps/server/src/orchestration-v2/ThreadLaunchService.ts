import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type AgentTaskBinding,
  CommandId,
  type GitCommandError,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ThreadProjection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkspaceAttachments from "./WorkspaceAttachments.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
      readonly buildItem?: number | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly agentTask?: AgentTaskBinding;
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  /**
   * Set when `root` only means no checkout was chosen, as for a client draft or
   * an MCP launch without a strategy: a SlipJay project then gives the thread its
   * own workspace. Without it, `root` runs on the project root.
   */
  readonly rootIsDefault?: boolean;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  /** A thread that watches the new one, from before its first message, so no finish is missed. */
  readonly watchedBy?: ThreadId;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "workspaceStrategy" | "initialMessage" | "agentTask"
> & {
  readonly reusedWorktree?: { readonly baseRef: string };
};

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "watch-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * `launch` accepts such a launch and reports the failure inside the
     * thread; a caller that needs it before a thread exists checks first.
     */
    readonly checkWorktreeBase: (
      input: Pick<ThreadLaunchInput, "projectId" | "workspaceStrategy">,
    ) => Effect.Effect<void, ThreadLaunchBaseRefError>;
    readonly retryPreparation: (
      input: ThreadLaunchPreparationInput,
    ) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    readonly prepareRun: (input: ThreadLaunchPreparationInput) => Effect.Effect<void>;
    /**
     * Sends a run that is about to start back to workspace preparation when
     * SlipJay released its thread's workspace, as Land does, so it runs in a
     * fresh workspace like a first message. Reports whether it did; a failure
     * leaves the run starting, so the caller can retry.
     */
    readonly prepareReleasedWorkspace: (
      input: ThreadLaunchPreparationInput,
    ) => Effect.Effect<
      boolean,
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
      | ProjectService.ProjectOperationError
    >;
    /**
     * Where a terminal of the thread opens. When SlipJay released the thread's workspace,
     * the thread is moved to a fresh one first and the terminal opens there; any failure
     * leaves the requested directory, which the terminal then reports as missing.
     */
    readonly terminalCwd: (input: {
      readonly threadId: string;
      readonly cwd: string;
      readonly worktreePath?: string | null | undefined;
    }) => Effect.Effect<{ readonly cwd: string; readonly worktreePath: string | null }>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: PreparationInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.type !== "worktree" || strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = project.workspaceRoot;
      // SlipJay always starts from the integration branch.
      if ((yield* workspaces.resolve(cwd)) === "slipjay") return undefined;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      if (
        strategy.startFromOrigin === true &&
        (yield* git.resolveWorktreeBaseRemote({ cwd, refName: baseRef })) !== null
      )
        return undefined;
      // `git worktree add` also starts from a remote-tracking branch of that
      // name; any ref carrying it is reason enough to let Git decide.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" })) ? project : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  /**
   * The Build item a thread works under: its HQ link, or else the item its workspace was
   * attached to, which needs no HQ connection.
   */
  const threadBuildItem = Effect.fn("ThreadLaunchService.threadBuildItem")(function* (
    threadId: ThreadId,
  ) {
    const { thread } = yield* threads.getThreadRecords(threadId, []);
    return thread.workItem?.number ?? thread.workspaceIssue ?? undefined;
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const reused = input.reusedWorktree;
    const tracked = input.workspaceStrategy.type === "worktree" || reused !== undefined;
    let createdWorktreePath: string | null = null;
    let createdBySlipJay = false;
    let workspaceIssue: number | null = null;
    // The workspace the thread was bound to when a SlipJay checkout was chosen for it.
    let boundWorktreePath: string | null | undefined;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    let runReleased = false;
    // The background branch rename records the worktree again when it lands,
    // so cleanup stops it before forgetting a removed worktree.
    let branchRename: Fiber.Fiber<unknown> | null = null;
    if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = Effect.fn("ThreadLaunchService.generateBranchNameFor")(
        function* (cwd: string, message: ThreadLaunchInitialMessage) {
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                  input.projectId,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              message: message.text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
            })
            .pipe(
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        },
      );

      const requestedBranch = input.workspaceStrategy.branch;
      let branch: string | null;
      if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
        const uuid = yield* randomUuidV4;
        branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
      } else {
        branch = requestedBranch ?? null;
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      if (input.workspaceStrategy.type === "worktree" && runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:worktree`),
            threadId,
            runId,
            phase: "worktree",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      const slipjay =
        input.workspaceStrategy.type === "worktree" &&
        (yield* workspaces.resolve(project.workspaceRoot)) === "slipjay";
      if (slipjay) {
        // SlipJay names the workspace after the task and starts it from the
        // integration branch, so there is no branch to fetch, name or rename.
        yield* setupTracker.stageStatus(threadId, "fetch", "skipped");
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        const task =
          requestedBranch ?? initialMessage?.text.trim().split("\n")[0]?.slice(0, 80) ?? "";
        // A thread launched for a Build item works in that item's workspace. A thread that
        // already belongs to one, such as one replacing a workspace SlipJay removed, gets a
        // new checkout carrying the item, since the item's workspace may be another thread's.
        const buildItem = input.workspaceStrategy.buildItem;
        const owned = buildItem === undefined ? yield* threadBuildItem(threadId) : undefined;
        const issue =
          buildItem !== undefined
            ? { number: buildItem, mode: "resume" as const }
            : owned !== undefined
              ? { number: owned, mode: "attach" as const }
              : undefined;
        // A terminal recovering the same released workspace may have rebound the thread
        // since this run was scheduled. Its checkout stands: a second one would leave the
        // terminal in a workspace the thread is no longer bound to.
        const bound = (yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId))))?.worktreePath;
        boundWorktreePath = bound ?? null;
        if (
          bound != null &&
          (yield* workspaces
            .contains(project.workspaceRoot, bound)
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          worktreePath = bound;
          branch = null;
        } else {
          // SlipJay reports the path after dependency preparation. Keep acquisition
          // and rollback registration atomic, so cancellation cannot lose that path.
          // A resumed Build item workspace predates this launch, so cancelling never removes it.
          yield* Effect.gen(function* () {
            const allocation = yield* workspaces
              .allocate({
                projectRoot: project.workspaceRoot,
                task: task || "T3 thread",
                ...(issue === undefined ? {} : { issue }),
              })
              .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
            worktreePath = allocation.workspacePath;
            branch = null;
            workspaceIssue = allocation.issue;
            if (allocation.created) {
              createdWorktreePath = worktreePath;
              createdBySlipJay = true;
            }
          }).pipe(Effect.uninterruptible);
        }
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      } else if (input.workspaceStrategy.type === "worktree") {
        let startRef = input.workspaceStrategy.baseRef;
        let baseRefName = input.workspaceStrategy.baseRef;
        const shouldFetch =
          input.workspaceStrategy.startFromOrigin === true &&
          (yield* git
            .resolveWorktreeBaseRemote({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)))) !== null;
        yield* setupTracker.stageStatus(threadId, "fetch", shouldFetch ? "running" : "skipped");
        if (shouldFetch) {
          const remoteBase = yield* git
            .fetchWorktreeBaseCommit({
              cwd: project.workspaceRoot,
              refName: input.workspaceStrategy.baseRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBase !== null) {
            startRef = remoteBase.commitSha;
            baseRefName = `refs/remotes/${remoteBase.remoteRefName}`;
          }
        }
        if (shouldFetch) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        if (
          branch !== null &&
          isTemporaryWorktreeBranch(branch) &&
          (yield* git
            .hasCommit({
              cwd: project.workspaceRoot,
              refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          branch = flattenTemporaryWorktreeBranchName(branch);
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        const worktree = yield* git
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: startRef,
              newRefName: branch!,
              baseRefName,
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (path) =>
                  Effect.sync(() => {
                    createdWorktreePath = path;
                  }),
                onCheckoutProgress: (progress) =>
                  setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
              },
            },
          )
          .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        worktreePath = worktree.worktree.path;
        branch = worktree.worktree.refName;
        createdWorktreePath = worktreePath;
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      }

      // A reused worktree is already recorded, and rewriting it could undo
      // the first attempt's branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
            ...(workspaceIssue === null ? {} : { workspaceIssue }),
            // Compare-and-set, so a terminal that rebound the thread while this run
            // allocated keeps its checkout; the run then adopts that checkout.
            ...(boundWorktreePath === undefined ? {} : { expectedWorktreePath: boundWorktreePath }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const current = (yield* threads.getThreadShell(threadId))?.worktreePath;
                if (
                  boundWorktreePath === undefined ||
                  current == null ||
                  current === boundWorktreePath ||
                  !(yield* workspaces.contains(project.workspaceRoot, current))
                ) {
                  return yield* error;
                }
                if (createdBySlipJay && createdWorktreePath !== null) {
                  yield* workspaces
                    .release({ projectRoot: project.workspaceRoot, path: createdWorktreePath })
                    .pipe(Effect.ignoreCause({ log: true }));
                }
                createdWorktreePath = null;
                createdBySlipJay = false;
                worktreePath = current;
                branch = null;
                workspaceIssue = null;
              }),
            ),
            Effect.mapError(mapError(input, "update-thread", threadId)),
          );
      }
      workspaceRecorded = true;

      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        isTemporaryWorktreeBranch(branch)
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        branchRename = yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            git.renameBranch({
              cwd: worktreeCwd,
              oldBranch,
              newBranch,
              ...(exactName ? { exactName: true } : {}),
            }),
          ),
          Effect.flatMap((renamed) =>
            Effect.gen(function* () {
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:branch-rename`),
                  threadId,
                  branch: renamed.branch,
                  worktreePath: worktreeCwd,
                  expectedBranch: oldBranch,
                  expectedWorktreePath: worktreeCwd,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Parent thread worktree branch update failed", {
                      threadId,
                      cause,
                    }),
                  ),
                );
              // Updating the parent first makes later subagents inherit the new name.
              // Re-read after each pass for children of subagents updated in that pass.
              const visited = new Set([threadId]);
              while (true) {
                const snapshot = yield* threads.getShellSnapshot();
                const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
                  (thread) =>
                    !visited.has(thread.id) &&
                    thread.worktreePath === worktreeCwd &&
                    thread.branch === oldBranch,
                );
                if (sharing.length === 0) break;
                for (const thread of sharing) {
                  visited.add(thread.id);
                  yield* threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:branch-rename:${thread.id}`),
                      threadId: thread.id,
                      branch: renamed.branch,
                      expectedBranch: oldBranch,
                      expectedWorktreePath: worktreeCwd,
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Shared thread worktree branch update failed", {
                          threadId: thread.id,
                          cause,
                        }),
                      ),
                    );
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }),
          ),
          Effect.forkIn(preparationScope),
        );
      }

      if (runId !== null && worktreePath !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      // Managed tasks use an already prepared, exact workspace. A project setup
      // script runs outside the provider sandbox and must never widen that grant.
      const setup =
        worktreePath === null || input.agentTask !== undefined
          ? ({ status: "no-script" } as const)
          : yield* setupScripts
              .runForThread({
                threadId,
                projectId: input.projectId,
                projectCwd: project.workspaceRoot,
                worktreePath,
                ...(tracked
                  ? {
                      observeCompletion: {
                        onOutputLine: (line: string) =>
                          setupTracker.appendTail(threadId, "setup-script", line),
                      },
                    }
                  : {}),
                project: {
                  id: project.id,
                  workspaceRoot: project.workspaceRoot,
                  scripts: project.scripts,
                },
              })
              .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));

      let awaitAsyncSetup = Effect.void;
      if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: completion.exitCode === 0 ? "done" : "failed",
              detail: `exited with ${completion.exitCode ?? "no exit code"}`,
            });
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            awaitAsyncSetup = awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stage(threadId, "setup-script", {
                  status: "failed",
                  detail: failureDetail(Cause.squash(cause)),
                }),
              ),
            );
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(threadId, "setup-script", "skipped");
      }
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
          })
          .pipe(
            Effect.mapError(mapError(input, "release-run", threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                runReleased = true;
              }),
            ),
            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const cancelled = Cause.hasInterruptsOnly(cause);
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          if (cancelled && setupTerminalId)
            yield* terminals
              .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
              .pipe(Effect.ignore);
          if (
            tracked &&
            createdWorktreePath &&
            ((cancelled && !runReleased) || !workspaceRecorded)
          ) {
            if (branchRename !== null) yield* Fiber.interrupt(branchRename);
            const removedPath = createdWorktreePath;
            // The thread forgets the worktree only once it is gone; a failed
            // removal leaves the directory for the user to clean up rather than
            // reusing a checkout that may be half written.
            const removal: Effect.Effect<
              void,
              WorkspaceProvider.WorkspaceProviderError | GitCommandError
            > = createdBySlipJay
              ? workspaces.release({ projectRoot: project.workspaceRoot, path: removedPath })
              : git.removeWorktree({ cwd: project.workspaceRoot, path: removedPath, force: true });
            yield* removal.pipe(
              Effect.andThen(
                threads
                  .dispatch({
                    type: "thread.metadata.update",
                    commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                    threadId,
                    worktreePath: null,
                    branch: null,
                    // A terminal may have rebound the thread to its own checkout meanwhile.
                    expectedWorktreePath: removedPath,
                  })
                  .pipe(Effect.ignore),
              ),
              Effect.catchCause((removeCause) =>
                Effect.logWarning("Failed to remove an abandoned thread worktree", {
                  commandId: input.commandId,
                  threadId,
                  path: removedPath,
                  cause: removeCause,
                }),
              ),
            );
          }
        }),
      ),
    );
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const preparation = Effect.gen(function* () {
      const prepare = prepareInBackground(input, threadId, runId);
      if (
        runId === null ||
        (input.workspaceStrategy.type !== "worktree" && input.reusedWorktree === undefined)
      ) {
        return yield* prepare;
      }
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const projection = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (projection.runs.find((run) => run.id === runId)?.status !== "preparing") return;
      const interruption = threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              (stored.event.payload.status === "interrupted" ||
                stored.event.payload.status === "cancelled"),
          ),
          Stream.runHead,
          Effect.flatMap((event) => (Option.isSome(event) ? Effect.interrupt : Effect.never)),
        );
      yield* Effect.raceFirst(prepare, interruption);
    });
    yield* preparation.pipe(
      Effect.onError((cause) =>
        failPreparedRun(
          input,
          threadId,
          runId,
          Cause.hasInterruptsOnly(cause) ? "Worktree setup cancelled." : Cause.squash(cause),
        ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (request) {
      // Scratch has no Git repository. Normalize before folder allocation so
      // durable preparation and retries use the thread's own Scratch folder.
      const input: ThreadLaunchInput =
        request.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(request.projectId))
          ? { ...request, workspaceStrategy: { type: "root" } }
          : request;
      yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
        type: "thread.create",
        projectId: input.projectId,
      }).pipe(Effect.mapError(mapError(input, "resolve-project")));
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      if (
        input.workspaceStrategy.type === "existing_worktree" &&
        !(yield* workspaces.contains(project.workspaceRoot, input.workspaceStrategy.worktreePath))
      ) {
        return yield* mapError(
          input,
          "provision-worktree",
        )("The workspace is not a checkout of the project's repository.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      yield* threads.assertProviderInstanceEnabled({
        projectId: input.projectId,
        commandId: input.commandId,
        instanceId: input.modelSelection.instanceId,
      });
      return yield* Effect.gen(function* () {
        // A retried launch has no client-supplied id to replay against, so
        // recover the thread id its accepted create was recorded under before
        // allocating another one; a fresh id would only collide with the
        // recorded receipt.
        const reusableLaunchReceipt =
          input.threadId === undefined &&
          Option.isSome(launchReceipt) &&
          launchReceipt.value.status === "accepted" &&
          launchReceipt.value.commandType === "thread.create"
            ? launchReceipt.value
            : undefined;
        const candidateThreadId =
          input.threadId ??
          reusableLaunchReceipt?.threadId ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));

        if (reusableLaunchReceipt !== undefined) {
          const shell = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (shell === null) {
            return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
          }
          if (shell.projectId !== input.projectId) {
            return yield* mapError(
              input,
              "resolve-project",
              candidateThreadId,
            )("Project identity changed.");
          }
        }

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        const requestedStrategy = input.workspaceStrategy;
        // A Scratch thread launched at the project root runs in a folder of its
        // own. Only the first attempt claims one; a retry replays its create.
        let workspaceStrategy: ThreadLaunchWorkspaceStrategy =
          requestedStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => requestedStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : requestedStrategy;
        // A SlipJay conversation that chose no checkout owns one from its launch,
        // so a later first message never runs in the integration checkout. Client
        // drafts launch only when sent. Managed readers keep their parent's binding,
        // and an explicit root, such as a scheduled task's, stays on the root.
        if (
          input.rootIsDefault === true &&
          workspaceStrategy.type === "root" &&
          input.agentTask === undefined &&
          input.importedNativeThread === undefined &&
          (yield* workspaces.resolve(project.workspaceRoot)) === "slipjay"
        ) {
          workspaceStrategy = { type: "worktree", baseRef: "HEAD" };
        }
        const initialBranch = workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
                expectedEmpty: true,
              })
            : threads.dispatch({
                type: "thread.create",
                ...(input.agentTask === undefined ? {} : { agentTask: input.agentTask }),
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                ...(input.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: input.importedNativeThread }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }

        if (input.watchedBy !== undefined) {
          yield* threads
            .dispatch({
              type: "thread.thread-watch",
              commandId: CommandId.make(`${input.commandId}:watch`),
              threadId: input.watchedBy,
              watchedThreadId: threadId,
              watching: true,
            })
            .pipe(Effect.mapError(mapError(input, "watch-thread", threadId)));
        }

        // A launch whose first message is refused never runs, so its watch would wait forever.
        const unwatchLaunched =
          input.watchedBy === undefined
            ? Effect.void
            : threads
                .dispatch({
                  type: "thread.thread-watch",
                  commandId: CommandId.make(`${input.commandId}:unwatch`),
                  threadId: input.watchedBy,
                  watchedThreadId: threadId,
                  watching: false,
                })
                .pipe(Effect.ignore);

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              ...(input.initialMessage.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
              ...(input.initialMessage.senderThreadId === undefined
                ? {}
                : { senderThreadId: input.initialMessage.senderThreadId }),
              attachments: input.initialMessage.attachments,
              ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start", workspaceStrategy },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(
              Effect.tapError(() => unwatchLaunched),
              Effect.mapError(mapError(input, "dispatch-message", threadId)),
            );
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            yield* unwatchLaunched;
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        const boundWorktreePath = projection.thread.worktreePath;
        const preparationStrategy: ThreadLaunchWorkspaceStrategy =
          Option.isSome(launchReceipt) && boundWorktreePath !== null
            ? {
                type: "existing_worktree",
                worktreePath: boundWorktreePath,
                ...(projection.thread.branch === null ? {} : { branch: projection.thread.branch }),
              }
            : workspaceStrategy;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(
                  { ...input, workspaceStrategy: preparationStrategy },
                  threadId,
                  runId,
                );
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  const prepareRun: ThreadLaunchService["Service"]["prepareRun"] = Effect.fn(
    "ThreadLaunchService.prepareRun",
  )(function* (input) {
    const scheduled = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRunPreparation(input, projection, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(input, input.threadId, input.runId, Cause.squash(scheduled.cause));
    }
  });

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    yield* prepareRun(input);
    return dispatched;
  });

  const scheduleRunPreparation = Effect.fn("ThreadLaunchService.scheduleRunPreparation")(function* (
    input: ThreadLaunchPreparationInput,
    projection: OrchestrationV2ThreadProjection,
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: ThreadLaunchWorkspaceStrategy,
  ) {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    // A worktree the failed attempt already created is reused, not created again.
    // One SlipJay has released since is gone, so a fresh one is prepared instead.
    const boundWorktreePath = projection.thread.worktreePath;
    const project = Option.getOrUndefined(yield* projects.getById(projection.thread.projectId));
    const reuse =
      workspacePreparation.type === "worktree" &&
      boundWorktreePath !== null &&
      project !== undefined &&
      (yield* workspaces.contains(project.workspaceRoot, boundWorktreePath))
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: boundWorktreePath,
              ...(projection.thread.branch === null ? {} : { branch: projection.thread.branch }),
            },
            reusedWorktree: { baseRef: workspacePreparation.baseRef },
          }
        : null;
    return yield* schedulePreparation(
      {
        commandId: input.commandId,
        projectId: projection.thread.projectId,
        ...(projection.thread.agentTask === undefined
          ? {}
          : { agentTask: projection.thread.agentTask }),
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  });

  /** The thread's own SlipJay workspace, when SlipJay has released it. */
  const releasedWorkspace = Effect.fn("ThreadLaunchService.releasedWorkspace")(function* (
    threadId: ThreadId,
  ) {
    // Only a conversation's own SlipJay workspace is replaced. A git
    // worktree has a branch to recreate it from, and a managed task's
    // workspace belongs to the work that assigned it.
    const thread = yield* threads.getThreadShell(threadId);
    if (
      thread === null ||
      thread.worktreePath === null ||
      thread.branch !== null ||
      thread.agentTask !== undefined
    ) {
      return null;
    }
    const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
    // Released means no longer a checkout of the project: SlipJay may have
    // removed or recycled the folder, and a shell left inside can recreate
    // it empty, so the folder existing proves nothing.
    if (
      project === undefined ||
      (yield* workspaces.resolve(project.workspaceRoot)) !== "slipjay" ||
      (yield* workspaces.contains(project.workspaceRoot, thread.worktreePath))
    ) {
      return null;
    }
    return { thread, worktreePath: thread.worktreePath, project };
  });

  const prepareReleasedWorkspace: ThreadLaunchService["Service"]["prepareReleasedWorkspace"] =
    Effect.fn("ThreadLaunchService.prepareReleasedWorkspace")(function* (input) {
      const released = yield* releasedWorkspace(input.threadId);
      if (released === null) return false;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace-replaced`),
        threadId: input.threadId,
        workspaceReplaced: true,
      });
      yield* threads.dispatch({
        type: "prepared-run.defer",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: input.runId,
        workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      });
      yield* prepareRun(input);
      return true;
    });

  const replaceTerminalWorkspace = Effect.fn("ThreadLaunchService.replaceTerminalWorkspace")(
    function* (input: Parameters<ThreadLaunchService["Service"]["terminalCwd"]>[0]) {
      const unchanged = { cwd: input.cwd, worktreePath: input.worktreePath ?? null };
      // A live Jujutsu checkout keeps its `.jj`, unlike a removed one or an empty folder left
      // in its place, so most terminals open without asking SlipJay.
      const root = input.worktreePath ?? input.cwd;
      if (yield* fileSystem.exists(path.join(root, ".jj")).pipe(Effect.orElseSucceed(() => true)))
        return unchanged;
      const threadId = ThreadId.make(input.threadId);
      const released = yield* releasedWorkspace(threadId);
      if (released === null) return unchanged;
      const relative = path.relative(released.worktreePath, input.cwd);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return unchanged;
      const buildItem = yield* threadBuildItem(threadId);
      const {
        workspacePath: worktreePath,
        created,
        issue,
      } = yield* workspaces.allocate({
        projectRoot: released.project.workspaceRoot,
        task: released.thread.title,
        ...(buildItem === undefined ? {} : { issue: { number: buildItem, mode: "attach" } }),
      });
      // Compare-and-set: a turn preparing a workspace at the same time keeps its own.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`command:terminal-workspace:${threadId}:${worktreePath}`),
          threadId,
          branch: null,
          worktreePath,
          expectedWorktreePath: released.worktreePath,
          workspaceReplaced: true,
          ...(issue === null ? {} : { workspaceIssue: issue }),
        })
        .pipe(
          Effect.onError(() =>
            created
              ? workspaces
                  .release({ projectRoot: released.project.workspaceRoot, path: worktreePath })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          ),
        );
      return { cwd: path.join(worktreePath, relative), worktreePath };
    },
  );

  const terminalCwd: ThreadLaunchService["Service"]["terminalCwd"] = (input) =>
    replaceTerminalWorkspace(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not replace a released workspace for a terminal", {
          threadId: input.threadId,
          error: error.message,
        }).pipe(Effect.as({ cwd: input.cwd, worktreePath: input.worktreePath ?? null })),
      ),
    );

  return ThreadLaunchService.of({
    launch,
    checkWorktreeBase,
    retryPreparation,
    prepareRun,
    prepareReleasedWorkspace,
    terminalCwd,
  });
});

export const layer = Layer.effect(ThreadLaunchService, make);

/**
 * Lets the effect worker hand a run whose SlipJay workspace was released to
 * workspace preparation before its provider starts. Without the production
 * layer nothing is handed over, and turn start refuses the missing directory.
 */
export class ReleasedWorkspacePreparation extends Context.Reference<{
  readonly prepare: ThreadLaunchService["Service"]["prepareReleasedWorkspace"];
}>("t3/orchestration-v2/ReleasedWorkspacePreparation", {
  defaultValue: () => ({ prepare: () => Effect.succeed(false) }),
}) {}

export const layerReleasedWorkspacePreparation = Layer.effect(
  ReleasedWorkspacePreparation,
  Effect.gen(function* () {
    const launch = yield* ThreadLaunchService;
    const attachments = yield* WorkspaceAttachments.WorkspaceAttachments;
    // The turn also learns which attached workspaces SlipJay has released, for example after
    // the agent's own `slipjay land`.
    return {
      prepare: (input) =>
        attachments
          .markReleased(input.threadId)
          .pipe(Effect.andThen(launch.prepareReleasedWorkspace(input))),
    };
  }),
);
