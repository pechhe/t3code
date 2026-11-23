import {
  WEAVE_NAMES,
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  type Project as ProjectRecord,
  type ServerProvider,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadImportService from "../../../orchestration-v2/ThreadImportService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HandoffImport from "../../../peer/handoff/HandoffImport.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as SlipJayLandings from "../../../project/SlipJayLandings.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import { threadWatchRefusal } from "../../../orchestration-v2/threadWatch.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { admitLinkedLaunch, recordLinkedPick } from "../../../peer/LinkedRoleAdmission.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import {
  resolveProjectFileBackedSetting,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestrationMcp from "../../OrchestratorMcpService.ts";
import * as ForgeWorkItems from "../../../weave/ForgeWorkItems.ts";
import * as WeaveAgentConnections from "../../../weave/WeaveAgentConnections.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import {
  logWhyNotDelegated,
  refuseImplementStance,
  requireWhyNotDelegated,
} from "../../delegationLimits.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectInvalidError"
      ? error.detail
      : error._tag === "ProjectNotFoundError"
        ? "The project was not found."
        : error._tag === "ProjectConflictError"
          ? "The workspace is already registered to a project."
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
const connectionHandler: McpToolAccess.Handlers<
  typeof ProjectToolkit.tools
>["t3_weave_connection"] = McpToolAccess.writesEnvironment((input) =>
  Effect.gen(function* () {
    const context = yield* readCaller();
    const connections = yield* WeaveAgentConnections.WeaveAgentConnections;
    const invalid = (message: string) =>
      new OrchestratorMcpFailure({ code: "invalid_request", message });
    const weaveFailure = (error: WeaveAgentConnections.WeaveConnectionError) =>
      error.reason === "store_failed" ? unavailable() : invalid(error.message);
    if (input.action === "connect") {
      const { origin: requestedOrigin, delegation: ref } = input;
      if (requestedOrigin === undefined || ref === undefined)
        return yield* invalid(
          "Connecting needs origin and delegation, a secretRef from request_secret.",
        );
      // A secret ref is bound to the project of the thread that requested it.
      if (context.caller === undefined)
        return yield* invalid(
          "Connect from inside a T3 thread: request_secret binds the delegation's ref to that thread.",
        );
      const projectId = context.caller.projectId;
      const delegation = yield* SecretRequests.SecretRequests.pipe(
        Effect.flatMap((secrets) => secrets.consume({ ref, projectId })),
        Effect.mapError((error) => invalid(error.message)),
      );
      const { origin } = yield* connections
        .connect({ origin: requestedOrigin, delegation })
        .pipe(Effect.mapError(weaveFailure));
      return { connected: true, origin };
    }
    if (input.action === "disconnect") {
      yield* connections.disconnect.pipe(Effect.mapError(weaveFailure));
      return { connected: false, origin: null };
    }
    const current = yield* connections.read.pipe(Effect.mapError(weaveFailure));
    return { connected: current !== null, origin: current?.origin ?? null };
  }),
);

function worktreeCheckHint(
  error:
    | ThreadLaunch.ThreadLaunchBaseRefError
    | ThreadLaunch.ThreadLaunchBranchExistsError
    | ThreadLaunch.ThreadLaunchBranchConflictError
    | ThreadLaunch.ThreadLaunchNotRepositoryError,
  strategy: { readonly startFromOrigin?: boolean | undefined },
) {
  if (error._tag === "ThreadLaunchNotRepositoryError")
    return `Use workspaceStrategy: {type: "root"}, or pass the projectId of a Git repository.`;
  if (error._tag === "ThreadLaunchBranchExistsError")
    return "Pass a branch name that does not exist yet, or omit branch to get a generated name.";
  if (error._tag === "ThreadLaunchBranchConflictError") {
    const sibling = error.branch.replaceAll("/", "-");
    return `Use a name that does not nest under or contain an existing branch${
      sibling === error.branch ? "" : `, such as "${sibling}"`
    }.`;
  }
  return `Pass a branch, tag, or commit that exists there${
    strategy.startFromOrigin === true
      ? "; no remote of the project has it either."
      : ", or set startFromOrigin:true if it exists only on a remote."
  }`;
}

/** The composer falls back to the project's t3.json when no setting picks the mode. */
const projectFileThreadEnvMode = Effect.fn("mcp.projectFileThreadEnvMode")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(`${workspaceRoot}/${T3_PROJECT_FILE_NAME}`)
    .pipe(Effect.orElseSucceed(() => null));
  return resolveProjectFileBackedSetting(
    "defaultThreadEnvMode",
    null,
    contents === null ? null : parseT3ProjectFile(contents),
  ).value;
});

