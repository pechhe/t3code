import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createMediaRecorder, recordedMimeType } from "./mediaRecording";

const constructed: Array<MediaRecorderOptions | undefined> = [];

const stubMediaRecorder = (supported: ReadonlyArray<string>) => {
  vi.stubGlobal(
    "MediaRecorder",
    class {
      static isTypeSupported = (type: string) => supported.includes(type);
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        constructed.push(options);
      }
    },
  );
};

const streamOf = (settings: MediaTrackSettings) =>
  ({ getVideoTracks: () => [{ getSettings: () => settings }] }) as unknown as MediaStream;

afterEach(() => {
  constructed.length = 0;
  vi.unstubAllGlobals();
});

describe("createMediaRecorder", () => {
  it("prefers MP4 over WebM when both are supported", () => {
    stubMediaRecorder(["video/webm", "video/mp4;codecs=avc1.42e01e"]);
    createMediaRecorder(streamOf({}));
    expect(constructed[0]?.mimeType).toBe("video/mp4;codecs=avc1.42e01e");
  });

  it("prefers in-band H.264 parameter sets so a capture can change size", () => {
    stubMediaRecorder(["video/mp4;codecs=avc1", "video/mp4;codecs=avc3"]);
    createMediaRecorder(streamOf({}));
    expect(constructed[0]?.mimeType).toBe("video/mp4;codecs=avc3");
  });

  it("lets the browser choose when no preferred type is supported", () => {
    stubMediaRecorder([]);
    createMediaRecorder(streamOf({}));
    expect(constructed[0]).not.toHaveProperty("mimeType");
  });

  it("sizes the bitrate to the capture unless given one", () => {
    stubMediaRecorder(["video/webm"]);
    const retina = { width: 3024, height: 1964, frameRate: 30 };
    createMediaRecorder(streamOf(retina));
    createMediaRecorder(streamOf(retina), { videoBitsPerSecond: 5_000_000 });
    expect(constructed.map((options) => options?.videoBitsPerSecond)).toEqual([
      8_908_704, 5_000_000,
    ]);
  });
});

describe("recordedMimeType", () => {
  it("falls back to the chunk type when the recorder does not report one", () => {
    const recorder = { mimeType: "" } as MediaRecorder;
    expect(
      recordedMimeType(recorder, [new Blob([]), new Blob(["x"], { type: "video/webm" })]),
    ).toBe("video/webm");
    expect(recordedMimeType(recorder, [])).toBeUndefined();
  });
});
