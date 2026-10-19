// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Replay rehydrates historical trees on disk and prints the table.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { LandingTests, LandingWorkspace } from "../test-landing.ts";

interface ReplayCommit {
  readonly plan: LandingTests;
  readonly workspaces: ReadonlyArray<LandingWorkspace>;
  readonly tracked: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
}

interface ReplayOptions {
  readonly root: string;
  /** Oldest first. */
  readonly commits: ReadonlyArray<string>;
  readonly pinned: string;
  readonly jj: (args: ReadonlyArray<string>) => string;
  readonly plan: (commit: string) => ReplayCommit;
  /** The gate's budgeted selection, listed from the rehydrated tree at `root`. */
  readonly budget: (
    commit: ReplayCommit,
    root: string,
  ) => Promise<{ readonly selected: ReadonlyArray<unknown>; readonly deferred: ReadonlyArray<unknown>; readonly seconds: number }>;
  readonly budgetSeconds: number;
}

// Mirrors the files a test workspace needs to build its import graph; the rest of the tree
// (reference repositories, assets, native sources) never reaches a Vitest module graph.
const TREE =
  /^(?:apps|packages|infra|scripts|oxlint-plugin-t3code)\/|^(?:package\.json|tsconfig[^/]*\.json|vite\.config\.ts)$/;

/**
 * Rehydrates each commit's tree under a scratch directory, oldest first, and lists what the gate
 * would run there. No test body runs.
 */
export async function replayLandings(options: ReplayOptions) {
  const { root, jj } = options;
  // Vitest keys modules by real path; a symlinked temporary directory would never match.
  const scratch = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-landing-replay-")),
  );
  let previous: { commit: string; tracked: ReadonlySet<string> } | undefined;
  let longest = 0;
  let over = 0;
  try {
    console.log("commit | run/selected test files | estimated seconds | selection");
    for (const commit of options.commits) {
      const replayed = options.plan(commit);
      const current = new Set(replayed.tracked.filter((file) => TREE.test(file)));
      // The first tree copies unchanged files from this checkout and fetches only what differs.
      const from = previous?.commit ?? "@";
      const delta = new Set(
        jj([
          "diff",
          ...(previous ? ["--ignore-working-copy"] : []),
          "--from",
          from,
          "--to",
          commit,
          "-T",
          'json(path) ++ "\\n"',
        ])
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string),
      );
      const known = previous?.tracked ?? new Set<string>();
      for (const file of known)
        if (!current.has(file)) NodeFS.rmSync(NodePath.join(scratch, file), { force: true });
      for (const file of current) {
        const target = NodePath.join(scratch, file);
        if (known.has(file) && !delta.has(file)) continue;
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        if (!previous && !delta.has(file)) NodeFS.copyFileSync(NodePath.join(root, file), target);
        else
          NodeFS.writeFileSync(
            target,
            jj(["file", "show", "--ignore-working-copy", "-r", commit, file]),
          );
      }
      for (const workspace of replayed.workspaces) {
        const link = NodePath.join(scratch, workspace.directory, "node_modules");
        if (
          !NodeFS.existsSync(link) &&
          NodeFS.existsSync(NodePath.join(root, workspace.directory, "node_modules"))
        ) {
          NodeFS.symlinkSync(NodePath.join(root, workspace.directory, "node_modules"), link, "dir");
        }
      }
      if (!NodeFS.existsSync(NodePath.join(scratch, "node_modules"))) {
        NodeFS.symlinkSync(
          NodePath.join(root, "node_modules"),
          NodePath.join(scratch, "node_modules"),
          "dir",
        );
      }
      previous = { commit, tracked: current };
      const { plan } = replayed;
      const budget = await options.budget(replayed, scratch);
      longest = Math.max(longest, budget.seconds);
      if (budget.seconds > options.budgetSeconds) over++;
      console.log(
        `${commit.slice(0, 12)} | ${budget.selected.length}/${budget.selected.length + budget.deferred.length} | ${Math.round(budget.seconds)} | ${plan.kind === "complete" ? `complete: ${plan.reason}` : plan.kind === "none" ? "none" : `related in ${plan.runs.map((run) => run.directory).join(", ")}`}`,
      );
    }
    console.log(
      `Longest estimate ${Math.round(longest)}s; ${over}/${options.commits.length} over the ${options.budgetSeconds}s budget. Integration branch pinned at ${options.pinned}.`,
    );
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}
