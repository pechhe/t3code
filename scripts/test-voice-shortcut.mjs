import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Check the native gesture and listener lifecycle without posting keyboard events.
const source = NodeFS.readFileSync(
  new URL("../apps/server/src/voiceBridge/MacCommandShortcut.ts", import.meta.url),
  "utf8",
);
const helper = /const HELPER_SOURCE = `([\s\S]*?)`;/u.exec(source)?.[1];
if (!helper?.includes("NSApplication.shared.setActivationPolicy"))
  throw new Error("Native helper not found.");
const gesture = helper.slice(0, helper.indexOf("NSApplication.shared.setActivationPolicy"));
const assertions = String.raw`
var g = RightOptionGesture()
func check(_ result: Bool, _ expected: Bool) { precondition(result == expected) }
check(g.flagsChanged(keyCode: 61, flags: 0x80040), false)
check(g.flagsChanged(keyCode: 61, flags: 0), true)
check(g.flagsChanged(keyCode: 61, flags: 0), false)
check(g.flagsChanged(keyCode: 61, flags: 0x80040), false)
g.otherInput()
check(g.flagsChanged(keyCode: 61, flags: 0), false)
check(g.flagsChanged(keyCode: 61, flags: 0x80040), false)
check(g.flagsChanged(keyCode: 58, flags: 0x80060), false)
check(g.flagsChanged(keyCode: 61, flags: 0x80020), false)
check(g.flagsChanged(keyCode: 61, flags: 0x180048), false)
check(g.flagsChanged(keyCode: 61, flags: 0x100008), false)
check(g.flagsChanged(keyCode: 61, flags: 0x80040), false)
g.reset()
check(g.flagsChanged(keyCode: 61, flags: 0), false)
check(g.flagsChanged(keyCode: 61, flags: 0x90040), false)
check(g.flagsChanged(keyCode: 61, flags: 0x10000), true)
let optionDown = CGEvent(keyboardEventSource: nil, virtualKey: 61, keyDown: true)!
optionDown.flags = CGEventFlags(rawValue: 0x80040)
let optionUp = CGEvent(keyboardEventSource: nil, virtualKey: 61, keyDown: false)!
optionUp.flags = []
let command = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true)!
command.flags = CGEventFlags(rawValue: 0x1c0000)
command.setIntegerValueField(.eventSourceUserData, value: 0x54335643)
g.reset()
precondition(g.receive(type: .flagsChanged, event: optionDown) == nil)
precondition(g.receive(type: .keyDown, event: command) == nil)
precondition(g.receive(type: .flagsChanged, event: optionUp) == "trigger")
let physicalCommand = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true)!
physicalCommand.flags = CGEventFlags(rawValue: 0x1c0000)
precondition(physicalCommand.getIntegerValueField(.eventSourceUserData) == 0)
precondition(g.receive(type: .flagsChanged, event: optionDown) == nil)
precondition(g.receive(type: .keyDown, event: physicalCommand) == nil)
precondition(g.receive(type: .flagsChanged, event: optionUp) == nil)
let cancel = CGEvent(keyboardEventSource: nil, virtualKey: 10, keyDown: true)!
precondition(g.receive(type: .flagsChanged, event: optionDown) == nil)
precondition(g.receive(type: .keyDown, event: cancel) == "cancel")
precondition(g.receive(type: .flagsChanged, event: optionUp) == nil)
var listener = RightOptionMonitor<Int>()
var removed: [Int] = []
check(listener.restart(install: { 1 }, remove: { removed.append($0) }), true)
check(listener.restart(install: { nil }, remove: { removed.append($0) }), false)
precondition(listener.current == nil && removed == [1])
check(listener.restart(install: { nil }, remove: { removed.append($0) }), false)
precondition(removed == [1])
check(listener.restart(install: { 2 }, remove: { removed.append($0) }), true)
check(listener.restart(install: { 3 }, remove: { removed.append($0) }), true)
precondition(listener.current == 3 && removed == [1, 2])
print("PASS: monitor removal, failed wake recovery, retry, alone, one release, typing/mouse cancellation, left/right overlap, modifier chord, wake reset, Caps Lock")
`;
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-voice-shortcut-test-"));
try {
  const testPath = NodePath.join(directory, "gesture.swift");
  NodeFS.writeFileSync(testPath, gesture + assertions);
  NodeChildProcess.execFileSync("/usr/bin/swift", [testPath], { stdio: "inherit" });
  const observerAssertions = String.raw`
let original = monitor.current!
NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
precondition(monitor.current != nil && monitor.current !== original)
precondition(!CFMachPortIsValid(original))
print("PASS: actual passive listener installation and wake replacement without posting keyboard events")
`;
  const observerPath = NodePath.join(directory, "observer.swift");
  NodeFS.writeFileSync(
    observerPath,
    helper.replace("NSApplication.shared.run()", observerAssertions),
  );
  NodeChildProcess.execFileSync("/usr/bin/swift", [observerPath], { stdio: "inherit" });
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
