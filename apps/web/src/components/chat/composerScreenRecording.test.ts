import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_SCREEN_RECORDING_LIMIT_MS,
  composerScreenRecordingFileName,
  createComposerScreenRecorder,
  type ComposerScreenRecordingState,
} from "./composerScreenRecording";

class FakeTrack extends EventTarget {
  stopped = false;
  constructor(readonly kind: "video" | "audio") {
    super();
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(...kinds: Array<"video" | "audio">) {
    this.tracks = kinds.map((kind) => new FakeTrack(kind));
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  removeTrack(track: FakeTrack) {
    this.tracks.splice(this.tracks.indexOf(track), 1);
  }
}

class FakeRecorder extends EventTarget {
  state: RecordingState = "inactive";
  mimeType = "video/webm;codecs=vp9";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // Like a real recorder, the final chunk and `stop` arrive after `state` already changed.
    queueMicrotask(() => {
      const chunk = new Event("dataavailable") as Event & { data: Blob };
      chunk.data = new Blob(["frames"], { type: this.mimeType });
      this.dispatchEvent(chunk);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

const setup = (
  options: { readonly pick?: () => Promise<FakeStream>; readonly captureBusy?: boolean } = {},
) => {
  const stream = new FakeStream("video", "audio");
  const recorder = new FakeRecorder();
  const states: ComposerScreenRecordingState["phase"][] = [];
  const getDisplayMedia = vi.fn(options.pick ?? (async () => stream));
  const screenRecorder = createComposerScreenRecorder(
    {
      captureBusy: () => options.captureBusy ?? false,
      getDisplayMedia: getDisplayMedia as never,
      createRecorder: () => recorder as unknown as MediaRecorder,
      now: () => Date.now(),
    },
    (state) => states.push(state.phase),
  );
  const allTracksStopped = () => stream.tracks.every((track) => track.stopped);
  return { stream, recorder, states, getDisplayMedia, screenRecorder, allTracksStopped };
};

describe("composer screen recording", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 14, 5, 9) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for video only and drops any audio the picker granted", async () => {
    const { stream, getDisplayMedia, screenRecorder } = setup();
    const audio = stream.getAudioTracks()[0]!;
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(audio.stopped).toBe(true);
    expect(stream.getAudioTracks()).toEqual([]);
    screenRecorder.discard();
    await outcome;
  });

  it("stops by itself at the limit and keeps what was captured", async () => {
    const { states, screenRecorder, allTracksStopped } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(COMPOSER_SCREEN_RECORDING_LIMIT_MS - 1);
    expect(screenRecorder.getState().phase).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    if (result?.type !== "recorded") throw new Error(`expected a recording, got ${result?.type}`);
    expect(result.file.name).toBe("Screen recording 2026-10-16 at 14.05.09.webm");
    expect(result.file.type).toBe("video/webm;codecs=vp9");
    expect(await result.file.text()).toBe("frames");
    expect(allTracksStopped()).toBe(true);
    expect(states).toEqual(["picking", "recording", "finishing", "idle"]);
  });

  it("keeps the recording and clears the limit timer when stopped", async () => {
    const { screenRecorder, allTracksStopped } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(5_000);
    screenRecorder.stop();
    expect((await outcome)?.type).toBe("recorded");
    expect(allTracksStopped()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the recording when sharing ends from the system indicator", async () => {
    const { stream, screenRecorder } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    stream.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    expect((await outcome)?.type).toBe("recorded");
  });

  it("discards synchronously, stopping every track", async () => {
    const { screenRecorder, allTracksStopped, recorder } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    screenRecorder.discard();
    expect(allTracksStopped()).toBe(true);
    expect(recorder.state).toBe("inactive");
    expect(screenRecorder.getState().phase).toBe("idle");
    expect(await outcome).toEqual({ type: "discarded" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a stream that arrives after a discard during the picker", async () => {
    let grant!: (stream: FakeStream) => void;
    const late = new FakeStream("video");
    const { screenRecorder } = setup({
      pick: () => new Promise((resolve) => (grant = resolve)),
    });
    const outcome = screenRecorder.start();
    screenRecorder.discard();
    grant(late);
    expect(await outcome).toEqual({ type: "discarded" });
    expect(late.tracks.every((track) => track.stopped)).toBe(true);
  });

  it("reports a dismissed picker without attaching anything", async () => {
    const { screenRecorder } = setup({
      pick: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    });
    expect(await screenRecorder.start()).toEqual({ type: "not-allowed" });
    expect(screenRecorder.getState().phase).toBe("idle");
  });

  it("does not ask for a capture while a browser-panel recording holds the request slot", async () => {
    const { screenRecorder, getDisplayMedia, states } = setup({ captureBusy: true });
    expect(await screenRecorder.start()).toEqual({ type: "busy" });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("ignores a second start while one is in progress", async () => {
    const { screenRecorder } = setup();
    const outcome = screenRecorder.start();
    expect(await screenRecorder.start()).toBeNull();
    screenRecorder.discard();
    await outcome;
  });
});

describe("composerScreenRecordingFileName", () => {
  it("names MP4 output .mp4", () => {
    expect(
      composerScreenRecordingFileName(
        new Date(2026, 0, 2, 3, 4, 5).getTime(),
        "video/mp4;codecs=avc1",
      ),
    ).toBe("Screen recording 2026-01-02 at 03.04.05.mp4");
  });
});
