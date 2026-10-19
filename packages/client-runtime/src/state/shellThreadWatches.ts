import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

// The timestamps are strings on the client's shells and DateTimes on the contract's; only null matters.
type WatcherShell = Pick<OrchestrationV2ThreadShell, "id" | "threadWatches"> & {
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
};

/**
 * The threads watching `threadId`, oldest watch first. Watches live on the watcher, and a client
 * holds every active thread's shell, so the reverse list needs nothing from the server. An
 * archived or deleted watcher no longer watches.
 */
export function threadWatchers<Shell extends WatcherShell>(
  shells: Iterable<Shell>,
  threadId: ThreadId,
): ReadonlyArray<Shell> {
  const watchers: Array<{ readonly shell: Shell; readonly startedAt: string }> = [];
  for (const shell of shells) {
    if (shell.archivedAt !== null || shell.deletedAt !== null || shell.id === threadId) continue;
    const watch = shell.threadWatches?.find(
      (candidate) => candidate.target.kind === "thread" && candidate.target.threadId === threadId,
    );
    if (watch !== undefined) watchers.push({ shell, startedAt: watch.startedAt });
  }
  return watchers
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .map(({ shell }) => shell);
}
