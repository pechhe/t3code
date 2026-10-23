// @effect-diagnostics nodeBuiltinImport:off - Exercises the real fork updater shell script against private repositories, state and application directories.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterAll, describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const SCRIPT =
  process.env.FORK_NIGHTLY_SCRIPT_UNDER_TEST ??
  NodePath.join(import.meta.dirname, "fork-nightly.sh");
const APP = "T3 Peach.app";
const INSTALL_JOB = "com.pechhe.t3code-install-on-quit";
const WEBHOOK = "https://hooks.invalid/rebase";
const OLD_TAG = "v0.1.1-nightly.20990101.1";
const NEW_TAG = "v0.1.2-nightly.20990102.1";
// Attempt tests drive several full hourly runs (git fetches against local remotes) each.
const TIMEOUT = 120_000;
const CONNECT_ENV = "T3CODE_RELAY_URL=https://relay.example\n";

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(T3FORK_|T3CODE_|GIT_|GITHUB_|XPC_SERVICE_NAME$)/.test(key),
  ),
);

const STUBS: Record<string, string> = {
  // Valid unless the bundle carries an INVALID marker.
  codesign: `for a; do last="$a"; done
[ ! -e "$last/Contents/INVALID" ]
`,
  // A copy that can be told to die after creating only part of the destination.
  ditto: `if [ "$T3_TEST_DITTO" = partial-fail ]; then
  mkdir -p "$2/Contents/MacOS"
  exit 1
fi
case "$1" in *.replaced) [ "$T3_TEST_DITTO" != fail-retain ] || exit 1 ;; esac
cp -R "$1" "$2"
`,
  pgrep: `echo "$*" >> "$T3_TEST_ROOT/pgrep.log"
[ -e "$T3_TEST_ROOT/running" ]
`,
  curl: `body=""; prev=""; probe=""
for a; do
  [ "$prev" = -d ] && body="$a"
  [ "$prev" = -w ] && probe=1
  prev="$a"
  url="$a"
done
# A release-asset probe: published unless T3_TEST_ABSENT names a part of its URL.
if [ -n "$probe" ]; then
  printf '%s\\n' "$url" >> "$T3_TEST_ROOT/probe.log"
  [ "$T3_TEST_PROBE" = fail ] && exit 7
  for part in $T3_TEST_ABSENT; do
    case "$url" in *"$part"*) printf 404; exit 0 ;; esac
  done
  printf 206
  exit 0
fi
jq -cn --arg url "$url" --arg body "$body" '{url: $url, body: $body}' >> "$T3_TEST_ROOT/curl.log"
[ "$T3_TEST_CURL" = fail ] && exit 7
exit 0
`,
  // A build that gets past selection stops at the app build.
  vp: `printf '%s\\n' "vp $*" >> "$T3_TEST_ROOT/calls.log"
cat .env > "$T3_TEST_ROOT/env-at-vp" 2>/dev/null
exit 1
`,
  // The VPS build step: its exit status is whatever T3_TEST_VPS_STATUS says (3: a release asset is missing).
  ssh: `printf '%s\\n' "ssh $*" >> "$T3_TEST_ROOT/calls.log"
case "$*" in *" build "*)
  [ "$T3_TEST_VPS_STATUS" != 3 ] || { echo "the upstream release v1 has no downloadable SHA256SUMS (u)" >&2; exit 3; }
  exit "\${T3_TEST_VPS_STATUS:-0}" ;;
esac
`,
  // The script's waits shrink so polling loops finish quickly.
  sleep: `exec /bin/sleep 0.2
`,
  // Describes the install-on-quit job as the test's job-state file says.
  launchctl: `printf '%s\\n' "launchctl $*" >> "$T3_TEST_ROOT/calls.log"
if [ "$1" = print ] && [ -e "$T3_TEST_ROOT/job-state" ]; then cat "$T3_TEST_ROOT/job-state"; fi
`,
  ...Object.fromEntries(
    ["osascript", "open"].map((name) => [
      name,
      `printf '%s\\n' "${name} $*" >> "$T3_TEST_ROOT/calls.log"\n`,
    ]),
  ),
};

interface Fixture {
  readonly root: string;
  readonly state: string;
  readonly apps: string;
  readonly installed: string;
  readonly origin: string;
  readonly upstream: string;
  readonly env: Record<string, string>;
}

async function withFixture(body: (f: Fixture) => Promise<void>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-nightly-")),
  );
  try {
    const bin = NodePath.join(root, "bin");
    const apps = NodePath.join(root, "Applications");
    const state = NodePath.join(root, "state");
    const home = NodePath.join(root, "home");
    for (const dir of [bin, apps, state, home]) await NodeFSP.mkdir(dir, { recursive: true });
    for (const [name, source] of Object.entries(STUBS)) {
      await NodeFSP.writeFile(NodePath.join(bin, name), `#!/bin/sh\n${source}`, { mode: 0o755 });
    }
    const f: Fixture = {
      root,
      state,
      apps,
      installed: NodePath.join(apps, APP),
      origin: NodePath.join(root, "origin.git"),
      upstream: NodePath.join(root, "upstream.git"),
      env: {
        ...baseEnv,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        T3_TEST_ROOT: root,
        T3FORK_STATE: state,
        T3FORK_REPO: NodePath.join(root, "clone"),
        T3FORK_APPLICATIONS: apps,
        T3FORK_VPS: "",
        T3FORK_ORIGIN_URL: NodePath.join(root, "origin.git"),
        T3FORK_UPSTREAM_URL: NodePath.join(root, "upstream.git"),
      },
    };
    expect(f.installed.startsWith(root)).toBe(true);
    expect(f.state.startsWith(root)).toBe(true);
    await body(f);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  f: Fixture,
  args: ReadonlyArray<string>,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const result = await execFile("bash", [SCRIPT, ...args], {
      env: { ...f.env, ...extraEnv },
      timeout: 25_000,
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function exists(path: string) {
  return NodeFSP.stat(path).then(
    () => true,
    () => false,
  );
}

async function readText(path: string) {
  return NodeFSP.readFile(path, "utf8").catch(() => "");
}

async function readJson(path: string) {
  return JSON.parse(await NodeFSP.readFile(path, "utf8")) as Record<string, unknown>;
}

/** A bundle whose BUILD file says which build it is. `incomplete` omits Info.plist. */
async function makeApp(
  dir: string,
  build: string,
  options: { incomplete?: boolean; invalid?: boolean } = {},
) {
  await NodeFSP.mkdir(NodePath.join(dir, "Contents/MacOS"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dir, "Contents/MacOS/exe"), `exe ${build}\n`);
  await NodeFSP.writeFile(NodePath.join(dir, "Contents/BUILD"), build);
  if (!options.incomplete)
    await NodeFSP.writeFile(NodePath.join(dir, "Contents/Info.plist"), "<plist/>");
  if (options.invalid) await NodeFSP.writeFile(NodePath.join(dir, "Contents/INVALID"), "");
}

async function build(dir: string) {
  return (await readText(NodePath.join(dir, "Contents/BUILD"))) || undefined;
}

async function isComplete(dir: string) {
  return (
    (await exists(NodePath.join(dir, "Contents/Info.plist"))) &&
    (await exists(NodePath.join(dir, "Contents/MacOS/exe")))
  );
}

async function writeJson(path: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, JSON.stringify(value));
}

async function installOld(f: Fixture) {
  await makeApp(f.installed, "old");
  await writeJson(NodePath.join(f.state, "active-mac.json"), { source: "old-src", version: "0.9" });
}

async function stageBuild(
  f: Fixture,
  options: { source?: string; selected?: string; invalid?: boolean } = {},
) {
  const source = options.source ?? "new-src";
  await makeApp(NodePath.join(f.state, "staged", APP), "new", { invalid: options.invalid });
  await writeJson(NodePath.join(f.state, "staged/receipt.json"), { source, version: "1.0.1" });
  await writeJson(NodePath.join(f.state, "selected.json"), { source: options.selected ?? source });
}

const stateFile = (f: Fixture, ...parts: string[]) => NodePath.join(f.state, ...parts);

async function nightlyLog(f: Fixture) {
  return readText(stateFile(f, "nightly.log"));
}

async function calls(f: Fixture, name: string) {
  return (await readText(NodePath.join(f.root, "calls.log")))
    .split("\n")
    .filter((line) => line.startsWith(`${name} `) || line === name);
}

async function curlCalls(f: Fixture) {
  return (await readText(NodePath.join(f.root, "curl.log")))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const call = JSON.parse(line) as { url: string; body: string };
      return { url: call.url, body: JSON.parse(call.body) as Record<string, string> };
    });
}

