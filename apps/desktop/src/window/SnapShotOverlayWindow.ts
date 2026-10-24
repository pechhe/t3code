import type { DesktopSnapShotOverlayInsets } from "@t3tools/contracts";
import type * as Electron from "electron";

/** Marks the renderer as the SnapShot overlay; read once by the web app at startup. */
const SNAP_SHOT_OVERLAY_SURFACE = "snap-shot-overlay";

// Before its first placement, which stretches it from the top of the work area to the bottom of
// the screen: room above the composer for its menus and the whole conversation.
const INITIAL_OVERLAY_HEIGHT = 640;
// Either side of the composer, for its shadow; the renderer pads its lane by the same amount.
const OVERLAY_SIDE_MARGIN = 24;
// The composer's width without a main window to match: the default chat width.
const DEFAULT_COMPOSER_WIDTH = 736;
// Without a main window to match, the composer rests this far above the work area.
const DEFAULT_COMPOSER_LIFT = 12;

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
    width: DEFAULT_COMPOSER_WIDTH + 2 * OVERLAY_SIDE_MARGIN,
    height: INITIAL_OVERLAY_HEIGHT,
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

export interface SnapShotOverlayPlacement {
  readonly bounds: Electron.Rectangle;
  readonly insets: DesktopSnapShotOverlayInsets;
}

/**
 * Puts the overlay's composer exactly where the main window's composer sits, so switching to
 * T3 finds the same composer in the same place. `composer` is that composer's column on screen,
 * whose bottom edge is where it rests; without it, the composer sits at the bottom centre of
 * the display. Either way the window spans from the top of the work area to the bottom of the
 * screen, under any Dock, so the composer can slide in from the edge and the conversation can
 * open above it.
 */
export function snapShotOverlayPlacement(input: {
  readonly display: Pick<Electron.Display, "bounds" | "workArea">;
  readonly composer: Electron.Rectangle | null;
  readonly zoomFactor: number;
}): SnapShotOverlayPlacement {
  const { bounds, workArea } = input.display;
  const zoom = input.zoomFactor > 0 ? input.zoomFactor : 1;
  const bottom = bounds.y + bounds.height;
  const margin = Math.round(OVERLAY_SIDE_MARGIN * zoom);
  const column = input.composer ?? {
    width: Math.min(Math.round(DEFAULT_COMPOSER_WIDTH * zoom), workArea.width - 2 * margin),
    x: 0,
    y: 0,
    height: workArea.y + workArea.height - Math.round(DEFAULT_COMPOSER_LIFT * zoom),
  };
  const x = input.composer
    ? column.x
    : Math.round(workArea.x + (workArea.width - column.width) / 2);
  const anchor = Math.round(Math.min(column.y + column.height, bottom));
  const top = workArea.y;
  return {
    bounds: {
      x: Math.round(x) - margin,
      y: top,
      width: Math.round(column.width) + 2 * margin,
      height: bottom - top,
    },
    insets: {
      composer: (bottom - anchor) / zoom,
      workArea: (bottom - (workArea.y + workArea.height)) / zoom,
    },
  };
}

/** A frame in a window's viewport, on screen. */
export function viewportFrameOnScreen(
  frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  contentBounds: Electron.Rectangle,
  zoomFactor: number,
): Electron.Rectangle {
  return {
    x: contentBounds.x + frame.x * zoomFactor,
    y: contentBounds.y + frame.y * zoomFactor,
    width: frame.width * zoomFactor,
    height: frame.height * zoomFactor,
  };
}
