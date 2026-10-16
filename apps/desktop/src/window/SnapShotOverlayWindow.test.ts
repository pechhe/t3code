import { describe, expect, it } from "vite-plus/test";

import {
  snapShotOverlayPlacement,
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

  // A display with a menu bar above and a Dock below its work area.
  const display = {
    bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1440, y: 25, width: 1920, height: 985 },
  };

  it("puts its composer where the main window's composer rests, reaching the screen edge", () => {
    const composer = { x: 1900, y: 400, width: 736, height: 560 };
    expect(snapShotOverlayPlacement({ display, composer, zoomFactor: 1 })).toEqual({
      bounds: { x: 1900 - 24, y: 960 - 640, width: 736 + 48, height: 1080 - (960 - 640) },
      bottomInset: 1080 - 960,
    });
  });

  it("scales its margins and inset with the main window's zoom", () => {
    const composer = { x: 1900, y: 400, width: 920, height: 560 };
    const placement = snapShotOverlayPlacement({ display, composer, zoomFactor: 1.25 });
    expect(placement.bounds.x).toBe(1900 - 30);
    expect(placement.bounds.width).toBe(920 + 60);
    expect(placement.bottomInset).toBe((1080 - 960) / 1.25);
  });

  it("sits at the bottom centre of the display without a main window to match", () => {
    expect(snapShotOverlayPlacement({ display, composer: null, zoomFactor: 1 })).toEqual({
      bounds: { x: 1440 + 592 - 24, y: 998 - 640, width: 736 + 48, height: 1080 - (998 - 640) },
      bottomInset: 1080 - 998,
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
