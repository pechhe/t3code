import { describe, expect, it } from "vite-plus/test";

import {
  snapShotOverlayBounds,
  snapShotOverlayUrl,
  snapShotOverlayWindowOptions,
  supportsSnapShotOverlay,
} from "./SnapShotOverlayWindow.ts";

describe("SnapShot overlay window", () => {
  it("opens the overlay route of the app with the overlay surface marked", () => {
    const url = new URL(snapShotOverlayUrl("t3code://app/"));
    expect(url.searchParams.get("surface")).toBe("snap-shot-overlay");
    expect(url.hash).toBe("#/snap-shot");
    expect(url.href).toBe("t3code://app/?surface=snap-shot-overlay#/snap-shot");
  });

  it("sits centred near the top of the display under the pointer", () => {
    expect(snapShotOverlayBounds({ x: 1440, y: 25, width: 1920, height: 1055 })).toEqual({
      x: 1440 + 620,
      y: 25 + 115,
      width: 680,
      height: 480,
    });
  });

  it("shrinks to fit a small display", () => {
    expect(snapShotOverlayBounds({ x: 0, y: 0, width: 600, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
  });

  it("is a non-activating panel on macOS and a tool window on Windows", () => {
    const options = (platform: NodeJS.Platform) =>
      snapShotOverlayWindowOptions({ platform, preloadPath: "/preload.js", title: "T3" });
    expect(options("darwin").type).toBe("panel");
    expect(options("win32").type).toBe("toolbar");
    expect(options("linux").type).toBeUndefined();
    expect(supportsSnapShotOverlay("linux")).toBe(false);
  });
});
