import { readActiveBrowserRecordingTabIds } from "~/browser/browserRecording";
import { createMediaRecorder, recordedMimeType, stopMediaStream } from "~/browser/mediaRecording";

export const COMPOSER_SCREEN_RECORDING_LIMIT_MS = 60_000;
// Agents need fast motion more than detail, and a full Retina screen cannot be captured and encoded
// at 60 fps, so the capture scales down to fit this edge; smaller windows keep their own size.
const FRAME_RATE = 60;
const MAX_EDGE = 1920;
const DISPLAY_MEDIA_OPTIONS: DisplayMediaStreamOptions = {
  audio: false,
  video: {
    frameRate: { ideal: FRAME_RATE, max: FRAME_RATE },
    width: { max: MAX_EDGE },
    height: { max: MAX_EDGE },
  },
};
// MediaRecorder treats the bitrate as a target, so leave headroom under the upload cap.
const UPLOAD_CAP_HEADROOM = 0.8;
const PREVIEW_WIDTH = 160;
const PREVIEW_HEIGHT = 100;
const PREVIEW_INTERVAL_MS = 500;

export type ComposerScreenRecordingState =
  | { readonly phase: "idle" }
  | { readonly phase: "picking" }
  | {
      readonly phase: "recording";
      readonly startedAt: number;
      /** Recorded time before `resumedAt`; paused spans are not recorded and do not count. */
      readonly elapsedMs: number;
      /** When recording last resumed, or null while paused. */
      readonly resumedAt: number | null;
      /**
       * A still of what is being recorded as an image URL. Browsers do not name the surface the
       * user picked, so the picture is how the user tells which one it is.
       */
      readonly preview: string | null;
      readonly canChangeSource: boolean;
    }
  | { readonly phase: "finishing" };

export type ComposerScreenRecordingOutcome =
  | { readonly type: "recorded"; readonly file: File }
  /** Browsers report a dismissed picker and a refused OS permission the same way. */
  | { readonly type: "not-allowed" }
  | { readonly type: "discarded" }
  | { readonly type: "busy" }
  | { readonly type: "failed"; readonly error: unknown };

export type ComposerScreenSourceChange =
  | { readonly type: "changed" }
  /** No change: the picker was dismissed, or there was no recording to change. */
  | { readonly type: "kept" }
  | { readonly type: "failed"; readonly error: unknown };

/** Feeds the recorder one source at a time, so the source can change without a new recording. */
export interface ComposerScreenRelay {
  readonly output: MediaStream;
  readonly use: (track: MediaStreamTrack) => void;
  readonly stop: () => void;
}

export interface ComposerScreenRecorderHost {
  /**
   * The desktop answers an armed browser-panel recording's display-media request by frame, and the
   * composer asks from the same frame, so the composer must not ask while one is starting or running.
   */
  readonly captureBusy: () => boolean;
  readonly getDisplayMedia: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly createRecorder: (stream: MediaStream) => MediaRecorder;
  /** Null where the browser cannot relay frames; the recording then keeps its first source. */
  readonly createRelay: (onPreview: (preview: string) => void) => ComposerScreenRelay | null;
  readonly now: () => number;
}

export function composerScreenRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

// Chromium's frame streams; TypeScript's DOM library does not declare them.
declare const MediaStreamTrackProcessor:
  | (new (init: { readonly track: MediaStreamTrack }) => {
      readonly readable: ReadableStream<VideoFrame>;
    })
  | undefined;
declare const MediaStreamTrackGenerator:
  | (new (init: { readonly kind: "video" }) => MediaStreamTrack & {
      readonly writable: WritableStream<VideoFrame>;
    })
  | undefined;

