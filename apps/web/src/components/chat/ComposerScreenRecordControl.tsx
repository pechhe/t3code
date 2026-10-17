import type { DesktopScreenRecordingSupport } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, ScreenShareIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_SCREEN_RECORDING_LIMIT_MS,
  composerScreenRecordingSupported,
  type ComposerScreenRecordingState,
  screenRecordingElapsedMs,
} from "./composerScreenRecording";
import { screenRecordingControls, useScreenRecording } from "./screenRecordingSession";

// The desktop's answer is fixed for the life of the app, so every composer shares one read.
let desktopSupport: DesktopScreenRecordingSupport | null | undefined;
let desktopSupportRead: Promise<void> | null = null;

/**
 * Electron passes the browser capability check everywhere, but it can only let the user pick a
 * source where the desktop reports support, so Record stays hidden elsewhere.
 */
export function useComposerScreenRecordingAvailable(): boolean {
  const bridge = window.desktopBridge;
  const getSupport = bridge?.getScreenRecordingSupport;
  const [support, setSupport] = useState(desktopSupport);
  useEffect(() => {
    if (!getSupport || support !== undefined) return;
    let active = true;
    desktopSupportRead ??= getSupport().then(
      (value) => {
        desktopSupport = value;
      },
      () => {
        desktopSupport = null;
      },
    );
    void desktopSupportRead.then(() => {
      if (active) setSupport(desktopSupport);
    });
    return () => {
      active = false;
    };
  }, [getSupport, support]);
  if (!composerScreenRecordingSupported()) return false;
  // Desktop builds without the support check also lack the display-media handler.
  if (bridge) return support === "supported";
  return true;
}

const formatClock = (ms: number) => {
  const seconds = Math.floor(Math.max(0, Math.min(ms, COMPOSER_SCREEN_RECORDING_LIMIT_MS)) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function RecordingElapsed({
  state,
}: {
  readonly state: Extract<ComposerScreenRecordingState, { phase: "recording" }>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = state.resumedAt !== null;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);
  return (
    <span role="timer" className="text-muted-foreground text-xs tabular-nums">
      {formatClock(screenRecordingElapsedMs(state, now))} /{" "}
      {formatClock(COMPOSER_SCREEN_RECORDING_LIMIT_MS)}
    </span>
  );
}

export function ComposerScreenRecordControl({
  busy,
  onStart,
}: {
  readonly busy: boolean;
  readonly onStart: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onStart}
            aria-label="Record screen"
          />
        }
      >
        <ScreenShareIcon />
      </TooltipTrigger>
      <TooltipPopup>
        {busy ? "A recording is in progress" : "Record a screen or window (up to 1 minute)"}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Recording controls on every screen, for clients where the desktop does not show them outside
 * the window. A recording keeps going across threads, so its controls cannot live in a composer.
 */
export function ScreenRecordingBar() {
  const { state, origin, indicator } = useScreenRecording();
  if (state.phase !== "recording" || indicator !== "none") return null;
  const paused = state.resumedAt === null;
  return (
    <div
      role="region"
      aria-label="Screen recording"
      className="bg-popover text-popover-foreground fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border py-1 pr-1 pl-3 shadow-lg"
    >
      <span
        aria-hidden
        className={
          paused ? "bg-muted-foreground size-2 rounded-full" : "bg-destructive size-2 rounded-full"
        }
      />
      <RecordingElapsed state={state} />
      {origin ? (
        <span className="text-muted-foreground max-w-48 truncate text-xs">for {origin.title}</span>
      ) : null}
      {state.canChangeSource ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Change what's recorded"
                onClick={screenRecordingControls.changeSource}
              />
            }
          >
            {state.preview ? (
              <img src={state.preview} alt="" className="max-h-5 max-w-10 rounded-sm border" />
            ) : (
              <ScreenShareIcon />
            )}
          </TooltipTrigger>
          <TooltipPopup>Change what's recorded</TooltipPopup>
        </Tooltip>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={paused ? "Resume recording" : "Pause recording"}
        onClick={paused ? screenRecordingControls.resume : screenRecordingControls.pause}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={screenRecordingControls.stop}>
        <SquareIcon />
        Stop
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Discard recording"
        onClick={screenRecordingControls.discard}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
