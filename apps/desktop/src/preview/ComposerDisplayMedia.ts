import * as NodeOS from "node:os";

import type { DesktopScreenRecordingSupport } from "@t3tools/contracts";
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
