import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import {
  delegatedTaskProgressTurnItems,
  delegatedTaskRunHold,
} from "@t3tools/provider-core/server/delegatedTaskHold";
import type { NodeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";
import { delegatedTaskResultRun, delegatedTaskRuns } from "./RestartBackgroundNote.ts";

export interface DelegatedCompletionGuard {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly taskId?: NodeId;
}

/** True when the run is no longer the delegated task's result, so its completion must not commit. */
export const refuses = Effect.fnUntraced(function* (
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"],
  guard: DelegatedCompletionGuard,
) {
  const child = yield* projectionStore.getThreadRecords(
    guard.threadId,
    ["runs", "messages", "subagents", "providerThreads", "turnItems"],
    {
      messageRoles: ["user"],
      ...delegatedTaskProgressTurnItems,
    },
  );
  const pendingBlockingAdvice = yield* projectionStore.hasPendingBlockingAdvice(guard.threadId);
  const projection = { ...child, pendingBlockingAdvice };
  const progress = delegatedTaskProgress(projection);
  const run = child.runs.find((candidate) => candidate.id === guard.runId);
  const originalTaskId =
    child.thread.forkedFrom?.type === "node" ? child.thread.forkedFrom.nodeId : undefined;
  const taskId = guard.taskId ?? run?.delegatedTaskId;
  const followup = taskId !== undefined && taskId !== originalTaskId;
  const taskRuns = followup && taskId !== undefined ? delegatedTaskRuns(child, taskId) : [];
  const ownedRunIds =
    taskRuns.length === 0 ? undefined : new Set(taskRuns.map((candidate) => candidate.id));
  const latestTaskRun =
    followup && taskId !== undefined ? delegatedTaskResultRun(taskRuns) : progress.resultRun;
  return (
    run === undefined ||
    latestTaskRun?.id !== guard.runId ||
    (followup
      ? delegatedTaskRunHold(projection, run, ownedRunIds).held
      : progress.state !== "result_available")
  );
});
