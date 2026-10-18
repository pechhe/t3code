import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** How long an ended conversation stays offered for resuming. */
export const SNAP_SHOT_RESUME_WINDOW_MS = 30 * 60 * 1000;

export interface EndedSnapShotConversation {
  readonly threadRef: ScopedThreadRef;
  readonly endedAt: number;
}

interface SnapShotOverlaySessionState {
  /** The conversation the overlay last ended, which a fresh chat offers to resume. */
  readonly ended: EndedSnapShotConversation | null;
  readonly endConversation: (threadRef: ScopedThreadRef, now: number) => void;
  readonly forgetEnded: () => void;
  /** Drops an ended conversation once it is too old to offer. */
  readonly forgetStaleEnded: (now: number) => void;
}

/**
 * The overlay keeps one conversation going until the user ends it; the next capture then starts
 * a fresh chat, and the ended one stays a click away for a while.
 */
export const useSnapShotOverlaySession = create<SnapShotOverlaySessionState>()((set) => ({
  ended: null,
  endConversation: (threadRef, now) => set({ ended: { threadRef, endedAt: now } }),
  forgetEnded: () => set({ ended: null }),
  forgetStaleEnded: (now) =>
    set((state) =>
      state.ended && now - state.ended.endedAt >= SNAP_SHOT_RESUME_WINDOW_MS
        ? { ended: null }
        : state,
    ),
}));

export function isEndedSnapShotConversation(
  ended: EndedSnapShotConversation | null,
  threadRef: ScopedThreadRef,
): boolean {
  return (
    ended !== null &&
    ended.threadRef.environmentId === threadRef.environmentId &&
    ended.threadRef.threadId === threadRef.threadId
  );
}
