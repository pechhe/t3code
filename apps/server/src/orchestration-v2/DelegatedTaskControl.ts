/**
 * The fork's delegated-task control, out of upstream's `Orchestrator.ts`, which keeps only hook
 * lines. Groups: stop pauses and resumes, follow-ups, app-owned completion, message targeting.
 * Pure except through the `emitEvent` the Orchestrator passes in.
 */
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type {
  CommandId,
  OrchestrationV2AppThread,
  MessageId,
  NodeId,
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { type delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import {
  abandonedBackgroundWorkNote,
  delegatedTaskRunHold,
} from "@t3tools/provider-core/server/delegatedTaskHold";
import { delegatedTaskResultRun, delegatedTaskRuns, runOutcome } from "./RestartBackgroundNote.ts";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import {
  PAUSED_TASK_RESUME_MESSAGE_PREFIX,
  serverContinuationCapReached,
} from "./serverContinuation.ts";

type NewEvent<Type extends OrchestrationV2DomainEvent["type"]> = Omit<
  Extract<OrchestrationV2DomainEvent, { readonly type: Type }>,
  "id"
>;

/** The Orchestrator's `emit(events, command)`, handed in so this module adds no state or I/O. */
export type EmitEvent<E = never> = <Event extends OrchestrationV2DomainEvent>(
  event: Omit<Event, "id">,
) => Effect.Effect<unknown, E>;

const taskUpdatedEvent = (
  threadId: ThreadId,
  task: OrchestrationV2Subagent,
  payload: OrchestrationV2Subagent,
  now: DateTime.Utc,
): NewEvent<"subagent.updated"> => ({
  type: "subagent.updated",
  threadId,
  ...(task.runId === null ? {} : { runId: task.runId }),
  nodeId: task.id,
  driver: task.driver,
  providerInstanceId: task.providerInstanceId,
  occurredAt: now,
  payload,
});

/** A person's message from a client resumes a stopped thread, and so does a task's resume. */
export function resumesStoppedThread(message: {
  readonly messageId: MessageId;
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
}): boolean {
  return (
    (message.createdBy === "user" &&
      (message.creationSource === "web" || message.creationSource === "mobile") &&
      message.scheduledTaskId === undefined) ||
    message.messageId.startsWith(PAUSED_TASK_RESUME_MESSAGE_PREFIX)
  );
}

/** A Stop that paused tasks left their run's cohort stopped; other threads skip the resume. */
function mayHavePausedTasks(runs: ReadonlyArray<OrchestrationV2Run>): boolean {
  return runs.some((run) => run.delegatedCompletion?.disposition === "stopped");
}

function pausedTasksResumeEffect(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${input.commandId}:delegated-tasks.resume:${input.runId}`,
    commandId: input.commandId,
    threadId: input.threadId,
    request: { type: "delegated-tasks.resume" },
  };
}

/** The resume effect a started run carries when its message resumes a thread a Stop paused. */
export function pausedTasksResumeEffects(input: {
  readonly resumes: boolean;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  return input.resumes && mayHavePausedTasks(input.runs)
    ? [
        pausedTasksResumeEffect({
          commandId: input.commandId,
          threadId: input.threadId,
          runId: input.runId,
        }),
      ]
    : [];
}

export function withoutPausedMark(task: OrchestrationV2Subagent): OrchestrationV2Subagent {
  const { pausedByParentStop: _paused, ...unpaused } = task;
  return unpaused;
}

/** Cancelling a task a Stop disposed closes it, so it is neither continued nor resumed. */
export function closedStoppedTaskEvent(input: {
  readonly parentThreadId: ThreadId;
  readonly task: OrchestrationV2Subagent;
  readonly state: "acknowledged" | "disposed";
  readonly now: DateTime.Utc;
}): NewEvent<"subagent.updated"> | undefined {
  const { task, state, now } = input;
  if (
    state !== "disposed" ||
    task.completionDelivery?.state !== "disposed" ||
    !(task.completionDelivery.stopped === true || task.pausedByParentStop === true)
  ) {
    return undefined;
  }
  return taskUpdatedEvent(
    input.parentThreadId,
    task,
    {
      ...withoutPausedMark(task),
      completionDelivery: { state, observedByRunId: null },
      updatedAt: now,
    },
    now,
  );
}

/** A repeated Stop reaches a cohort the first one settled; re-emitting it would only wake clients. */
export function stopFindsCohortSettled(input: {
  readonly cohort: OrchestrationV2Run["delegatedCompletion"];
  readonly nextDisposition: "open" | "stopped" | "disposed";
  readonly tasks: ReadonlyArray<OrchestrationV2Subagent>;
  readonly keptTaskCount: number;
}): boolean {
  const settledTasks = input.tasks.every(
    (task) =>
      task.completionDelivery?.state === "acknowledged" ||
      task.completionDelivery?.state === "delivered" ||
      task.completionDelivery?.state === "disposed",
  );
  return (
    input.keptTaskCount === 0 &&
    input.cohort?.disposition === input.nextDisposition &&
    input.cohort.delivery === null &&
    settledTasks
  );
}

/** Marks each live local task of a stopped thread paused, before the cohort disposal settles it. */
export const pauseStoppedTasks = <E>(input: {
  readonly emitEvent: EmitEvent<E>;
  readonly threadId: ThreadId;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly now: DateTime.Utc;
}) =>
  Effect.forEach(
    input.subagents.filter(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        task.pausedByParentStop !== true &&
        (task.status === "idle" || isOrchestrationV2WorkActive(task.status)),
    ),
    (task) =>
      input.emitEvent(
        taskUpdatedEvent(
          input.threadId,
          task,
          { ...task, pausedByParentStop: true, updatedAt: input.now },
          input.now,
        ),
      ),
    { discard: true },
  );

/** Every run whose completion cohort a Stop disposes: the given ones, delivering ones, open tasks'. */
export function stoppedCohortRunIds(input: {
  readonly runIds: ReadonlyArray<RunId>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}): Set<RunId> {
  const cohortRunIds = new Set(input.runIds);
  for (const run of input.runs) {
    if (run.delegatedCompletion?.delivery != null) cohortRunIds.add(run.id);
  }
  for (const task of input.subagents) {
    const delivery = task.completionDelivery?.state;
    if (
      task.origin === "app_owned" &&
      task.runId !== null &&
      delivery !== "acknowledged" &&
      delivery !== "delivered" &&
      delivery !== "disposed"
    ) {
      cohortRunIds.add(task.runId);
    }
  }
  return cohortRunIds;
}

/**
 * A tree walk stops a child whose turn ended but whose run still waits (on its checkpoint or
 * on work under it), so its task ends interrupted rather than reporting a run that is over.
 */
// Untraced: runs inside the Orchestrator's dispatch span, as the inline code it replaced did.
export const interruptWaitingChildRun = Effect.fnUntraced(function* <E, E2>(input: {
  readonly emitEvent: EmitEvent<E>;
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly loadRootNode: (
    nodeId: NodeId,
  ) => Effect.Effect<
    Extract<OrchestrationV2ThreadProjection["nodes"][number], { readonly id: NodeId }> | undefined,
    E2
  >;
  readonly now: DateTime.Utc;
}) {
  const { emitEvent, threadId, run, now } = input;
  const rootNode = run.rootNodeId === null ? undefined : yield* input.loadRootNode(run.rootNodeId);
  if (rootNode !== undefined) {
    yield* emitEvent({
      type: "node.updated",
      threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...rootNode, status: "interrupted", completedAt: now },
    });
  }
  yield* emitEvent({
    type: "run.updated",
    threadId,
    runId: run.id,
    ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "interrupted", completedAt: now },
  });
});

/** A follow-up carries the conversation on, so the tasks a Stop paused there are resumed. */
export function resumedPausedTaskEvents(input: {
  readonly paused: ReadonlyArray<OrchestrationV2Subagent>;
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly now: DateTime.Utc;
}): ReadonlyArray<NewEvent<"subagent.updated">> {
  return input.paused
    .filter((task) => task.childThreadId === input.childThreadId)
    .map((task) =>
      taskUpdatedEvent(
        input.parentThreadId,
        task,
        { ...withoutPausedMark(task), updatedAt: input.now },
        input.now,
      ),
    );
}

/** What the published result adds to the child's text: abandoned work and a spent restart loop. */
export function delegatedResultNote(input: {
  readonly abandonedBackgroundWork: Parameters<typeof abandonedBackgroundWorkNote>[0];
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly childRun: OrchestrationV2Run;
}): string {
  const abandonedNote = abandonedBackgroundWorkNote(input.abandonedBackgroundWork);
  // The restart loop's last run is cancelled, so its result would not say why it stopped.
  const restartLoopNote =
    input.childRun.status === "cancelled" &&
    input.childRun.restartContinuationOfRunId !== undefined &&
    serverContinuationCapReached(input.runs, input.childRun)
      ? "Stopped after T3 Code restarted this task too many times in a row, so it needs a follow-up."
      : undefined;
  return [abandonedNote, restartLoopNote].filter((note) => note !== undefined).join("\n\n");
}

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * The original task publishes only the thread's available result; a follow-up publishes its
 * own run's result once the work that run left behind, inside its grace, is done.
 */
export function followupPublicationHold(input: {
  readonly childControls: Parameters<typeof delegatedTaskRunHold>[0];
  readonly progress: ReturnType<typeof delegatedTaskProgress>;
  readonly pendingBlockingAdvice: boolean;
  readonly task: OrchestrationV2Subagent;
  readonly originalTaskId: NodeId;
  readonly terminalStatusOf: (status: OrchestrationV2Run["status"]) => unknown;
}):
  | { readonly publish: false }
  | {
      readonly publish: true;
      readonly abandonedBackgroundWork: ReturnType<
        typeof delegatedTaskRunHold
      >["abandonedBackgroundWork"];
    } {
  const { childControls, progress, task } = input;
  const taskRuns = delegatedTaskRuns(childControls, task.id);
  const taskRun =
    taskRuns.length === 0
      ? task.id === input.originalTaskId
        ? progress.resultRun
        : undefined
      : delegatedTaskResultRun(taskRuns);
  const ownedRunIds =
    taskRuns.length === 0 ? undefined : new Set(taskRuns.map((candidate) => candidate.id));
  const hold =
    taskRun === undefined || input.terminalStatusOf(runOutcome(taskRun)) === null
      ? undefined
      : delegatedTaskRunHold(
          { ...childControls, pendingBlockingAdvice: input.pendingBlockingAdvice },
          taskRun,
          ownedRunIds,
        );
  if (
    progress.state !== "result_available" &&
    (task.id === input.originalTaskId || hold?.held === true)
  )
    return { publish: false };
  return { publish: true, abandonedBackgroundWork: hold?.abandonedBackgroundWork ?? [] };
}

/**
 * A run the thread queues for itself continues the task of the run that sent it, and a
 * restart the provider runs as the next turn continues the task of the turn it stopped.
 */
export function continuedDelegatedTaskId(
  command: MessageDispatch,
  runs: ReadonlyArray<OrchestrationV2Run>,
  isActiveRun: (run: OrchestrationV2Run) => boolean,
) {
  const continuedRunId =
    command.restartContinuationOfRunId ??
    command.manualContinuationOfRunId ??
    command.usageLimitContinuationOfRunId ??
    command.delegatedCompletion?.parentRunId ??
    (command.dispatchMode.type === "restart_active" ? command.dispatchMode.targetRunId : undefined);
  return runs.find((run) =>
    continuedRunId === undefined
      ? command.senderThreadId === command.threadId && isActiveRun(run)
      : run.id === continuedRunId,
  )?.delegatedTaskId;
}

/**
 * A message only for a running turn goes straight into it or nowhere: none of the dispatch
 * conversions (start, queue, steer when ready) may turn it into a turn of its own.
 */
// Untraced: runs inside the Orchestrator's dispatch span, as the inline code it replaced did.
export const ensureTurnStillRunning = Effect.fnUntraced(function* <E, E2>(input: {
  readonly command: MessageDispatch;
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly providerTurns: OrchestrationV2ThreadProjection["providerTurns"];
  readonly dispatchMode: MessageDispatch["dispatchMode"];
  readonly stopReachedRun: (runId: RunId) => Effect.Effect<boolean, E>;
  readonly fail: (fields: {
    readonly commandId: CommandId;
    readonly commandType: MessageDispatch["type"];
    readonly cause: string;
  }) => Effect.Effect<never, E2>;
}) {
  const { dispatchMode } = input;
  const targetRunId =
    dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active"
      ? dispatchMode.targetRunId
      : undefined;
  const target = input.runs.find((run) => run.id === targetRunId);
  if (
    target === undefined ||
    target.status !== "running" ||
    !input.providerTurns.some(
      (turn) => turn.runAttemptId === target.activeAttemptId && turn.status === "running",
    ) ||
    (yield* input.stopReachedRun(target.id))
  ) {
    return yield* input.fail({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: "The targeted turn is not running, and this message was only for its turn.",
    });
  }
});

type RefusalFields = {
  readonly commandId: CommandId;
  readonly commandType: MessageDispatch["type"];
  readonly cause: string;
};

/** Advice reaches a delegation only while it is open: not ended, not complete, not stopped. */
// Untraced: runs inside the Orchestrator's dispatch span, as the inline code it replaced did.
export const ensureAdviceMayDeliver = Effect.fnUntraced(function* <E, E2>(input: {
  readonly command: MessageDispatch;
  readonly loadRuns: Effect.Effect<ReadonlyArray<OrchestrationV2Run>, E>;
  readonly loadThread: Effect.Effect<OrchestrationV2AppThread, E>;
  readonly loadParentSubagents: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, E>;
  readonly stopReachedRun: (runId: RunId) => Effect.Effect<boolean, E>;
  readonly fail: (fields: RefusalFields) => Effect.Effect<never, E2>;
}) {
  const { command } = input;
  const delivery = command.adviceDelivery;
  if (delivery === undefined) return;
  const refuse = (cause: string) =>
    input.fail({ commandId: command.commandId, commandType: command.type, cause });
  const latest = latestExecutedRun(yield* input.loadRuns);
  const destination = yield* input.loadThread;
  const parentId =
    command.threadId === delivery.workerThreadId
      ? destination.lineage.parentThreadId
      : command.threadId;
  if (parentId !== null) {
    const tasks = (yield* input.loadParentSubagents(parentId)).filter(
      (task) =>
        task.origin === "app_owned" &&
        (task.childThreadId === delivery.workerThreadId ||
          task.remoteChild?.threadId === delivery.workerThreadId),
    );
    const owner =
      tasks.findLast(
        (task) =>
          task.result === null &&
          task.completionDelivery?.state !== "disposed" &&
          !["completed", "failed", "interrupted", "cancelled"].includes(task.status),
      ) ?? tasks.at(-1);
    if (
      owner === undefined ||
      owner.result !== null ||
      owner.completionDelivery?.state === "disposed" ||
      ["completed", "failed", "interrupted", "cancelled"].includes(owner.status)
    )
      return yield* refuse("Advice cannot revive an ended delegation.");
  } else if (latest?.status === "completed" && !(delivery.blocking && delivery.runId === latest.id))
    return yield* refuse("Advice cannot revive completed work.");

  if (
    latest !== null &&
    (["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status) ||
      (yield* input.stopReachedRun(latest.id)))
  )
    return yield* refuse("Advice cannot resume a stopped thread.");
});

/** A thread with running delegated tasks is not archived until they end or are cancelled. */
export const ensureNoRunningDelegatedTasks = Effect.fnUntraced(function* <E, R>(input: {
  readonly command: {
    readonly commandId: CommandId;
    readonly type: string;
    readonly threadId: ThreadId;
  };
  readonly loadSubagents: Effect.Effect<
    { readonly subagents: ReadonlyArray<OrchestrationV2Subagent> },
    E,
    R
  >;
  readonly fail: (fields: {
    readonly commandId: CommandId;
    readonly commandType: string;
    readonly cause: string;
  }) => Effect.Effect<never, E>;
}) {
  const records = yield* input.loadSubagents;
  if (
    records.subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        isOrchestrationV2WorkActive(task.status),
    )
  )
    return yield* input.fail({
      commandId: input.command.commandId,
      commandType: input.command.type,
      cause: `Thread ${input.command.threadId} has running delegated tasks. Wait for them or cancel them before archiving.`,
    });
});

/** Only a managed conversation accepts a follow-up source revision. */
export const ensureFollowupSourceAccepted = <E>(input: {
  readonly command: MessageDispatch;
  readonly thread: OrchestrationV2AppThread;
  readonly fail: (fields: RefusalFields) => Effect.Effect<never, E>;
}) =>
  input.command.followupSourceRevision !== undefined && input.thread.agentTask === undefined
    ? input.fail({
        commandId: input.command.commandId,
        commandType: input.command.type,
        cause: "Only a managed conversation accepts a follow-up source revision.",
      })
    : Effect.void;

/** Stamps the follow-up's source revision on the thread as its message left it. */
// Untraced: runs inside the Orchestrator's dispatch span, as the inline code it replaced did.
export const recordFollowupSourceRevision = Effect.fnUntraced(function* <E>(input: {
  readonly command: MessageDispatch;
  readonly thread: OrchestrationV2AppThread;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly emitEvent: EmitEvent<E>;
}) {
  const { command, thread } = input;
  if (command.followupSourceRevision === undefined) return;
  const updated =
    (yield* Ref.get(input.events))
      .flatMap((event) =>
        event.type === "thread.metadata-updated" && event.payload.id === thread.id
          ? [event.payload]
          : [],
      )
      .at(-1) ?? thread;
  yield* input.emitEvent({
    type: "thread.metadata-updated",
    threadId: thread.id,
    occurredAt: updated.updatedAt,
    payload: { ...updated, followupSourceRevision: command.followupSourceRevision },
  });
});

/** A terminal child's result is published even when no event arrives to say so. */
export const sweepDelegatedTaskResults = <E, E2, R>(input: {
  readonly recoveryThreadIds: Effect.Effect<ReadonlyArray<ThreadId>, E>;
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E2>;
  readonly finalizeUnderParentLock: (
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
  ) => Effect.Effect<unknown, E2, R>;
}) =>
  input.recoveryThreadIds.pipe(
    Effect.tap((threadIds) =>
      Effect.annotateCurrentSpan("recovery.subagentResultThreads", threadIds.length),
    ),
    Effect.flatMap((threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          Effect.gen(function* () {
            // The full row, not the shell: a deleted child is no shell, and its parent still waits.
            const thread = yield* input.loadThread(threadId);
            const parentThreadId = thread.lineage.parentThreadId;
            if (parentThreadId === null) return;
            yield* input.finalizeUnderParentLock(parentThreadId, threadId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to recover terminal app-owned subagent", {
                childThreadId: threadId,
                cause,
              }),
            ),
          ),
        { concurrency: 8, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to inspect app-owned subagents during recovery", {
        cause,
      }),
    ),
  );

/** Before the parent hears of a delegated task's failure, a recovery may continue it. */
export const scheduleFailedRunRecovery = <E, R>(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly schedule: Effect.Effect<unknown, E, R>;
}) =>
  input.schedule.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to schedule a delegated task recovery", {
        threadId: input.threadId,
        runId: input.runId,
        cause,
      }),
    ),
  );
