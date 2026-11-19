import type { OrchestrationV2Subagent } from "./orchestrationV2.ts";

/**
 * `task_cancel` closed the task: its completion was disposed other than by a Stop, which leaves a
 * task open to follow-ups. A closed task never runs again.
 */
export function isOrchestrationV2TaskClosed(
  task: Pick<OrchestrationV2Subagent, "completionDelivery" | "pausedByParentStop">,
): boolean {
  return (
    task.completionDelivery?.state === "disposed" &&
    task.completionDelivery.stopped !== true &&
    task.pausedByParentStop !== true
  );
}
