import { describe, expect, it } from "vite-plus/test";

import configure from "../vite.config";

const warmedFiles = (mode: string) => {
  const config = configure({ command: "serve", mode });
  return (config as { server: { warmup: { clientFiles: string[] } } }).server.warmup.clientFiles;
};

describe("the shared Vite config's warmup", () => {
  it("compiles nothing up front for the test servers that inherit it", () => {
    expect(warmedFiles("test")).toEqual([]);
  });

  it("still warms the app for a dev server", () => {
    expect(warmedFiles("development")).toEqual(["./src/main.tsx"]);
  });
});
