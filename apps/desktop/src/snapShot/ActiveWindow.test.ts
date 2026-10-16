import { assert, beforeEach, it, vi } from "vite-plus/test";

const { loadWindowsForegroundApiMock } = vi.hoisted(() => ({
  loadWindowsForegroundApiMock: vi.fn(),
}));

vi.mock("../electron/WindowsForeground.ts", () => ({
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  loadWindowsForegroundApiMock.mockReset();
});

it("composes the Windows foreground window from Win32 calls", async () => {
  const api = {
    getForegroundWindow: vi.fn(() => 0x1_f123_4567n),
    getWindowRect: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
    getWindowThreadAndProcessId: vi.fn(() => ({ threadId: 5, processId: 123 })),
    getProcessImagePath: vi.fn(() => "C:\\Program Files\\Editor\\editor.exe"),
    getWindowText: vi.fn(() => "main.ts - Editor"),
  };
  loadWindowsForegroundApiMock.mockResolvedValue(api);

  const window = await activeWindow("win32");

  assert.deepEqual(window, {
    platform: "windows",
    id: 0x1_f123_4567,
    title: "main.ts - Editor",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: { name: "editor.exe", processId: 123, path: "C:\\Program Files\\Editor\\editor.exe" },
  });
  assert.deepEqual(api.getWindowRect.mock.calls, [[0x1_f123_4567n]]);
  assert.deepEqual(api.getProcessImagePath.mock.calls, [[123]]);
});

it("resolves undefined when Windows reports no foreground window", async () => {
  const api = {
    getForegroundWindow: vi.fn(() => 0n),
    getWindowRect: vi.fn(),
    getWindowThreadAndProcessId: vi.fn(),
    getProcessImagePath: vi.fn(),
    getWindowText: vi.fn(),
  };
  loadWindowsForegroundApiMock.mockResolvedValue(api);

  assert.isUndefined(await activeWindow("win32"));
  assert.lengthOf(api.getWindowRect.mock.calls, 0);
});

it("resolves undefined on other platforms without querying the OS", async () => {
  assert.isUndefined(await activeWindow("darwin"));
  assert.isUndefined(await activeWindow("linux"));
  assert.lengthOf(loadWindowsForegroundApiMock.mock.calls, 0);
});
