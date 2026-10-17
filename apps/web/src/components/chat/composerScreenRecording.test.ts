import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_SCREEN_RECORDING_LIMIT_MS,
  composerScreenRecordingFileName,
  createComposerScreenRecorder,
  type ComposerScreenRecordingState,
  screenRecordingElapsedMs,
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
  pause() {
    this.state = "paused";
  }
  resume() {
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

class FakeRelay {
  readonly output = new FakeStream("video");
  readonly used: FakeTrack[] = [];
  stopped = false;
  constructor(readonly showPreview: (preview: string) => void) {}
  use(track: FakeTrack) {
    this.used.push(track);
  }
  stop() {
    this.stopped = true;
  }
}

const setup = (
  options: {
    readonly pick?: () => Promise<FakeStream>;
    readonly captureBusy?: boolean;
    readonly relay?: boolean;
  } = {},
) => {
  const stream = new FakeStream("video", "audio");
  const recorder = new FakeRecorder();
  const states: ComposerScreenRecordingState["phase"][] = [];
  const getDisplayMedia = vi.fn(options.pick ?? (async () => stream));
  let relay: FakeRelay | null = null;
  let recorded: unknown = null;
  const screenRecorder = createComposerScreenRecorder(
    {
      captureBusy: () => options.captureBusy ?? false,
      getDisplayMedia: getDisplayMedia as never,
      createRecorder: (input) => {
        recorded = input;
        return recorder as unknown as MediaRecorder;
      },
      createRelay: (showPreview) => {
        if (!options.relay) return null;
        relay = new FakeRelay(showPreview);
        return relay as never;
      },
      now: () => Date.now(),
    },
    (state) => states.push(state.phase),
  );
  const allTracksStopped = () => stream.tracks.every((track) => track.stopped);
  return {
    stream,
    recorder,
    states,
    getDisplayMedia,
    screenRecorder,
    allTracksStopped,
    relay: () => relay,
    recorded: () => recorded,
  };
};

const recordingState = (state: ComposerScreenRecordingState) => {
  if (state.phase !== "recording") throw new Error(`expected recording, got ${state.phase}`);
  return state;
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
  it("leaves paused time out of the elapsed time and the limit", async () => {
    const { recorder, screenRecorder } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(10_000);
    screenRecorder.pause();
    expect(recorder.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(COMPOSER_SCREEN_RECORDING_LIMIT_MS * 2);
    const paused = screenRecorder.getState();
    if (paused.phase !== "recording") throw new Error(`expected recording, got ${paused.phase}`);
    expect(paused.resumedAt).toBeNull();
    expect(screenRecordingElapsedMs(paused, Date.now())).toBe(10_000);

    screenRecorder.resume();
    expect(recorder.state).toBe("recording");
    await vi.advanceTimersByTimeAsync(COMPOSER_SCREEN_RECORDING_LIMIT_MS - 10_000 - 1);
    const resumed = screenRecorder.getState();
    if (resumed.phase !== "recording") throw new Error(`expected recording, got ${resumed.phase}`);
    expect(screenRecordingElapsedMs(resumed, Date.now())).toBe(
      COMPOSER_SCREEN_RECORDING_LIMIT_MS - 1,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome)?.type).toBe("recorded");
  });

  it("stops from paused and keeps what was captured", async () => {
    const { screenRecorder, allTracksStopped } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(3_000);
    screenRecorder.pause();
    screenRecorder.stop();
    expect((await outcome)?.type).toBe("recorded");
    expect(allTracksStopped()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("changing what is recorded", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 9, 16, 14, 5, 9) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records through the relay and shows its preview", async () => {
    const { screenRecorder, stream, relay, recorded } = setup({ relay: true });
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded()).toBe(relay()?.output);
    expect(relay()?.used).toEqual(stream.getVideoTracks());
    expect(recordingState(screenRecorder.getState())).toMatchObject({
      preview: null,
      canChangeSource: true,
    });

    relay()?.showPreview("data:image/jpeg;base64,first");
    expect(recordingState(screenRecorder.getState()).preview).toBe("data:image/jpeg;base64,first");
    screenRecorder.stop();
    expect((await outcome)?.type).toBe("recorded");
    expect(relay()?.stopped).toBe(true);
  });

  it("pauses while the picker is open, then records the new source", async () => {
    const { screenRecorder, stream, recorder, getDisplayMedia, relay } = setup({ relay: true });
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(2_000);
    relay()?.showPreview("data:image/jpeg;base64,first");

    let grant!: (stream: FakeStream) => void;
    const next = new FakeStream("video", "audio");
    getDisplayMedia.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
    const change = screenRecorder.changeSource();
    expect(recorder.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(10_000);
    grant(next);

    expect(await change).toEqual({ type: "changed" });
    expect(recorder.state).toBe("recording");
    expect(relay()?.used).toEqual([...stream.getVideoTracks(), ...next.getVideoTracks()]);
    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
    expect(next.getAudioTracks()).toEqual([]);
    const changed = recordingState(screenRecorder.getState());
    expect(changed.preview).toBeNull();
    expect(screenRecordingElapsedMs(changed, Date.now())).toBe(2_000);

    // The old source's end no longer ends the recording; the new one's does.
    stream.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    expect(screenRecorder.getState().phase).toBe("recording");
    next.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
    expect((await outcome)?.type).toBe("recorded");
    expect(next.tracks.every((track) => track.stopped)).toBe(true);
  });

  it("keeps the source and stays paused when the picker is dismissed", async () => {
    const { screenRecorder, stream, recorder, getDisplayMedia } = setup({ relay: true });
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    screenRecorder.pause();
    getDisplayMedia.mockImplementationOnce(() =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    );
    expect(await screenRecorder.changeSource()).toEqual({ type: "kept" });
    expect(recorder.state).toBe("paused");
    expect(stream.getVideoTracks()[0]!.stopped).toBe(false);
    screenRecorder.discard();
    await outcome;
  });

  it("ignores pause and resume while the picker is open", async () => {
    const { screenRecorder, recorder, getDisplayMedia } = setup({ relay: true });
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    let dismiss!: (error: unknown) => void;
    getDisplayMedia.mockImplementationOnce(() => new Promise((_, reject) => (dismiss = reject)));
    const change = screenRecorder.changeSource();
    screenRecorder.resume();
    expect(recorder.state).toBe("paused");
    dismiss(new DOMException("Permission denied", "NotAllowedError"));
    expect(await change).toEqual({ type: "kept" });
    expect(recorder.state).toBe("recording");
    screenRecorder.discard();
    await outcome;
  });

  it("stops a source picked after the recording was discarded", async () => {
    const { screenRecorder, getDisplayMedia } = setup({ relay: true });
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    let grant!: (stream: FakeStream) => void;
    const late = new FakeStream("video");
    getDisplayMedia.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
    const change = screenRecorder.changeSource();
    screenRecorder.discard();
    grant(late);
    expect(await change).toEqual({ type: "kept" });
    expect(late.tracks.every((track) => track.stopped)).toBe(true);
    expect(await outcome).toEqual({ type: "discarded" });
  });

  it("keeps its only source where the browser cannot relay frames", async () => {
    const { screenRecorder, stream, getDisplayMedia, recorded } = setup();
    const outcome = screenRecorder.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded()).toBe(stream);
    expect(recordingState(screenRecorder.getState()).canChangeSource).toBe(false);
    expect(await screenRecorder.changeSource()).toEqual({ type: "kept" });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
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
