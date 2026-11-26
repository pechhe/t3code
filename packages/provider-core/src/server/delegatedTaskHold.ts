import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  abandonedBackgroundWork,
  delegatedCompletionHold,
} from "@t3tools/shared/delegatedBackgroundWork";
import {
  backgroundWorkName,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

import { subagentHoldsCompletion } from "./subagentProjection.ts";

/** The turn items `delegatedTaskProgress` reads: those that can still be background work. */
export const delegatedTaskProgressTurnItems = {
  turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
  turnItemStatuses: ["pending", "running", "waiting"],
} as const satisfies {
  readonly turnItemTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly turnItemStatuses: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
};

export type DelegatedTaskProjection = {
  readonly pendingBlockingAdvice?: boolean;
  readonly thread: Pick<OrchestrationV2AppThread, "pullRequests" | "activeProviderThreadId"> &
    Partial<Pick<OrchestrationV2AppThread, "parkedWaits" | "agentTask" | "lineage">>;
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  /** Active turn items are enough: only those can be pending background work. */
  readonly turnItems: Parameters<typeof derivePendingBackgroundWork>[0]["turnItems"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification" | "createdBy">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery"> &
      Partial<Pick<OrchestrationV2ThreadProjection["subagents"][number], "runId">>
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["providerThreads"][number],
      "id" | "pendingBackgroundTasks"
    >
  >;
};

/**
 * A delegated child waiting on another thread, a Forge item, a landing or Production keeps its result
 * until the wake, so its parent never acts on a partial answer; a wait on a time does not.
 */
function waitHoldsDelegatedResult(
  target: NonNullable<OrchestrationV2AppThread["parkedWaits"]>[number]["target"],
): boolean {
  return target.kind !== "time";
}

/**
 * How one result run stands: whether the thread's own work still holds it, and the commands and
 * monitors a publish would abandon. A managed task holds for an awaited command only through the
 * grace period; its pull request watches do, and so do the waits `waitHoldsDelegatedResult` names.
 */
export function delegatedTaskRunHold(
  projection: DelegatedTaskProjection,
  resultRun: OrchestrationV2Run,
  ownedRunIds?: ReadonlySet<OrchestrationV2Run["id"]>,
): {
  readonly held: boolean;
  readonly abandonedBackgroundWork: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
} {
  // Before source settlement, failed/cancelled/interrupted runs left dynamic_tool items running.
  // Remove this compatibility filter once no such stored run can still hold a task open.
  const stoppedRunIds = new Set(
    projection.runs
      .filter((run) => ["failed", "cancelled", "interrupted"].includes(run.status))
      .map((run) => String(run.id)),
  );
  // A follow-up waits only on the work its own runs started: a roster resends the tasks an earlier
  // run left running, and the projection keeps each one's run.
  const ownsRun = (runId: OrchestrationV2Run["id"] | null | undefined) =>
    runId == null || runId === resultRun.id || ownedRunIds?.has(runId) === true;
  const startedByResultRun = (task: OrchestrationV2PendingBackgroundTask) => ownsRun(task.runId);
  const overtakenByLaterRun =
    ownedRunIds !== undefined &&
    projection.runs.some(
      (run) =>
        !ownsRun(run.id) &&
        (run.startedAt !== null || run.ordinal === 1) &&
        run.status !== "rolled_back" &&
        run.status !== "queued" &&
        runRanAfter(run, resultRun),
    );
  const backgroundWork = [
    ...new Map(
      [
        ...derivePendingBackgroundWork({
          latestRun: resultRun,
          providerThreads: projection.providerThreads,
          turnItems: projection.turnItems.filter(
            (item) => item.type !== "dynamic_tool" || !stoppedRunIds.has(String(item.runId)),
          ),
          activeProviderThreadId: projection.thread.activeProviderThreadId,
          runs: projection.runs,
          pullRequests: projection.thread.pullRequests,
        }).filter(startedByResultRun),
        ...projection.providerThreads
          .flatMap((thread) => thread.pendingBackgroundTasks ?? [])
          .filter(startedByResultRun),
      ].map((task) => [task.taskId, task] as const),
    ).values(),
  ];
  // A delegated child's result waits with its parent: an awaited command or monitor holds until it
  // ends and wakes the child, while a plain thread's own work holds whatever it is.
  const managed =
    projection.thread.agentTask !== undefined ||
    projection.thread.lineage?.relationshipToParent === "subagent";
  const holdsWork = managed ? delegatedCompletionHold(backgroundWork) : backgroundWork.length > 0;
  const held =
    (!overtakenByLaterRun &&
      ((projection.pendingBlockingAdvice === true && resultRun.status === "completed") ||
        (projection.thread.agentTask !== undefined &&
          (projection.thread.parkedWaits ?? []).some((wait) =>
            waitHoldsDelegatedResult(wait.target),
          )))) ||
    projection.subagents.some(
      (task) => (ownedRunIds === undefined || ownsRun(task.runId)) && subagentHoldsCompletion(task),
    ) ||
    holdsWork;
  return {
    held,
    abandonedBackgroundWork: held ? [] : abandonedBackgroundWork(backgroundWork),
  };
}

/** What a delivered result says about the background work it published over. */
export function abandonedBackgroundWorkNote(
  tasks: ReadonlyArray<
    Pick<OrchestrationV2PendingBackgroundTask, "taskId" | "description" | "kind">
  >,
): string | undefined {
  if (tasks.length === 0) return undefined;
  return `Abandoned background work: ${tasks
    .map((task) => `${task.taskId} (${backgroundWorkName(task)})`)
    .join(", ")}.`;
}
