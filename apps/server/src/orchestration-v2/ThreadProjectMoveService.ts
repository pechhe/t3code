import type { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { liveWorkspaceAttachments } from "@t3tools/shared/workspaceAttachments";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkspaceAttachments from "./WorkspaceAttachments.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

export interface ThreadProjectMoveContinuation {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
}

/**
 * Moves a No project chat into a project in place: the thread keeps its id and history and
 * continues in the project's workspace. Undo reverses the move until a run starts there.
 */
export class ThreadProjectMoveService extends Context.Service<
  ThreadProjectMoveService,
  {
    /**
     * A retry under the same command id replays the recorded move without allocating again.
     * A continuation is queued as the thread's own message, so it starts the next turn there.
     */
    readonly move: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly continuation?: ThreadProjectMoveContinuation | undefined;
    }) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, ThreadProjectMoveError>;
    readonly undo: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, ThreadProjectMoveError>;
  }
>()("t3/orchestration-v2/ThreadProjectMoveService") {}

const refuse = (message: string) => new ThreadProjectMoveError({ message });
const failed = (prefix: string) =>
  Effect.mapError(
    (cause: { readonly message: string }) =>
      new ThreadProjectMoveError({ message: `${prefix}: ${cause.message}`, cause }),
  );

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const attachments = yield* WorkspaceAttachments.WorkspaceAttachments;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;

  const loadThread = Effect.fn("ThreadProjectMoveService.loadThread")(function* (
    threadId: ThreadId,
  ) {
    const { thread, runs } = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(failed("Unable to read the chat"));
    return { ...thread, runCount: runs.length };
  });

  const loadProject = Effect.fn("ThreadProjectMoveService.loadProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.getById(projectId).pipe(failed("Unable to read the project"));
    if (Option.isNone(project)) return yield* refuse("The project was not found.");
    return project.value;
  });

  const followSchedules = (threadId: ThreadId, projectId: ProjectId) =>
    scheduledTasks
      .moveThreadProject({ threadId, projectId })
      .pipe(failed("The chat moved, but its scheduled tasks did not follow"));

  const move: ThreadProjectMoveService["Service"]["move"] = Effect.fn(
    "ThreadProjectMoveService.move",
  )(function* (input) {
    const thread = yield* loadThread(input.threadId);
    const replay = yield* threads.hasReceipt(input.commandId);
    if (!replay) {
      if (thread.archivedAt !== null) return yield* refuse("An archived chat cannot move.");
      if (!(yield* folders.isScratchProject(thread.projectId)))
        return yield* refuse("Only a No project chat can move into a project.");
      if (yield* folders.isScratchProject(input.projectId))
        return yield* refuse("Choose a project other than No project.");
    }
    const project = yield* loadProject(input.projectId);
    yield* threads
      .assertProviderInstanceEnabled({
        commandId: input.commandId,
        projectId: project.id,
        instanceId: thread.providerInstanceId,
      })
      .pipe(
        Effect.mapError(() => refuse(`This chat's provider is turned off for ${project.title}.`)),
      );

    // A workspace the chat already holds in the project becomes its primary one; otherwise it
    // starts where a new chat in the project would. A replay reuses what the move recorded.
    const held = replay
      ? undefined
      : yield* Effect.findFirst(
          liveWorkspaceAttachments(thread).filter(
            (attachment) => attachment.projectId === project.id,
          ),
          (attachment) => workspaces.contains(project.workspaceRoot, attachment.workspacePath),
        ).pipe(Effect.map(Option.getOrUndefined));
    const workspace = replay
      ? {
          worktreePath: thread.worktreePath,
          branch: thread.branch,
          workspaceIssue: thread.workspaceIssue ?? null,
          allocated: thread.projectMove?.allocatedWorkspace ?? false,
        }
      : held !== undefined
        ? {
            worktreePath: held.workspacePath,
            branch: held.branch,
            workspaceIssue: null,
            allocated: false,
          }
        : {
            ...(yield* launch
              .allocateProjectWorkspace({
                threadId: thread.id,
                projectRoot: project.workspaceRoot,
                task: thread.title,
              })
              .pipe(failed(`Unable to prepare a workspace in ${project.title}`))),
            branch: null,
          };

    const recorded = yield* threads
      .dispatch({
        type: "thread.project-move.record",
        commandId: input.commandId,
        threadId: thread.id,
        change: {
          action: "apply",
          projectId: project.id,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          workspaceIssue: workspace.workspaceIssue,
          allocatedWorkspace: workspace.allocated,
        },
      })
      .pipe(
        failed("Unable to move the chat"),
        Effect.tapError(() =>
          !replay && workspace.allocated && workspace.worktreePath !== null
            ? workspaces
                .release({ projectRoot: project.workspaceRoot, path: workspace.worktreePath })
                .pipe(Effect.ignoreCause({ log: true }))
            : Effect.void,
        ),
      );
    yield* followSchedules(thread.id, project.id);
    if (input.continuation !== undefined)
      yield* threads
        .sendToThread({
          projectId: project.id,
          commandId: input.continuation.commandId,
          threadId: thread.id,
          messageId: input.continuation.messageId,
          // Sent by the thread itself, so it reads as the chat continuing after the move.
          senderThreadId: thread.id,
          text: input.continuation.text,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(failed("The chat moved, but its continuation could not be queued"));
    return recorded;
  });

  const undo: ThreadProjectMoveService["Service"]["undo"] = Effect.fn(
    "ThreadProjectMoveService.undo",
  )(function* (input) {
    const thread = yield* loadThread(input.threadId);
    const recorded = thread.projectMove;
    if (recorded == null) {
      // A retry after the revert committed replays its receipt.
      if (yield* threads.hasReceipt(input.commandId))
        return yield* revert(input).pipe(failed("Unable to undo the move"));
      return yield* refuse("This chat has no move to undo.");
    }
    if (thread.runCount > recorded.runCount)
      return yield* refuse("The chat has run in the project since it moved, so it stays there.");
    // The workspace the move allocated goes first, under the checks detaching one applies, so
    // a refusal leaves the chat in the project rather than pointing at a removed folder.
    if (recorded.allocatedWorkspace && thread.worktreePath !== null) {
      const project = yield* loadProject(thread.projectId);
      yield* attachments
        .releaseWorkspace({
          threadId: thread.id,
          projectRoot: project.workspaceRoot,
          workspacePath: thread.worktreePath,
        })
        .pipe(Effect.mapError((error) => refuse(`Unable to undo the move: ${error.message}`)));
    }
    const reverted = yield* revert(input).pipe(failed("Unable to undo the move"));
    yield* followSchedules(thread.id, recorded.fromProjectId);
    return reverted;
  });

  const revert = (input: { readonly commandId: CommandId; readonly threadId: ThreadId }) =>
    threads.dispatch({
      type: "thread.project-move.record",
      commandId: input.commandId,
      threadId: input.threadId,
      change: { action: "revert" },
    });

  return ThreadProjectMoveService.of({ move, undo });
});

export const layer = Layer.effect(ThreadProjectMoveService, make);
