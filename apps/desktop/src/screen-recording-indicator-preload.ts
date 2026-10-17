// @effect-diagnostics globalDate:off globalTimers:off -- The sandboxed pill ticks its own clock against the renderer's epoch timestamps.
import { ipcRenderer } from "electron";

import {
  SCREEN_RECORDING_INDICATOR_PILL_CHANNEL,
  SCREEN_RECORDING_INDICATOR_STATE_CHANNEL,
} from "./ipc/channels.ts";

interface IndicatorState {
  readonly elapsedMs: number;
  readonly resumedAt: number | null;
  readonly limitMs: number;
  readonly preview: string | null;
  readonly canChangeSource: boolean;
}

const formatClock = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

window.addEventListener("DOMContentLoaded", () => {
  const clock = document.getElementById("clock");
  const changeSource = document.getElementById("change-source");
  const preview = document.getElementById("preview");
  let state: IndicatorState | null = null;
  let ticker: number | undefined;
  const render = () => {
    if (!state || !clock) return;
    const running = state.resumedAt === null ? 0 : Date.now() - state.resumedAt;
    clock.textContent = formatClock(Math.min(state.elapsedMs + running, state.limitMs));
  };
  ipcRenderer.on(SCREEN_RECORDING_INDICATOR_STATE_CHANNEL, (_event, next: IndicatorState) => {
    state = next;
    document.body.toggleAttribute("data-paused", next.resumedAt === null);
    if (changeSource) changeSource.hidden = !next.canChangeSource;
    if (next.preview === null) preview?.removeAttribute("src");
    else if (preview?.getAttribute("src") !== next.preview)
      preview?.setAttribute("src", next.preview);
    window.clearInterval(ticker);
    // Ticks only while recording; a paused clock does not repaint.
    if (next.resumedAt !== null) ticker = window.setInterval(render, 1_000);
    render();
  });
  for (const action of ["pause", "resume", "stop", "discard", "change-source"] as const) {
    document
      .getElementById(action)
      ?.addEventListener("click", () =>
        ipcRenderer.send(SCREEN_RECORDING_INDICATOR_PILL_CHANNEL, action),
      );
  }
});
