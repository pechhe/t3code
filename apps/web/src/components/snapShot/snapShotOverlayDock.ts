import { useState } from "react";

import type { ChatMessage } from "~/types";

/**
 * Where the overlay's composer is: up, or docked below the screen edge while the agent works,
 * until the user raises it for that turn. Expanded, the whole conversation shows above it.
 */
export interface SnapShotOverlayDock {
  readonly docked: boolean;
  readonly working: boolean;
  /** The latest message the user sent, and the agent's reply to it once one exists. */
  readonly prompt: ChatMessage | null;
  readonly reply: ChatMessage | null;
  readonly raise: () => void;
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
}

/**
 * The dock's state for a chat's messages. `turn` names the turn being worked on, and
 * `raisedTurn` the turn the user last raised the composer for.
 */
export function resolveSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
  raisedTurn: string | null,
): Pick<SnapShotOverlayDock, "docked" | "working" | "prompt" | "reply"> & {
  readonly turn: string | null;
} {
  const promptIndex = messages.findLastIndex((message) => message.role === "user");
  const prompt = messages[promptIndex] ?? null;
  const reply =
    prompt === null
      ? null
      : (messages.slice(promptIndex + 1).findLast((message) => message.role === "assistant") ??
        null);
  const turn = working ? (prompt?.id ?? "") : null;
  return { docked: turn !== null && raisedTurn !== turn, working, prompt, reply, turn };
}

export function useSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
): SnapShotOverlayDock {
  const [raisedTurn, setRaisedTurn] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { turn, ...dock } = resolveSnapShotOverlayDock(messages, working, raisedTurn);
  return { ...dock, raise: () => setRaisedTurn(turn), expanded, setExpanded };
}
