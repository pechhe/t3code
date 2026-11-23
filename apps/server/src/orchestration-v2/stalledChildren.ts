import type { OrchestrationV2ThreadStalled, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { STUCK_WORKING_AFTER_MS, THREAD_STALLED_AFTER_MS } from "@t3tools/shared/threadStanding";

export interface StalledChildCandidate {
  readonly topLevelThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly title: string;
  /** The later of the live run's start and the child's newest provider event, in epoch ms. */
  readonly lastProviderActivityAt: number;
  readonly holdingCompletion?: true;
}

/**
 * Which top-level threads wait on a stalled child: the child that has been quiet longest wins, so
 * the mark stays put while it stays quiet and moves only when that child speaks.
 */
export function decideStalledThreads(
  now: number,
  candidates: ReadonlyArray<StalledChildCandidate>,
): ReadonlyMap<ThreadId, OrchestrationV2ThreadStalled> {
  const stalled = new Map<ThreadId, StalledChildCandidate>();
  for (const candidate of candidates) {
    const threshold = candidate.holdingCompletion
      ? STUCK_WORKING_AFTER_MS
      : THREAD_STALLED_AFTER_MS;
    if (
      !Number.isFinite(candidate.lastProviderActivityAt) ||
      now - candidate.lastProviderActivityAt < threshold
    )
      continue;
    const current = stalled.get(candidate.topLevelThreadId);
    if (
      current === undefined ||
      candidate.lastProviderActivityAt < current.lastProviderActivityAt
    ) {
      stalled.set(candidate.topLevelThreadId, candidate);
    }
  }
  return new Map(
    [...stalled].map(([threadId, candidate]) => [
      threadId,
      {
        childThreadId: candidate.childThreadId,
        title: candidate.title,
        since: DateTime.formatIso(DateTime.makeUnsafe(candidate.lastProviderActivityAt)),
      },
    ]),
  );
}

export const DELIVERY_STALLED_PREFIX = "Delivery stalled · ";
export const BACKGROUND_STALLED_PREFIX = "Background work stalled · ";

export function isCompletionStall(stalled: OrchestrationV2ThreadStalled | undefined): boolean {
  return (
    stalled?.title.startsWith(DELIVERY_STALLED_PREFIX) === true ||
    stalled?.title.startsWith(BACKGROUND_STALLED_PREFIX) === true
  );
}
