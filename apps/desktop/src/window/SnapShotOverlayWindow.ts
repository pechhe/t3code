import type * as Electron from "electron";

/** Marks the renderer as the SnapShot overlay; read once by the web app at startup. */
export const SNAP_SHOT_OVERLAY_SURFACE = "snap-shot-overlay";

const OVERLAY_WIDTH = 680;
const OVERLAY_HEIGHT = 480;
// The overlay sits a little above the middle of the screen, like a launcher.
const OVERLAY_TOP_FRACTION = 0.2;

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

/** Centred horizontally on the work area of the display under the pointer. */
export function snapShotOverlayBounds(workArea: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(OVERLAY_WIDTH, workArea.width);
  const height = Math.min(OVERLAY_HEIGHT, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) * OVERLAY_TOP_FRACTION),
    width,
    height,
  };
}
