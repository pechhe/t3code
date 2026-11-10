import type { OrchestrationV2ThreadStalled, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { THREAD_STALLED_AFTER_MS } from "@t3tools/shared/threadStanding";

export interface StalledChildCandidate {
  readonly topLevelThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly title: string;
  /** The later of the live run's start and the child's newest provider event, in epoch ms. */
  readonly lastProviderActivityAt: number;
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
    if (now - candidate.lastProviderActivityAt < THREAD_STALLED_AFTER_MS) continue;
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
