import type { DesktopScreenRecordingSupport } from "@t3tools/contracts";
import { ScreenShareIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_SCREEN_RECORDING_LIMIT_MS,
  composerScreenRecordingSupported,
  type ComposerScreenRecordingState,
} from "./composerScreenRecording";

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

function RecordingElapsed({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return (
    <span role="timer" className="text-muted-foreground text-xs tabular-nums">
      {formatClock(now - startedAt)} / {formatClock(COMPOSER_SCREEN_RECORDING_LIMIT_MS)}
    </span>
  );
}

export function ComposerScreenRecordControl({
  state,
  onStart,
  onStop,
}: {
  readonly state: ComposerScreenRecordingState;
  readonly onStart: () => void;
  readonly onStop: () => void;
}) {
  if (state.phase === "recording") {
    return (
      <div data-chat-composer-screen-recording="true" className="flex items-center gap-2">
        <RecordingElapsed startedAt={state.startedAt} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onStop}
        >
          <SquareIcon />
          Stop
        </Button>
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={state.phase !== "idle"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onStart}
            aria-label="Record screen"
          />
        }
      >
        <ScreenShareIcon />
      </TooltipTrigger>
      <TooltipPopup>Record a screen or window (up to 1 minute)</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A refused macOS Screen Recording permission arrives as the same `NotAllowedError` as a dismissed
 * picker, so ask the desktop shell, which SnapShot already uses for this.
 */
export async function explainRefusedScreenRecording(): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge?.getSnapShotState || !bridge.setupSnapShot) return;
  const state = await bridge.getSnapShotState().catch(() => null);
  if (state?.macPermissions?.screenRecording !== false) return;
  const id = toastManager.add({
    type: "error",
    title: "T3 Code can't record your screen",
    description: "Allow Screen Recording in System Settings, then restart T3 Code.",
    actionProps: {
      children: "Open System Settings",
      onClick: () => {
        toastManager.close(id);
        void bridge.setupSnapShot?.("allow-screen-recording").catch(() => undefined);
      },
    },
  });
}
