import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const { createFromBufferMock, execFileMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  execFileMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock, spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: readFileMock, writeFile: writeFileMock }));
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: createFromBufferMock } }));

import {
  captureMacWindowSnapshot,
  macSnapShotArguments,
  startMacSnapShotProcess,
  type MacSnapShotChild,
  type MacWindowCapture,
} from "./MacSnapShot.ts";
import type { ActiveWindow } from "./ActiveWindow.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("image"),
]);

const active: ActiveWindow = {
  platform: "macos",
  id: 42,
  title: "Editor",
  bounds: { x: 10, y: 20, width: 800, height: 600 },
  owner: { name: "Code", processId: 123, path: "/Applications/Code.app" },
};

const helperReply = {
  window: {
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  },
  captured: true,
};

function fakeChild() {
  const lines: Array<(line: string) => void> = [];
  const exits: Array<() => void> = [];
  const sent: string[] = [];
  const child: MacSnapShotChild = {
    send: (line) => sent.push(line),
    onLine: (listener) => lines.push(listener),
    onExit: (listener) => exits.push(listener),
    kill: vi.fn(),
  };
  return {
    child,
    sent,
    emit: (line: string) => lines.forEach((listener) => listener(line)),
    exit: () => exits.forEach((listener) => listener()),
  };
}

const poolReturning = (capture: MacWindowCapture) => ({
  capture: vi.fn(async (_outputPath: string) => capture),
});

beforeEach(() => {
  execFileMock
    .mockReset()
    .mockImplementation(
      (
        _path: string,
        _args: ReadonlyArray<string>,
        _options: { readonly timeout: number },
        callback: (error: Error | null) => void,
      ) => callback(null),
    );
  readFileMock.mockReset().mockResolvedValue(PNG);
  writeFileMock.mockReset();
  createFromBufferMock.mockReset().mockReturnValue({
    getSize: () => ({ width: 800, height: 600 }),
    isEmpty: () => false,
  });
});

it("asks a ready helper for the front window and parses its reply", async () => {
  const fake = fakeChild();
  const helper = startMacSnapShotProcess(() => fake.child);

  const capture = helper.capture("/tmp/window.png");
  fake.emit("ready");
  await vi.waitFor(() => assert.deepEqual(fake.sent, ["/tmp/window.png"]));
  fake.emit(JSON.stringify(helperReply));

  assert.deepEqual(await capture, {
    active: {
      platform: "macos",
      id: 42,
      title: "main.ts",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      owner: {
        name: "Editor",
        processId: 123,
        path: "/Applications/Editor.app",
        bundleId: "com.example.editor",
      },
    },
    captured: true,
  });
  assert.isFalse(helper.alive);
});

it("omits an empty macOS bundle identifier", async () => {
  const fake = fakeChild();
  const helper = startMacSnapShotProcess(() => fake.child);
  fake.emit("ready");

  const capture = helper.capture("/tmp/window.png");
  await vi.waitFor(() => assert.lengthOf(fake.sent, 1));
  fake.emit(
    JSON.stringify({
      window: { ...helperReply.window, owner: { ...helperReply.window.owner, bundleId: "" } },
      captured: false,
    }),
  );

  const { active: window, captured } = await capture;
  assert.deepEqual(window?.owner, {
    name: "Editor",
    processId: 123,
    path: "/Applications/Editor.app",
  });
  assert.isFalse(captured);
});

it("reports no window when the helper finds none", async () => {
  const fake = fakeChild();
  const helper = startMacSnapShotProcess(() => fake.child);
  fake.emit("ready");

  const capture = helper.capture("/tmp/window.png");
  await vi.waitFor(() => assert.lengthOf(fake.sent, 1));
  fake.emit("{}");

  assert.deepEqual(await capture, { captured: false });
});

it("rejects when the helper exits without replying", async () => {
  const fake = fakeChild();
  const helper = startMacSnapShotProcess(() => fake.child);

  const capture = helper.capture("/tmp/window.png");
  fake.emit("execution error: Error: boom (-2700)");
  fake.exit();

  await expect(capture).rejects.toThrow("macOS window capture helper exited.");
});

it("keeps the helper's image without running screencapture", async () => {
  const pool = poolReturning({ active, captured: true });

  const capture = await captureMacWindowSnapshot(pool, "/tmp/window.png", () => ({
    width: 800,
    height: 600,
  }));

  assert.deepEqual(pool.capture.mock.calls, [["/tmp/window.png"]]);
  assert.lengthOf(execFileMock.mock.calls, 0);
  assert.deepEqual(readFileMock.mock.calls, [["/tmp/window.png"]]);
  assert.lengthOf(writeFileMock.mock.calls, 0);
  assert.strictEqual(capture?.active, active);
  assert.strictEqual(capture?.png, PNG);
  assert.deepEqual(capture?.source, { name: "Editor" });
});

it("falls back to screencapture when the helper could not capture the window", async () => {
  const pool = poolReturning({ active, captured: false });

  await captureMacWindowSnapshot(pool, "/tmp/window.png", () => ({ width: 800, height: 600 }));

  assert.deepEqual(execFileMock.mock.calls[0]?.slice(0, 3), [
    "/usr/sbin/screencapture",
    macSnapShotArguments(42, "/tmp/window.png"),
    { timeout: 15_000 },
  ]);
});

it("resolves undefined when there is no front window", async () => {
  const pool = poolReturning({ captured: false });

  const capture = await captureMacWindowSnapshot(pool, "/tmp/window.png", () => ({
    width: 800,
    height: 600,
  }));

  assert.isUndefined(capture);
  assert.lengthOf(execFileMock.mock.calls, 0);
  assert.lengthOf(readFileMock.mock.calls, 0);
});

it("bounds large captures without changing their aspect ratio", async () => {
  const resizedPng = Buffer.from("bounded png");
  const resizeMock = vi.fn().mockReturnValue({ toPNG: () => resizedPng });
  createFromBufferMock.mockReturnValue({
    getSize: () => ({ width: 2_000, height: 1_200 }),
    isEmpty: () => false,
    resize: resizeMock,
  });

  const capture = await captureMacWindowSnapshot(
    poolReturning({ active, captured: true }),
    "/tmp/window.png",
    () => ({ width: 1_000, height: 1_000 }),
  );

  assert.deepEqual(resizeMock.mock.calls, [[{ width: 1_000, height: 600, quality: "best" }]]);
  assert.deepEqual(writeFileMock.mock.calls, [["/tmp/window.png", resizedPng]]);
  assert.strictEqual(capture?.png, resizedPng);
});

it("rejects a capture that did not produce a PNG", async () => {
  readFileMock.mockResolvedValue(Buffer.from("not a png"));

  await expect(
    captureMacWindowSnapshot(poolReturning({ active, captured: true }), "/tmp/window.png", () => ({
      width: 800,
      height: 600,
    })),
  ).rejects.toThrow("macOS returned an invalid snapshot.");
});
