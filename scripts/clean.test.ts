// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway trees and runs the real clean CLI over them.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const CLEAN = NodePath.join(import.meta.dirname, "clean.ts");

// Everything the command must remove, including the per-package trees the old `rm -rf`
// globs never reached and a stale generated bin inside a removed tree.
const REMOVED = [
  "node_modules/.pnpm/stale",
  "apps/web/node_modules/.bin/tsc",
  "apps/server/node_modules/stale",
  "apps/server/dist/bundle",
  "apps/server/dist-electron/app",
  "apps/desktop/.vite-plus/cache",
  "packages/shared/node_modules/stale",
  "packages/shared/dist/bundle",
  "infra/relay/node_modules/stale",
  "oxlint-plugin-t3code/node_modules/stale",
  "scripts/node_modules/stale",
  ".vite-plus/cache",
];

// Source, configuration and runtime state the command must never touch.
const KEPT = [
  "pnpm-workspace.yaml",
  ".env",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/web/src/index.ts",
  "apps/server/src/server.ts",
  "infra/relay/src/worker.ts",
  "scripts/fork-nightly.sh",
  ".t3/userdata/statev2.sqlite",
];

async function fixture(files: ReadonlyArray<string>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-clean-")),
  );
  for (const file of files) {
    const path = NodePath.join(root, file);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, `${file}\n`);
  }
  await NodeFSP.mkdir(NodePath.join(root, "scripts"), { recursive: true });
  await NodeFSP.copyFile(CLEAN, NodePath.join(root, "scripts/clean.ts"));
  return root;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function clean(root: string): Promise<RunResult> {
  try {
    const result = await execFile("node", [NodePath.join(root, "scripts/clean.ts")], {
      cwd: NodeOS.tmpdir(),
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

it("removes every generated tree and leaves source, configuration and runtime state", async () => {
  const root = await fixture([...REMOVED, ...KEPT]);
  const outside = await fixture(["node_modules/stale"]);
  // A package whose node_modules is a link: the link goes, what it points at stays.
  await NodeFSP.symlink(outside, NodePath.join(root, "apps/mobile/node_modules"));
  try {
    expect((await clean(root)).code, "exit code").toBe(0);
    for (const removed of [
      ...REMOVED,
      "node_modules",
      "apps/web/node_modules",
      "packages/shared/node_modules",
      "infra/relay/node_modules",
      "oxlint-plugin-t3code/node_modules",
      "scripts/node_modules",
      "apps/server/dist",
      "apps/server/dist-electron",
      "apps/desktop/.vite-plus",
      ".vite-plus",
      "apps/mobile/node_modules",
    ]) {
      expect(await exists(NodePath.join(root, removed)), `${removed} removed`).toBe(false);
    }
    for (const kept of KEPT) {
      expect(await exists(NodePath.join(root, kept)), `${kept} kept`).toBe(true);
    }
    expect(await exists(NodePath.join(outside, "node_modules/stale"))).toBe(true);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.rm(outside, { recursive: true, force: true });
  }
});

it("is idempotent on a tree that holds nothing generated", async () => {
  const root = await fixture([...KEPT]);
  try {
    expect((await clean(root)).code).toBe(0);
    expect((await clean(root)).code).toBe(0);
    for (const kept of KEPT) {
      expect(await exists(NodePath.join(root, kept)), `${kept} kept`).toBe(true);
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses a directory that is not a repository root", async () => {
  const root = await fixture(["apps/web/node_modules/stale"]);
  try {
    const refused = await clean(root);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("pnpm-workspace.yaml");
    expect(await exists(NodePath.join(root, "apps/web/node_modules/stale"))).toBe(true);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
