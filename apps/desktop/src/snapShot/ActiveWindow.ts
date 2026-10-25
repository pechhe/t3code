import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";

/** id is CGWindowNumber on macOS or HWND on Windows, matching the capture backend. */
export type ActiveWindow = {
  readonly platform: "macos" | "windows";
  readonly id: number;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly owner: {
    readonly name: string;
    readonly processId: number;
    readonly path: string;
    readonly bundleId?: string;
  };
};

async function windowsActiveWindow(): Promise<ActiveWindow | undefined> {
  const api = await loadWindowsForegroundApi();
  const handle = api.getForegroundWindow();
  if (handle === 0n) return undefined;
  const bounds = api.getWindowRect(handle);
  if (!bounds) return undefined;
  const { processId } = api.getWindowThreadAndProcessId(handle);
  const path = processId === 0 ? "" : api.getProcessImagePath(processId);
  const name = path.split(/[\\/]/).pop() ?? "";
  return {
    platform: "windows",
    id: Number(handle),
    title: api.getWindowText(handle),
    bounds,
    owner: { name, processId, path },
  };
}

export function activeWindow(platform: NodeJS.Platform): Promise<ActiveWindow | undefined> {
  if (platform === "win32") return windowsActiveWindow();
  return Promise.resolve(undefined);
}
