// @effect-diagnostics globalTimers:off - A notification hold runs in web and desktop clients, outside an Effect runtime.
import {
  isQuietRunCompletion,
  type OrchestrationV2ThreadStanding,
  type RunId,
} from "@t3tools/contracts";

export type ThreadNotificationKind = "input" | "completion";

type ThreadStandingState = OrchestrationV2ThreadStanding["state"];

export interface ThreadNotificationObservation {
  /** Run, status and request key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The pending request's id, when it has one; null whenever attention is. */
  readonly requestId: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** The server's standing; absent from older servers, where the fields above decide. */
  readonly standing?: ThreadStandingState | undefined;
}

/** What a thread shell says about whether its finished run has anything to report. */
export interface ThreadRunReport {
  readonly latestRunStopRequested?: boolean | undefined;
  /** A run with nothing to report, such as a compaction T3 started, stays quiet. */
  readonly latestRunSilent?: boolean | undefined;
  readonly readOnCompletionRunId?: RunId | null | undefined;
  readonly latestRun: { readonly runId: RunId; readonly status: string } | null;
}

/** A finished thread must stay finished this long, so a wake that starts right after does not ping. */
const FINISHED_NOTIFICATION_HOLD_MS = 5_000;

/** Runs `notify` after `delayMs`, returning the cancel that stops it. */
export type ThreadNotificationHold = (notify: () => void, delayMs: number) => () => void;

const holdWithTimer: ThreadNotificationHold = (notify, delayMs) => {
  const timer = setTimeout(notify, delayMs);
  return () => clearTimeout(timer);
};

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
 * Where the shell carries the server's standing, it alone decides: `needs_you` and `stalled`
 * notify at once, and `finished` waits out the hold. Without standing the runtime rules below
 * decide, exactly as before. Attention and completion each notify once per transition.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
  hold: ThreadNotificationHold = holdWithTimer,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // Finished episodes waiting out the hold, and the ones that have notified.
  const holding = new Map<Key, () => void>();
  const notifiedFinished = new Set<Key>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  // Attention keys with a request id seen since the thread last stopped needing attention.
  const attended = new Map<Key, Set<string>>();
  const attend = (
    key: Key,
    prior: ThreadNotificationObservation | undefined,
    next: ThreadNotificationObservation,
  ): boolean => {
    if (next.attention === null) {
      attended.delete(key);
      return false;
    }
    if (next.requestId === null) return next.attention !== prior?.attention;
    const seen = attended.get(key);
    if (seen?.has(next.attention)) return false;
    if (seen) seen.add(next.attention);
    else attended.set(key, new Set([next.attention]));
    return true;
  };
  const releaseHold = (key: Key) => {
    holding.get(key)?.();
    holding.delete(key);
  };

  const observeStanding = (
    key: Key,
    prior: ThreadNotificationObservation | undefined,
    next: ThreadNotificationObservation,
    options: { readonly archived: boolean; readonly quiet: boolean },
    fresh: boolean,
  ) => {
    const standing = next.standing!;
    if (standing !== "finished") {
      releaseHold(key);
      notifiedFinished.delete(key);
    }
    // The first sighting and archived threads never notify, and neither keeps a pending hold.
    if (!prior || options.archived) {
      releaseHold(key);
      notifiedFinished.delete(key);
      return;
    }
    // Attention standing cannot see (a question below the thread, a linked environment's
    // request) still notifies, and a second question while the thread needs you is a new event.
    if (standing === "needs_you" || standing === "stalled") {
      if (prior.standing !== standing || fresh) notify(key, "input");
      return;
    }
    if (fresh) {
      notify(key, "input");
      return;
    }
    const enteredFinished =
      standing === "finished" && (prior.standing === "working" || prior.standing === "waiting");
    if (!enteredFinished || options.quiet || holding.has(key) || notifiedFinished.has(key)) return;
    holding.set(
      key,
      hold(() => {
        holding.delete(key);
        notifiedFinished.add(key);
        notify(key, "completion");
      }, FINISHED_NOTIFICATION_HOLD_MS),
    );
  };

  // The pre-standing rules, kept whole for a server that sends no standing: attention notifies
  // at once, and completion notifies when a newer run has completed.
  const observeRuntime = (
    key: Key,
    prior: ThreadNotificationObservation | undefined,
    next: ThreadNotificationObservation,
    options: { readonly archived: boolean; readonly quiet: boolean },
    fresh: boolean,
  ) => {
    if (!prior || options.archived) return;
    if (fresh) {
      notify(key, "input");
      return;
    }
    const at = next.completedAt;
    if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
    handled.set(key, at);
    notify(key, "completion");
  };

  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      const fresh = attend(key, prior, next);
      if (next.standing === undefined) observeRuntime(key, prior, next, options, fresh);
      else observeStanding(key, prior, next, options, fresh);
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of attended.keys()) if (!keys.has(key)) attended.delete(key);
      for (const key of notifiedFinished) if (!keys.has(key)) notifiedFinished.delete(key);
      for (const key of Array.from(holding.keys())) if (!keys.has(key)) releaseHold(key);
    },
    clear(): void {
      handled.clear();
      attended.clear();
      notifiedFinished.clear();
      for (const key of Array.from(holding.keys())) releaseHold(key);
    },
  };
}
