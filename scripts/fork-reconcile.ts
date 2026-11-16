#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository inspection CLI shared by fork checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function requireRepositoryNode(repo: string, restart = false) {
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(repo, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const pin = manifest.engines?.node;
  if (typeof pin === "string" && /^\d+\.\d+\.\d+$/.test(pin) && process.versions.node !== pin) {
    const message = `These checks require Node ${pin}; running ${process.versions.node}. Run with vp env exec --node=${pin} node <command>.`;
    if (restart && process.env.T3_FORK_PINNED_NODE === undefined) {
      const child = NodeChildProcess.spawnSync(
        "vp",
        ["env", "exec", `--node=${pin}`, "node", ...process.argv.slice(1)],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            PATH: (process.env.PATH ?? "")
              .split(NodePath.delimiter)
              .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry))
              .join(NodePath.delimiter),
            T3_FORK_PINNED_NODE: "1",
          },
        },
      );
      if (!child.error) {
        if (child.status !== 0) process.stderr.write(`${message}\n`);
        process.exit(child.status ?? 1);
      }
    }
    throw new Error(message);
  }
}

// A non-colocated jj workspace shares its integration checkout's Git object store.
export function gitRepository(repo: string): string {
  if (NodeFS.existsSync(NodePath.join(repo, ".git"))) return repo;
  const pointer = NodePath.join(repo, ".jj", "repo");
  if (!NodeFS.existsSync(pointer)) return repo;
  const store = NodeFS.statSync(pointer).isDirectory()
    ? pointer
    : NodePath.resolve(NodePath.dirname(pointer), NodeFS.readFileSync(pointer, "utf8").trim());
  const backend = NodePath.join(store, "store");
  const target = NodePath.join(backend, "git_target");
  return NodeFS.existsSync(target)
    ? NodePath.resolve(backend, NodeFS.readFileSync(target, "utf8").trim())
    : NodePath.join(backend, "git");
}

export function repositoryGit(repo: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync(
    "git",
    ["-c", "core.quotePath=false", "-C", gitRepository(repo), ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

export function workspaceRevision(repo: string): string {
  if (!NodeFS.existsSync(NodePath.join(repo, ".jj")))
    return repositoryGit(repo, ["rev-parse", "HEAD"]);
  return NodeChildProcess.execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function reconciliationFiles(repo: string, rev = workspaceRevision(repo)) {
  const merge = repositoryGit(repo, ["rev-list", "--first-parent", "--merges", "-n1", rev]);
  if (!merge) throw new Error("No upstream merge on the candidate's first-parent history.");
  // Remerge diff includes every resolution, even one that chose a parent's version.
  const resolutions = repositoryGit(repo, [
    "show",
    "--format=",
    "--diff-merges=remerge",
    "--name-only",
    merge,
  ]);
  const edits = repositoryGit(repo, ["diff", "--name-only", "--no-renames", merge, rev, "--"]);
  return {
    merge,
    rev,
    files: [...new Set(`${resolutions}\n${edits}`.split("\n").filter(Boolean))].sort(),
  };
}

export function conflictFiles(repo: string, fork: string, upstream: string): readonly string[] {
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "-C",
      gitRepository(repo),
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      fork,
      upstream,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if ((result.status !== 0 && result.status !== 1) || !/^[a-f0-9]{40,64}\n?/.test(result.stdout))
    throw new Error(result.stderr || "merge-tree failed");
  return result.stdout.trim().split("\n").slice(1).filter(Boolean);
}

if (import.meta.main) {
  try {
    const [fork, upstream, repo = process.cwd()] = process.argv.slice(2);
    requireRepositoryNode(repo, true);
    if (!fork || !upstream)
      throw new Error("usage: fork-reconcile.ts <fork commit> <upstream commit> [repository]");
    for (const file of conflictFiles(repo, fork, upstream)) process.stdout.write(`${file}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
