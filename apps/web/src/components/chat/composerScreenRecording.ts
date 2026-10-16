import { readActiveBrowserRecordingTabIds } from "~/browser/browserRecording";
import { createMediaRecorder, recordedMimeType, stopMediaStream } from "~/browser/mediaRecording";

export const COMPOSER_SCREEN_RECORDING_LIMIT_MS = 60_000;
const FRAME_RATE = 30;
// MediaRecorder treats the bitrate as a target, so leave headroom under the upload cap.
const UPLOAD_CAP_HEADROOM = 0.8;

export type ComposerScreenRecordingState =
  | { readonly phase: "idle" }
  | { readonly phase: "picking" }
  | { readonly phase: "recording"; readonly startedAt: number }
  | { readonly phase: "finishing" };

export type ComposerScreenRecordingOutcome =
  | { readonly type: "recorded"; readonly file: File }
  /** Browsers report a dismissed picker and a refused OS permission the same way. */
  | { readonly type: "not-allowed" }
  | { readonly type: "discarded" }
  | { readonly type: "busy" }
  | { readonly type: "failed"; readonly error: unknown };

export interface ComposerScreenRecorderHost {
  /**
   * The desktop answers an armed browser-panel recording's display-media request by frame, and the
   * composer asks from the same frame, so the composer must not ask while one is starting or running.
   */
  readonly captureBusy: () => boolean;
  readonly getDisplayMedia: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly createRecorder: (stream: MediaStream) => MediaRecorder;
  readonly now: () => number;
}

export function composerScreenRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

export function browserComposerScreenRecorderHost(
  maxFileBytes: number,
): ComposerScreenRecorderHost {
  const maxVideoBitsPerSecond = Math.floor(
    (maxFileBytes * 8 * UPLOAD_CAP_HEADROOM) / (COMPOSER_SCREEN_RECORDING_LIMIT_MS / 1_000),
  );
  return {
    captureBusy: () => readActiveBrowserRecordingTabIds().size > 0,
    getDisplayMedia: (options) => navigator.mediaDevices.getDisplayMedia(options),
    createRecorder: (stream) => createMediaRecorder(stream, { maxVideoBitsPerSecond }),
    now: () => Date.now(),
  };
}

export function composerScreenRecordingFileName(startedAt: number, mimeType: string): string {
  const date = new Date(startedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const extension = mimeType.toLowerCase().startsWith("video/mp4") ? "mp4" : "webm";
  return `Screen recording ${day} at ${time}.${extension}`;
}

const isNotAllowedError = (error: unknown) =>
  error instanceof DOMException && error.name === "NotAllowedError";

/**
 * One capture at a time. `start` settles when the capture ends, whether stopped, auto-stopped at
 * the limit, ended from the OS sharing indicator, or discarded; every path stops all tracks.
 */
export function createComposerScreenRecorder(
  host: ComposerScreenRecorderHost,
  onStateChange: (state: ComposerScreenRecordingState) => void,
) {
  let state: ComposerScreenRecordingState = { phase: "idle" };
  let discardPicking: (() => void) | null = null;
  let finishRecording: ((keep: boolean) => void) | null = null;

  const setState = (next: ComposerScreenRecordingState) => {
    state = next;
    onStateChange(next);
  };

  const record = (stream: MediaStream): Promise<ComposerScreenRecordingOutcome> => {
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = host.createRecorder(stream);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.start(1_000);
    } catch (error) {
      stopMediaStream(stream);
      setState({ phase: "idle" });
      return Promise.resolve({ type: "failed", error });
    }
    // Registered up front: a recorder whose tracks ended stops on its own, and its final chunk
    // arrives just before this event even though `state` already reads "inactive".
    const recorderStopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    const startedAt = host.now();
    setState({ phase: "recording", startedAt });

    return new Promise((resolve) => {
      let done = false;
      const finish = async (keep: boolean) => {
        if (done) return;
        done = true;
        if (finishRecording === finishOnce) finishRecording = null;
        clearTimeout(limitTimer);
        if (!keep) {
          stopMediaStream(stream);
          if (recorder.state !== "inactive") recorder.stop();
          setState({ phase: "idle" });
          resolve({ type: "discarded" });
          return;
        }
        setState({ phase: "finishing" });
        try {
          if (recorder.state !== "inactive") recorder.stop();
          await recorderStopped;
        } finally {
          stopMediaStream(stream);
        }
        const mimeType = recordedMimeType(recorder, chunks);
        setState({ phase: "idle" });
        if (!mimeType || chunks.length === 0) {
          resolve({ type: "failed", error: new Error("The screen recording captured no video.") });
          return;
        }
        const file = new File(chunks, composerScreenRecordingFileName(startedAt, mimeType), {
          type: mimeType,
          lastModified: host.now(),
        });
        resolve({ type: "recorded", file });
      };
      const finishOnce = (keep: boolean) => {
        void finish(keep).catch((error: unknown) => {
          stopMediaStream(stream);
          setState({ phase: "idle" });
          resolve({ type: "failed", error });
        });
      };
      finishRecording = finishOnce;
      const limitTimer = setTimeout(() => finishOnce(true), COMPOSER_SCREEN_RECORDING_LIMIT_MS);
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => finishOnce(true), { once: true });
      }
    });
  };

  return {
    getState: () => state,
    start: async (): Promise<ComposerScreenRecordingOutcome | null> => {
      if (state.phase !== "idle") return null;
      if (host.captureBusy()) return { type: "busy" };
      setState({ phase: "picking" });
      let discarded = false;
      const picking = () => {
        discarded = true;
      };
      discardPicking = picking;
      let stream: MediaStream;
      try {
        stream = await host.getDisplayMedia({
          audio: false,
          video: { frameRate: { ideal: FRAME_RATE, max: FRAME_RATE } },
        });
      } catch (error) {
        if (discardPicking === picking) discardPicking = null;
        setState({ phase: "idle" });
        if (discarded) return { type: "discarded" };
        return isNotAllowedError(error) ? { type: "not-allowed" } : { type: "failed", error };
      }
      if (discardPicking === picking) discardPicking = null;
      if (discarded) {
        stopMediaStream(stream);
        setState({ phase: "idle" });
        return { type: "discarded" };
      }
      for (const track of stream.getAudioTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
      return record(stream);
    },
    stop: () => finishRecording?.(true),
    discard: () => {
      discardPicking?.();
      discardPicking = null;
      finishRecording?.(false);
    },
  };
}

export type ComposerScreenRecorder = ReturnType<typeof createComposerScreenRecorder>;
