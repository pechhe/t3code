import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { MAC_WINDOW_CAPTURE_SCRIPT } from "./macWindowCapture.ts";

function selectWindow(skipBundleIds: string) {
  const replies: string[] = [];
  const apps = ["com.FluidApp.app", "com.example.other", "com.example.focused"];
  const windows = apps.map((_, index) => ({
    objectForKey: (key: string) => {
      const values: Record<string, unknown> = {
        kCGWindowLayer: { js: 0 },
        kCGWindowOwnerPID: { js: index },
        kCGWindowNumber: { js: index + 10 },
        kCGWindowName: "Page",
        kCGWindowBounds: { X: 0, Y: 0, Width: 800, Height: 600 },
      };
      return values[key];
    },
  }));
  const platform = Object.assign((value: unknown) => value, {
    NSApplication: { sharedApplication: { setActivationPolicy: () => {} } },
    NSProcessInfo: {
      processInfo: {
        environment: { objectForKey: () => ({ isNil: () => false, js: skipBundleIds }) },
      },
    },
    NSWorkspace: {
      sharedWorkspace: { frontmostApplication: { isNil: () => false, processIdentifier: 2 } },
    },
    NSRunningApplication: {
      // This is the selector Cocoa exposes; misspellings must fail like they do in JXA.
      runningApplicationWithProcessIdentifier: (pid: number) => ({
        isNil: () => false,
        bundleIdentifier: { js: apps[pid] },
        localizedName: { js: `App ${pid}` },
        bundleURL: { path: { js: `/Applications/App${pid}.app` } },
      }),
    },
    CGWindowListCopyWindowInfo: () => windows,
    CFMakeCollectable: () => {},
    CFArrayGetCount: (list: unknown[]) => list.length,
    CFArrayGetValueAtIndex: (list: unknown[], index: number) => list[index],
    CGWindowListCreateImage: () => null,
    NSFileHandle: { fileHandleWithStandardInput: { availableData: {} } },
    NSString: { alloc: { initWithDataEncoding: () => ({ js: "/tmp/capture.png\n" }) } },
  });
  const context = {
    $: platform,
    ObjC: {
      import: () => {},
      castRefToObject: (value: unknown) => value,
      deepUnwrap: (value: unknown) => value,
      unwrap: (value: unknown) => value,
    },
    console: { log: (line: string) => replies.push(line) },
  };
  NodeVM.runInNewContext(`${MAC_WINDOW_CAPTURE_SCRIPT}\nrun();`, context);
  return JSON.parse(replies[1]!) as { window?: { id: number }; captured?: boolean };
}

describe("macOS capture window selection", () => {
  it("keeps the focused application's window when no apps are excluded", () => {
    expect(selectWindow("").window?.id).toBe(12);
  });

  it("captures the window behind FluidVoice when its app is excluded", () => {
    expect(selectWindow("com.FluidApp.app").window?.id).toBe(11);
  });

  it("returns no window when every visible app is excluded", () => {
    expect(
      selectWindow("com.FluidApp.app,com.example.other,com.example.focused").window,
    ).toBeUndefined();
  });
});
