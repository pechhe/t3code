// @effect-diagnostics nodeBuiltinImport:off -- Notch geometry comes from NSScreen through a one-shot JXA query.
import * as NodeChildProcess from "node:child_process";

import type {
  DesktopScreenRecordingIndicatorAction,
  DesktopScreenRecordingIndicatorState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  SCREEN_RECORDING_INDICATOR_ACTION_CHANNEL,
  SCREEN_RECORDING_INDICATOR_PILL_CHANNEL,
  SCREEN_RECORDING_INDICATOR_STATE_CHANNEL,
} from "../ipc/channels.ts";

/** A screen's notch in points, relative to the screen's left edge. */
const ScreenNotch = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  notchLeft: Schema.Finite,
  notchRight: Schema.Finite,
  notchHeight: Schema.Finite,
});
type ScreenNotch = typeof ScreenNotch.Type;
const decodeScreenNotches = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ScreenNotch)),
);

// Electron's Display has no safe-area fields; NSScreen reports the camera housing as the gap
// between the two menu bar areas either side of it.
const NOTCH_SCRIPT = `
ObjC.import("AppKit");
function run() {
  const screens = $.NSScreen.screens;
  const notches = [];
  for (let i = 0; i < screens.count; i++) {
    const screen = screens.objectAtIndex(i);
    if (screen.safeAreaInsets.top <= 0) continue;
    const frame = screen.frame;
    const left = screen.auxiliaryTopLeftArea;
    const right = screen.auxiliaryTopRightArea;
    notches.push({
      x: frame.origin.x,
      // NSScreen counts y up from the primary screen's bottom; Electron counts down from its top.
      y: screens.objectAtIndex(0).frame.size.height - frame.origin.y - frame.size.height,
      width: frame.size.width,
      notchLeft: left.origin.x - frame.origin.x + left.size.width,
      notchRight: right.origin.x - frame.origin.x,
      notchHeight: screen.safeAreaInsets.top,
    });
  }
  return JSON.stringify(notches);
}`;

const readScreenNotches = () =>
  new Promise<ReadonlyArray<ScreenNotch>>((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", NOTCH_SCRIPT],
      { timeout: 2_000 },
      (error, stdout) => {
        try {
          resolve(error ? [] : decodeScreenNotches(stdout.trim()));
        } catch {
          resolve([]);
        }
      },
    );
  });

const WING_WIDTH = 116;
const PLAIN_HEIGHT = 32;
const PLAIN_GAP = 8;

/**
 * Sits in the notch with the controls on either side of it, or, on a screen without one, as a
 * tab hanging from the top centre. Either way it covers part of the menu bar, not the app.
 */
export function screenRecordingIndicatorBounds(
  display: Pick<Electron.Display, "bounds">,
  notch: ScreenNotch | undefined,
): Electron.Rectangle & { readonly gap: number } {
  const { bounds } = display;
  if (notch) {
    const gap = notch.notchRight - notch.notchLeft;
    return {
      x: Math.round(bounds.x + notch.notchLeft - WING_WIDTH),
      y: bounds.y,
      width: Math.round(gap + WING_WIDTH * 2),
      height: Math.round(notch.notchHeight),
      gap: Math.round(gap),
    };
  }
  const width = WING_WIDTH * 2 + PLAIN_GAP;
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y,
    width,
    height: PLAIN_HEIGHT,
    gap: PLAIN_GAP,
  };
}

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const PAUSE_ICON = icon(
  '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
);
const PLAY_ICON = icon('<polygon points="6 3 20 12 6 21 6 3"/>');
const STOP_ICON = icon('<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>');
const DISCARD_ICON = icon(
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
);

