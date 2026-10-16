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

  it("sits on the bottom edge of the display, centred over the work area", () => {
    // A secondary display with a menu bar above and a Dock below its work area.
    const bounds = { x: 1440, y: 0, width: 1920, height: 1080 };
    const workArea = { x: 1440, y: 25, width: 1920, height: 985 };
    expect(snapShotOverlayBounds({ bounds, workArea })).toEqual({
      x: 1440 + 560,
      y: 1080 - 640,
      width: 800,
      height: 640,
    });
  });

  it("shrinks to fit a small display", () => {
    const bounds = { x: 0, y: 0, width: 600, height: 400 };
    expect(snapShotOverlayBounds({ bounds, workArea: { ...bounds, y: 25, height: 375 } })).toEqual({
      x: 0,
      y: 25,
      width: 600,
      height: 375,
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
