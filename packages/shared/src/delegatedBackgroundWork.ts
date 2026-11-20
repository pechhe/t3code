import type { PendingBackgroundWorkTask } from "./orchestrationV2PendingBackgroundWork.ts";
import { isWatchBackgroundTask } from "./orchestrationV2PendingBackgroundWork.ts";

/**
 * Whether a delegated task's result still waits for its background work. Work that will produce it
 * holds: its own subagents, opaque background tasks and pull request watches, and a command or monitor the child
 * awaited, which wakes the child when it ends and so ends the wait with its own timeout. A command
 * the child did not await is a dev server or a watchdog and never holds.
 */
export function delegatedCompletionHold(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "taskId" | "kind" | "awaited">>,
): boolean {
  return tasks.some(
    (task) =>
      isWatchBackgroundTask(task.taskId) ||
      (task.kind !== "command" && task.kind !== "monitor") ||
      task.awaited === true,
  );
}

/** The own commands and monitors a result abandons by publishing while they still run. */
export function abandonedBackgroundWork<
  Task extends Pick<PendingBackgroundWorkTask, "taskId" | "kind">,
>(tasks: ReadonlyArray<Task>): ReadonlyArray<Task> {
  return tasks.filter(
    (task) =>
      !isWatchBackgroundTask(task.taskId) && (task.kind === "command" || task.kind === "monitor"),
  );
}
