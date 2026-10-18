import * as NodeOS from "node:os";

import {
  DesktopScreenRecordingSource,
  type DesktopScreenRecordingSupport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { DataType } from "ffi-rs";
import * as Electron from "electron";

import { isWaylandSession } from "../snapShot/snapShot.ts";

// Electron's `useSystemPicker` needs macOS 15, which is Darwin 24.
const SYSTEM_PICKER_DARWIN_MAJOR = 24;

export function composerScreenRecordingSupport(input: {
  readonly platform: NodeJS.Platform;
  readonly darwinRelease: string;
  readonly environment: NodeJS.ProcessEnv;
}): DesktopScreenRecordingSupport {
  if (input.platform === "darwin") {
    return Number.parseInt(input.darwinRelease, 10) >= SYSTEM_PICKER_DARWIN_MAJOR
      ? "supported"
      : "needs-newer-macos";
  }
  // The XDG desktop portal shows its own picker when Electron lists sources on Wayland.
  return isWaylandSession(input.platform, input.environment) ? "supported" : "unsupported";
}

export const currentComposerScreenRecordingSupport = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
) => composerScreenRecordingSupport({ platform, darwinRelease: NodeOS.release(), environment });

const decodeScreenSource = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopScreenRecordingSource),
);

interface MacScreenPicker {
  readonly prepare: () => void;
  readonly selection: () => DesktopScreenRecordingSource | null;
}

let macScreenPicker: Promise<MacScreenPicker> | undefined;

const MAC_SCREEN_PICKER_LIBRARY = "libt3-screen-picker.dylib";

/** Packaged apps carry the library as a resource; development builds it with `start-electron`. */
export const macScreenPickerLibraryPath = (environment: {
  readonly path: { readonly join: (...segments: ReadonlyArray<string>) => string };
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly rootDir: string;
  readonly processArch: string;
}) =>
  environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "screen-picker", MAC_SCREEN_PICKER_LIBRARY)
    : environment.path.join(
        environment.rootDir,
        "native",
        "screen-picker",
        "build",
        environment.processArch,
        MAC_SCREEN_PICKER_LIBRARY,
      );

// The library observes macOS's picker from inside this process; see native/screen-picker.
const loadMacScreenPicker = (libraryPath: string) =>
  import("ffi-rs").then(({ DataType, load, open }): MacScreenPicker => {
    const library = "t3-screen-picker";
    open({ library, path: libraryPath });
    const call = (funcName: string, retType: DataType) =>
      load({ library, funcName, retType, paramsType: [], paramsValue: [] });
    return {
      prepare: () => call("t3_screen_picker_prepare", DataType.Void),
      selection: () => {
        const json = call("t3_screen_picker_selection", DataType.String) as string;
        return json === "" ? null : decodeScreenSource(json);
      },
    };
  });

const macScreenPickerFor = (libraryPath: string) => {
  if (!macScreenPicker) {
    const loading = loadMacScreenPicker(libraryPath);
    macScreenPicker = loading;
    // A library that failed to load is tried again on the next recording.
    loading.catch(() => {
      if (macScreenPicker === loading) macScreenPicker = undefined;
    });
  }
  return macScreenPicker;
};

/**
 * Readies macOS's system picker for the next `getDisplayMedia()` and forgets the last pick, so
 * `macScreenPickerSelection` reports only what the user picks next.
 */
export async function prepareMacScreenPicker(libraryPath: string): Promise<void> {
  (await macScreenPickerFor(libraryPath)).prepare();
}

/** What the user picked since `prepareMacScreenPicker`, or null before a pick. */
export async function macScreenPickerSelection(
  libraryPath: string,
): Promise<DesktopScreenRecordingSource | null> {
  return (await macScreenPickerFor(libraryPath)).selection();
}

export interface ComposerDisplayMediaHost {
  /** Whether listing sources shows the platform's own picker, so the result is the user's choice. */
  readonly sourcesArePicked: () => boolean;
  readonly getSources: () => Promise<ReadonlyArray<Electron.DesktopCapturerSource>>;
}

export const electronComposerDisplayMediaHost = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ComposerDisplayMediaHost => ({
  sourcesArePicked: () => isWaylandSession(platform, environment),
  getSources: () =>
    Electron.desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
    }),
});

/**
 * Answers the composer's `getDisplayMedia()` when Electron could not show macOS's system picker.
 * Only a source the user picked is shared; anywhere `getSources` would just list sources, the
 * request is refused and the renderer explains why through `getScreenRecordingSupport`.
 */
export async function answerComposerDisplayMediaRequest(
  callback: (streams: Electron.Streams) => void,
  host: ComposerDisplayMediaHost,
): Promise<void> {
  let streams: Electron.Streams = {};
  if (host.sourcesArePicked()) {
    try {
      const [source] = await host.getSources();
      if (source) streams = { video: source };
    } catch {
      streams = {};
    }
  }
  callback(streams);
}