// Anchored to the fatal line: other diagnostics, such as a dubious-ownership refusal, quote the path.
const NON_REPOSITORY_FATAL =
  /^fatal: (?:not a git repository|gitfile does not point to a valid repository)/im;

/** Branches from the checkout's current branch, as the composer does; a checkout with no commit or a detached HEAD stays shared. */
const defaultWorktreeStrategy = Effect.fn("mcp.defaultWorktreeStrategy")(function* (
  workspaceRoot: string,
): Effect.fn.Return<
  OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined,
  OrchestratorMcpFailure,
  GitVcsDriver.GitVcsDriver
> {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const unreadable = new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      "Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.",
  });
  const commit = yield* git
    .execute({
      operation: "mcp.defaultWorktreeStrategy",
      cwd: workspaceRoot,
      // Not peeled: a branch whose tip object is missing still resolves, so only an unborn HEAD exits 1.
      args: ["rev-parse", "--verify", "--quiet", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    })
    .pipe(Effect.orElseSucceed(() => null));
  // Only Git saying "no commit yet" (exit 1) or "not a repository" keeps the launch shared.
  if (commit?.exitCode === 1 || (commit !== null && NON_REPOSITORY_FATAL.test(commit.stderr)))
    return undefined;
  if (commit?.exitCode !== 0) return yield* unreadable;
  // symbolic-ref skips the index, so a held index lock cannot drop the launch into the shared checkout.
  const head = yield* git
    .execute({
      operation: "mcp.defaultWorktreeStrategy",
      cwd: workspaceRoot,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (head?.exitCode === 1) return undefined;
  const branch = head?.exitCode === 0 ? head.stdout.trim() : "";
  if (branch.length === 0) return yield* unreadable;
  return { type: "worktree" as const, baseRef: branch };
});

/** Settings, not the project record, hold the project default model that new threads use. */
const withSavedDefaultModel = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.mapError(unavailable),
  );
  return (project: ProjectRecord) => {
    const resolved = resolveProjectSettings(settings, project.id, project);
    return {
      ...project,
      defaultModelSelection:
        resolved.sources.defaultModelSelection === "project"
          ? resolved.settings.defaultModelSelection
          : null,
    };
  };
});

