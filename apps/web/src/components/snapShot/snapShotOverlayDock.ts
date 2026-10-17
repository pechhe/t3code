import { useState } from "react";

import type { ChatMessage } from "~/types";

/**
 * Where the overlay's composer is: up, or docked below the screen edge while the agent works
 * or while the user has tucked it away to see the app behind. `toggle` flips the default for
 * the current turn only, so the next send or reply starts from its own default again.
 */
export interface SnapShotOverlayDock {
  readonly docked: boolean;
  readonly working: boolean;
  /** The latest message the user sent, and the agent's reply to it once one exists. */
  readonly prompt: ChatMessage | null;
  readonly reply: ChatMessage | null;
  readonly toggle: () => void;
}

/**
 * The dock's state for a chat's messages. `phase` names the current turn, working or answered,
 * and `toggledPhase` is the phase the user last flipped.
 */
export function resolveSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
  toggledPhase: string | null,
): Omit<SnapShotOverlayDock, "toggle"> & { readonly phase: string | null } {
  const promptIndex = messages.findLastIndex((message) => message.role === "user");
  const prompt = messages[promptIndex] ?? null;
  const reply =
    prompt === null
      ? null
      : (messages.slice(promptIndex + 1).findLast((message) => message.role === "assistant") ??
        null);
  // While working the composer docks and the user can raise it; once the reply is in it rises
  // and the user can tuck it away.
  const phase = working ? `working:${prompt?.id ?? ""}` : prompt ? `done:${prompt.id}` : null;
  const toggled = phase !== null && toggledPhase === phase;
  return { docked: phase !== null && working !== toggled, working, prompt, reply, phase };
}

export function useSnapShotOverlayDock(
  messages: ReadonlyArray<ChatMessage>,
  working: boolean,
): SnapShotOverlayDock {
  const [toggledPhase, setToggledPhase] = useState<string | null>(null);
  const { phase, ...dock } = resolveSnapShotOverlayDock(messages, working, toggledPhase);
  return {
    ...dock,
    toggle: () => setToggledPhase((current) => (current === phase ? null : phase)),
  };
}
