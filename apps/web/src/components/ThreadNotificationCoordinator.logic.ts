import { isQuietRunCompletion, type RunId } from "@t3tools/contracts";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

/** What a thread shell says about whether its finished run has anything to report. */
export interface ThreadRunReport {
  readonly latestRunStopRequested?: boolean | undefined;
  /** A run with nothing to report, such as a compaction T3 started, stays quiet. */
  readonly latestRunSilent?: boolean | undefined;
  readonly readOnCompletionRunId?: RunId | null | undefined;
  readonly latestRun: { readonly runId: RunId; readonly status: string } | null;
}

/**
 * A completion notifies nothing when its run has nothing to report: a manual stop, a silent
 * run, or the run an explicit mark-read request is bound to. Attention still notifies, so a
 * failure or a later run is never hidden.
 */
export function isQuietThreadCompletion(report: ThreadRunReport): boolean {
  return (
    report.latestRunStopRequested === true ||
    report.latestRunSilent === true ||
    isQuietRunCompletion(
      report.readOnCompletionRunId,
      report.latestRun?.runId,
      report.latestRun?.status,
    )
  );
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}
