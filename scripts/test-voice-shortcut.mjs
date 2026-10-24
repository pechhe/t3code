import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Exercise the native gesture implementation without starting the event observer.
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
print("PASS: alone, one release, typing/mouse cancellation, left/right overlap, modifier chord, wake reset, Caps Lock")
`;
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-voice-shortcut-test-"));
try {
  const testPath = NodePath.join(directory, "gesture.swift");
  NodeFS.writeFileSync(testPath, gesture + assertions);
  NodeChildProcess.execFileSync("/usr/bin/swift", [testPath], { stdio: "inherit" });
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
