import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ChatMessage } from "~/types";
import {
  type SnapShotOverlayComposerPlacement,
  isSnapShotOverlayDocked,
  useSnapShotOverlaySession,
} from "./snapShotOverlaySession";

/** The most messages the overlay shows of a conversation; the rest are in T3. */
export const SNAP_SHOT_TRANSCRIPT_LIMIT = 30;

/**
 * Where the overlay's composer is: up, or put away behind the pill, by the user or while the
 * agent works until the user brings it up for that turn. Expanded, the whole conversation shows
 * above it.
 */
export interface SnapShotOverlayDock {
  readonly docked: boolean;
  readonly working: boolean;
  /** The latest message the user sent, and the agent's reply to it once one exists. */
  readonly prompt: ChatMessage | null;
  readonly reply: ChatMessage | null;
  /** The conversation's latest prompts and replies, oldest first. */
  readonly transcript: ReadonlyArray<ChatMessage>;
  /** Whether earlier messages are left out of `transcript`. */
  readonly truncated: boolean;
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
}

/** The dock's state for a chat's messages. `turn` names the turn being worked on. */
export function resolveSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
  placement: SnapShotOverlayComposerPlacement,
): Omit<SnapShotOverlayDock, "expanded" | "setExpanded"> & { readonly turn: string | null } {
  const promptIndex = messages.findLastIndex((message) => message.role === "user");
  const prompt = messages[promptIndex] ?? null;
  const reply =
    prompt === null
      ? null
      : (messages.slice(promptIndex + 1).findLast((message) => message.role === "assistant") ??
        null);
  const turn = working ? (prompt?.id ?? "") : null;
  const conversation = messages.filter((message) => message.role !== "system");
  return {
    // An unsent chat has nothing to put away for.
    docked: (prompt !== null || working) && isSnapShotOverlayDocked(placement, turn),
    working,
    prompt,
    reply,
    transcript: conversation.slice(-SNAP_SHOT_TRANSCRIPT_LIMIT),
    truncated: conversation.length > SNAP_SHOT_TRANSCRIPT_LIMIT,
    turn,
  };
}

/** The overlay chat's dock; `report` tells the overlay which turn is being worked on. */
export function useSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
  report: boolean,
): SnapShotOverlayDock {
  const placement = useSnapShotOverlaySession(
    useShallow(({ hidden, raisedTurn }) => ({ hidden, raisedTurn })),
  );
  const [expanded, setExpanded] = useState(false);
  const { turn, ...dock } = resolveSnapShotOverlayDock(messages, working, placement);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the overlay's working turn to the session store the overlay window shares
  useEffect(() => {
    if (report) useSnapShotOverlaySession.getState().setWorkingTurn(turn);
  }, [report, turn]);
  return { ...dock, expanded, setExpanded };
}

/**
 * The overlay's composer comes back from its dock ready for a follow-up, once it has risen:
 * focusing it on the way up would scroll the overlay to it. Returns the composer stack's ref.
 */
export function useSnapShotOverlayComposerFocus(
  overlayPresentation: boolean,
  dock: SnapShotOverlayDock,
  focusComposer: () => void,
) {
  const composerStackRef = useRef<HTMLDivElement>(null);
  const composerRaised = overlayPresentation && dock.prompt !== null && !dock.docked;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the overlay composer after its DOM entrance animations settle
  useEffect(() => {
    if (!composerRaised) return;
    const cancellation = { cancelled: false };
    const rising = composerStackRef.current?.getAnimations() ?? [];
    void Promise.allSettled(rising.map((animation) => animation.finished)).then(() => {
      if (!cancellation.cancelled) focusComposer();
    });
    return () => {
      cancellation.cancelled = true;
    };
  }, [focusComposer, composerRaised]);
  return composerStackRef;
}

/**
 * `overlay` is the SnapShot overlay's compact chat: the timeline and composer only, without the
 * header, side panels, terminal or draft hero.
 */
export type ChatViewPresentation = "app" | "overlay";
