import { MessageId, ThreadId, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import { threadWatchRefusal } from "../../../orchestration-v2/threadWatch.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as BuildWorkItems from "../../../hq/BuildWorkItems.ts";
import * as HqAgentConnections from "../../../hq/HqAgentConnections.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller } = context;
        const commandId = yield* newCommandId();
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
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
        if (input.buildItem !== undefined) {
          const project = yield* readProject;
          const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
          if (
            input.workspaceStrategy !== undefined ||
            project === undefined ||
            (yield* workspaces.resolve(project.workspaceRoot)) !== "slipjay"
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "buildItem picks the item's SlipJay workspace: use it in a project with slipjay.json and without workspaceStrategy.",
            });
        }
        // SlipJay's attach-issue always receives the canonical number, so a ref is resolved first.
        const buildItem =
          typeof input.buildItem === "string"
            ? (yield* (yield* BuildWorkItems.BuildWorkItems).resolve(input.buildItem).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: error.message,
                    }),
                ),
              )).number
            : input.buildItem;
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
        // A launch is accepted before its worktree is provisioned, so a base
        // ref that cannot resolve is refused while the agent can still act on it.
        const strategy = input.workspaceStrategy;
        if (strategy?.type === "worktree")
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
        const modelSelection =
          input.modelSelection ??
          caller?.modelSelection ??
          (yield* readProject)?.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy:
            buildItem === undefined
              ? (input.workspaceStrategy ?? { type: "root" })
              : { type: "worktree", baseRef: "HEAD", buildItem },
          rootIsDefault: input.workspaceStrategy === undefined && buildItem === undefined,
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
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
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
  t3_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
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
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
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
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_hq_connection: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const connections = yield* HqAgentConnections.HqAgentConnections;
      const invalid = (message: string) =>
        new OrchestratorMcpFailure({ code: "invalid_request", message });
      const hqFailure = (error: HqAgentConnections.HqConnectionError) =>
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
          .pipe(Effect.mapError(hqFailure));
        return { connected: true, origin };
      }
      if (input.action === "disconnect") {
        yield* connections.disconnect.pipe(Effect.mapError(hqFailure));
        return { connected: false, origin: null };
      }
      const current = yield* connections.read.pipe(Effect.mapError(hqFailure));
      return { connected: current !== null, origin: current?.origin ?? null };
    }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment((input) =>
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
  ),
});
