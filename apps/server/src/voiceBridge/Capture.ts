// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the capture helper and reads its temporary PNG with Node.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { MAC_WINDOW_CAPTURE_SCRIPT } from "@t3tools/shared/macWindowCapture";

const OSASCRIPT_PATH = "/usr/bin/osascript";

/**
 * The app whose own window must not be the capture: the ask arrives from
 * FluidVoice's Command window, which is frontmost by then, and the interesting
 * window is the one behind it — the page the person was looking at.
 */
export const FLUIDVOICE_BUNDLE_ID = "com.FluidApp.app";

/** The bundle ids the shared window reader skips, as its helper variable wants them. */
export const captureSkipBundleIds = (): string => FLUIDVOICE_BUNDLE_ID;
const SCREEN_CAPTURE_PATH = "/usr/sbin/screencapture";
const HELPER_TIMEOUT_MS = 5_000;
const SCREEN_CAPTURE_TIMEOUT_MS = 15_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A capture of the window that had focus, ready to upload as an attachment. */
export type CapturedWindow = {
  readonly png: Uint8Array;
  readonly name: string;
  readonly mimeType: "image/png";
  readonly sizeBytes: number;
  readonly appName: string | null;
};

type HelperReply = {
  readonly window?: {
    readonly id: number;
    readonly title: string;
    readonly owner: { readonly name: string };
  };
  readonly captured?: boolean;
};

function parseHelperReply(lines: ReadonlyArray<string>): HelperReply | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as HelperReply;
    } catch {
      continue;
    }
  }
  return null;
}

/** Asks the shared JXA helper for the frontmost window, writing it to `outputPath` when it can. */
function readFrontWindow(outputPath: string): Promise<HelperReply | null> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(OSASCRIPT_PATH, ["-l", "JavaScript", "-e", MAC_WINDOW_CAPTURE_SCRIPT], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, T3_CAPTURE_SKIP_BUNDLE_IDS: captureSkipBundleIds() },
    });
    const lines: Array<string> = [];
    let buffered = "";
    let settled = false;
    const finish = (reply: HelperReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, HELPER_TIMEOUT_MS);
    child.stdin.on("error", () => undefined);
    // JXA's console.log writes to stderr.
    child.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const complete = buffered.split("\n");
      buffered = complete.pop() ?? "";
      for (const line of complete) lines.push(line);
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(parseHelperReply(lines)));
    child.stdin.write(`${outputPath}\n`);
  });
}

function runScreenCapture(windowId: number, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      SCREEN_CAPTURE_PATH,
      ["-l", String(windowId), "-o", "-x", "-t", "png", outputPath],
      { timeout: SCREEN_CAPTURE_TIMEOUT_MS },
      (error) => resolve(error === null),
    );
  });
}

/**
 * Captures the window that had focus when the ask arrived, which is the page the
 * person was looking at. Returns `null` when this machine cannot capture (not
 * macOS), when the capture helper finds no window, or when the helper is denied
 * Screen Recording: the ask still reaches T3 as text.
 */
export async function captureFrontWindow(outputPath: string): Promise<CapturedWindow | null> {
  if (process.platform !== "darwin") return null;
  const reply = await readFrontWindow(outputPath);
  const window = reply?.window;
  if (window === undefined) return null;
  // CoreGraphics capture inside the helper is deprecated; screencapture covers a
  // system that drops it, exactly as the desktop SnapShot service does.
  if (reply?.captured !== true && !(await runScreenCapture(window.id, outputPath))) return null;
  let png: Buffer;
  try {
    png = await NodeFSP.readFile(outputPath);
  } catch {
    return null;
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  const name = `SnapShot-${window.owner.name || "window"}.png`;
  return { png, name, mimeType: "image/png", sizeBytes: png.length, appName: window.owner.name || null };
}