function createBrowserScreenRelay(
  onPreview: (preview: string) => void,
): ComposerScreenRelay | null {
  if (typeof MediaStreamTrackProcessor === "undefined") return null;
  if (typeof MediaStreamTrackGenerator === "undefined") return null;
  const output = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = output.writable.getWriter();
  const canvas = document.createElement("canvas");
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let previewSize = "";
  let previewAt = -Infinity;
  // Taken again when the picture changes shape, since the first frame of a capture can be a
  // placeholder size and a recorded window can be resized.
  const preview = (frame: VideoFrame) => {
    const size = `${frame.displayWidth}x${frame.displayHeight}`;
    const now = performance.now();
    if (size === previewSize || now - previewAt < PREVIEW_INTERVAL_MS) return;
    previewSize = size;
    previewAt = now;
    const scale = Math.min(
      PREVIEW_WIDTH / frame.displayWidth,
      PREVIEW_HEIGHT / frame.displayHeight,
      1,
    );
    canvas.width = Math.max(1, Math.round(frame.displayWidth * scale));
    canvas.height = Math.max(1, Math.round(frame.displayHeight * scale));
    canvas.getContext("2d")?.drawImage(frame, 0, 0, canvas.width, canvas.height);
    onPreview(canvas.toDataURL("image/jpeg", 0.7));
  };
  const pump = async (source: ReadableStreamDefaultReader<VideoFrame>) => {
    for (;;) {
      const { done, value } = await source.read();
      if (done) return;
      if (reader !== source) {
        value.close();
        return;
      }
      preview(value);
      // The generator closes each frame once written.
      void writer.write(value).catch(() => undefined);
    }
  };
  const release = () => {
    void reader?.cancel().catch(() => undefined);
    reader = null;
  };
  return {
    output: new MediaStream([output]),
    use: (track) => {
      release();
      const next = new MediaStreamTrackProcessor({ track }).readable.getReader();
      reader = next;
      previewSize = "";
      previewAt = -Infinity;
      void pump(next).catch(() => undefined);
    },
    stop: () => {
      release();
      output.stop();
    },
  };
}

export function browserComposerScreenRecorderHost(
  maxFileBytes: number,
): ComposerScreenRecorderHost {
  // The whole budget: the source can change size mid-recording, so its settings are no guide.
  const videoBitsPerSecond = Math.floor(
    (maxFileBytes * 8 * UPLOAD_CAP_HEADROOM) / (COMPOSER_SCREEN_RECORDING_LIMIT_MS / 1_000),
  );
  return {
    captureBusy: () => readActiveBrowserRecordingTabIds().size > 0,
    getDisplayMedia: async (options) => {
      // Preparation only helps the picker; a failed call must not stop the recording.
      await window.desktopBridge?.prepareScreenRecording?.().catch(() => undefined);
      return navigator.mediaDevices.getDisplayMedia(options);
    },
    createRecorder: (stream) => createMediaRecorder(stream, { videoBitsPerSecond }),
    createRelay: createBrowserScreenRelay,
    now: () => Date.now(),
  };
}

