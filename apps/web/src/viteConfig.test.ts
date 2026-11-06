import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import configure from "../vite.config";

const warmedFiles = () => {
  const config = configure({ command: "serve", mode: "test" });
  return (config as { server: { warmup: { clientFiles: string[] } } }).server.warmup.clientFiles;
};

describe("the shared Vite config's warmup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("compiles nothing up front for the test servers that inherit it", () => {
    vi.stubEnv("VITEST", "true");
    expect(warmedFiles()).toEqual([]);
  });

  it("still warms the app for a dev server", () => {
    vi.stubEnv("VITEST", "");
    expect(warmedFiles()).toEqual(["./src/main.tsx"]);
  });
});
