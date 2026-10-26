// @effect-diagnostics nodeBuiltinImport:off -- FluidVoice is driven through the installed macOS Accessibility surface.

import * as NodeChildProcess from "node:child_process";

const STATUS_SCRIPT = `
function run() {
const p = Application('System Events').processes.byName('FluidVoice');
const titles = p.menuBars()[1].menuBarItems()[0].menus()[0].menuItems().map(x => x.name());
if (titles.some(x => x && x.startsWith('Recording...'))) return 'recording';
else if (titles.some(x => x && x.startsWith('Ready to Record'))) return 'ready';
else throw new Error('Cannot determine whether FluidVoice is recording.');

}
`;

// FluidVoice's dictation hotkey is a bare Right Shift (key code 60, device bit 0x4), so a tap is a
// flags-changed pair; the event type and key code are set by hand because a modifier key has no
// key-down.
const TAP_RIGHT_SHIFT_SCRIPT = `
ObjC.import('CoreGraphics');
function post(flags) {
  const event = $.CGEventCreate(null);
  $.CGEventSetType(event, 12);
  $.CGEventSetIntegerValueField(event, 9, 60);
  $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
}
post(0x20004);
post(0);
`;

export function runMacScript(script: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: 10_000, ...(signal === undefined ? {} : { signal }) },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout.trim());
      },
    );
  });
}

export function parseFluidVoiceRecordingStatus(status: string): boolean {
  if (status === "recording") return true;
  if (status === "ready") return false;
  throw new Error(`Unexpected FluidVoice recording status: ${JSON.stringify(status)}`);
}

export const isFluidVoiceRecording = async (signal?: AbortSignal): Promise<boolean> =>
  parseFluidVoiceRecordingStatus(await runMacScript(STATUS_SCRIPT, signal));

/**
 * Starts or stops FluidVoice's plain dictation by tapping its hotkey, only when it is not already
 * in the wanted state so a repeated call is harmless.
 */
export const setFluidVoiceDictation = async (
  active: boolean,
  signal?: AbortSignal,
): Promise<void> => {
  if ((await isFluidVoiceRecording(signal)) === active) return;
  await runMacScript(TAP_RIGHT_SHIFT_SCRIPT, signal);
};
