import type { DesktopScreenRecordingIndicatorAction } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { videoMimeType } from "~/types";
import { toastManager } from "../ui/toast";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import {
  browserComposerScreenRecorderHost,
  COMPOSER_SCREEN_RECORDING_LIMIT_MS,
  createComposerScreenRecorder,
  type ComposerScreenRecorder,
  type ComposerScreenRecordingState,
} from "./composerScreenRecording";

/** The thread a recording attaches to: the one where Record was pressed. */
export interface ScreenRecordingOrigin {
  readonly target: ComposerThreadTarget;
  readonly title: string;
  readonly open: () => void;
}

export interface ScreenRecordingSnapshot {
  readonly state: ComposerScreenRecordingState;
  readonly origin: ScreenRecordingOrigin | null;
  /**
   * Whether the desktop shows the controls outside the window, so the app needs no bar. "pending"
   * keeps the bar from flashing up while the desktop places its indicator.
   */
  readonly indicator: "none" | "pending" | "shown";
}

// One capture at a time for the whole app, so a recording outlives the composer that started it.
let recorder: ComposerScreenRecorder | null = null;
let snapshot: ScreenRecordingSnapshot = {
  state: { phase: "idle" },
  origin: null,
  indicator: "none",
};
const listeners = new Set<() => void>();
let indicatorRevision = 0;
let indicatorActionsSubscribed = false;
// Pressing Stop takes the user back to the recording's thread; the time limit stopping it does not.
let stopRequested = false;

const publish = (next: Partial<ScreenRecordingSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
};

const showIndicator = (state: ComposerScreenRecordingState) => {
  const setIndicator = window.desktopBridge?.setScreenRecordingIndicator;
  if (!setIndicator || (state.phase !== "recording" && snapshot.indicator === "none")) return;
  const revision = ++indicatorRevision;
  if (state.phase === "recording" && snapshot.indicator === "none")
    publish({ indicator: "pending" });
  const indicator =
    state.phase === "recording"
      ? {
          elapsedMs: state.elapsedMs,
          resumedAt: state.resumedAt,
          limitMs: COMPOSER_SCREEN_RECORDING_LIMIT_MS,
          source: state.source,
          canChangeSource: state.canChangeSource,
        }
      : null;
  void setIndicator(indicator).then(
    (shown) => {
      if (revision === indicatorRevision) publish({ indicator: shown ? "shown" : "none" });
    },
    () => {
      if (revision === indicatorRevision) publish({ indicator: "none" });
    },
  );
};

const subscribeToIndicatorActions = () => {
  const onAction = window.desktopBridge?.onScreenRecordingIndicatorAction;
  if (indicatorActionsSubscribed || !onAction) return;
  indicatorActionsSubscribed = true;
  onAction((action: DesktopScreenRecordingIndicatorAction) =>
    action === "change-source"
      ? screenRecordingControls.changeSource()
      : screenRecordingControls[action](),
  );
};

// FluidVoice dictation runs while the recording is running, so the narration lands with the video.
// Calls queue because each one reads FluidVoice's live state before tapping its hotkey.
let dictationWanted = false;
let dictationQueue: Promise<void> = Promise.resolve();
let dictationFailureReported = false;

const syncDictation = (state: ComposerScreenRecordingState) => {
  const setDictation = window.desktopBridge?.setDictation;
  if (state.phase === "idle") dictationFailureReported = false;
  const wanted = state.phase === "recording" && state.resumedAt !== null;
  if (!setDictation || wanted === dictationWanted) return;
  dictationWanted = wanted;
  dictationQueue = dictationQueue
    .then(() => setDictation(wanted))
    .catch((error: unknown) => {
      if (dictationFailureReported) return;
      dictationFailureReported = true;
      toastManager.add({
        type: "warning",
        title: "Couldn't control FluidVoice dictation",
        description: error instanceof Error ? error.message : undefined,
      });
    });
};

const onStateChange = (state: ComposerScreenRecordingState) => {
  publish({ state });
  showIndicator(state);
  syncDictation(state);
};

export const screenRecordingControls = {
  pause: () => recorder?.pause(),
  resume: () => recorder?.resume(),
  stop: () => {
    if (!recorder) return;
    stopRequested = true;
    recorder.stop();
  },
  discard: () => recorder?.discard(),
  changeSource: () => {
    void recorder?.changeSource().then((change) => {
      if (change.type !== "failed") return;
      toastManager.add({
        type: "error",
        title: "Couldn't change what's recorded",
        description: change.error instanceof Error ? change.error.message : undefined,
      });
    });
  },
};

// A recording that cannot attach is still the user's work, so offer it as a download.
const reportUnattached = (file: File, description: string) => {
  const id = toastManager.add({
    type: "error",
    title: "Couldn't attach the recording",
    description,
    actionProps: {
      children: "Save video",
      onClick: () => {
        toastManager.close(id);
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
    },
  });
};

const attach = (origin: ScreenRecordingOrigin, file: File, maxFileBytes: number) => {
  if (file.size > maxFileBytes) {
    reportUnattached(file, fileAttachmentTooLargeMessage(file.name, maxFileBytes));
    return;
  }
  const mimeType = videoMimeType({ name: file.name, mimeType: file.type }) ?? file.type;
  const stored = useComposerDraftStore.getState().addFiles(
    origin.target,
    [
      {
        type: "file",
        id: randomUUID(),
        name: file.name,
        mimeType,
        sizeBytes: file.size,
        file: file.type === mimeType ? file : new File([file], file.name, { type: mimeType }),
      },
    ],
    { appendReference: true },
  );
  if (stored.length === 0) {
    reportUnattached(
      file,
      `The draft in "${origin.title}" is full or no longer exists. Save the video to attach it yourself.`,
    );
    return;
  }
  if (stopRequested) {
    origin.open();
    toastManager.add({
      type: "success",
      title: "Recording attached",
      description: `Added to the draft in "${origin.title}".`,
    });
    return;
  }
  const id = toastManager.add({
    type: "success",
    title: "Recording attached",
    description: `Added to the draft in "${origin.title}".`,
    actionProps: {
      children: "Open",
      onClick: () => {
        toastManager.close(id);
        origin.open();
      },
    },
  });
};

/**
 * A refused macOS Screen Recording permission arrives as the same `NotAllowedError` as a dismissed
 * picker, so ask the desktop shell, which SnapShot already uses for this.
 */
async function explainRefusedScreenRecording(): Promise<void> {
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

export async function startScreenRecording(
  origin: ScreenRecordingOrigin,
  maxFileBytes: number,
): Promise<void> {
  if (recorder) return;
  subscribeToIndicatorActions();
  const current = createComposerScreenRecorder(
    browserComposerScreenRecorderHost(maxFileBytes),
    onStateChange,
  );
  recorder = current;
  stopRequested = false;
  publish({ origin });
  const outcome = await current.start();
  if (recorder === current) recorder = null;
  publish({ origin: null });
  if (outcome?.type === "recorded") {
    attach(origin, outcome.file, maxFileBytes);
  } else if (outcome?.type === "busy") {
    toastManager.add({
      type: "info",
      title: "A browser recording is in progress.",
      description: "Stop it before recording your screen.",
    });
  } else if (outcome?.type === "not-allowed") {
    await explainRefusedScreenRecording();
  } else if (outcome?.type === "failed") {
    toastManager.add({
      type: "error",
      title: "Couldn't record the screen",
      description: outcome.error instanceof Error ? outcome.error.message : undefined,
    });
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;

export function useScreenRecording(): ScreenRecordingSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
