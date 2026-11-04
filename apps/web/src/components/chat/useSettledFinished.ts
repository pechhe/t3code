import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const RECENTLY_FINISHED_MS = 10_000;
const EMPTY_THREAD_ID_SET: ReadonlySet<ThreadId> = new Set();

// Remembered for the session, so coming back to a thread shows only what finished while away.
const settledFinishedByThread = new Map<string, ReadonlySet<ThreadId>>();

function subscribeToDocumentVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const isDocumentVisible = () => document.visibilityState === "visible";

/**
 * Which finished subagents have had their time in view and moved down into the finished list.
 * Each gets its own full time; going out of view starts them all over when they return.
 */
export function useSettledFinished(
  threadRef: ScopedThreadRef,
  finishedIds: ReadonlyArray<ThreadId>,
  visible: boolean,
  holdMs = RECENTLY_FINISHED_MS,
) {
  const key = `${threadRef.environmentId}:${threadRef.threadId}`;
  const [settled, setSettled] = useState<ReadonlySet<ThreadId>>(EMPTY_THREAD_ID_SET);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  if (settledKey !== key) {
    setSettledKey(key);
    setSettled(settledFinishedByThread.get(key) ?? EMPTY_THREAD_ID_SET);
  }
  const documentVisible = useSyncExternalStore(subscribeToDocumentVisibility, isDocumentVisible);
  const inView = visible && documentVisible;
  const pending = finishedIds.filter((id) => !settled.has(id)).join("\n");
  const shownAt = useRef(new Map<ThreadId, number>());
  useEffect(() => {
    const shown = shownAt.current;
    if (pending === "" || !inView) {
      shown.clear();
      return;
    }
    const ids = pending.split("\n") as ThreadId[];
    const now = Date.now();
    for (const id of shown.keys()) {
      if (!ids.includes(id)) shown.delete(id);
    }
    for (const id of ids) {
      if (!shown.has(id)) shown.set(id, now);
    }
    const dueAt = (id: ThreadId) => (shown.get(id) ?? now) + holdMs;
    const nextDue = Math.min(...ids.map(dueAt));
    const timer = setTimeout(
      () => {
        setSettled((current) => {
          const next = new Set([...current, ...ids.filter((id) => dueAt(id) <= nextDue)]);
          settledFinishedByThread.set(key, next);
          return next;
        });
      },
      Math.max(0, nextDue - now),
    );
    return () => clearTimeout(timer);
  }, [holdMs, inView, key, pending]);
  return settled;
}