async function pollUntil(condition: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function git(cwd: string, args: ReadonlyArray<string>, date?: string) {
  const dated = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  const { stdout } = await execFile("git", [...args], {
    cwd,
    env: {
      ...baseEnv,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...dated,
    },
  });
  return stdout.trim();
}

/**
 * Upstream holds v0.1.0 (merged into the fork). Origin's t3peach holds a fork
 * commit and a merge commit, so its head is an integration and needs no build once
 * selected. Returns the head.
 */
async function buildTemplate() {
  const dir = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-nightly-repos-")),
  );
  const origin = NodePath.join(dir, "origin.git");
  const upstream = NodePath.join(dir, "upstream.git");
  const work = NodePath.join(dir, "work");
  await NodeFSP.mkdir(work);
  await git(work, ["init", "-q", "-b", "main"]);
  const commit = async (file: string, date: string) => {
    await NodeFSP.writeFile(NodePath.join(work, file), `${file}\n`);
    await git(work, ["add", file]);
    await git(work, ["commit", "-q", "-m", file], date);
  };
  await commit("base", "2026-01-01T00:00:00Z");
  await git(work, ["tag", "v0.1.0-nightly.20260101.1"]);
  await git(work, ["checkout", "-q", "-b", "t3peach"]);
  // The fork keeps the upstream example, and `.env` is ignored like the real one.
  await NodeFSP.writeFile(NodePath.join(work, ".gitignore"), ".env\n");
  await NodeFSP.writeFile(NodePath.join(work, ".env.example"), CONNECT_ENV);
  await git(work, ["add", ".gitignore", ".env.example"]);
  await commit("fork-change", "2026-01-02T00:00:00Z");
  await git(work, ["checkout", "-q", "-b", "side", "main"]);
  await commit("side", "2026-01-03T00:00:00Z");
  await git(work, ["checkout", "-q", "t3peach"]);
  await git(
    work,
    ["merge", "-q", "--no-ff", "-m", "Merge upstream integration", "side"],
    "2026-01-04T00:00:00Z",
  );
  for (const bare of [upstream, origin])
    await git(dir, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(work, ["push", "-q", origin, "t3peach"]);
  await git(work, ["push", "-q", upstream, "main", "--tags"]);
  await git(work, ["checkout", "-q", "main"]);
  return { dir, head: await git(origin, ["rev-parse", "t3peach"]) };
}

let template: ReturnType<typeof buildTemplate> | undefined;
afterAll(async () => {
  if (template) await NodeFSP.rm((await template).dir, { recursive: true, force: true });
});

async function seedRepos(f: Fixture) {
  template ??= buildTemplate();
  const { dir, head } = await template;
  await NodeFSP.cp(dir, f.root, { recursive: true });
  await writeJson(stateFile(f, "selected.json"), { source: head });
  await NodeFSP.writeFile(stateFile(f, "rebase-webhook-url"), `${WEBHOOK}\n`);
  await installOld(f);
  return head;
}

/** Publishes a new upstream nightly that t3peach does not contain. */
async function publishUpstreamTag(f: Fixture, tag: string, date: string) {
  const work = NodePath.join(f.root, "work");
  await NodeFSP.writeFile(NodePath.join(work, tag), tag);
  await git(work, ["add", tag]);
  await git(work, ["commit", "-q", "-m", tag], date);
  await git(work, ["tag", tag]);
  await git(work, ["push", "-q", f.upstream, "main", tag]);
  return git(work, ["rev-parse", tag]);
}

async function attemptOf(f: Fixture, tag: string) {
  return readJson(stateFile(f, "attempts", `${tag}.json`));
}

async function expectNoBuild(f: Fixture) {
  expect(await exists(stateFile(f, "build-started"))).toBe(false);
  expect(await exists(stateFile(f, "build-failed.json"))).toBe(false);
}

/**
 * Lands a new upstream integration on origin's t3peach (a merge whose second parent
 * is `upstream`), carrying a receipt for `tag`. The old head stays selectable.
 */
async function landIntegration(f: Fixture, tag: string, date: string) {
  const work = NodePath.join(f.root, "work");
  await git(work, ["checkout", "-q", "-b", `int-${tag}`, "main"]);
  await NodeFSP.writeFile(NodePath.join(work, `int-${tag}`), tag);
  await git(work, ["add", "."]);
  await git(work, ["commit", "-q", "-m", `upstream ${tag}`], date);
  const upstream = await git(work, ["rev-parse", "HEAD"]);
  await git(work, ["checkout", "-q", "t3peach"]);
  await git(work, ["merge", "-q", "--no-ff", "--no-commit", `int-${tag}`], date);
  await NodeFSP.mkdir(NodePath.join(work, "fork"), { recursive: true });
  await writeJson(NodePath.join(work, "fork/upstream-receipt.json"), {
    upstream: { target: { tag } },
  });
  await git(work, ["add", "."]);
  await git(work, ["commit", "-q", "-m", `Merge ${tag}`], date);
  await git(work, ["push", "-q", f.origin, "t3peach"]);
  const head = await git(work, ["rev-parse", "HEAD"]);
  await git(work, ["checkout", "-q", "main"]);
  return { head, upstream };
}

const BUILD_TAG = "v0.1.3-nightly.20990103.1";
const INCOMING_DIR = (f: Fixture) => NodePath.join(f.apps, `.${APP}.installing`);
const REPLACED_DIR = (f: Fixture) => NodePath.join(f.apps, `.${APP}.replaced`);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("fork nightly updater", () => {
  describe.concurrent("desktop install", () => {
    it(
      "installs the selected staged build and keeps the old app as the previous build",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await isComplete(f.installed)).toBe(true);
          expect(await build(stateFile(f, "previous", APP))).toBe("old");
          expect(await readJson(stateFile(f, "previous/receipt.json"))).toMatchObject({
            source: "old-src",
          });
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "new-src",
            version: "1.0.1",
            installedAt: expect.any(String),
          });
          expect(await exists(stateFile(f, "staged"))).toBe(false);
          for (const leftover of [`.${APP}.installing`, `.${APP}.replaced`]) {
            expect(await exists(NodePath.join(f.apps, leftover))).toBe(false);
          }
          expect(await exists(stateFile(f, "lock"))).toBe(false);
          expect((await NodeFSP.readdir(f.state)).filter((n) => n.startsWith("run."))).toEqual([]);
          // A plain install neither relaunches the app nor touches launchd.
          expect(await calls(f, "open")).toEqual([]);
          expect(await calls(f, "launchctl")).toEqual([]);
        });
      },
      TIMEOUT,
    );

    it(
      "keeps the installed app complete when the copy is interrupted, then installs on the next run",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          const activeBefore = await readText(stateFile(f, "active-mac.json"));
          const failed = await run(f, ["install"], { T3_TEST_DITTO: "partial-fail" });
          expect(failed.code).not.toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await isComplete(f.installed)).toBe(true);
          expect(await readText(stateFile(f, "active-mac.json"))).toBe(activeBefore);
          expect(await build(stateFile(f, "staged", APP))).toBe("new");
          expect(await exists(stateFile(f, "staged/receipt.json"))).toBe(true);
          expect(await exists(stateFile(f, "previous"))).toBe(false);
          expect(await exists(NodePath.join(f.apps, `.${APP}.installing`))).toBe(false);

          const retry = await run(f, ["install"]);
          expect(retry.code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "new-src",
          });
          expect(await exists(stateFile(f, "staged"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "records the install when keeping the replaced app fails, and keeps it on the next run",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          const result = await run(f, ["install"], { T3_TEST_DITTO: "fail-retain" });
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "new-src",
          });
          expect(await build(REPLACED_DIR(f))).toBe("old");
          expect(await exists(stateFile(f, "previous"))).toBe(false);
          expect(await nightlyLog(f)).toContain("could not keep the replaced app");

          expect((await run(f, ["install"])).code).toBe(0);
          expect(await exists(REPLACED_DIR(f))).toBe(false);
          expect(await build(stateFile(f, "previous", APP))).toBe("old");
          expect(await readJson(stateFile(f, "previous/receipt.json"))).toMatchObject({
            source: "old-src",
          });
          expect(await exists(stateFile(f, "replaced-receipt.json"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "waits instead of nesting apps while the replaced app still cannot be kept, then keeps the immediately prior build",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          expect((await run(f, ["install"], { T3_TEST_DITTO: "fail-retain" })).code).toBe(0);
          expect(await build(REPLACED_DIR(f))).toBe("old");

          // A newer build is staged while keeping the replaced app still fails.
          await NodeFSP.rm(stateFile(f, "staged"), { recursive: true, force: true });
          await makeApp(stateFile(f, "staged", APP), "newer");
          await writeJson(stateFile(f, "staged/receipt.json"), { source: "newer-src" });
          await writeJson(stateFile(f, "selected.json"), { source: "newer-src" });
          const waiting = await run(f, ["install"], { T3_TEST_DITTO: "fail-retain" });
          expect(waiting.code).not.toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await build(REPLACED_DIR(f))).toBe("old");
          expect(await exists(NodePath.join(REPLACED_DIR(f), APP))).toBe(false);
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "new-src",
          });
          expect(await exists(stateFile(f, "staged/receipt.json"))).toBe(true);
          expect((await run(f, ["status"])).stdout).toContain(
            'replaced, not yet kept as previous: {"source":"old-src"',
          );

          // Once keeping succeeds, the newer build installs and the build it
          // replaced, not the older one, is the one-step rollback.
          expect((await run(f, ["install"])).code).toBe(0);
          expect(await build(f.installed)).toBe("newer");
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "newer-src",
          });
          expect(await build(stateFile(f, "previous", APP))).toBe("new");
          expect(await exists(stateFile(f, "previous", APP, APP))).toBe(false);
          expect(await readJson(stateFile(f, "previous/receipt.json"))).toMatchObject({
            source: "new-src",
          });
          expect(await exists(REPLACED_DIR(f))).toBe(false);
          expect(await exists(stateFile(f, "replaced-receipt.json"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "leaves the installed app unchanged when the copy fails signature validation",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f, { invalid: true });
          const activeBefore = await readText(stateFile(f, "active-mac.json"));
          const result = await run(f, ["install"]);
          expect(result.code).not.toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await isComplete(f.installed)).toBe(true);
          expect(await readText(stateFile(f, "active-mac.json"))).toBe(activeBefore);
          expect(await exists(stateFile(f, "staged/receipt.json"))).toBe(true);
          expect(await exists(NodePath.join(f.apps, `.${APP}.installing`))).toBe(false);
          expect(await exists(stateFile(f, "previous"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    describe("an interrupted replacement", () => {
      it(
        "restores the replaced app when the install path is absent, then installs the staged build",
        async () => {
          await withFixture(async (f) => {
            await NodeFSP.mkdir(f.apps, { recursive: true });
            await makeApp(NodePath.join(f.apps, `.${APP}.replaced`), "old");
            await makeApp(NodePath.join(f.apps, `.${APP}.installing`), "half-new", {
              incomplete: true,
            });
            await writeJson(stateFile(f, "active-mac.json"), { source: "old-src" });
            await stageBuild(f, { invalid: true });

            // Staged validation fails, so only the recovery is observable.
            const recovered = await run(f, ["install"]);
            expect(recovered.code).not.toBe(0);
            expect(await build(f.installed)).toBe("old");
            expect(await isComplete(f.installed)).toBe(true);
            expect(await exists(NodePath.join(f.apps, `.${APP}.installing`))).toBe(false);
            // The restore is not an install.
            expect(await readJson(stateFile(f, "active-mac.json"))).toEqual({ source: "old-src" });
            expect(await exists(stateFile(f, "staged/receipt.json"))).toBe(true);

            await NodeFSP.rm(stateFile(f, "staged", APP, "Contents/INVALID"));
            expect((await run(f, ["install"])).code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await build(stateFile(f, "previous", APP))).toBe("old");
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
              installedAt: expect.any(String),
            });
          });
        },
        TIMEOUT,
      );

      it(
        "restores the previous build over an incomplete installed bundle, then installs the staged build",
        async () => {
          await withFixture(async (f) => {
            await makeApp(f.installed, "broken", { incomplete: true });
            await makeApp(stateFile(f, "previous", APP), "prev");
            await writeJson(stateFile(f, "previous/receipt.json"), { source: "prev-src" });
            await writeJson(stateFile(f, "active-mac.json"), { source: "broken-src" });
            await stageBuild(f, { invalid: true });

            const recovered = await run(f, ["install"]);
            expect(recovered.code).not.toBe(0);
            expect(await build(f.installed)).toBe("prev");
            expect(await isComplete(f.installed)).toBe(true);
            // The incomplete bundle is kept aside, not deleted.
            const aside = (await NodeFSP.readdir(f.state)).filter((n) => n.startsWith("broken-"));
            expect(aside).toHaveLength(1);
            expect(await build(stateFile(f, aside[0]!))).toBe("broken");
            // Restored from previous: the receipt names the restored build, not an install.
            expect(await readJson(stateFile(f, "active-mac.json"))).toEqual({ source: "prev-src" });
            expect(await build(stateFile(f, "previous", APP))).toBe("prev");

            await NodeFSP.rm(stateFile(f, "staged", APP, "Contents/INVALID"));
            expect((await run(f, ["install"])).code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await isComplete(f.installed)).toBe(true);
            expect(await build(stateFile(f, "previous", APP))).toBe("prev");
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
            });
          });
        },
        TIMEOUT,
      );

      it(
        "restores a complete app and does not install a staged build that is no longer selected",
        async () => {
          await withFixture(async (f) => {
            await makeApp(f.installed, "broken", { incomplete: true });
            await makeApp(stateFile(f, "previous", APP), "prev");
            await writeJson(stateFile(f, "previous/receipt.json"), { source: "prev-src" });
            await stageBuild(f, { selected: "someone-else" });
            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("prev");
            expect(await isComplete(f.installed)).toBe(true);
            expect(await exists(stateFile(f, "staged"))).toBe(false);
            expect(await readJson(stateFile(f, "active-mac.json"))).toEqual({ source: "prev-src" });
          });
        },
        TIMEOUT,
      );

      it(
        "installs the staged build over an incomplete bundle when nothing else can restore it",
        async () => {
          await withFixture(async (f) => {
            await makeApp(f.installed, "broken", { incomplete: true });
            await stageBuild(f);
            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await isComplete(f.installed)).toBe(true);
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
            });
          });
        },
        TIMEOUT,
      );
    });

    it(
      "discards a staged build whose target was superseded without installing it",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f, { source: "stale-src", selected: "newer-src" });
          const activeBefore = await readText(stateFile(f, "active-mac.json"));
          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await exists(stateFile(f, "staged"))).toBe(false);
          expect(await exists(stateFile(f, "previous"))).toBe(false);
          expect(await readText(stateFile(f, "active-mac.json"))).toBe(activeBefore);
          expect(await nightlyLog(f)).toContain("is not the selected target newer-src");
        });
      },
      TIMEOUT,
    );

    describe("rename migration", () => {
      const LEGACY_APP = "T3 Peach (Nightly).app";

      it(
        "moves an install under the older pre-rename name aside too",
        async () => {
          await withFixture(async (f) => {
            const olderApp = "T3 Code (Nightly).app";
            const olderInstalled = NodePath.join(f.apps, olderApp);
            await makeApp(olderInstalled, "old");
            await stageBuild(f);

            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await exists(olderInstalled)).toBe(false);
            expect(await build(stateFile(f, "legacy", olderApp))).toBe("old");
          });
        },
        TIMEOUT,
      );

      it(
        "renames pre-rename staged and previous copies and replaces the legacy install",
        async () => {
          await withFixture(async (f) => {
            const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
            await makeApp(legacyInstalled, "old");
            await makeApp(stateFile(f, "staged", LEGACY_APP), "new");
            await makeApp(stateFile(f, "previous", LEGACY_APP), "older");
            await writeJson(stateFile(f, "staged/receipt.json"), {
              source: "new-src",
              version: "1.0.1",
            });
            await writeJson(stateFile(f, "previous/receipt.json"), { source: "older-src" });
            await writeJson(stateFile(f, "selected.json"), { source: "new-src" });

            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            // finish_install removes the staged build it just installed.
            expect(await exists(stateFile(f, "staged"))).toBe(false);
            expect(await build(stateFile(f, "previous", APP))).toBe("older");
            expect(await exists(stateFile(f, "staged", LEGACY_APP))).toBe(false);
            expect(await exists(stateFile(f, "previous", LEGACY_APP))).toBe(false);
            expect(await exists(legacyInstalled)).toBe(false);
            expect(await build(f.installed)).toBe("new");
            expect(await nightlyLog(f)).toContain("renamed the staged");
            expect(await nightlyLog(f)).toContain("renamed the previous");
          });
        },
        TIMEOUT,
      );

      it(
        "keeps the legacy install until the renamed build is installed and the legacy app is not running",
        async () => {
          await withFixture(async (f) => {
            const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
            await makeApp(legacyInstalled, "old");
            await installOld(f);
            await stageBuild(f);
            await NodeFSP.writeFile(NodePath.join(f.root, "running"), "");

            await run(f, ["install"]);
            expect(await build(legacyInstalled)).toBe("old");
            expect(await exists(stateFile(f, "legacy"))).toBe(false);
            expect(await nightlyLog(f)).toContain("a legacy " + LEGACY_APP + " is running");

            await NodeFSP.rm(NodePath.join(f.root, "running"));
            await run(f, ["install"]);
            expect(await build(stateFile(f, "legacy", LEGACY_APP))).toBe("old");
            expect(await exists(legacyInstalled)).toBe(false);
          });
        },
        TIMEOUT,
      );

      it(
        "keeps a pre-rename install that the renamed build has not replaced yet",
        async () => {
          await withFixture(async (f) => {
            const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
            await makeApp(legacyInstalled, "old");
            await stageBuild(f);
            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await exists(legacyInstalled)).toBe(false);
            expect(await build(stateFile(f, "legacy", LEGACY_APP))).toBe("old");
          });
        },
        TIMEOUT,
      );
    });

    it(
      "removes the pre-rename transient install leftovers when it moves the legacy install aside",
      async () => {
        const LEGACY_APP = "T3 Code (Nightly).app";
        await withFixture(async (f) => {
          const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
          await makeApp(legacyInstalled, "old");
          await stageBuild(f);
          await makeApp(NodePath.join(f.apps, `.${LEGACY_APP}.installing`), "half-new");
          await makeApp(NodePath.join(f.apps, `.${LEGACY_APP}.replaced`), "old2");

          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await exists(NodePath.join(f.apps, `.${LEGACY_APP}.installing`))).toBe(false);
          expect(await exists(NodePath.join(f.apps, `.${LEGACY_APP}.replaced`))).toBe(false);
          expect(await build(stateFile(f, "legacy", LEGACY_APP))).toBe("old");
        });
      },
      TIMEOUT,
    );

    it(
      "does not roll a good legacy install back to the previous build on the first post-rename run",
      async () => {
        const LEGACY_APP = "T3 Code (Nightly).app";
        await withFixture(async (f) => {
          const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
          await makeApp(legacyInstalled, "old");
          await makeApp(stateFile(f, "previous", LEGACY_APP), "older");
          await writeJson(stateFile(f, "previous/receipt.json"), { source: "older-src" });
          await writeJson(stateFile(f, "active-mac.json"), { source: "current-src" });
          await writeJson(stateFile(f, "selected.json"), { source: "current-src" });

          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await build(legacyInstalled)).toBe("old");
          expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
            source: "current-src",
          });
          // No roll-back install and no missing-app alarm.
          expect(await exists(stateFile(f, "staged"))).toBe(false);
          expect(await calls(f, "osascript")).toEqual([]);
          expect(await nightlyLog(f)).not.toContain("was incomplete");
          expect(await nightlyLog(f)).not.toContain("no complete recovery copy");
        });
      },
      TIMEOUT,
    );

    it(
      "restores an interrupted new-name install beside a good legacy install and then installs",
      async () => {
        const LEGACY_APP = "T3 Code (Nightly).app";
        await withFixture(async (f) => {
          const legacyInstalled = NodePath.join(f.apps, LEGACY_APP);
          await makeApp(legacyInstalled, "old");
          // replace_app died between its two renames: the app it moved out is left
          // in the REPLACED dot dir and no app sits at INSTALLED.
          await makeApp(NodePath.join(f.apps, `.${APP}.replaced`), "current");
          await writeJson(stateFile(f, "replaced-receipt.json"), { source: "current-src" });
          await stageBuild(f);

          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          // The interrupted new-name build was restored, then the staged build
          // installed over it.
          expect(await build(f.installed)).toBe("new");
          expect(await build(stateFile(f, "previous", APP))).toBe("current");
          expect(await readJson(stateFile(f, "previous/receipt.json"))).toMatchObject({
            source: "current-src",
          });
        });
      },
      TIMEOUT,
    );

    describe("while T3 Peach is running", () => {
      it(
        "install leaves the staged build in place and logs that it waits",
        async () => {
          await withFixture(async (f) => {
            await installOld(f);
            await stageBuild(f);
            await NodeFSP.writeFile(NodePath.join(f.root, "running"), "");
            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("old");
            expect(await build(stateFile(f, "staged", APP))).toBe("new");
            expect(await exists(stateFile(f, "previous"))).toBe(false);
            expect(await nightlyLog(f)).toContain("waits for T3 Peach to quit");
            expect(await calls(f, "open")).toEqual([]);
          });
        },
        TIMEOUT,
      );

      it(
        "install --wait-for-quit waits for the app to quit, installs and reopens it",
        async () => {
          await withFixture(async (f) => {
            await installOld(f);
            await stageBuild(f);
            const marker = NodePath.join(f.root, "running");
            await NodeFSP.writeFile(marker, "");
            const pending = run(f, ["install", "--wait-for-quit"], {
              XPC_SERVICE_NAME: INSTALL_JOB,
            });
            // The script has entered its wait once it has asked pgrep.
            await pollUntil(
              async () => (await readText(NodePath.join(f.root, "pgrep.log"))) !== "",
              "the installer to start waiting",
            );
            // Several polls while the app is marked running: a premature install would show here.
            await pollUntil(
              async () =>
                (await readText(NodePath.join(f.root, "pgrep.log"))).split("\n").filter(Boolean)
                  .length >= 3,
              "the installer to keep waiting",
            );
            expect(await build(f.installed)).toBe("old");
            expect(await build(stateFile(f, "staged", APP))).toBe("new");
            expect(await calls(f, "open")).toEqual([]);

            await NodeFSP.rm(marker);
            const result = await pending;
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await exists(stateFile(f, "staged"))).toBe(false);
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
            });
            expect(await calls(f, "open")).toEqual([`open ${f.installed}`]);
            // The job is started on demand and stays loaded for the next install.
            expect(await calls(f, "launchctl")).toEqual([]);
          });
        },
        TIMEOUT,
      );

      it(
        "install --on-quit starts the waiting job from a LaunchAgent, never `launchctl submit`",
        async () => {
          await withFixture(async (f) => {
            const result = await run(f, ["install", "--on-quit"]);
            expect(result.code).toBe(0);
            const plist = await readText(
              NodePath.join(f.env.HOME!, "Library/LaunchAgents", `${INSTALL_JOB}.plist`),
            );
            expect(plist).toContain(`<key>Label</key><string>${INSTALL_JOB}</string>`);
            expect(plist).toContain(
              `exec /bin/bash "${f.env.T3FORK_REPO}/scripts/fork-nightly.sh" install --wait-for-quit`,
            );
            // A rehearsal's overrides reach the job, so it never touches real state.
            expect(plist).toContain(`<key>T3FORK_STATE</key><string>${f.state}</string>`);
            expect(plist).not.toContain("<key>RunAtLoad</key>");
            const domain = `gui/${process.getuid?.()}`;
            expect(await calls(f, "launchctl")).toEqual([
              `launchctl print ${domain}/${INSTALL_JOB}`,
              `launchctl bootout ${domain}/${INSTALL_JOB}`,
              `launchctl bootstrap ${domain} ${f.env.HOME}/Library/LaunchAgents/${INSTALL_JOB}.plist`,
              `launchctl kickstart ${domain}/${INSTALL_JOB}`,
            ]);
          });
        },
        TIMEOUT,
      );

      it.each([
        { name: "leaves the LaunchAgent alone", type: "LaunchAgent", replaced: false },
        { name: "replaces a job an older version submitted", type: "submitted", replaced: true },
      ])(
        "install --on-quit, while the job is already waiting, $name",
        async ({ type, replaced }) => {
          await withFixture(async (f) => {
            const plist = `${f.env.HOME}/Library/LaunchAgents/${INSTALL_JOB}.plist`;
            await NodeFSP.writeFile(
              NodePath.join(f.root, "job-state"),
              type === "LaunchAgent"
                ? `\tpath = ${plist}\n\ttype = LaunchAgent\n\tstate = running\n`
                : `\ttype = submitted\n\tstate = running\n`,
            );
            const result = await run(f, ["install", "--on-quit"]);
            expect(result.code).toBe(0);
            expect(result.stdout.includes("already waiting")).toBe(!replaced);
            const domain = `gui/${process.getuid?.()}`;
            expect(await calls(f, "launchctl")).toEqual([
              `launchctl print ${domain}/${INSTALL_JOB}`,
              ...(replaced
                ? [
                    `launchctl bootout ${domain}/${INSTALL_JOB}`,
                    `launchctl bootstrap ${domain} ${plist}`,
                    `launchctl kickstart ${domain}/${INSTALL_JOB}`,
                  ]
                : []),
            ]);
          });
        },
        TIMEOUT,
      );
    });

    it(
      "keeps its own file when its environment carries a run copy's variables",
      async () => {
        await withFixture(async (f) => {
          // An app the install job reopened passes its environment to every agent's run.
          const script = NodePath.join(f.root, "fork-nightly.sh");
          await NodeFSP.copyFile(SCRIPT, script);
          await execFile("bash", [script, "status"], {
            env: { ...f.env, T3FORK_FROM_COPY: script },
          });
          expect(await exists(script)).toBe(true);
          expect(
            (await NodeFSP.readdir(f.state)).filter((name) => name.startsWith("run.")),
          ).toEqual([]);
        });
      },
      TIMEOUT,
    );

    it(
      "is not blocked by a stale lock left by a dead process",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          const child = NodeChildProcess.spawn("true");
          await new Promise((resolve) => child.once("exit", resolve));
          await NodeFSP.mkdir(stateFile(f, "lock"));
          await NodeFSP.writeFile(stateFile(f, "lock/pid"), `${child.pid}\n`);
          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await exists(stateFile(f, "lock"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    describe("the install journal", () => {
      const journal = { source: "new-src", version: "1.0.1" };

      it.each([
        { name: "before the first rename", installedAbsent: false },
        { name: "between the two renames", installedAbsent: true },
      ])(
        "keeps the old app when the install was interrupted $name, then installs the staged build",
        async ({ installedAbsent }) => {
          await withFixture(async (f) => {
            await makeApp(INCOMING_DIR(f), "new");
            if (installedAbsent) await makeApp(REPLACED_DIR(f), "old");
            else await makeApp(f.installed, "old");
            await writeJson(stateFile(f, "active-mac.json"), { source: "old-src" });
            await writeJson(stateFile(f, "installing.json"), journal);
            await stageBuild(f, { invalid: true });

            const recovered = await run(f, ["install"]);
            expect(recovered.code).not.toBe(0);
            expect(await build(f.installed)).toBe("old");
            expect(await isComplete(f.installed)).toBe(true);
            expect(await exists(INCOMING_DIR(f))).toBe(false);
            expect(await exists(REPLACED_DIR(f))).toBe(false);
            expect(await exists(stateFile(f, "installing.json"))).toBe(false);
            expect(await readJson(stateFile(f, "active-mac.json"))).toEqual({ source: "old-src" });
            expect(await exists(stateFile(f, "staged/receipt.json"))).toBe(true);

            await NodeFSP.rm(stateFile(f, "staged", APP, "Contents/INVALID"));
            expect((await run(f, ["install"])).code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await build(stateFile(f, "previous", APP))).toBe("old");
            expect(await readJson(stateFile(f, "previous/receipt.json"))).toEqual({
              source: "old-src",
            });
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
              installedAt: expect.any(String),
            });
            expect(await exists(stateFile(f, "installing.json"))).toBe(false);
            expect(await exists(stateFile(f, "staged"))).toBe(false);
          });
        },
        TIMEOUT,
      );

      it(
        "finishes an install interrupted after both renames without copying again",
        async () => {
          await withFixture(async (f) => {
            await makeApp(f.installed, "new");
            await makeApp(REPLACED_DIR(f), "old");
            await writeJson(stateFile(f, "active-mac.json"), { source: "old-src", version: "0.9" });
            await writeJson(stateFile(f, "installing.json"), journal);
            await stageBuild(f);
            await makeApp(stateFile(f, "staged", APP), "staged-copy");

            const result = await run(f, ["install"]);
            expect(result.code).toBe(0);
            expect(await build(f.installed)).toBe("new");
            expect(await build(stateFile(f, "previous", APP))).toBe("old");
            expect(await readJson(stateFile(f, "previous/receipt.json"))).toEqual({
              source: "old-src",
              version: "0.9",
            });
            expect(await readJson(stateFile(f, "active-mac.json"))).toMatchObject({
              source: "new-src",
              version: "1.0.1",
              installedAt: expect.any(String),
            });
            expect(await exists(stateFile(f, "staged"))).toBe(false);
            expect(await exists(stateFile(f, "installing.json"))).toBe(false);
            expect(await exists(REPLACED_DIR(f))).toBe(false);
            expect(await exists(INCOMING_DIR(f))).toBe(false);
            expect(await nightlyLog(f)).toContain("finished the interrupted install");
          });
        },
        TIMEOUT,
      );
    });

    it(
      "takes over a lock that has no owner and is older than a minute",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          await NodeFSP.mkdir(stateFile(f, "lock"));
          await execFile("touch", ["-t", "202001010000", stateFile(f, "lock")]);
          const result = await run(f, ["install"]);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await exists(stateFile(f, "lock"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "skips a scheduled run while a fresh lock has no owner yet",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          await NodeFSP.mkdir(stateFile(f, "lock"));
          const result = await run(f, []);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await nightlyLog(f)).toContain("another run holds");
          expect(await exists(stateFile(f, "lock"))).toBe(true);
        });
      },
      TIMEOUT,
    );

    it(
      "holds a selected staged build while the VPS runtime's source is unknown",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          await writeJson(stateFile(f, "vps-unknown.json"), { source: "new-src" });
          const held = await run(f, ["install"]);
          expect(held.code).toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await build(stateFile(f, "staged", APP))).toBe("new");
          expect(await nightlyLog(f)).toContain("waits: the VPS runtime's source is unknown");

          await NodeFSP.rm(stateFile(f, "vps-unknown.json"));
          expect((await run(f, ["install"])).code).toBe(0);
          expect(await build(f.installed)).toBe("new");
          expect(await exists(stateFile(f, "staged"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "skips a scheduled run while a live process holds the lock",
      async () => {
        await withFixture(async (f) => {
          await installOld(f);
          await stageBuild(f);
          await NodeFSP.mkdir(stateFile(f, "lock"));
          await NodeFSP.writeFile(stateFile(f, "lock/pid"), `${process.pid}\n`);
          const result = await run(f, []);
          expect(result.code).toBe(0);
          expect(await build(f.installed)).toBe("old");
          expect(await nightlyLog(f)).toContain("another run holds");
          // The live holder's lock is left alone.
          expect(await readText(stateFile(f, "lock/pid"))).toBe(`${process.pid}\n`);
        });
      },
      TIMEOUT,
    );
  });

  describe("update attempts", () => {
    it(
      "dispatches an unclaimed attempt on a schedule, then blocks it after three deliveries",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const sha = await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");

          expect((await run(f, [])).code).toBe(0);
          const first = await curlCalls(f);
          expect(first).toHaveLength(1);
          expect(first[0]!.url).toBe(WEBHOOK);
          const attempt = await attemptOf(f, OLD_TAG);
          expect(first[0]!.body).toEqual({
            tag: OLD_TAG,
            sha,
            attempt: attempt.attempt,
            action: "update",
          });
          expect(attempt).toMatchObject({ phase: "dispatched", dispatches: 1, sha });
          // The selected build already holds the landed integration: nothing is built.
          await expectNoBuild(f);
          expect(await readJson(stateFile(f, "selected.json"))).toEqual({ source: head });

          // Soon after, the same attempt is not sent again.
          expect((await run(f, [])).code).toBe(0);
          expect(await curlCalls(f)).toHaveLength(1);

          // Once the redispatch interval elapses an unclaimed attempt is sent again.
          const zero = { T3FORK_REDISPATCH_SECONDS: "0" };
          await run(f, [], zero);
          expect(await curlCalls(f)).toHaveLength(2);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "dispatched", dispatches: 2 });
          await run(f, [], zero);
          expect(await curlCalls(f)).toHaveLength(3);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "dispatched", dispatches: 3 });

          // After the third delivery nobody has claimed it: blocked, no further calls.
          await run(f, [], zero);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            blocked: { kind: "evidence" },
          });
          await run(f, [], zero);
          expect(await curlCalls(f)).toHaveLength(3);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "blocked" });
          await expectNoBuild(f);
          // Every id in the deliveries is the same attempt.
          expect(new Set((await curlCalls(f)).map((c) => c.body.attempt)).size).toBe(1);
        });
      },
      TIMEOUT,
    );

    it(
      "records a failed webhook delivery and retries it on the next run",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          expect((await run(f, [], { T3_TEST_CURL: "fail" })).code).toBe(0);
          expect(await curlCalls(f)).toHaveLength(1);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "dispatch-failed",
            dispatches: 0,
          });
          expect(await nightlyLog(f)).toContain("Could not reach the t3-fork-rebase webhook");

          expect((await run(f, [])).code).toBe(0);
          const calls2 = await curlCalls(f);
          expect(calls2).toHaveLength(2);
          expect(calls2[1]!.body.attempt).toBe(calls2[0]!.body.attempt);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "dispatched", dispatches: 1 });
        });
      },
      TIMEOUT,
    );

    it(
      "refuses a second claimant, allows a take-over, and never redispatches a claimed attempt",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          const sha = await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");

          const a = await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          expect(a.code).toBe(0);
          expect(JSON.parse(a.stdout)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadA",
            sha,
          });
          const b = await run(f, ["attempt", OLD_TAG, "claim", "threadB"]);
          expect(b.code).toBe(3);
          expect(b.stderr).toContain("claimed by threadA");
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ claimedBy: "threadA" });
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadB", "--take-over"])).code).toBe(
            0,
          );
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadB",
          });

          // Hourly runs, even with a redispatch interval of zero, leave it alone, and
          // a newer upstream tag waits behind it.
          const zero = { T3FORK_REDISPATCH_SECONDS: "0" };
          await run(f, [], zero);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, [], zero);
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadB",
          });
          expect(await exists(stateFile(f, "attempts", `${NEW_TAG}.json`))).toBe(false);
          expect(await nightlyLog(f)).toContain(`upstream ${NEW_TAG} waits for attempt`);
        });
      },
      TIMEOUT,
    );

    it(
      "notifies once when a quiet claim holds back a newer upstream tag",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          const env = { T3FORK_REDISPATCH_SECONDS: "0" };
          await run(f, [], env);
          await run(f, [], env);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            quietNotified: true,
          });
          expect((await nightlyLog(f)).match(/has made no progress/g)).toHaveLength(1);
        });
      },
      TIMEOUT,
    );

    it(
      "notifies once when the claimed attempt for the newest tag goes quiet",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          const env = { T3FORK_REDISPATCH_SECONDS: "0" };
          await run(f, [], env);
          await run(f, [], env);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            quietNotified: true,
          });
          expect((await nightlyLog(f)).match(/has made no progress/g)).toHaveLength(1);
        });
      },
      TIMEOUT,
    );

    it(
      "keeps a publication block, and its retry route, when the update lands",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "attempts", `${BUILD_TAG}.json`), {
            tag: BUILD_TAG,
            sha: "0".repeat(40),
            attempt: `${BUILD_TAG}@1`,
            phase: "blocked",
            blocked: { kind: "publication", summary: "release archive missing" },
            dispatches: 1,
          });
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({
            phase: "blocked",
            blocked: { kind: "publication" },
          });
          await run(f, ["attempt", BUILD_TAG, "retry"]);
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          expect(await curlCalls(f)).toHaveLength(1);
        });
      },
      TIMEOUT,
    );

    it(
      "keeps an owner-decision block holding back a newer upstream tag across runs",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          const blocked = await run(f, [
            "attempt",
            OLD_TAG,
            "blocked",
            "owner-decision",
            "keep or drop the fork worker?",
          ]);
          expect(blocked.code).toBe(0);
          expect((await attemptOf(f, OLD_TAG)).blocked).toMatchObject({
            kind: "owner-decision",
            summary: "keep or drop the fork worker?",
          });
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          for (let i = 0; i < 3; i++) await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "blocked" });
          expect(await exists(stateFile(f, "attempts", `${NEW_TAG}.json`))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "lets a landed publication blocker retry while an older unlanded attempt holds",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          const landed = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "attempts", `${BUILD_TAG}.json`), {
            tag: BUILD_TAG,
            sha: landed.upstream,
            attempt: `${BUILD_TAG}@1`,
            phase: "landed",
            blocked: { kind: "publication", summary: "release archive missing" },
            dispatches: 1,
          });
          expect((await run(f, ["attempt", BUILD_TAG, "retry"])).code).toBe(0);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({ phase: "retry" });
        });
      },
      TIMEOUT,
    );

    it(
      "keeps an owner decision through a delayed duplicate claim; only its holder or retry resumes it",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await run(f, ["attempt", OLD_TAG, "blocked", "owner-decision", "keep the fork worker?"]);
          const before = await attemptOf(f, OLD_TAG);

          for (const args of [["threadB"], ["threadB", "--take-over"]]) {
            const late = await run(f, ["attempt", OLD_TAG, "claim", ...args]);
            expect(late.code).toBe(3);
            expect(late.stderr).toContain("keep the fork worker?");
          }
          expect(await attemptOf(f, OLD_TAG)).toEqual(before);
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            claimedBy: "threadA",
            blocked: { kind: "owner-decision", summary: "keep the fork worker?" },
          });

          // Henry answers in the holding thread, which resumes the same attempt.
          const resumed = await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          expect(resumed.code).toBe(0);
          const after = await attemptOf(f, OLD_TAG);
          expect(after).toMatchObject({ phase: "claimed", claimedBy: "threadA" });
          expect(after.attempt).toBe(before.attempt);
          expect(after.blocked).toBeUndefined();
        });
      },
      TIMEOUT,
    );

    it(
      "refuses another thread's ordinary claim of a blocked attempt but allows a take-over",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await run(f, ["attempt", OLD_TAG, "blocked", "checks", "typecheck fails"]);
          const late = await run(f, ["attempt", OLD_TAG, "claim", "threadB"]);
          expect(late.code).toBe(3);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            claimedBy: "threadA",
          });
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadB", "--take-over"])).code).toBe(
            0,
          );
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadB",
          });
        });
      },
      TIMEOUT,
    );

    it(
      "refuses a late claim of a superseded attempt and lets the newer tag be claimed",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, []);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, []);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "superseded" });

          const late = await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          expect(late.code).toBe(3);
          expect(late.stderr).toContain(`superseded by ${NEW_TAG}`);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "superseded" });
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"])).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses another tag's claim while an update is claimed or waits for an owner decision",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");

          const whileClaimed = await run(f, ["attempt", NEW_TAG, "claim", "threadB"]);
          expect(whileClaimed.code).toBe(3);
          expect(whileClaimed.stderr).toContain("threadA");

          await run(f, ["attempt", OLD_TAG, "blocked", "owner-decision", "keep the fork worker?"]);
          const manual = await run(f, ["attempt", NEW_TAG, "claim", "threadB"]);
          expect(manual.code).toBe(3);
          expect(await attemptOf(f, NEW_TAG)).not.toMatchObject({ phase: "claimed" });
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            blocked: { kind: "owner-decision" },
          });

          // Henry answers by retrying the older attempt, which then supersedes cleanly.
          expect((await run(f, ["attempt", OLD_TAG, "retry"])).code).toBe(0);
          await run(f, []);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "superseded" });
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"])).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses a retry of a newer tag while an older attempt holds, and lets the holder's retry release it",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");

          for (const hold of [[], ["blocked", "owner-decision", "keep the fork worker?"]]) {
            if (hold.length > 0) await run(f, ["attempt", OLD_TAG, ...hold]);
            const jump = await run(f, ["attempt", NEW_TAG, "retry"]);
            expect(jump.code).toBe(3);
            expect(jump.stderr).toContain(OLD_TAG);
            expect(await exists(stateFile(f, "attempts", `${NEW_TAG}.json`))).toBe(false);
          }
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            claimedBy: "threadA",
          });

          expect((await run(f, ["attempt", OLD_TAG, "retry"])).code).toBe(0);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "retry" });
          await run(f, []);
          expect((await run(f, ["attempt", NEW_TAG, "retry"])).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses an owner decision from a superseded attempt, so two attempts cannot hold each other",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, []);
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          // The older claim goes stale with its release, so the newer tag supersedes it.
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0", T3_TEST_ABSENT: `${OLD_TAG}/` });
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "superseded",
            supersededBy: NEW_TAG,
          });
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"])).code).toBe(0);

          // The superseded attempt's thread reports its block late: it no longer holds
          // the update, so the block is refused rather than deadlocking both attempts.
          const late = await run(f, [
            "attempt",
            OLD_TAG,
            "blocked",
            "owner-decision",
            "keep the fork worker?",
          ]);
          expect(late.code).toBe(3);
          expect(late.stderr).toContain(`superseded by ${NEW_TAG}`);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "superseded" });

          // The newer attempt is still the update in flight, and it can move on.
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"])).code).toBe(0);
          expect((await run(f, ["attempt", NEW_TAG, "retry"])).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses a block on an attempt another thread's claim holds the update over",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          // The older release vanishes, so its claim holds nothing back and the newer
          // tag is claimed while the older one is still recorded as claimed.
          const absent = { T3_TEST_ABSENT: `${OLD_TAG}/` };
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"], absent)).code).toBe(0);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadA",
          });

          const late = await run(f, [
            "attempt",
            OLD_TAG,
            "blocked",
            "owner-decision",
            "keep the fork worker?",
          ]);
          expect(late.code).toBe(3);
          expect(late.stderr).toContain(NEW_TAG);
          expect(late.stderr).toContain("threadB");
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "claimed" });
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadB"], absent)).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses an owner decision on a landed attempt but keeps recording its build blocks",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
          // The agent lands the merge, records it, and then builds it.
          const work = NodePath.join(f.root, "work");
          await git(work, ["checkout", "-q", "t3peach"]);
          await git(
            work,
            ["merge", "-q", "--no-ff", "-m", `Merge ${OLD_TAG}`, OLD_TAG],
            "2099-01-03T00:00:00Z",
          );
          const head = await git(work, ["rev-parse", "HEAD"]);
          await git(work, ["push", "-q", f.origin, "t3peach"]);
          expect((await run(f, ["attempt", OLD_TAG, "landed", "op-1", head])).code).toBe(0);

          const decision = await run(f, [
            "attempt",
            OLD_TAG,
            "blocked",
            "owner-decision",
            "keep the fork worker?",
          ]);
          expect(decision.code).toBe(3);
          expect(decision.stderr).toContain("landed");
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "landed" });

          const missing = await run(f, [
            "attempt",
            OLD_TAG,
            "blocked",
            "evidence",
            `the upstream release of ${OLD_TAG} lacks SHA256SUMS`,
          ]);
          expect(missing.code).toBe(0);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "blocked",
            blocked: { kind: "evidence" },
          });
        });
      },
      TIMEOUT,
    );

    it(
      "refuses an owner decision on a recorded landing the updater clone cannot yet see on origin",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
          const work = NodePath.join(f.root, "work");
          await git(work, ["checkout", "-q", "t3peach"]);
          await git(
            work,
            ["merge", "-q", "--no-ff", "-m", `Merge ${OLD_TAG}`, OLD_TAG],
            "2099-01-03T00:00:00Z",
          );
          const head = await git(work, ["rev-parse", "HEAD"]);
          // Not pushed: origin/t3peach in the updater clone does not contain the landing.
          expect((await run(f, ["attempt", OLD_TAG, "landed", "op-1", head])).code).toBe(0);

          const decision = await run(f, ["attempt", OLD_TAG, "blocked", "owner-decision", "keep?"]);
          expect(decision.code).toBe(3);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "landed" });

          expect(
            (await run(f, ["attempt", OLD_TAG, "blocked", "evidence", "no SHA256SUMS"])).code,
          ).toBe(0);
          const again = await run(f, ["attempt", OLD_TAG, "blocked", "owner-decision", "keep?"]);
          expect(again.code).toBe(3);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ blocked: { kind: "evidence" } });
        });
      },
      TIMEOUT,
    );

    it(
      "keeps a non-owner block with its holder through a claim, and an owner decision through a take-over",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          const stalled = await run(f, ["attempt", OLD_TAG, "claim", "threadB"]);
          expect(stalled.code).toBe(3);
          expect(stalled.stderr).toContain("claimed by threadA");
          await run(f, ["attempt", OLD_TAG, "blocked", "evidence", "no release notes"]);
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadB"])).code).toBe(3);
          await run(f, ["attempt", OLD_TAG, "blocked", "owner-decision", "keep the fork worker?"]);
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadB", "--take-over"])).code).toBe(
            3,
          );
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ claimedBy: "threadA" });
        });
      },
      TIMEOUT,
    );

    it(
      "lets a landed attempt's build be claimed while an update is in flight",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, []);
          expect((await run(f, ["attempt", NEW_TAG, "claim", "threadA"])).code).toBe(0);
          const build = await run(f, ["attempt", BUILD_TAG, "claim", "threadB"]);
          expect(build.code).toBe(0);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadB",
          });
        });
      },
      TIMEOUT,
    );

    it(
      "lets a newer tag supersede an attempt blocked on checks",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          expect(
            (await run(f, ["attempt", OLD_TAG, "blocked", "checks", "typecheck fails"])).code,
          ).toBe(0);
          const newSha = await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          expect((await run(f, [])).code).toBe(0);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "superseded",
            supersededBy: NEW_TAG,
          });
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "dispatched", sha: newSha });
          const sent = await curlCalls(f);
          expect(sent).toHaveLength(1);
          expect(sent[0]!.body).toMatchObject({ tag: NEW_TAG, sha: newSha });
        });
      },
      TIMEOUT,
    );

    it(
      "dispatches a blocked attempt again only after retry",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await run(f, ["attempt", OLD_TAG, "blocked", "publication", "landing rejected"]);
          const zero = { T3FORK_REDISPATCH_SECONDS: "0" };
          await run(f, [], zero);
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "blocked" });

          const retried = await run(f, ["attempt", OLD_TAG, "retry"]);
          expect(retried.code).toBe(0);
          const after = await attemptOf(f, OLD_TAG);
          expect(after).toMatchObject({ phase: "retry", dispatches: 0 });
          expect(after.blocked).toBeUndefined();
          expect(after.claimedBy).toBeUndefined();
          await run(f, []);
          const sent = await curlCalls(f);
          expect(sent).toHaveLength(1);
          expect(sent[0]!.body).toMatchObject({ tag: OLD_TAG });
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "dispatched", dispatches: 1 });
        });
      },
      TIMEOUT,
    );

    it(
      "rejects an unknown blocked kind",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          const result = await run(f, ["attempt", OLD_TAG, "blocked", "whim", "no"]);
          expect(result.code).toBe(2);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "new" });
        });
      },
      TIMEOUT,
    );

    it(
      "stops dispatching once the landed branch contains the tag",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, [], {});
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "dispatched" });
          // The agent lands the merge of the tag: t3peach now contains it.
          const work = NodePath.join(f.root, "work");
          await git(work, ["checkout", "-q", "t3peach"]);
          await git(
            work,
            ["merge", "-q", "--no-ff", "-m", `Merge ${OLD_TAG}`, OLD_TAG],
            "2099-01-03T00:00:00Z",
          );
          const merged = await git(work, ["rev-parse", "HEAD"]);
          await git(work, ["push", "-q", f.origin, "t3peach"]);
          await writeJson(stateFile(f, "selected.json"), { source: merged });
          await run(f, [], { T3FORK_REDISPATCH_SECONDS: "0" });
          // A contained tag needs no attempt, and nothing is dispatched again.
          expect(await curlCalls(f)).toHaveLength(1);
          await expectNoBuild(f);
        });
      },
      TIMEOUT,
    );

    it(
      "waits for a manual run, notifying once, when no webhook is configured",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await NodeFSP.rm(stateFile(f, "rebase-webhook-url"));
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          const zero = { T3FORK_REDISPATCH_SECONDS: "0" };
          for (let i = 0; i < 3; i++) expect((await run(f, [], zero)).code).toBe(0);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "awaiting-manual",
            dispatches: 0,
          });
          expect(await curlCalls(f)).toEqual([]);
          const notes = (await calls(f, "osascript")).filter((line) =>
            line.includes("needs the t3-fork-rebase skill run by hand"),
          );
          expect(notes).toHaveLength(1);
          const logged = (await nightlyLog(f)).split("\n").filter((l) => l.includes("run by hand"));
          expect(logged).toHaveLength(1);

          // Configuring the webhook and retrying dispatches it.
          await NodeFSP.writeFile(stateFile(f, "rebase-webhook-url"), `${WEBHOOK}\n`);
          await run(f, ["attempt", OLD_TAG, "retry"]);
          await run(f, [], zero);
          expect(await curlCalls(f)).toHaveLength(1);
        });
      },
      TIMEOUT,
    );
  });
  describe("release eligibility", () => {
    const zero = { T3FORK_REDISPATCH_SECONDS: "0" };
    const noRelease = (tag: string) => ({ T3_TEST_ABSENT: `${tag}/` });

    it(
      "dispatches neither a tag-only nor an incomplete release, and names what is absent",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          expect((await run(f, [], noRelease(OLD_TAG))).code).toBe(0);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "unpublished",
            unavailable: `upstream has no published release for ${OLD_TAG} (no SHA256SUMS)`,
          });

          await run(f, [], { T3_TEST_ABSENT: `${OLD_TAG}/t3-` });
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "unpublished",
            unavailable: `the upstream release of ${OLD_TAG} lacks t3-${OLD_TAG.slice(1)}-linux-x64.tar.gz`,
          });
          await expectNoBuild(f);

          // Once the release is complete the same tag is dispatched as a normal update.
          await run(f, []);
          expect(await curlCalls(f)).toHaveLength(1);
          const attempt = await attemptOf(f, OLD_TAG);
          expect(attempt).toMatchObject({ phase: "dispatched", dispatches: 1 });
          expect(attempt).not.toHaveProperty("unavailable");
        });
      },
      TIMEOUT,
    );

    it(
      "selects the published release past a newer tag that has none, and past a stale claim",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          const newSha = await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          // The newest tag has no release: the older, complete one goes out.
          await run(f, [], noRelease(NEW_TAG));
          const sent = await curlCalls(f);
          expect(sent.map((c) => c.body.tag)).toEqual([OLD_TAG]);
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "unpublished", sha: newSha });
        });
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          // An agent claimed the older tag, whose release is missing.
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, [], { ...zero, ...noRelease(OLD_TAG) });
          const sent = await curlCalls(f);
          expect(sent.map((c) => c.body.tag)).toEqual([NEW_TAG]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "superseded",
            supersededBy: NEW_TAG,
          });
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "dispatched" });
        });
      },
      TIMEOUT,
    );

    it(
      "keeps a newer dispatched tag whose release vanished, and sends it again once it returns",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          const newSha = await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, []);
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "dispatched" });
          // The newer release loses its assets: the older, complete tag goes out.
          await run(f, [], noRelease(NEW_TAG));
          expect((await curlCalls(f)).map((c) => c.body.tag)).toEqual([NEW_TAG, OLD_TAG]);
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "dispatched", sha: newSha });
          // Its release is complete again: the newer tag is sent once more.
          await run(f, [], zero);
          expect((await curlCalls(f)).map((c) => c.body.tag)).toEqual([NEW_TAG, OLD_TAG, NEW_TAG]);
          expect(await attemptOf(f, NEW_TAG)).toMatchObject({ phase: "dispatched", dispatches: 2 });
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({
            phase: "superseded",
            supersededBy: NEW_TAG,
          });
        });
      },
      TIMEOUT,
    );

    it(
      "ends a skipped tag's skip once a newer tag's update has merged it",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, [], noRelease(OLD_TAG));
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "unpublished" });
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, [], noRelease(OLD_TAG));
          expect((await curlCalls(f)).map((c) => c.body.tag)).toEqual([NEW_TAG]);
          // The newer tag's update lands: its merge carries the skipped tag's commit too.
          const work = NodePath.join(f.root, "work");
          await git(work, ["checkout", "-q", "t3peach"]);
          await git(
            work,
            ["merge", "-q", "--no-ff", "-m", "Merge update", "main"],
            "2099-01-03T00:00:00Z",
          );
          await git(work, ["push", "-q", f.origin, "t3peach"]);
          await run(f, [], noRelease(OLD_TAG));
          const attempt = await attemptOf(f, OLD_TAG);
          expect(attempt).toMatchObject({ phase: "landed" });
          expect(attempt).not.toHaveProperty("unavailable");
        });
      },
      TIMEOUT,
    );

    it(
      "leaves the head retryable when the VPS build finds its release incomplete",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const tag = "v0.1.0-nightly.20260103.1";
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", tag, "side"]);
          await git(work, ["push", "-q", f.upstream, tag]);
          const refused = await run(f, ["build", "--rev", head, "--recovery", "roll back"], {
            T3FORK_VPS: "vps",
            T3_TEST_VPS_STATUS: "3",
          });
          expect(refused.code).not.toBe(0);
          expect(await nightlyLog(f)).toContain(
            `Not building ${head}: the upstream release v1 has no downloadable SHA256SUMS`,
          );
          expect(await exists(stateFile(f, "build-failed.json"))).toBe(false);
          expect(await attemptOf(f, tag)).toMatchObject({
            unavailable: expect.stringContaining("no downloadable SHA256SUMS"),
          });
          expect(await exists(stateFile(f, "selected.json.tmp"))).toBe(false);
        });
        // Any other VPS failure is a failed build of that head.
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const tag = "v0.1.0-nightly.20260103.1";
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", tag, "side"]);
          await git(work, ["push", "-q", f.upstream, tag]);
          await run(f, ["build", "--rev", head, "--recovery", "roll back"], {
            T3FORK_VPS: "vps",
            T3_TEST_VPS_STATUS: "1",
          });
          expect(await readJson(stateFile(f, "build-failed.json"))).toMatchObject({ source: head });
        });
      },
      TIMEOUT,
    );

    it(
      "still holds a newer tag behind a claim on a published release",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await run(f, ["attempt", OLD_TAG, "claim", "threadA"]);
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, OLD_TAG)).toMatchObject({ phase: "claimed" });
        });
      },
      TIMEOUT,
    );

    it(
      "dispatches nothing, and records nothing, when the release cannot be checked",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          await publishUpstreamTag(f, NEW_TAG, "2099-01-02T00:00:00Z");
          expect((await run(f, [], { T3_TEST_PROBE: "fail" })).code).toBe(0);
          expect(await curlCalls(f)).toEqual([]);
          expect(await exists(stateFile(f, "attempts"))).toBe(true);
          expect(await exists(stateFile(f, "attempts", `${OLD_TAG}.json`))).toBe(false);
          expect(await exists(stateFile(f, "attempts", `${NEW_TAG}.json`))).toBe(false);
          expect(await nightlyLog(f)).toContain(`could not check the release of ${NEW_TAG}`);
        });
      },
      TIMEOUT,
    );

    it(
      "refuses to claim an update whose release is not published",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await publishUpstreamTag(f, OLD_TAG, "2099-01-01T00:00:00Z");
          const refused = await run(
            f,
            ["attempt", OLD_TAG, "claim", "threadA"],
            noRelease(OLD_TAG),
          );
          expect(refused.code).toBe(3);
          expect(refused.stderr).toContain(`no published release for ${OLD_TAG}`);
          expect((await run(f, ["attempt", OLD_TAG, "claim", "threadA"])).code).toBe(0);
        });
      },
      TIMEOUT,
    );

    it(
      "requests the build of a landed integration only once its release is published",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          const { upstream } = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await run(f, [], { ...zero, T3_TEST_ABSENT: `${BUILD_TAG}/t3-` });
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({
            phase: "landed",
            sha: upstream,
            unavailable: `the upstream release of ${BUILD_TAG} lacks t3-${BUILD_TAG.slice(1)}-linux-x64.tar.gz`,
          });
          await run(f, [], zero);
          expect((await curlCalls(f)).map((c) => c.body.action)).toEqual(["build"]);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({ phase: "build-requested" });
          expect(await attemptOf(f, BUILD_TAG)).not.toHaveProperty("unavailable");
        });
      },
      TIMEOUT,
    );

    it(
      "does not build a tag whose release has no assets, and keeps the head retryable",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const tag = "v0.1.0-nightly.20260103.1";
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", tag, "side"]);
          await git(work, ["push", "-q", f.upstream, tag]);
          const refused = await run(
            f,
            ["build", "--rev", head, "--recovery", "roll back"],
            noRelease(tag),
          );
          expect(refused.code).not.toBe(0);
          expect(await nightlyLog(f)).toContain(
            `Not building ${head}: upstream has no published release for ${tag}`,
          );
          expect(await calls(f, "vp")).toEqual([]);
          expect(await exists(stateFile(f, "build-failed.json"))).toBe(false);
          expect(await exists(stateFile(f, "build-started"))).toBe(false);
          expect(await exists(stateFile(f, "attempts", `${tag}.json`))).toBe(false);
        });
      },
      TIMEOUT,
    );
  });

  describe("build requests", () => {
    const zero = { T3FORK_REDISPATCH_SECONDS: "0" };

    async function requested(f: Fixture) {
      return (await curlCalls(f)).filter((c) => c.body.action === "build");
    }

    it(
      "asks the agent to build a landed integration once, and never builds itself",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          const { upstream } = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          expect((await run(f, [])).code).toBe(0);
          const sent = await curlCalls(f);
          expect(sent).toHaveLength(1);
          const attempt = await attemptOf(f, BUILD_TAG);
          expect(sent[0]!.body).toEqual({
            tag: BUILD_TAG,
            sha: upstream,
            attempt: attempt.attempt,
            action: "build",
          });
          expect(attempt).toMatchObject({ phase: "build-requested", dispatches: 1 });
          expect((await run(f, [])).code).toBe(0);
          expect(await curlCalls(f)).toHaveLength(1);
          await expectNoBuild(f);
          expect(await exists(stateFile(f, "staged"))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "requests a build when no build was ever selected",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          await NodeFSP.rm(stateFile(f, "selected.json"));
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await run(f, []);
          expect(await requested(f)).toHaveLength(1);
          await expectNoBuild(f);
        });
      },
      TIMEOUT,
    );

    it(
      "resumes a build whose staging failed, but not one that reached the Mac",
      async () => {
        await withFixture(async (f) => {
          await seedRepos(f);
          const { head } = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "selected.json"), { source: head });
          // Selected, nothing staged, and the Mac still runs another source.
          await run(f, []);
          expect(await requested(f)).toHaveLength(1);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({ phase: "build-requested" });
        });
        await withFixture(async (f) => {
          await seedRepos(f);
          const { head } = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "selected.json"), { source: head });
          await writeJson(stateFile(f, "active-mac.json"), { source: head });
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await exists(stateFile(f, "attempts", `${BUILD_TAG}.json`))).toBe(false);
        });
      },
      TIMEOUT,
    );

    it(
      "does not request a build while a recovery target is selected",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "selected.json"), { source: head, recovery: "bad build" });
          await run(f, [], zero);
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await nightlyLog(f)).toContain(`recovery target ${head} stays selected`);
        });
      },
      TIMEOUT,
    );

    it(
      "does not retry a failed build of the landed head, but builds a newer one",
      async () => {
        await withFixture(async (f) => {
          const oldHead = await seedRepos(f);
          const { head } = await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(stateFile(f, "build-failed.json"), { source: head, reason: "x" });
          await run(f, [], zero);
          expect(await curlCalls(f)).toEqual([]);
          expect(await nightlyLog(f)).toContain(`the build of ${head} failed before`);

          await writeJson(stateFile(f, "build-failed.json"), { source: oldHead, reason: "x" });
          await run(f, [], zero);
          expect(await requested(f)).toHaveLength(1);
        });
      },
      TIMEOUT,
    );

    it(
      "never takes over a quiet claim on a landed update; it notifies once and retry resumes it",
      async () => {
        const claimed = (epoch: number) => ({
          tag: BUILD_TAG,
          sha: "0".repeat(40),
          attempt: `${BUILD_TAG}@1`,
          phase: "claimed",
          claimedBy: "threadA",
          dispatches: 1,
          updatedEpoch: epoch,
        });
        const env = { T3FORK_REDISPATCH_SECONDS: "5" };
        await withFixture(async (f) => {
          await seedRepos(f);
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(
            stateFile(f, "attempts", `${BUILD_TAG}.json`),
            claimed(Math.floor(Date.now() / 1000) - 600),
          );
          await run(f, [], env);
          await run(f, [], env);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({
            phase: "claimed",
            claimedBy: "threadA",
            quietNotified: true,
          });
          const log = await nightlyLog(f);
          expect(log.match(/has made no progress/g)).toHaveLength(1);
          await run(f, ["attempt", BUILD_TAG, "retry"]);
          await run(f, [], env);
          expect(await requested(f)).toHaveLength(1);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({ phase: "build-requested" });
        });
        await withFixture(async (f) => {
          await seedRepos(f);
          await landIntegration(f, BUILD_TAG, "2026-02-01T00:00:00Z");
          await writeJson(
            stateFile(f, "attempts", `${BUILD_TAG}.json`),
            claimed(Math.floor(Date.now() / 1000) + 3600),
          );
          await run(f, [], env);
          expect(await curlCalls(f)).toEqual([]);
          expect(await attemptOf(f, BUILD_TAG)).toMatchObject({ phase: "claimed" });
        });
      },
      TIMEOUT,
    );
  });

  describe("build selection", () => {
    it(
      "refuses source from before upstream receipts unless it is an explicit recovery target",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", "v0.1.0-nightly.20260103.1", "side"]);
          await git(work, ["push", "-q", f.upstream, "v0.1.0-nightly.20260103.1"]);

          const refused = await run(f, ["build", "--rev", head]);
          expect(refused.code).not.toBe(0);
          expect(await readJson(stateFile(f, "build-failed.json"))).toMatchObject({
            source: head,
            reason: expect.stringContaining("needs --recovery"),
          });
          expect(await calls(f, "vp")).toEqual([]);

          const recovery = await run(f, ["build", "--rev", head, "--recovery", "roll back"]);
          expect(recovery.code).not.toBe(0);
          expect(await nightlyLog(f)).toContain(
            `building 0.1.0-nightly.20260103.1 from ${head} (predates upstream receipts; recovery: roll back)`,
          );
          expect(await readJson(stateFile(f, "build-failed.json"))).toMatchObject({
            source: head,
            reason: "the app build failed",
          });
          expect(await readJson(stateFile(f, "selected.json"))).toEqual({ source: head });
        });
      },
      TIMEOUT,
    );

    it(
      "gives the app build the public Connect values when the clone has no .env",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", "v0.1.0-nightly.20260103.1", "side"]);
          await git(work, ["push", "-q", f.upstream, "v0.1.0-nightly.20260103.1"]);

          await run(f, ["build", "--rev", head, "--recovery", "roll back"]);
          expect(await calls(f, "vp")).toEqual(["vp i"]);
          expect(await readText(NodePath.join(f.root, "env-at-vp"))).toBe(CONNECT_ENV);
        });
      },
      TIMEOUT,
    );

    it(
      "refreshes the .env it created from a newer .env.example but never one that was edited",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", "v0.1.0-nightly.20260103.1", "side"]);
          await git(work, ["push", "-q", f.upstream, "v0.1.0-nightly.20260103.1"]);
          const envAtBuild = () => readText(NodePath.join(f.root, "env-at-vp"));
          // Lands a commit on t3peach that changes the example, and returns it.
          const landExample = async (content: string) => {
            await git(work, ["checkout", "-q", "t3peach"]);
            await NodeFSP.writeFile(NodePath.join(work, ".env.example"), content);
            await git(work, ["commit", "-q", "-am", "example"], "2026-01-05T00:00:00Z");
            await git(work, ["push", "-q", f.origin, "t3peach"]);
            return git(work, ["rev-parse", "t3peach"]);
          };

          await run(f, ["build", "--rev", head, "--recovery", "roll back"]);
          expect(await envAtBuild()).toBe(CONNECT_ENV);

          const refreshed = "T3CODE_RELAY_URL=https://relay.next\n";
          await run(f, ["build", "--rev", await landExample(refreshed), "--recovery", "roll back"]);
          expect(await envAtBuild()).toBe(refreshed);

          const override = "T3CODE_RELAY_URL=https://relay.override\n";
          await NodeFSP.writeFile(NodePath.join(f.root, "clone", ".env"), override);
          const latest = await landExample("T3CODE_RELAY_URL=https://relay.latest\n");
          await run(f, ["build", "--rev", latest, "--recovery", "roll back"]);
          expect(await envAtBuild()).toBe(override);
        });
      },
      TIMEOUT,
    );

    it(
      "leaves an existing .env alone so a deliberate override wins",
      async () => {
        await withFixture(async (f) => {
          const head = await seedRepos(f);
          const work = NodePath.join(f.root, "work");
          await git(work, ["tag", "v0.1.0-nightly.20260103.1", "side"]);
          await git(work, ["push", "-q", f.upstream, "v0.1.0-nightly.20260103.1"]);
          // The refused build still clones, so the override can be placed before the next one.
          await run(f, ["build", "--rev", head]);
          const override = "T3CODE_RELAY_URL=https://relay.override\n";
          await NodeFSP.writeFile(NodePath.join(f.root, "clone", ".env"), override);

          await run(f, ["build", "--rev", head, "--recovery", "roll back"]);
          expect(await readText(NodePath.join(f.root, "env-at-vp"))).toBe(override);
        });
      },
      TIMEOUT,
    );
  });
});
