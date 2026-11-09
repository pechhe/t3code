import {
  WEAVE_NAMES,
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadImportService from "../../../orchestration-v2/ThreadImportService.ts";
import * as HandoffImport from "../../../peer/handoff/HandoffImport.ts";
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
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ForgeWorkItems from "../../../weave/ForgeWorkItems.ts";
import * as WeaveAgentConnections from "../../../weave/WeaveAgentConnections.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import {
  logWhyNotDelegated,
  newCommandId,
  readCaller,
  requireWhyNotDelegated,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
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
        if (launched === null || launched.deletedAt !== null)
          yield* requireWhyNotDelegated(caller, input.whyNotDelegated);
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
        if (!replaying && input.workspaceStrategy?.type === "existing_worktree") {
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
        // Reject unresolved base refs before accepting a launch; worktree provisioning happens later.
        const strategy = input.workspaceStrategy;
        if (!replaying && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                    strategy.startFromOrigin === true
                      ? "; the project has no usable remote to fetch it from."
                      : ", or set startFromOrigin:true if it exists only on a remote."
                  }`,
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
          caller === undefined && !replaying
            ? yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.flatMap((settings) =>
                  Effect.map(
                    readProject,
                    (project) => resolveProjectSettings(settings, projectId, project).settings,
                  ),
                ),
              )
            : undefined;
        const modelSelection =
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
        if (!replaying) {
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
            forgeItem === undefined
              ? (input.workspaceStrategy ?? { type: "root" })
              : { type: "worktree", baseRef: "HEAD", forgeItem },
          rootIsDefault: input.workspaceStrategy === undefined && forgeItem === undefined,
          ...(input.watch === true && caller !== undefined ? { watchedBy: caller.id } : {}),
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
          ...(linkOrigin === undefined ? {} : { linkOrigin }),
          // Kept only alongside linkOrigin: thread.create drops it otherwise.
          ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
        }).pipe(
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
        };
      }),
    // The launched thread carries the caller's link, if it has one.
    "stamped",
  ),
  t3_thread_import: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const projects = yield* access;
        const project = yield* projects
          .getById(input.projectId)
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
        return yield* imports
          .importThread({
            ...input,
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
      return yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
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
      return result.value;
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
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  [WEAVE_NAMES.connectionTool]: connectionHandler,
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
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
        return yield* repositories.cloneRepository(input).pipe(
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
