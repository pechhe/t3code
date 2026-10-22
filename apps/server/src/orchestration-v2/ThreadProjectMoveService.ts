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
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

export interface ThreadProjectMoveContinuation {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  /** Omitted for a move that needs no next step beyond continuing: the service writes it. */
  readonly text?: string | undefined;
  /** The thread whose agent asked for the move; the moved thread itself for a self-move. */
  readonly senderThreadId: ThreadId | undefined;
}

/**
 * The continuation T3 queues when a chat moves itself: the conversation carries over, so the
 * next turn only needs to know where it now works and that it should carry on.
 */
const movedContinuationText = (projectTitle: string) =>
  `This chat has moved into ${projectTitle}. The conversation carried over, so continue the work you were about to start; follow this project's instructions.`;

/**
 * Moves a No project chat into a project in place: the thread keeps its id and history and
 * continues in the project's workspace, which its next turn prepares when it has none there.
 * Undo reverses the move until a run starts there.
 */
export class ThreadProjectMoveService extends Context.Service<
  ThreadProjectMoveService,
  {
    /**
     * A retry under the same command id replays the recorded move. A continuation is queued
     * as the thread's own message, so it starts the next turn there.
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

  // The move stands once recorded, so a schedule that fails to follow is logged rather than
  // reported as a failed move; its next dispatch says the thread is in another project.
  const followSchedules = (threadId: ThreadId, projectId: ProjectId) =>
    scheduledTasks.moveThreadProject({ threadId, projectId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("A moved chat's scheduled tasks did not follow it", {
          threadId,
          projectId,
          cause,
        }),
      ),
    );

  const move: ThreadProjectMoveService["Service"]["move"] = Effect.fn(
    "ThreadProjectMoveService.move",
  )(function* (input) {
    const thread = yield* loadThread(input.threadId);
    const replay = yield* threads.hasReceipt(input.commandId);
    if (!replay) {
      if (thread.archivedAt !== null) return yield* refuse("An archived chat cannot move.");
      // A delegated task's workspace belongs to the work that assigned it.
      if (thread.agentTask !== undefined)
        return yield* refuse(
          "A delegated task works where its lead assigned it, so it cannot move.",
        );
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

    // A workspace the chat already holds in the project becomes its primary one. Otherwise a
    // SlipJay project's workspace is prepared when the next turn starts, so nothing exists
    // before the move commits; any other project runs at its root.
    const held = replay
      ? undefined
      : yield* Effect.findFirst(
          liveWorkspaceAttachments(thread).filter(
            (attachment) => attachment.projectId === project.id,
          ),
          (attachment) => workspaces.contains(project.workspaceRoot, attachment.workspacePath),
        ).pipe(Effect.map(Option.getOrUndefined));
    const recorded = yield* threads
      .dispatch({
        type: "thread.project-move.record",
        commandId: input.commandId,
        threadId: thread.id,
        change: {
          action: "apply",
          fromProjectId: thread.projectId,
          projectId: project.id,
          worktreePath: held?.workspacePath ?? null,
          branch: held?.branch ?? null,
          workspaceIssue: null,
          pendingWorkspace:
            held === undefined && (yield* workspaces.resolve(project.workspaceRoot)) === "slipjay",
        },
      })
      .pipe(failed("Unable to move the chat"));
    yield* followSchedules(thread.id, project.id);
    if (input.continuation !== undefined)
      yield* threads
        .sendToThread({
          projectId: project.id,
          commandId: input.continuation.commandId,
          threadId: thread.id,
          messageId: input.continuation.messageId,
          ...(input.continuation.senderThreadId === undefined
            ? {}
            : { senderThreadId: input.continuation.senderThreadId }),
          text: input.continuation.text ?? movedContinuationText(project.title),
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
