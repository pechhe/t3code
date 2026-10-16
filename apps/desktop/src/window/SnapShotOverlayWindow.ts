import type * as Electron from "electron";

/** Marks the renderer as the SnapShot overlay; read once by the web app at startup. */
export const SNAP_SHOT_OVERLAY_SURFACE = "snap-shot-overlay";

// Wide enough for the chat composer, tall enough for an answer above it.
const OVERLAY_WIDTH = 800;
const OVERLAY_HEIGHT = 640;

/** Platforms where the overlay can sit over other apps without raising T3. */
export function supportsSnapShotOverlay(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function snapShotOverlayUrl(applicationUrl: string): string {
  const url = new URL(applicationUrl);
  url.searchParams.set("surface", SNAP_SHOT_OVERLAY_SURFACE);
  url.hash = "/snap-shot";
  return url.href;
}

export function snapShotOverlayWindowOptions(input: {
  readonly platform: NodeJS.Platform;
  readonly preloadPath: string;
  readonly title: string;
}): Electron.BrowserWindowConstructorOptions {
  return {
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: input.title,
    // A macOS panel takes keyboard focus over the front app, including a
    // full-screen one, without activating T3 and raising its main window.
    // Windows has no such panel; a tool window stays out of the taskbar.
    ...(input.platform === "darwin"
      ? { type: "panel" }
      : input.platform === "win32"
        ? { type: "toolbar" }
        : {}),
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden until a capture; it must still answer the first one instantly.
      backgroundThrottling: false,
    },
  };
}

/**
 * Centred along the bottom edge of the display under the pointer, where the main window's
 * composer usually sits. It reaches the screen edge, under any Dock or taskbar, so the composer
 * can slide in from it; the renderer keeps the composer itself above the work area.
 */
export function snapShotOverlayBounds(
  display: Pick<Electron.Display, "bounds" | "workArea">,
): Electron.Rectangle {
  const { bounds, workArea } = display;
  const bottom = bounds.y + bounds.height;
  const width = Math.min(OVERLAY_WIDTH, workArea.width);
  const height = Math.min(OVERLAY_HEIGHT, bottom - workArea.y);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: bottom - height,
    width,
    height,
  };
}
