import type { EnvironmentThreadShell } from "./models.ts";

/**
 * A champion's own threads stay out of thread lists unless the thread itself waits on
 * someone. Champion attention and failed checks show on the Champion page and its
 * sidebar mark instead; listing them crowded the thread list with every check. An escalation
 * thread is the exception: it exists to put one decision or incident in the Inbox.
 */
export function championNeedsInbox(
  thread: Pick<
    EnvironmentThreadShell,
    | "champion"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
  >,
): boolean {
  return (
    thread.champion === undefined ||
    thread.champion.kind === "escalation" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  );
}
