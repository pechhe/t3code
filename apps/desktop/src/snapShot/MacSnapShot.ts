// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns native capture helpers and reads their temporary output with Node.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as Electron from "electron";
import * as Schema from "effect/Schema";

import { MAC_WINDOW_CAPTURE_SCRIPT } from "@t3tools/shared/macWindowCapture";
import type { ActiveWindow } from "./ActiveWindow.ts";
import {
  makeSnapShotProcessPool,
  type SnapShotProcess,
  type SnapShotProcessPool,
} from "./SnapShotProcessPool.ts";

const MAC_SCREEN_CAPTURE_PATH = "/usr/sbin/screencapture";
const MAC_SCREEN_CAPTURE_TIMEOUT_MS = 15_000;
const MAC_WINDOW_CAPTURE_TIMEOUT_MS = 5_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type MacSnapShotSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

const MacWindowCaptureReply = Schema.Struct({
  window: Schema.optional(
    Schema.Struct({
      id: Schema.Number,
      title: Schema.String,
      bounds: Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
      owner: Schema.Struct({
        name: Schema.String,
        processId: Schema.Number,
        path: Schema.String,
        bundleId: Schema.String,
      }),
    }),
  ),
  captured: Schema.optional(Schema.Boolean),
});
const decodeMacWindowCaptureReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(MacWindowCaptureReply),
);

/** The frontmost window, and whether the helper already wrote its image. */
export type MacWindowCapture = {
  readonly active?: ActiveWindow;
  readonly captured: boolean;
};

export function parseMacWindowCaptureReply(line: string): MacWindowCapture {
  const { window, captured } = decodeMacWindowCaptureReply(line);
  if (!window) return { captured: false };
  return {
    active: {
      platform: "macos",
      id: window.id,
      title: window.title,
      bounds: window.bounds,
      owner: {
        name: window.owner.name,
        processId: window.owner.processId,
        path: window.owner.path,
        ...(window.owner.bundleId ? { bundleId: window.owner.bundleId } : {}),
      },
    },
    captured: captured === true,
  };
}

export type MacSnapShotChild = {
  readonly send: (line: string) => void;
  readonly onLine: (listener: (line: string) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly kill: () => void;
};

function spawnMacSnapShotChild(): MacSnapShotChild {
  const child = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MAC_WINDOW_CAPTURE_SCRIPT],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  // A helper that already exited closes its stdin; its exit reports the failure.
  child.stdin.on("error", () => undefined);
  return {
    send: (line) => child.stdin.write(line + "\n"),
    onLine: (listener) => {
      let buffered = "";
      // JXA's console.log writes to stderr.
      child.stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) listener(line.trim());
      });
    },
    onExit: (listener) => {
      child.once("exit", listener);
      child.once("error", listener);
    },
    kill: () => child.kill(),
  };
}

export type MacSnapShotProcess = SnapShotProcess<string, MacWindowCapture>;

/** One helper, started ahead of the shortcut, that captures the front window into a path. */
export function startMacSnapShotProcess(
  spawn: () => MacSnapShotChild = spawnMacSnapShotChild,
): MacSnapShotProcess {
  let child: MacSnapShotChild;
  try {
    child = spawn();
  } catch {
    return {
      alive: false,
      capture: () => Promise.reject(new Error("macOS window capture is unavailable.")),
      close: () => undefined,
    };
  }
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<MacWindowCapture>();
  let settled = false;
  const finish = (error?: Error, value?: MacWindowCapture) => {
    if (settled) return;
    settled = true;
    ready.resolve();
    if (value) result.resolve(value);
    else result.reject(error ?? new Error("macOS window capture failed."));
    child.kill();
  };
  child.onLine((line) => {
    if (line === "ready") {
      ready.resolve();
      return;
    }
    if (!line.startsWith("{")) return;
    try {
      finish(undefined, parseMacWindowCaptureReply(line));
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error("macOS window capture failed."));
    }
  });
  child.onExit(() => finish(new Error("macOS window capture helper exited.")));
  void result.promise.catch(() => undefined);

  return {
    get alive() {
      return !settled;
    },
    capture: async (outputPath) => {
      if (settled) throw new Error("macOS window capture helper already used.");
      const timeout = setTimeout(
        () => finish(new Error("macOS window capture timed out. Try again.")),
        MAC_WINDOW_CAPTURE_TIMEOUT_MS,
      );
      timeout.unref();
      try {
        await ready.promise;
        if (settled) return await result.promise;
        child.send(outputPath);
        return await result.promise;
      } finally {
        clearTimeout(timeout);
      }
    },
    close: () => finish(new Error("macOS window capture cancelled.")),
  };
}

export type MacSnapShotPool = SnapShotProcessPool<string, MacWindowCapture>;

export function makeMacSnapShotPool(
  start: () => MacSnapShotProcess = startMacSnapShotProcess,
): MacSnapShotPool {
  return makeSnapShotProcessPool(start, {
    unavailable: "macOS window capture is unavailable.",
    busy: "macOS window capture is still in progress. Try again.",
  });
}

function macSnapShotArguments(windowId: number, outputPath: string): string[] {
  return ["-l", String(windowId), "-o", "-x", "-t", "png", outputPath];
}

function runMacSnapShot(windowId: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      MAC_SCREEN_CAPTURE_PATH,
      macSnapShotArguments(windowId, outputPath),
      { timeout: MAC_SCREEN_CAPTURE_TIMEOUT_MS },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

/** Capture the frontmost window, or `undefined` when there is none. */
export async function captureMacWindowSnapshot(
  pool: Pick<MacSnapShotPool, "capture">,
  outputPath: string,
  maxSize: (active: ActiveWindow) => Electron.Size,
): Promise<
  | { readonly active: ActiveWindow; readonly source: MacSnapShotSource; readonly png: Buffer }
  | undefined
> {
  const { active, captured } = await pool.capture(outputPath);
  if (!active) return undefined;
  // CoreGraphics window capture is deprecated; screencapture covers a system that drops it.
  if (!captured) await runMacSnapShot(active.id, outputPath);
  const capturedPng = await NodeFSP.readFile(outputPath);
  if (
    capturedPng.length < PNG_SIGNATURE.length ||
    !capturedPng.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("macOS returned an invalid snapshot.");
  }
  const image = Electron.nativeImage.createFromBuffer(capturedPng);
  if (image.isEmpty()) throw new Error("macOS returned an invalid snapshot.");
  const size = image.getSize();
  const bounds = maxSize(active);
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height, 1);
  const png =
    scale < 1
      ? image
          .resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "best",
          })
          .toPNG()
      : capturedPng;
  if (png !== capturedPng) await NodeFSP.writeFile(outputPath, png);
  return {
    active,
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png,
  };
}
