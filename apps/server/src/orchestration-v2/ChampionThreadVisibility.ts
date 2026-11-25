import type {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

/**
 * Champion threads are kept out of the lists of clients that don't announce `championThreads`, such
 * as the shipped App Store app: they have no Champion screen, and every check would crowd the list.
 * A Champion thread that waits on the person stays listed, and so does an escalation thread.
 */
export function championThreadHiddenFromList(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "champion"
    | "pendingRuntimeRequest"
    | "pendingReleaseApprovals"
    | "hasActionableProposedPlan"
    | "pendingGuestMessageCount"
  >,
): boolean {
  return (
    thread.champion !== undefined &&
    thread.champion.kind !== "escalation" &&
    thread.pendingRuntimeRequest === null &&
    (thread.pendingReleaseApprovals?.length ?? 0) === 0 &&
    !thread.hasActionableProposedPlan &&
    (thread.pendingGuestMessageCount ?? 0) === 0
  );
}

export function withoutChampionThreads(
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem {
  switch (item.kind) {
    case "snapshot":
      return {
        ...item,
        snapshot: {
          ...item.snapshot,
          threads: item.snapshot.threads.filter((thread) => !championThreadHiddenFromList(thread)),
          archivedThreads: item.snapshot.archivedThreads.filter(
            (thread) => !championThreadHiddenFromList(thread),
          ),
        },
      };
    case "thread.updated":
      return championThreadHiddenFromList(item.thread)
        ? {
            kind: "thread.removed",
            sequence: item.sequence,
            location: item.location,
            threadId: item.thread.id,
          }
        : item;
    default:
      return item;
  }
}
