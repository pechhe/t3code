import type { OrchestrationV2Notification, OrchestrationV2TurnItem } from "@t3tools/contracts";

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