function indicatorHtml(gap: number) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>T3 Code recording</title><style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
body { display: flex; color: #f5f5f5; font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; -webkit-user-select: none; cursor: default; }
#pill { display: flex; width: 100%; height: 100%; background: #000; border-radius: 0 0 14px 14px; }
.wing { display: flex; flex: 1; align-items: center; gap: 6px; padding: 0 10px; }
#left { justify-content: flex-start; }
#right { justify-content: flex-end; gap: 2px; }
#gap { width: ${gap}px; flex: none; }
#dot { width: 8px; height: 8px; border-radius: 50%; background: #ff453a; }
body[data-paused] #dot { background: #8e8e93; }
#clock { font-variant-numeric: tabular-nums; }
button { display: grid; place-items: center; width: 26px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; }
button:hover { background: rgba(255,255,255,.16); }
button:focus-visible { outline: 2px solid #0a84ff; outline-offset: -2px; }
#stop { color: #ff453a; }
#resume, body[data-paused] #pause { display: none; }
body[data-paused] #resume { display: grid; }
</style></head><body><div id="pill">
<div class="wing" id="left"><span id="dot"></span><span id="clock" role="timer">0:00</span></div>
<div id="gap"></div>
<div class="wing" id="right">
<button id="pause" title="Pause recording" aria-label="Pause recording">${PAUSE_ICON}</button>
<button id="resume" title="Resume recording" aria-label="Resume recording">${PLAY_ICON}</button>
<button id="stop" title="Stop and attach" aria-label="Stop and attach">${STOP_ICON}</button>
<button id="discard" title="Discard recording" aria-label="Discard recording">${DISCARD_ICON}</button>
</div></div></body></html>`;
}

const OWNER_GONE_EVENTS = ["destroyed", "did-navigate", "render-process-gone"] as const;

class IndicatorWindow {
  private window: Electron.BrowserWindow | undefined;
  private owner: Electron.WebContents | undefined;
  private state: DesktopScreenRecordingIndicatorState | null = null;
  private generation = 0;
  private readonly onPillAction = (event: Electron.IpcMainEvent, action: unknown) => {
    if (!this.window || event.sender !== this.window.webContents) return;
    if (action !== "pause" && action !== "resume" && action !== "stop" && action !== "discard")
      return;
    const owner = this.owner;
    if (owner && !owner.isDestroyed())
      owner.send(
        SCREEN_RECORDING_INDICATOR_ACTION_CHANNEL,
        action satisfies DesktopScreenRecordingIndicatorAction,
      );
  };
  private readonly onOwnerGone = () => this.close();

  private readonly preload: string;

  constructor(preload: string) {
    this.preload = preload;
    Electron.ipcMain.on(SCREEN_RECORDING_INDICATOR_PILL_CHANNEL, this.onPillAction);
  }

  async set(
    owner: Electron.WebContents,
    state: DesktopScreenRecordingIndicatorState | null,
  ): Promise<boolean> {
    if (!state) {
      // Only the window recording may take its controls away.
      if (owner === this.owner) this.close();
      return false;
    }
    if (this.window && this.owner === owner) {
      this.state = state;
      this.window.webContents.send(SCREEN_RECORDING_INDICATOR_STATE_CHANNEL, state);
      return true;
    }
    this.close();
    this.state = state;
    // Claimed before the notch lookup, so a stop that arrives while the pill opens still ends it.
    this.owner = owner;
    // A reload or crash ends the recording with the page, so the controls go with it.
    for (const event of OWNER_GONE_EVENTS) owner.once(event as "destroyed", this.onOwnerGone);
    const generation = this.generation;
    const ownerWindow = Electron.BrowserWindow.fromWebContents(owner);
    const display = ownerWindow
      ? Electron.screen.getDisplayMatching(ownerWindow.getBounds())
      : Electron.screen.getPrimaryDisplay();
    const notch = (await readScreenNotches()).find(
      (candidate) =>
        candidate.x === display.bounds.x &&
        candidate.y === display.bounds.y &&
        candidate.width === display.bounds.width,
    );
    if (generation !== this.generation || owner.isDestroyed()) return false;
    const { gap, ...bounds } = screenRecordingIndicatorBounds(display, notch);
    const window = new Electron.BrowserWindow({
      ...bounds,
      type: "panel",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      // Frameless windows may only cover the menu bar when allowed past the visible frame.
      enableLargerThanScreen: true,
      title: "T3 Code recording",
      webPreferences: {
        preload: this.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = window;
    // Above the menu bar, on every Space, and left out of screen captures where macOS allows.
    window.setAlwaysOnTop(true, "status");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setContentProtection(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("closed", () => {
      if (this.window === window) this.close();
    });
    try {
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml(gap))}`,
      );
    } catch {
      if (this.window === window) this.close();
      return false;
    }
    if (this.window !== window || !this.state) return false;
    window.setBounds(bounds);
    window.webContents.send(SCREEN_RECORDING_INDICATOR_STATE_CHANNEL, this.state);
    window.showInactive();
    return true;
  }

  close() {
    this.generation++;
    this.state = null;
    for (const event of OWNER_GONE_EVENTS)
      this.owner?.removeListener(event as "destroyed", this.onOwnerGone);
    this.owner = undefined;
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }

  dispose() {
    this.close();
    Electron.ipcMain.removeListener(SCREEN_RECORDING_INDICATOR_PILL_CHANNEL, this.onPillAction);
  }
}

export class ScreenRecordingIndicator extends Context.Service<
  ScreenRecordingIndicator,
  {
    readonly set: (
      ownerWebContentsId: number,
      state: DesktopScreenRecordingIndicatorState | null,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/preview/ScreenRecordingIndicator") {}

export const layer = Layer.effect(
  ScreenRecordingIndicator,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    // Only macOS lets a window sit over the menu bar; elsewhere the app shows its own controls.
    if (environment.platform !== "darwin") {
      return ScreenRecordingIndicator.of({ set: () => Effect.succeed(false) });
    }
    const indicator = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new IndicatorWindow(
            path.join(environment.dirname, "screen-recording-indicator-preload.cjs"),
          ),
      ),
      (window) => Effect.sync(() => window.dispose()),
    );
    return ScreenRecordingIndicator.of({
      set: Effect.fn("ScreenRecordingIndicator.set")(function* (ownerWebContentsId, state) {
        const owner = Electron.webContents.fromId(ownerWebContentsId);
        if (!owner || owner.isDestroyed()) return false;
        return yield* Effect.tryPromise(() => indicator.set(owner, state)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not show the recording indicator", cause).pipe(
              Effect.as(false),
            ),
          ),
        );
      }),
    });
  }),
);
