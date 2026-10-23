import type { OrchestrationV2Notification, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";

/** One chip per subagent a notification names; a batched delegated-task notice names several. */
export function notificationSubagentRefs(source: OrchestrationV2Notification["source"]) {
  const childThreadId = notificationChildThreadId(source);
  if (source.kind === "delegated_task") {
    // A follow-up runs in the child thread its assignment started, so the task id is what names
    // whose return this is; the child thread is the fallback for a task the parent cannot find.
    if (source.taskIds.length === 1) {
      return [
        {
          subagentId: source.taskIds[0]!,
          ...(childThreadId === undefined ? {} : { childThreadId }),
        },
      ];
    }
    if (childThreadId === undefined) {
      return source.taskIds.map((subagentId) => ({ subagentId }));
    }
  }
  return childThreadId === undefined ? [] : [{ childThreadId }];
}

const SUBAGENT_RETURN_VERBS: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "returned",
  failed: "failed",
  cancelled: "stopped",
  updated: "sent an update",
  unknown: "returned",
};

const SUBAGENT_RETURN_STATUSES: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

export function subagentReturnVerb(outcome: OrchestrationV2Notification["outcome"]): string {
  return SUBAGENT_RETURN_VERBS[outcome];
}

export function subagentReturnStatus(
  outcome: OrchestrationV2Notification["outcome"],
): OrchestrationV2TurnItem["status"] | null {
  return SUBAGENT_RETURN_STATUSES[outcome];
}

type SubagentRoundFacts = {
  readonly id: string;
  readonly origin: "provider_native" | "app_owned";
  readonly childThreadId: string | null;
  readonly startedAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
};

/**
 * Which exchange with the same child conversation a managed task is, counting the assignment
 * that started it as round 1. A follow-up runs in the child thread it continues, so its new
 * subagent record shares that thread's earlier record rather than introducing another agent.
 */
export function subagentFollowUpRound(
  subagents: ReadonlyArray<SubagentRoundFacts>,
  subagentId: string,
): number | null {
  const current = subagents.find((subagent) => subagent.id === subagentId);
  if (current === undefined || current.origin !== "app_owned" || current.childThreadId === null) {
    return null;
  }
  const rounds = subagents
    .filter(
      (subagent) =>
        subagent.origin === "app_owned" && subagent.childThreadId === current.childThreadId,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) -
          DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  const index = rounds.findIndex((subagent) => subagent.id === subagentId);
  return index > 0 ? index + 1 : null;
}

/**
 * The dispatch pill names the exchange; the round's return notification reports its outcome, so a
 * settled follow-up still reads as sent where it was sent.
 */
export function subagentFollowUpVerb(
  status: OrchestrationV2TurnItem["status"],
  reviewing: boolean,
): string {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return "sent";
    default:
      return reviewing ? "reviewing…" : "working…";
  }
}
