/**
 * The fork's delegation behaviour for `ThreadManagementService`, kept out of upstream's file:
 * resuming tasks a Stop paused, external work ownership, and waiting on delegated work.
 */
import * as Effect from "effect/Effect";

import {
  CommandId,
  MessageId,
  type AgentTaskBinding,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

import { PAUSED_TASK_RESUME_MESSAGE_PREFIX } from "./serverContinuation.ts";

const PAUSED_TASK_RESUME_TEXT =
  "Your parent thread was stopped, which interrupted you, and has now resumed. Before you continue, check any operation you had running when you were stopped (a landing, a background command, a delegated task) and whether it finished. Then carry on with your task.";

/** Continues each task a Stop of this thread paused, as a new task in its own conversation. */
export const resumePausedDelegatedTasks = Effect.fn("ThreadManagementService.resumeDelegatedTasks")(
  function* <E, E2>(input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly loadPausedTasks: Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, E>;
    readonly dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<unknown, E2>;
  }) {
    const subagents = yield* input.loadPausedTasks;
    const resumed = new Set<ThreadId>();
    for (const task of subagents) {
      if (task.origin !== "app_owned" || task.childThreadId === null) continue;
      const threadId = task.childThreadId;
      if (resumed.has(threadId)) continue;
      resumed.add(threadId);
      // A task that cannot resume keeps its mark, so the parent's next message tries again.
      yield* input
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${input.commandId}:resume:${threadId}`),
          threadId,
          messageId: MessageId.make(
            `${PAUSED_TASK_RESUME_MESSAGE_PREFIX}${input.commandId}:${threadId}`,
          ),
          senderThreadId: input.threadId,
          text: PAUSED_TASK_RESUME_TEXT,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Unable to resume a delegated task", {
              parentThreadId: input.threadId,
              threadId,
              error,
            }),
          ),
        );
    }
  },
);

type ExternalOwner = NonNullable<AgentTaskBinding["externalOwner"]>;

/**
 * Raw agent messages cannot bypass external work ownership. The owning
 * service may continue a validated task with its authenticated principal.
 */
export const ensureExternalWorkOwner = Effect.fnUntraced(function* <E, E2>(input: {
  readonly command: OrchestrationV2ServerCommand;
  readonly externalWorkOwner: ExternalOwner | undefined;
  readonly getOwner: (threadId: ThreadId) => Effect.Effect<ExternalOwner | undefined, E>;
  readonly reject: (fields: {
    readonly commandId: CommandId;
    readonly commandType: OrchestrationV2ServerCommand["type"];
    readonly cause: string;
  }) => Effect.Effect<never, E2>;
}) {
  const { command, externalWorkOwner } = input;
  if (
    command.type !== "message.dispatch" ||
    command.createdBy !== "agent" ||
    command.dispatchMode.type === "defer_start"
  )
    return;
  const owner = yield* input.getOwner(command.threadId);
  if (
    owner !== undefined &&
    (externalWorkOwner === undefined ||
      owner.environmentId !== externalWorkOwner.environmentId ||
      owner.clientSessionId !== externalWorkOwner.clientSessionId ||
      owner.externalSessionKey !== externalWorkOwner.externalSessionKey ||
      owner.projectId !== externalWorkOwner.projectId ||
      owner.ceiling !== externalWorkOwner.ceiling)
  )
    return yield* input.reject({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Submit a new external work attempt instead of messaging its backing thread.",
    });
});

/** The thread's published result once its delegated work has settled, or undefined while it waits. */
export const delegatedWorkResult = Effect.fnUntraced(function* <E, E2>(input: {
  readonly loadRecords: Effect.Effect<Parameters<typeof delegatedTaskProgress>[0], E>;
  readonly resultPending: Effect.Effect<boolean, E2>;
  readonly isTerminalRunStatus: (status: OrchestrationV2Run["status"]) => boolean;
  readonly latestRun: (projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  }) => OrchestrationV2Run | undefined;
}) {
  const records = yield* input.loadRecords;
  const progress = delegatedTaskProgress(records);
  // A thread rolled back past all its work, with nothing left running, has no answer to wait for.
  if (
    progress.resultRun === undefined &&
    records.runs.every((run) => input.isTerminalRunStatus(run.status))
  ) {
    return input.latestRun(records);
  }
  if (progress.state !== "result_available") return undefined;
  return (yield* input.resultPending) ? undefined : progress.resultRun;
});
