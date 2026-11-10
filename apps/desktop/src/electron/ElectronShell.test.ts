import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { browserNameMock, openExternalMock, writeTextMock } = vi.hoisted(() => ({
  browserNameMock: vi.fn(),
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getApplicationNameForProtocol: browserNameMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    browserNameMock.mockReset();
    browserNameMock.mockReturnValue("Safari");
    writeTextMock.mockReset();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["https://example.com/path", { activate: true }],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "leaves Phi in the background for web links so only its kiosk window shows",
    () =>
      Effect.gen(function* () {
        browserNameMock.mockReturnValue("Phi");
        openExternalMock.mockResolvedValue(undefined);

        const electronShell = yield* ElectronShell.ElectronShell;
        yield* electronShell.openExternal("https://example.com/path");
        yield* electronShell.openExternal("zed://ssh/example.com/");

        assert.deepEqual(openExternalMock.mock.calls, [
          ["https://example.com/path", { activate: false }],
          ["zed://ssh/example.com/", { activate: true }],
        ]);
      }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+user%40example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        [
          "vscode://vscode-remote/ssh-remote+user%40example.com/home/user/project",
          { activate: true },
        ],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the JetBrains Toolbox ssh deep link", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const url =
        "jetbrains://gateway/ssh/environment?h=example.com&launchIde=true&ideHint=IU&projectHint=%2Fhome%2Fuser%2Fproject&u=user";
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(url);

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [[url, { activate: true }]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens local editor file deep links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const urls = [
        "cursor://file/Users/me/repo/file.md:186",
        "vscode://file/Users/me/repo/file.md:3:7",
        "vscode-insiders://file/Users/me/repo/file.md",
        "vscodium://file/C:/Users/me/repo/file.md:3",
      ];
      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.forEach(urls, (url) => electronShell.openExternal(url));

      assert.deepEqual(results, [true, true, true, true]);
      assert.deepEqual(
        openExternalMock.mock.calls,
        urls.map((url) => [url, { activate: true }]),
      );
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("normalizes the scheme case of local editor file deep links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("VSCode://file/Users/me/repo/file.md:3");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://file/Users/me/repo/file.md:3", { activate: true }],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open editor URLs that are not absolute local file links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.forEach(
        [
          "cursor://user@file/Users/me/repo/file.md",
          "cursor://:secret@file/Users/me/repo/file.md",
          "cursor://file:8080/Users/me/repo/file.md",
          "cursor://anysphere.cursor-deeplink/prompt?text=hi",
          "vscode://vscode.git/clone?url=https%3A%2F%2Fexample.com%2Frepo.git",
          "cursor://file",
          "cursor://file/",
          "cursor:file/Users/me/repo/file.md",
          "foo://file/Users/me/repo/file.md",
          "zed://file/Users/me/repo/file.md",
          "jetbrains://file/Users/me/repo/file.md",
          "javascript:alert(1)",
        ],
        (url) => electronShell.openExternal(url),
      );

      assert.deepEqual(results, Array(12).fill(false));
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open editor URLs that mix up link shapes", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal("zed://extension/attacker"),
        electronShell.openExternal("vscode://ssh/example.com/home/user/project"),
        electronShell.openExternal("jetbrains://idea/navigate/reference?project=x&path=y"),
        electronShell.openExternal("jetbrains://gateway/ssh/environment?launchIde=true"),
        electronShell.openExternal("jetbrains://gateway/com.example.provider/connect?h=x"),
      ]);

      assert.deepEqual(results, [false, false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal("zed://ssh/user:secret@example.com/home/user/project"),
        electronShell.openExternal("jetbrains://user@gateway/ssh/environment?h=example.com"),
      ]);

      assert.deepEqual(results, [false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
