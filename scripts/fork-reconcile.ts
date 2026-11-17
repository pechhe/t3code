#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository inspection CLI shared by fork checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { removedPathFiles } from "./lib/fork-removed-paths.ts";
import { requireRepositoryNode } from "./fork-upstream-receipt.ts";

export { requireRepositoryNode };
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

// Deletes the files the fork removed from upstream, which an upstream merge restores. In a Git
// checkout the deletion is staged too, so it settles a modify/delete conflict; a jj workspace
// records the deletion itself.
export function dropUpstreamRemovals(
  repo: string,
  paths?: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const files = removedPathFiles(repo, paths);
  if (files.length === 0) return files;
  for (const file of files) NodeFS.rmSync(NodePath.join(repo, file), { force: true });
  if (NodeFS.existsSync(NodePath.join(repo, ".git"))) {
    NodeChildProcess.execFileSync(
      "git",
      ["-C", repo, "rm", "--quiet", "--force", "--cached", "--", ...files],
      {
        stdio: "ignore",
      },
    );
  }
  return files;
}

if (import.meta.main) {
  try {
    const [first, second] = process.argv.slice(2);
    if (first === "drop") {
      const repo = second ?? process.cwd();
      requireRepositoryNode(repo, true);
      for (const file of dropUpstreamRemovals(repo)) process.stdout.write(`${file}\n`);
    } else {
      const [fork, upstream, repo = process.cwd()] = process.argv.slice(2);
      requireRepositoryNode(repo, true);
      if (!fork || !upstream)
        throw new Error(
          "usage: fork-reconcile.ts <fork commit> <upstream commit> [repository] | drop [repository]",
        );
      for (const file of conflictFiles(repo, fork, upstream)) process.stdout.write(`${file}\n`);
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