export function screenRecordingElapsedMs(
  state: Extract<ComposerScreenRecordingState, { phase: "recording" }>,
  now: number,
): number {
  return state.elapsedMs + (state.resumedAt === null ? 0 : now - state.resumedAt);
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

const videoOnly = (stream: MediaStream) => {
  for (const track of stream.getAudioTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  return stream;
};

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
  let setPaused: ((paused: boolean) => void) | null = null;
  let changeRecordedSource: (() => Promise<ComposerScreenSourceChange>) | null = null;

  const setState = (next: ComposerScreenRecordingState) => {
    state = next;
    onStateChange(next);
  };

  const record = (picked: MediaStream): Promise<ComposerScreenRecordingOutcome> => {
    const chunks: Blob[] = [];
    let source = picked;
    let preview: string | null = null;
    let publishRecording = () => {};
    let relay: ComposerScreenRelay | null = null;
    let recorder: MediaRecorder;
    const stopCapture = () => {
      stopMediaStream(source);
      relay?.stop();
    };
    try {
      relay = host.createRelay((next) => {
        preview = next;
        publishRecording();
      });
      const track = source.getVideoTracks()[0];
      if (relay && track) relay.use(track);
      recorder = host.createRecorder(relay?.output ?? source);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.start(1_000);
    } catch (error) {
      stopCapture();
      setState({ phase: "idle" });
      return Promise.resolve({ type: "failed", error });
    }
    // Registered up front: a recorder whose tracks ended stops on its own, and its final chunk
    // arrives just before this event even though `state` already reads "inactive".
    const recorderStopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    const startedAt = host.now();
    let elapsedMs = 0;
    let resumedAt: number | null = startedAt;
    const canChangeSource = relay !== null;

    return new Promise((resolve) => {
      let done = false;
      let changing = false;
      let limitTimer: ReturnType<typeof setTimeout> | undefined;
      publishRecording = () => {
        if (!done) {
          setState({
            phase: "recording",
            startedAt,
            elapsedMs,
            resumedAt,
            preview,
            canChangeSource,
          });
        }
      };
      const armLimit = () => {
        limitTimer = setTimeout(
          () => finishOnce(true),
          COMPOSER_SCREEN_RECORDING_LIMIT_MS - elapsedMs,
        );
      };
      // Sharing ended from the OS indicator ends the recording, but only for the current source.
      const watchSource = (stream: MediaStream) => {
        for (const track of stream.getVideoTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (source === stream) finishOnce(true);
            },
            { once: true },
          );
        }
      };
      const finish = async (keep: boolean) => {
        if (done) return;
        done = true;
        if (finishRecording === finishOnce) finishRecording = null;
        if (setPaused === pause) setPaused = null;
        if (changeRecordedSource === changeSource) changeRecordedSource = null;
        clearTimeout(limitTimer);
        if (!keep) {
          stopCapture();
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
          stopCapture();
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
          stopCapture();
          setState({ phase: "idle" });
          resolve({ type: "failed", error });
        });
      };
      const applyPause = (paused: boolean) => {
        if (done || paused === (resumedAt === null)) return;
        const now = host.now();
        if (paused) {
          clearTimeout(limitTimer);
          elapsedMs += now - (resumedAt ?? now);
          resumedAt = null;
          recorder.pause();
        } else {
          resumedAt = now;
          recorder.resume();
          armLimit();
        }
        publishRecording();
      };
      // Changing the source holds the pause until the picker closes.
      const pause = (paused: boolean) => {
        if (!changing) applyPause(paused);
      };
      const changeSource = async (): Promise<ComposerScreenSourceChange> => {
        if (done || changing || !relay) return { type: "kept" };
        changing = true;
        // The picker is not part of what the user wants to show.
        const wasRunning = resumedAt !== null;
        applyPause(true);
        try {
          const next = videoOnly(await host.getDisplayMedia(DISPLAY_MEDIA_OPTIONS));
          const track = next.getVideoTracks()[0];
          if (done || !track) {
            stopMediaStream(next);
            return { type: "kept" };
          }
          const previous = source;
          source = next;
          preview = null;
          relay.use(track);
          watchSource(next);
          stopMediaStream(previous);
          return { type: "changed" };
        } catch (error) {
          return isNotAllowedError(error) ? { type: "kept" } : { type: "failed", error };
        } finally {
          changing = false;
          if (wasRunning) applyPause(false);
          publishRecording();
        }
      };
      finishRecording = finishOnce;
      setPaused = pause;
      changeRecordedSource = changeSource;
      publishRecording();
      armLimit();
      watchSource(source);
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
        stream = await host.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
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
      return record(videoOnly(stream));
    },
    stop: () => finishRecording?.(true),
    pause: () => setPaused?.(true),
    resume: () => setPaused?.(false),
    /** Opens the picker again; the recording continues from whatever the user picks. */
    changeSource: (): Promise<ComposerScreenSourceChange> =>
      changeRecordedSource?.() ?? Promise.resolve({ type: "kept" }),
    discard: () => {
      discardPicking?.();
      discardPicking = null;
      finishRecording?.(false);
    },
  };
}

export type ComposerScreenRecorder = ReturnType<typeof createComposerScreenRecorder>;
