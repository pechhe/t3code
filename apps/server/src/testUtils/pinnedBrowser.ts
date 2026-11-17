// @effect-diagnostics nodeBuiltinImport:off - Test-only host code: it resolves a path before any test runtime exists.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as PreviewBrowser from "../preview/PreviewBrowser.ts";

// A user cache directory, not a temp one, so an install survives every run on the machine.
// PreviewBrowser adds tools/chrome-headless-shell/<platform>/<version> below it.
const CACHE_DIR = NodePath.join(".cache", "t3code");

/** Overrides the cache the shell is installed into, so a run can point at one it prepared. */
const PINNED_BROWSER_DIR_ENV = "T3CODE_TEST_BROWSER_DIR";

const cacheBaseDir = (): string => {
  const configured = process.env[PINNED_BROWSER_DIR_ENV]?.trim();
  return configured === undefined || configured === ""
    ? NodePath.join(NodeOS.homedir(), CACHE_DIR)
    : configured;
};

/**
 * The variable a suite reads T3's pinned shell from. The test environment deliberately strips
 * every ambient `T3CODE_` variable (packages/shared/src/testing/providerEnv.ts), so setting one
 * for a run has to be allowed through its keep list as well.
 */
const PINNED_BROWSER_ENV = "T3CODE_TEST_BROWSER";

let installedOnce: Promise<string | null> | undefined;

const resolve = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const release = PreviewBrowser.previewBrowserRelease(platform, arch);
  if (release === null) return Option.none<string>();
  const executable = NodePath.join(
    PreviewBrowser.previewBrowserToolsDir(cacheBaseDir()),
    release.platform,
    release.version,
    PreviewBrowser.previewBrowserExecutableName(platform),
  );
  if (NodeFS.existsSync(executable)) return Option.some(executable);
  return yield* PreviewBrowser.makePreviewBrowser({ baseDir: cacheBaseDir() }).pipe(
    Effect.flatMap((browser) => browser.executable),
    Effect.scoped,
    Effect.asSome,
  );
}).pipe(Effect.withSpan("test.pinnedBrowser"));

/**
 * T3's pinned chrome-headless-shell for the server's real-Chromium tests, installed once into a
 * stable cache (`~/.cache/t3code`), so the ~128 MB download is not per test run. Null when it
 * cannot be installed, which skips the calling suite; Playwright's browser is no fallback.
 */
export const pinnedBrowser = (): Promise<string | null> => {
  if (process.env[PINNED_BROWSER_ENV]?.trim() === "none") return Promise.resolve(null);
  // One attempt per process: a failed install must not retry in every file of the run.
  installedOnce ??= Effect.runPromise(
    resolve.pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      // Any failure, including a defect from the download, skips the suite instead of failing it.
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    ),
  ).then((installed) => {
    if (Option.isSome(installed)) return installed.value;
    process.stderr.write(
      "T3's pinned browser could not be installed; real-Chromium tests in this file will skip.\n",
    );
    return null;
  });
  return installedOnce;
};
