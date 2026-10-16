import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ desktopCapturer: {} }));

import {
  answerComposerDisplayMediaRequest,
  composerScreenRecordingSupport,
  type ComposerDisplayMediaHost,
} from "./ComposerDisplayMedia.ts";

const screen = { id: "screen:1:0", name: "Entire Screen" } as Electron.DesktopCapturerSource;

const answer = async (host: Partial<ComposerDisplayMediaHost>) => {
  const callback = vi.fn();
  await answerComposerDisplayMediaRequest(callback, {
    sourcesArePicked: () => true,
    getSources: async () => [screen],
    ...host,
  });
  expect(callback).toHaveBeenCalledOnce();
  return callback.mock.calls[0]?.[0];
};

describe("answerComposerDisplayMediaRequest", () => {
  it("shares the source the platform's own picker returned", async () => {
    expect(await answer({})).toEqual({ video: screen });
  });

  it("refuses without listing sources when no platform picker would ask the user", async () => {
    const getSources = vi.fn(async () => [screen]);
    expect(await answer({ sourcesArePicked: () => false, getSources })).toEqual({});
    expect(getSources).not.toHaveBeenCalled();
  });

  it("refuses when the picker returns nothing or fails", async () => {
    expect(await answer({ getSources: async () => [] })).toEqual({});
    expect(await answer({ getSources: () => Promise.reject(new Error("portal closed")) })).toEqual(
      {},
    );
  });
});

describe("composerScreenRecordingSupport", () => {
  const support = (platform: NodeJS.Platform, darwinRelease = "", environment = {}) =>
    composerScreenRecordingSupport({ platform, darwinRelease, environment });

  it("needs macOS 15 for the system picker", () => {
    expect(support("darwin", "24.0.0")).toBe("supported");
    expect(support("darwin", "23.6.0")).toBe("needs-newer-macos");
  });

  it("supports Wayland, whose portal shows a picker, and nothing else off macOS", () => {
    expect(support("linux", "", { XDG_SESSION_TYPE: "wayland" })).toBe("supported");
    expect(support("linux", "", { XDG_SESSION_TYPE: "x11" })).toBe("unsupported");
    expect(support("win32")).toBe("unsupported");
  });
});
