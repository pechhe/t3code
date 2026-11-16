// @effect-diagnostics nodeBuiltinImport:off - Real Git and jj fixtures for updater checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { conflictFiles, reconciliationFiles, requireRepositoryNode } from "./fork-reconcile.ts";

function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-reconcile-scratch"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Fixture",
        GIT_CONFIG_KEY_1: "user.email",
        GIT_CONFIG_VALUE_1: "fixture@example.invalid",
        GIT_CONFIG_KEY_2: "commit.gpgsign",
        GIT_CONFIG_VALUE_2: "false",
      },
    }).trim();
  const write = (file: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(dir, file), content);
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  write("package.json", JSON.stringify({ engines: { node: process.versions.node } }));
  write("conflict.ts", "base\n");
  const base = commit();
  write("conflict.ts", "upstream\n");
  write("upstream-only.ts", "upstream\n");
  const upstream = commit();
  git("checkout", "--detach", base);
  write("conflict.ts", "fork\n");
  const fork = commit();
  return {
    dir,
    git,
    write,
    commit,
    fork,
    upstream,
    [Symbol.dispose]() {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("reports conflicts without changing the working tree, index or branch", () => {
  using f = fixture();
  f.write("untracked", "leave me\n");
  const before = [
    f.git("status", "--porcelain"),
    f.git("rev-parse", "HEAD"),
    NodeFS.readFileSync(NodePath.join(f.dir, ".git/index")),
  ];
  expect(conflictFiles(f.dir, f.fork, f.upstream)).toEqual(["conflict.ts"]);
  const printed = NodeChildProcess.execFileSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, "fork-reconcile.ts"), f.fork, f.upstream, f.dir],
    { encoding: "utf8" },
  );
  expect(printed.trim()).toBe("conflict.ts");
  expect([
    f.git("status", "--porcelain"),
    f.git("rev-parse", "HEAD"),
    NodeFS.readFileSync(NodePath.join(f.dir, ".git/index")),
  ]).toEqual(before);
  expect(conflictFiles(f.dir, f.fork, f.fork)).toEqual([]);
  expect(() => conflictFiles(f.dir, "missing", f.upstream)).toThrow();
});

it("selects a parent's chosen resolution and later edits, not upstream-only files, in a jj workspace without .git", () => {
  using f = fixture();
  try {
    f.git("merge", "--no-edit", f.upstream);
  } catch {
    /* Expected conflict. */
  }
  f.write("conflict.ts", "upstream\n");
  const merge = f.commit();
  f.write("adapted.ts", "reconciliation\n");
  const candidate = f.commit();
  expect(reconciliationFiles(f.dir, candidate)).toEqual({
    merge,
    rev: candidate,
    files: ["adapted.ts", "conflict.ts"],
  });
  NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: f.dir, stdio: "pipe" });
  const workspace = NodePath.join(f.dir, "workspace");
  NodeChildProcess.execFileSync("jj", ["workspace", "add", workspace, "-r", candidate], {
    cwd: f.dir,
    stdio: "pipe",
  });
  NodeFS.rmSync(NodePath.join(workspace, ".git"), { recursive: true, force: true });
  expect(NodeFS.existsSync(NodePath.join(workspace, ".git"))).toBe(false);
  NodeFS.writeFileSync(NodePath.join(workspace, "working-copy.ts"), "also reconciliation\n");
  expect(reconciliationFiles(workspace).files).toEqual([
    "adapted.ts",
    "conflict.ts",
    "working-copy.ts",
  ]);
  const printed = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "check-changed.ts"),
      "--repo",
      workspace,
      "--reconcile",
      "--list",
    ],
    { encoding: "utf8" },
  );
  expect(printed.trim().split("\n")).toEqual(["adapted.ts", "conflict.ts", "working-copy.ts"]);
});

it("names the exact repository Node version before checks can run on another version", () => {
  using f = fixture();
  f.write("package.json", JSON.stringify({ engines: { node: "0.0.1" } }));
  expect(() => requireRepositoryNode(f.dir)).toThrow("require Node 0.0.1");
  f.write("package.json", JSON.stringify({ engines: { node: process.versions.node } }));
  expect(() => requireRepositoryNode(f.dir)).not.toThrow();
});