export const handlers = {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const context = yield* readCaller();
        const { caller } = context;
        // A retry with the same key replays the first launch: the ids derive
        // from the caller and the key, and the launch service replays a
        // command it already accepted.
        const commandId =
          input.clientRequestId === undefined
            ? yield* newCommandId()
            : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        // A retry of an accepted launch replays it, so it needs no reason again.
        const launched =
          input.clientRequestId === undefined
            ? null
            : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        const replayed = launched !== null && launched.deletedAt === null;
        // A replay starts nothing new unless this retry brings a first message not yet accepted.
        yield* refuseImplementStance(
          caller,
          !replayed
            ? undefined
            : input.message === undefined && (input.attachments ?? []).length === 0
              ? Effect.succeed(true)
              : context.threads.getMessagesById(threadId, [messageId]).pipe(
                  Effect.map((accepted) => accepted.has(messageId)),
                  Effect.mapError(unavailable),
                ),
        );
        if (!replayed) yield* requireWhyNotDelegated(caller, input.whyNotDelegated);
        const attachments = input.attachments ?? [];
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        if (input.forgeItem !== undefined && input.workspaceStrategy !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "forgeItem picks the item's SlipJay workspace: omit workspaceStrategy.",
          });
        // SlipJay's attach-issue always receives the canonical number, so a ref is resolved first.
        const forgeItem =
          typeof input.forgeItem === "string"
            ? (yield* (yield* ForgeWorkItems.ForgeWorkItems).resolve(input.forgeItem).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: error.message,
                    }),
                ),
              )).number
            : input.forgeItem;
        // A retry of an accepted launch replays it: it keeps the model it started
        // with and skips the checks only a new launch needs, which the project
        // may no longer pass, such as a base branch deleted since.
        const launchedModel =
          launched === null || launched.deletedAt !== null ? undefined : launched.modelSelection;
        const replaying = launchedModel !== undefined;
        if (launched !== null && replaying && launched.projectId !== projectId)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A launch retry must use the original project.",
          });
        const { delegatedHere, admitted } = yield* admitLinkedLaunch({
          linked: linkOrigin !== undefined,
          delegatedFrom: input.delegatedFrom,
          delegatedRole: input.delegatedRole,
          replaying,
          threadId,
          projectId,
          title: input.title,
          ceiling: context.limits.runtimeMode,
          runtimeMode: input.runtimeMode,
        });
        const project = replaying ? undefined : yield* readProject;
        if (!replaying && project === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The project was not found.",
          });
        if (!replaying && input.modelSelection !== undefined) {
          const { instanceId, model } = input.modelSelection;
          const registry = yield* ProviderRegistry.ProviderRegistry;
          // The thread runs in this folder, whose own provider config can add models.
          const cwd =
            input.workspaceStrategy?.type === "existing_worktree"
              ? input.workspaceStrategy.worktreePath
              : project?.workspaceRoot;
          const requireModel = (
            providers: ReadonlyArray<ServerProvider>,
          ): Effect.Effect<void, OrchestratorMcpFailure> => {
            const provider = OrchestrationMcp.withWorkspaceModels(providers, cwd).find(
              (candidate) => candidate.instanceId === instanceId,
            );
            return provider === undefined
              ? Effect.void
              : OrchestrationMcp.requireAdvertisedModel(provider, model);
          };
          const checked = requireModel(yield* registry.getProviders);
          yield* cwd === undefined
            ? checked
            : checked.pipe(
                Effect.catchIf(
                  (error) => error.code === "model_unavailable",
                  () =>
                    Project.ProjectService.pipe(
                      Effect.flatMap((projects) => projects.workspaceScanDirectory(cwd)),
                      Effect.flatMap((scanCwd) =>
                        registry.refreshWorkspaceSnapshot({ instanceId, cwd, scanCwd }),
                      ),
                      Effect.flatMap(requireModel),
                    ),
                ),
              );
        }
        // A retry rechecks the worktree too: the key alone must not reach another checkout.
        if (input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
          if (
            !(yield* workspaces.contains(
              project.workspaceRoot,
              input.workspaceStrategy.worktreePath,
            ))
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "worktreePath must be a git worktree or jj workspace of the project's repository.",
            });
        }
        const projectSettings =
          replaying || project === undefined
            ? undefined
            : yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.map(
                  (settings) => resolveProjectSettings(settings, projectId, project).settings,
                ),
              );
        // An outside caller that names no workspace follows the new-threads-in-a-worktree
        // default, as the composer does.
        const requestedStrategy =
          input.workspaceStrategy === undefined &&
          forgeItem === undefined &&
          admitted === undefined &&
          caller === undefined &&
          project !== undefined &&
          projectSettings !== undefined &&
          (projectSettings.defaultThreadEnvMode ??
            (yield* projectFileThreadEnvMode(project.workspaceRoot))) === "worktree"
            ? yield* defaultWorktreeStrategy(project.workspaceRoot)
            : input.workspaceStrategy;
        // An omitted startFromOrigin follows the new-worktree setting, as the composer and
        // t3_worktree_handoff do. Otherwise a stale local branch silently becomes the base.
        const strategy =
          projectSettings !== undefined &&
          requestedStrategy?.type === "worktree" &&
          requestedStrategy.startFromOrigin === undefined
            ? {
                ...requestedStrategy,
                startFromOrigin: projectSettings.newWorktreesStartFromOrigin,
              }
            : requestedStrategy;
        // Reject unresolved base refs and blocked branch names before accepting a launch; worktree provisioning happens later.
        if (!replaying && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} No thread was created. ${worktreeCheckHint(error, strategy)}`,
                }),
            ),
          );
        if (input.watch === true) {
          const refusal =
            caller === undefined
              ? "Only a thread can watch the thread it launches."
              : threadWatchRefusal(caller, threadId);
          if (refusal !== undefined)
            return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: refusal });
        }
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults =
          caller === undefined && admitted === undefined ? projectSettings : undefined;
        const modelSelection =
          admitted?.binding.effective ??
          input.modelSelection ??
          launchedModel ??
          caller?.modelSelection ??
          (projectDefaults
            ? resolveNewThreadModelSelection({
                defaultSelection: projectDefaults.defaultModelSelection,
                fallbackSelection: projectDefaults.fallbackModelSelection,
                providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                  Effect.flatMap((registry) => registry.getProviders),
                ),
                settings: projectDefaults,
                projectId,
                now: DateTime.toEpochMillis(yield* DateTime.now),
              }).selection
            : null) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        let startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        if (admitted !== undefined) startedRuntimeMode = admitted.runtimeMode;
        else if (!replaying) {
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          startedRuntimeMode = yield* resolveRuntimeMode(startedRuntimeMode, input.runtimeMode, {
            modelSelection,
            supportedRuntimeModes: providers.find(
              (provider) => provider.instanceId === modelSelection.instanceId,
            )?.supportedRuntimeModes,
          });
        }
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: startedRuntimeMode,
          interactionMode,
          workspaceStrategy:
            admitted !== undefined
              ? admitted.workspaceStrategy
              : forgeItem === undefined
                ? (strategy ?? { type: "root" })
                : { type: "worktree", baseRef: "HEAD", forgeItem },
          rootIsDefault:
            admitted === undefined && strategy === undefined && forgeItem === undefined,
          ...(admitted === undefined ? {} : { agentTask: admitted.binding }),
          ...(input.watch === true && caller !== undefined ? { watchedBy: caller.id } : {}),
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text:
                    admitted === undefined
                      ? (input.message ?? "")
                      : `${admitted.brief}\n\n${input.message ?? ""}`,
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
          ...(linkOrigin === undefined ? {} : { linkOrigin }),
          // Kept only alongside linkOrigin: thread.create drops it otherwise.
          ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
        }).pipe(
          Effect.onExit((exit) => admitted?.settle(exit._tag === "Success") ?? Effect.void),
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (
              error._tag === "ThreadManagementProviderInstanceDisabledError" ||
              error._tag === "ThreadLaunchForgeItemError"
            ) {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            // The administrator's ceiling refuses the mode; say so rather than "unavailable".
            if (error._tag === "ThreadLaunchError" && isAboveCeilingError(error.cause)) {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.cause.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        if (admitted !== undefined && !result.resumed)
          yield* recordLinkedPick(admitted, thread, input.message ?? "");
        if (!result.resumed && caller !== undefined)
          yield* logWhyNotDelegated({
            launchedFrom: caller.id,
            threadId: thread.id,
            whyNotDelegated: input.whyNotDelegated,
          });
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
          ...(thread.agentTask === undefined || !delegatedHere
            ? {}
            : { agentTask: thread.agentTask }),
        };
      }),
    // The launched thread carries the caller's link, if it has one.
    "stamped",
    // A linked environment never sees the calling thread, so its stance is judged here; the peer's receipts are unseen, so even a replay is refused.
    refuseImplementStance,
  ),
  t3_thread_watch_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const standing = yield* threads
        .watchedThreadStanding(input.threadId)
        .pipe(Effect.mapError(unavailable));
      if (standing.state !== "moved") return standing;
      if (standing.environmentId === undefined) return yield* unavailable();
      return {
        state: "moved" as const,
        environmentId: standing.environmentId,
        threadId: standing.threadId,
      };
    }),
  ),
  t3_thread_import: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const projects = yield* access;
        if ((input.scratch === true) === (input.projectId !== undefined))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Pass projectId, or scratch:true for the No project here.",
          });
        if (
          input.scratch === true &&
          (input.bundle !== undefined || input.worktreePath !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A thread moving into the No project carries no checkout; omit bundle and worktreePath.",
          });
        const projectId =
          input.projectId ??
          (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
            Effect.flatMap((folders) => folders.ensureScratchProject),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          )).projectId;
        const project = yield* projects
          .getById(projectId)
          .pipe(Effect.mapError(unavailable), Effect.map(Option.getOrUndefined));
        if (project === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The project was not found.",
          });
        if (input.worktreePath !== undefined && input.bundle !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A bundle lands in a new worktree; omit worktreePath.",
          });
        if (
          input.worktreePath !== undefined &&
          !(yield* (yield* WorkspaceProvider.WorkspaceProvider).contains(
            project.workspaceRoot,
            input.worktreePath,
          ))
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "worktreePath must be a git worktree or jj workspace of the project's repository.",
          });
        // Before anything is created here: waits this environment cannot keep end the move, naming why.
        const waits = [...(input.watches ?? []), ...(input.parkedWaits ?? [])];
        for (const wait of waits) {
          if (wait.target.kind === "thread" && wait.target.environmentId !== undefined) {
            const linked = yield* (yield* PeerLinks.PeerLinks)
              .get(wait.target.environmentId)
              .pipe(Effect.mapError(unavailable));
            if (Option.isNone(linked))
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `This environment is not linked to ${wait.target.environmentId}, so it cannot keep the thread's wait on "${wait.title}". Link it here first.`,
              });
          }
          if (wait.target.kind === "production") {
            const projects = yield* access;
            const productionProject = yield* projects
              .getById(wait.target.projectId ?? projectId)
              .pipe(Effect.mapError(unavailable), Effect.map(Option.getOrUndefined));
            const refusal = yield* SlipJayLandings.productionWaitRefusal(
              yield* Effect.serviceOption(SlipJayLandings.SlipJayLandings),
              {
                projectId: wait.target.projectId ?? projectId,
                checkouts: productionProject === undefined ? [] : [productionProject.workspaceRoot],
              },
            );
            if (refusal !== undefined)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `This environment cannot keep the thread's wait on "${wait.title}": ${refusal}`,
              });
          }
          if (wait.target.kind === "build_item") {
            const connection = yield* (yield* ForgeWorkItems.ForgeWorkItems).connected.pipe(
              Effect.mapError(unavailable),
            );
            if (!connection.connected)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `This environment has no Weave connection, so it cannot keep the thread's wait on Build #${wait.target.number}. Connect it in Settings first.`,
              });
          }
        }
        const imports = yield* ThreadImportService.ThreadImportService;
        const handoffs = yield* HandoffImport.HandoffImport;
        const bundle = input.bundle;
        const workspace =
          bundle === undefined
            ? undefined
            : handoffs.applyBundle({
                repoRoot: project.workspaceRoot,
                threadId: yield* ThreadImportService.importedThreadId(input.source),
                handoffId: input.source.handoffId,
                bundle,
              });
        const { scratch: _scratch, ...rest } = input;
        return yield* imports
          .importThread({
            ...rest,
            projectId,
            runtimeMode,
            interactionMode,
            linkOrigin,
            ...(workspace === undefined ? {} : { workspace }),
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "OrchestratorMcpFailure"
                ? error
                : new OrchestratorMcpFailure({
                    code:
                      error._tag === "ThreadImportProjectMismatchError"
                        ? "invalid_request"
                        : "orchestration_error",
                    message: error.message,
                  }),
            ),
          );
      }),
    // A moved thread carries the link that moved it, like a launch.
    "stamped",
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      // Identities are resolved: linked environments find this side's project by repository.
      const page = yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
      return { ...page, projects: page.projects.map(yield* withSavedDefaultModel) };
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return (yield* withSavedDefaultModel)(result.value);
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(
    ({ workspaceRoot, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        if (workspaceRoot === undefined) {
          // Only updates record model defaults; reject defaults that creation would silently drop.
          if (
            input.scripts !== undefined ||
            input.createWorkspaceRootIfMissing !== undefined ||
            input.defaultModelSelection !== undefined
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
            });
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const created = yield* folders.createNamedProject({ name: input.title }).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
          const project = yield* projects
            .getById(created.projectId)
            .pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
              ),
            );
          return {
            ...project,
            ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
          };
        }
        if (input.defaultModelSelection !== undefined && input.defaultModelSelection !== null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Creating a project does not set its default model; set defaultModelSelection afterwards with t3_project_update.",
          });
        const commandId = yield* newCommandId();
        return yield* projects
          .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
          .pipe(Effect.mapError(projectFailure));
      }),
    // Linked work may bring the repository it works in; an existing
    // registered workspace is still refused.
    { linkedCallers: "allowed" },
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      const updated = yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
      return (yield* withSavedDefaultModel)(updated);
    }),
  ),
  [WEAVE_NAMES.connectionTool]: connectionHandler,
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      if (yield* folders.isScratchProject(input.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            '"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.',
        });
      const projects = yield* Project.ProjectService;
      const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
      return yield* mutateProjectWithClone(projects, clones, {
        ...input,
        type: "project.delete",
        commandId: yield* newCommandId(),
      }).pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories.SourceControlRepositoryService;
        // Agents' MCP calls have their own long budget, and an aborted call interrupts git.
        return yield* repositories.cloneRepository(input, { timeoutMs: null }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.detail,
              }),
          ),
        );
      }),
    // An existing destination is never adopted.
    { linkedCallers: "allowed" },
  ),
} satisfies McpToolAccess.Handlers<typeof ProjectToolkit.tools>;

export const layer = McpToolAccess.toLayer(ProjectToolkit, handlers);
