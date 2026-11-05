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
