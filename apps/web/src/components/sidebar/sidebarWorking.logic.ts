import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { hasPlanReadyPrompt } from "../Sidebar.logic";

type NeedsYouInput = Pick<
  EnvironmentThreadShell,
  | "standing"
  | "parkedWaitGaveUp"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "hasActionableProposedPlan"
>;

/**
 * Whether an Active thread waits on its owner, so it sorts above Ready and Done threads. A
 * failed run the owner has seen settles to finished standing, and so drops out.
 */
export function isThreadNeedsYouForActiveSort(thread: NeedsYouInput): boolean {
  const standing = thread.standing;
  if (standing?.state === "stalled") return true;
  if (standing?.state === "needs_you" && standing.waitsOnPerson?.need !== "hold") return true;
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0 ||
    hasPlanReadyPrompt(thread) ||
    (standing === undefined && thread.parkedWaitGaveUp !== undefined)
  );
}

/** Keeps each tier's order and lifts the threads that need the owner above the rest. */
export function liftNeedsYouThreads<T extends NeedsYouInput>(threads: readonly T[]): T[] {
  const needsYou: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) {
    (isThreadNeedsYouForActiveSort(thread) ? needsYou : rest).push(thread);
  }
  return needsYou.length === 0 || rest.length === 0 ? [...threads] : [...needsYou, ...rest];
}
