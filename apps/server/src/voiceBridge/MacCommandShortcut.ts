// @effect-diagnostics nodeBuiltinImport:off -- The local macOS shortcut observes modifier events and uses the installed app's Accessibility surface.
// @effect-diagnostics globalTimers:off -- The startup deadline belongs to a native child process, outside Effect fibers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const HELPER_SOURCE = `
import AppKit

struct RightOptionGesture {
    private var held = false
    private var armed = false

    mutating func reset() { held = false; armed = false }
    mutating func otherInput() { armed = false }

    mutating func receive(type: CGEventType, event: CGEvent) -> String? {
        if event.getIntegerValueField(.eventSourceUserData) == 0x54335643 { return nil }
        let key = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
        if type == .flagsChanged {
            return flagsChanged(keyCode: key, flags: event.flags.rawValue) ? "trigger" : nil
        }
        otherInput()
        return type == .keyDown && (key == 53 || key == 10) ? "cancel" : nil
    }

    mutating func flagsChanged(keyCode: UInt16, flags: UInt64) -> Bool {
        guard keyCode == 61 else { armed = false; return false }
        let pressed = flags & 0x40 != 0
        if pressed && !held {
            held = true
            // Device bits distinguish right Option from left Option; Caps Lock is independent.
            armed = flags & 0x9e0000 == 0x80000 && flags & 0x20 == 0
            return false
        }
        guard !pressed && held else { return false }
        let trigger = armed
        reset()
        return trigger
    }
}

struct RightOptionMonitor<Token> {
    private(set) var current: Token?

    mutating func restart(install: () -> Token?, remove: (Token) -> Void) -> Bool {
        if let current { remove(current) }
        current = install()
        return current != nil
    }
}

func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

NSApplication.shared.setActivationPolicy(.prohibited)
var gesture = RightOptionGesture()
var monitor = RightOptionMonitor<CFMachPort>()
var source: CFRunLoopSource?
func observe() {
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    gesture.reset()
    let mask = [CGEventType.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let installed = monitor.restart(install: {
        CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: { _, type, event, _ in
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    gesture.reset()
                    if let tap = monitor.current {
                        CGEvent.tapEnable(tap: tap, enable: true)
                        if !CGEvent.tapIsEnabled(tap: tap) { emit("error: Right Option listener could not recover.") }
                    }
                    return Unmanaged.passUnretained(event)
                }
                // Observe before FluidVoice's session tap can consume cancel or other shortcuts.
                if let line = gesture.receive(type: type, event: event) { emit(line) }
                return Unmanaged.passUnretained(event)
            }, userInfo: nil)
    }, remove: { CFMachPortInvalidate($0) })
    guard installed, let tap = monitor.current,
          let next = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
        emit("error: Right Option listener unavailable; check Input Monitoring and Accessibility permissions.")
        exit(1)
    }
    source = next
    CFRunLoopAddSource(CFRunLoopGetMain(), next, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    if !CGEvent.tapIsEnabled(tap: tap) {
        emit("error: Right Option listener could not start.")
        exit(1)
    }
}
observe()
let wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in observe() }

let parent = getppid()
let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if getppid() != parent { exit(0) }
}
emit("ready")
NSApplication.shared.run()
`;

const STATUS_SCRIPT = `
function run() {
const p = Application('System Events').processes.byName('FluidVoice');
const titles = p.menuBars()[1].menuBarItems()[0].menus()[0].menuItems().map(x => x.name());
if (titles.some(x => x && x.startsWith('Recording...'))) return 'recording';
else if (titles.some(x => x && x.startsWith('Ready to Record'))) return 'ready';
else throw new Error('Cannot determine whether FluidVoice is recording.');

}
`;

const TOGGLE_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
const defaults = $.NSUserDefaults.alloc.initWithSuiteName('com.FluidApp.app');
const data = defaults.objectForKey('CommandModeHotkeyShortcut');
if (data.isNil()) throw new Error('Configure FluidVoice Command Mode to use Control-Option-Command-V.');
const shortcut = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
if (shortcut.keyCode !== 9 || shortcut.modifierFlagsRawValue !== 0x1c0000 ||
    (shortcut.modifierKeyCodes || []).length !== 0) {
  throw new Error('Right Option capture requires FluidVoice Command Mode to use Control-Option-Command-V.');
}
const down = $.CGEventCreateKeyboardEvent(null, 9, true);
$.CGEventSetFlags(down, 0x1c0000);
$.CGEventSetIntegerValueField(down, 42, 0x54335643);
$.CGEventPost(0, down);
const up = $.CGEventCreateKeyboardEvent(null, 9, false);
$.CGEventSetFlags(up, 0);
$.CGEventSetIntegerValueField(up, 42, 0x54335643);
$.CGEventPost(0, up);
`;

function runScript(script: string, signal?: AbortSignal): Promise<string> {
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
  parseFluidVoiceRecordingStatus(await runScript(STATUS_SCRIPT, signal));

export const toggleFluidVoiceCommand = async (signal?: AbortSignal): Promise<void> => {
  await runScript(TOGGLE_SCRIPT, signal);
};

export async function startMacCommandShortcut(options: {
  readonly helperPath: string;
  readonly onTrigger: () => void;
  readonly onCancel: () => void;
  readonly onFailure: (error: Error) => void;
}): Promise<() => void> {
  await NodeFSP.writeFile(options.helperPath, HELPER_SOURCE);
  const child = NodeChildProcess.spawn("/usr/bin/swift", [options.helperPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    let stopped = false;
    let buffered = "";
    let diagnostics = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      stop();
      if (ready) options.onFailure(error);
      else reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("The Mac command shortcut did not start.")),
      30_000,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-4_000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready") {
          ready = true;
          clearTimeout(timer);
          resolve(stop);
        } else if (ready && line === "trigger") options.onTrigger();
        else if (ready && line === "cancel") options.onCancel();
        else if (line.startsWith("error:")) fail(new Error(line.slice(6).trim()));
      }
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(diagnostics || `Mac shortcut exited (${code}).`)));
  });
}
