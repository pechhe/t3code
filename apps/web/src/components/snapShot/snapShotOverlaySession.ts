import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** How long an ended conversation stays offered for resuming. */
export const SNAP_SHOT_RESUME_WINDOW_MS = 30 * 60 * 1000;

export interface EndedSnapShotConversation {
  readonly threadRef: ScopedThreadRef;
  readonly endedAt: number;
}

/** Whether the conversation's composer is put away behind the pill. */
export interface SnapShotOverlayComposerPlacement {
  /** The user put the composer away. */
  readonly hidden: boolean;
  /** The working turn the user brought the composer up for; it stays up for that turn. */
  readonly raisedTurn: string | null;
}

interface SnapShotOverlaySessionState extends SnapShotOverlayComposerPlacement {
  /** The conversation the overlay last ended, which a fresh chat offers to resume. */
  readonly ended: EndedSnapShotConversation | null;
  readonly endConversation: (threadRef: ScopedThreadRef, now: number) => void;
  readonly forgetEnded: () => void;
  /** Drops an ended conversation once it is too old to offer. */
  readonly forgetStaleEnded: (now: number) => void;
  /** The turn the overlay's chat is working on, as the chat reports it; null while idle. */
  readonly workingTurn: string | null;
  readonly setWorkingTurn: (turn: string | null) => void;
  /** Brings the composer up, for the working turn too. */
  readonly show: () => void;
  /** Puts the composer away, leaving the pill. */
  readonly hide: () => void;
}

/**
 * The overlay keeps one conversation going until the user ends it; the next capture then starts
 * a fresh chat, and the ended one stays a click away for a while. While the conversation goes on,
 * its composer is up or put away behind a pill: put away by the user, or while the agent works.
 */
export const useSnapShotOverlaySession = create<SnapShotOverlaySessionState>()((set) => ({
  ended: null,
  endConversation: (threadRef, now) =>
    set({ ended: { threadRef, endedAt: now }, hidden: false, raisedTurn: null }),
  forgetEnded: () => set({ ended: null }),
  forgetStaleEnded: (now) =>
    set((state) =>
      state.ended && now - state.ended.endedAt >= SNAP_SHOT_RESUME_WINDOW_MS
        ? { ended: null }
        : state,
    ),
  hidden: false,
  raisedTurn: null,
  workingTurn: null,
  setWorkingTurn: (workingTurn) => set({ workingTurn }),
  show: () => set((state) => ({ hidden: false, raisedTurn: state.workingTurn })),
  hide: () => set({ hidden: true }),
}));

/** Whether the composer is put away while `turn`, if any, is being worked on. */
export function isSnapShotOverlayDocked(
  placement: SnapShotOverlayComposerPlacement,
  turn: string | null,
): boolean {
  return placement.hidden || (turn !== null && placement.raisedTurn !== turn);
}

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
