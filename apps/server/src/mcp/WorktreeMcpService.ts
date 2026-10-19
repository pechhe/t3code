import {
  CommandId,
  MessageId,
  type ProjectId,
  WorktreeMcpFailure,
  type WorktreeMcpAttachInput,
  type WorktreeMcpAttachResult,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpDetachInput,
  type WorktreeMcpDetachResult,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  listedWorkspaceAttachments,
  liveWorkspaceAttachments,
} from "@t3tools/shared/workspaceAttachments";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceAttachments from "../orchestration-v2/WorkspaceAttachments.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
    readonly attach: (
      scope: McpInvocationScope,
      input: WorktreeMcpAttachInput,
    ) => Effect.Effect<WorktreeMcpAttachResult, WorktreeMcpFailure>;
    readonly detach: (
      scope: McpInvocationScope,
      input: WorktreeMcpDetachInput,
    ) => Effect.Effect<WorktreeMcpDetachResult, WorktreeMcpFailure>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** How the handoff creates the thread's new checkout, and undoes it on failure. */
interface CheckoutPlan {
  readonly baseRef: string | null;
  readonly startedFromOrigin: boolean;
  readonly create: Effect.Effect<
    { readonly path: string; readonly branch: string | null },
    WorktreeMcpFailure
  >;
  /** Best effort: a failed removal is logged and leaves the checkout on disk. */
  readonly remove: (path: string) => Effect.Effect<void>;
}

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const attachments = yield* WorkspaceAttachments.WorkspaceAttachments;

  // Serializes handoffs per thread: two concurrent calls could otherwise both
  // pass the binding check and each create a worktree, leaving one untracked
  // on disk.
  const handoffThreadsInFlight = new Set<string>();
  // Serializes adoptions across threads, so two cannot both find a checkout unheld and attach it.
  const adoptions = yield* Semaphore.make(1);

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree tools act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpThreadInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.thread.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpHandoffInput,
  ) {
    const projection = yield* loadThread(scope);
    // The binding the handoff replaces. A thread may leave any workspace,
    // including one SlipJay has since released; the swap is compare-and-set
    // so a concurrent re-point (for example from the UI) is not overwritten.
    const previousWorktreePath = projection.thread.worktreePath;
    const bindingChanged = failure(
      "handoff_in_progress",
      `Thread '${scope.thread.threadId}' moved to another workspace during the handoff; the handoff was rolled back.`,
    );
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    if (input.worktreePath !== undefined && input.worktreePath === previousWorktreePath) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' already works in '${input.worktreePath}'.`,
      );
    }
    // A SlipJay workspace starts from the integration branch and is named after
    // the requested branch; it has no git branch of its own to check or create.
    const slipjay = (yield* workspaces.resolve(projectCwd)) === "slipjay";
    const { branch } = input;
    let checkout: CheckoutPlan;
    if (input.worktreePath !== undefined) {
      checkout = existingCheckout(projectCwd, input.worktreePath, slipjay);
    } else if (branch === undefined) {
      return yield* failure(
        "invalid_request",
        "Pass branch to create a workspace, or worktreePath to attach an existing one.",
      );
    } else {
      checkout = slipjay
        ? slipjayCheckout(projectCwd, branch)
        : yield* prepareGitCheckout(projectCwd, { ...input, branch });
    }

    const ids = yield* handoffIds(scope);

    // uninterruptibleMask: only the potentially slow worktree creation itself
    // stays interruptible (restore). From the moment it succeeds, through the
    // binding, continuation queue, setup script launch, and result
    // construction, there is no interruptible gap: a client cancel can
    // therefore neither orphan the created worktree before the rollback is
    // armed, nor skip setting up a worktree the thread was just bound to
    // (once the binding commits, the scheduled session detach can sever this
    // request's connection and interrupt the fiber).
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* restore(checkout.create);
        const worktreePath = created.path;

        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: scope.thread.threadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        // suspend: build the rollback only if cleanup actually runs.
        const removeCreatedWorktree = Effect.suspend(() => checkout.remove(worktreePath));

        const recheckAndBind = Effect.gen(function* () {
          // The projection was read before the potentially slow git work
          // above; a concurrent binding (for example from the UI) could have
          // attached the thread in the meantime. Re-check before committing so
          // the race cannot leave a second, untracked worktree.
          const recheck = yield* loadThread(scope);
          if (recheck.thread.worktreePath !== previousWorktreePath) {
            return yield* bindingChanged;
          }
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${scope.thread.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              branch: created.branch,
              worktreePath,
              expectedWorktreePath: previousWorktreePath,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(
                      failure(
                        "operation_failed",
                        `Unable to re-point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                      ),
                    ),
              ),
            );
        }).pipe(
          // Interrupt-only causes skip the removal: the binding may have
          // committed, and force-deleting a worktree the thread now points at
          // would be worse than leaking one.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        // Queue the continuation right after the binding commits: the detach
        // that the metadata update schedules will terminate the calling
        // session, and a durably queued message is what guarantees the thread
        // re-launches inside the worktree.
        const queueContinuation: Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure> =
          Effect.suspend(() =>
            input.continuationPrompt === undefined
              ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
              : threadManagement
                  .sendToThread({
                    projectId: projection.thread.projectId,
                    commandId: ids.continuationCommandId,
                    threadId: scope.thread.threadId,
                    messageId: ids.continuationMessageId,
                    text: input.continuationPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
                      status: "scheduled",
                      delivery: sendResult.delivery,
                    })),
                    reportFailed("worktree handoff continuation failed to queue"),
                  ),
          );

        const continuation = yield* recheckAndBind.pipe(Effect.andThen(queueContinuation));

        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? input.worktreePath === undefined) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.thread.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : { status: "no-script" },
              ),
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          worktreePath,
          branch: created.branch,
          baseRef: checkout.baseRef,
          startedFromOrigin: checkout.startedFromOrigin,
          setupScript,
          continuation,
          note:
            continuation.status === "scheduled"
              ? "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
              : "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.",
        };
        return result;
      }),
    );
  });

  const prepareGitCheckout = Effect.fn("WorktreeMcpService.prepareGitCheckout")(function* (
    projectCwd: string,
    input: WorktreeMcpHandoffInput & { readonly branch: string },
  ) {
    // The repo check runs regardless of whether baseRef was supplied, so a
    // non-repository workspace fails with an actionable error instead of an
    // opaque git failure further down.
    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    // Fail fast with an actionable message when the branch already exists:
    // the git driver deliberately keeps stderr out of its errors, so letting
    // `git worktree add` fail would surface only an opaque failure. The
    // existence check uses the complete local branch list (exact match); the
    // paginated substring search only enriches the message with the checkout
    // location when available.
    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
    if (localBranchNames.includes(input.branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: input.branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === input.branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${input.branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

    let worktreeBaseRef = baseRef;
    if (startFromOrigin) {
      yield* gitWorkflow
        .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
        .pipe(asOperationFailed("Unable to fetch origin"));
      const resolvedRemoteBase = yield* gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd: projectCwd,
          refName: baseRef,
          fallbackRemoteName: "origin",
        })
        .pipe(asOperationFailed(`Unable to resolve the remote-tracking commit of '${baseRef}'`));
      worktreeBaseRef = resolvedRemoteBase.commitSha;
    }

    return {
      baseRef,
      startedFromOrigin: startFromOrigin,
      create: gitWorkflow
        .createWorktree({
          cwd: projectCwd,
          refName: worktreeBaseRef,
          newRefName: input.branch,
          baseRefName: baseRef,
          path: null,
        })
        .pipe(
          Effect.map(({ worktree }) => ({ path: worktree.path, branch: worktree.refName })),
          asOperationFailed("Unable to create the worktree"),
        ),
      // Removing the worktree must succeed before deleting its freshly created
      // branch; otherwise the branch may still be checked out there.
      remove: (worktreePath: string) =>
        gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              gitWorkflow.deleteLocalBranch({
                cwd: projectCwd,
                refName: input.branch,
                force: true,
              }),
            ),
          ),
          Effect.ignoreCause({ log: true }),
        ),
    } satisfies CheckoutPlan;
  });

  // An existing checkout already belongs to whoever made it, so a failed
  // handoff leaves it in place.
  const existingCheckout = (
    projectCwd: string,
    worktreePath: string,
    slipjay: boolean,
  ): CheckoutPlan => ({
    baseRef: null,
    startedFromOrigin: false,
    create: Effect.gen(function* () {
      if (!(yield* workspaces.contains(projectCwd, worktreePath))) {
        return yield* failure(
          "invalid_request",
          `'${worktreePath}' is not a checkout of the project's repository.`,
        );
      }
      // A SlipJay workspace has no branch of its own, like one allocated here.
      if (slipjay) return { path: worktreePath, branch: null };
      const status = yield* gitWorkflow
        .localStatus({ cwd: worktreePath })
        .pipe(asOperationFailed("Unable to read the worktree's status"));
      return { path: worktreePath, branch: status.refName };
    }),
    remove: () => Effect.void,
  });

  const slipjayCheckout = (projectCwd: string, task: string): CheckoutPlan => ({
    baseRef: null,
    startedFromOrigin: false,
    create: workspaces.allocate({ projectRoot: projectCwd, task }).pipe(
      Effect.map(({ workspacePath }) => ({ path: workspacePath, branch: null })),
      Effect.mapError((error) => failure("operation_failed", error.message)),
    ),
    remove: (workspacePath) =>
      workspaces
        .release({ projectRoot: projectCwd, path: workspacePath })
        .pipe(Effect.ignoreCause({ log: true })),
  });

  // uninterruptibleMask: the guard acquisition and the registration of the releasing finalizer
  // happen with no interruptible gap in between. An interrupt landing between a bare add() and
  // the start of an ensured effect would otherwise leak the guard entry and block every future
  // workspace change for this thread until restart.
  const oneAtATime = <A>(
    scope: McpThreadInvocationScope,
    effect: Effect.Effect<A, WorktreeMcpFailure>,
  ): Effect.Effect<A, WorktreeMcpFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (handoffThreadsInFlight.has(scope.thread.threadId)) {
          return Effect.fail(
            failure(
              "handoff_in_progress",
              `A workspace change is already in progress for thread '${scope.thread.threadId}'.`,
            ),
          );
        }
        handoffThreadsInFlight.add(scope.thread.threadId);
        return restore(effect).pipe(
          Effect.ensuring(Effect.sync(() => handoffThreadsInFlight.delete(scope.thread.threadId))),
        );
      }),
    );

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* oneAtATime(scope, performHandoff(scope, input));
    },
  );

  // An adopted checkout's project, when the agent names only its path: the registered project
  // whose repository holds it.
  const projectHolding = Effect.fn("WorktreeMcpService.projectHolding")(function* (
    worktreePath: string,
  ) {
    const all = yield* projects.listShells().pipe(asOperationFailed("Unable to read projects"));
    const matches = yield* Effect.filter(all, (project) =>
      workspaces.contains(project.workspaceRoot, worktreePath),
    );
    if (matches.length === 0)
      return yield* failure(
        "invalid_request",
        `'${worktreePath}' is not a checkout of any registered project's repository.`,
      );
    if (matches.length > 1)
      return yield* failure(
        "invalid_request",
        `'${worktreePath}' is in a repository several projects are registered in (${matches.map((project) => project.id).join(", ")}); pass projectId.`,
      );
    return matches[0]!.id;
  });

  const performAttach = Effect.fn("WorktreeMcpService.performAttach")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpAttachInput,
  ) {
    const projection = yield* loadThread(scope);
    if (projection.thread.archivedAt !== null)
      return yield* failure("invalid_request", `Thread '${scope.thread.threadId}' is archived.`);
    const projectId =
      input.projectId ??
      (input.worktreePath === undefined
        ? yield* failure("invalid_request", "Pass projectId, or worktreePath to adopt a checkout.")
        : yield* projectHolding(input.worktreePath));
    const project = yield* loadProject(scope, projectId);
    if (projectId === projection.thread.projectId)
      return yield* failure(
        "invalid_request",
        "That is this thread's own project; use t3_worktree_handoff to change its primary workspace.",
      );
    // A workspace SlipJay released since the last turn frees its project's slot.
    yield* attachments.markReleased(scope.thread.threadId);
    const held = liveWorkspaceAttachments((yield* loadThread(scope)).thread).find(
      (attachment) => attachment.projectId === projectId,
    );
    if (held !== undefined)
      return yield* failure(
        "invalid_request",
        `This thread already holds ${held.workspacePath} in project ${projectId}; detach it first.`,
      );
    const projectCwd = project.workspaceRoot;
    const slipjay = (yield* workspaces.resolve(projectCwd)) === "slipjay";
    const adopted = input.worktreePath ?? (input.root === true ? projectCwd : undefined);
    let checkout: CheckoutPlan;
    if (adopted !== undefined) {
      checkout =
        adopted === projectCwd
          ? {
              baseRef: null,
              startedFromOrigin: false,
              create: gitWorkflow.localStatus({ cwd: projectCwd }).pipe(
                Effect.map((status) => ({ path: projectCwd, branch: status.refName })),
                asOperationFailed("Unable to read the project checkout's status"),
              ),
              remove: () => Effect.void,
            }
          : existingCheckout(projectCwd, adopted, slipjay);
    } else if (input.branch === undefined) {
      return yield* failure(
        "invalid_request",
        "Pass branch to create a workspace, worktreePath to adopt a checkout, or root to adopt the project's main checkout.",
      );
    } else {
      checkout = slipjay
        ? slipjayCheckout(projectCwd, input.branch)
        : yield* prepareGitCheckout(projectCwd, { ...input, branch: input.branch });
    }
    const ids = yield* handoffIds(scope);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const record = Effect.gen(function* () {
          if (adopted !== undefined) {
            const holders = yield* attachments.holders({
              workspacePath: adopted,
              threadId: scope.thread.threadId,
            });
            if (holders.length > 0)
              return yield* failure(
                "invalid_request",
                `'${adopted}' is attached to another thread (${holders.join(", ")}).`,
              );
          }
          const created = yield* restore(checkout.create);
          yield* threadManagement
            .dispatch({
              type: "thread.workspace-attachment.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              change: {
                action: "attach",
                attachment: {
                  projectId,
                  workspacePath: created.path,
                  branch: created.branch,
                  origin: adopted === undefined ? "allocated" : "adopted",
                },
              },
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "invalid_request",
                  `Unable to attach the workspace: ${errorMessage(error)}`,
                ),
              ),
              Effect.onError((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.suspend(() => checkout.remove(created.path)),
              ),
            );
          return created;
        });
        const created = yield* adopted === undefined ? record : adoptions.withPermits(1)(record);
        yield* vcsStatusBroadcaster
          .refreshStatus(created.path)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? adopted === undefined) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.thread.threadId,
              projectId,
              projectCwd,
              worktreePath: created.path,
              project: { id: project.id, workspaceRoot: projectCwd, scripts: project.scripts },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : { status: "no-script" },
              ),
              Effect.catchCause((cause) =>
                Effect.succeed<WorktreeMcpSetupScriptStatus>({
                  status: "failed",
                  detail: errorMessage(Cause.squash(cause)),
                }),
              ),
            );
        }
        const attachment = liveWorkspaceAttachments((yield* loadThread(scope)).thread).find(
          (candidate) => candidate.workspacePath === created.path,
        );
        if (attachment === undefined)
          return yield* failure("operation_failed", "The attachment was not recorded.");
        return { attachment, setupScript } satisfies WorktreeMcpAttachResult;
      }),
    );
  });

  const attach: WorktreeMcpService["Service"]["attach"] = Effect.fn("WorktreeMcpService.attach")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* oneAtATime(scope, performAttach(scope, input));
    },
  );

  const detach: WorktreeMcpService["Service"]["detach"] = Effect.fn("WorktreeMcpService.detach")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const before = (yield* loadThread(scope)).thread.workspaceAttachments?.find(
        (attachment) => attachment.workspacePath === input.workspacePath,
      );
      yield* oneAtATime(
        scope,
        attachments
          .detach({ threadId: scope.thread.threadId, workspacePath: input.workspacePath })
          .pipe(
            Effect.mapError((error) =>
              failure(
                error.reason === "failed" ? "operation_failed" : "invalid_request",
                error.message,
              ),
            ),
          ),
      );
      return {
        released: before?.origin === "allocated" && before.releasedAt === null,
      } satisfies WorktreeMcpDetachResult;
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
        attachments: listedWorkspaceAttachments(projection.thread),
      };
      return result;
    },
  );

  return WorktreeMcpService.of({ handoff, status, attach, detach });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
  | WorkspaceProvider.WorkspaceProvider
  | WorkspaceAttachments.WorkspaceAttachments
> = Layer.effect(WorktreeMcpService, make);
