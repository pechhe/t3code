// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Replay rehydrates historical trees on disk and prints the table.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { LandingTests, LandingWorkspace } from "../test-landing.ts";

interface ReplayCommit {
  readonly plan: LandingTests;
  readonly workspaces: ReadonlyArray<LandingWorkspace>;
  readonly tracked: ReadonlyArray<string>;
}

interface ReplayOptions {
  readonly root: string;
  /** Oldest first. */
  readonly commits: ReadonlyArray<string>;
  readonly pinned: string;
  readonly jj: (args: ReadonlyArray<string>) => string;
  readonly plan: (commit: string) => ReplayCommit;
}

// Mirrors the files a test workspace needs to build its import graph; the rest of the tree
// (reference repositories, assets, native sources) never reaches a Vitest module graph.
const TREE =
  /^(?:apps|packages|infra|scripts|oxlint-plugin-t3code)\/|^(?:package\.json|tsconfig[^/]*\.json|vite\.config\.ts)$/;
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The flag values a workspace's `vp test run` script passes that choose its Vitest projects. */
function flagValues(flags: ReadonlyArray<string>, name: string) {
  return flags.flatMap((flag, index) =>
    flag === name && flags[index + 1] ? [flags[index + 1]!] : [],
  );
}

interface CountRequest {
  readonly scratch: string;
  readonly directory: string;
  readonly flags: ReadonlyArray<string>;
  readonly related?: ReadonlyArray<string>;
}

/** Runs in a child process: one Vitest context per process keeps a long replay from exhausting the heap. */
async function countInProcess({
  scratch,
  directory: workspaceDirectory,
  flags,
  related,
}: CountRequest) {
  const { createVitest } = await import("vite-plus/test/node");
  const directory = NodePath.join(scratch, workspaceDirectory);
  const config = flagValues(flags, "--config")[0];
  const projects = flagValues(flags, "--project");
  const context = await createVitest(
    "test",
    {
      root: directory,
      watch: false,
      run: true,
      ...(config ? { config: NodePath.resolve(directory, config) } : {}),
      ...(flagValues(flags, "--dir")[0]
        ? { dir: NodePath.resolve(directory, flagValues(flags, "--dir")[0]!) }
        : {}),
      ...(projects.length > 0 ? { project: projects } : {}),
      ...(related ? { related: related.map((file) => NodePath.join(scratch, file)) } : {}),
    },
    {},
  );
  try {
    return related
      ? (await context.getRelevantTestSpecifications()).length
      : (await context.globTestSpecifications()).length;
  } finally {
    await context.close();
  }
}

function countFiles(
  scratch: string,
  workspace: LandingWorkspace,
  related: ReadonlyArray<string> | undefined,
) {
  const request: CountRequest = {
    scratch,
    directory: workspace.directory,
    flags: workspace.test && workspace.test !== "opaque" ? workspace.test.flags : [],
    ...(related ? { related } : {}),
  };
  return new Promise<number>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--max-old-space-size=8192", import.meta.filename, JSON.stringify(request)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const count = /^COUNT (\d+)$/m.exec(output)?.[1];
      if (code === 0 && count) resolve(Number(count));
      else reject(new Error(`counting ${workspace.directory} exited ${code}`));
    });
  });
}

/** Counts in parallel, a few processes at a time. */
async function countAll<T>(items: ReadonlyArray<T>, count: (item: T) => Promise<number>) {
  const results = items.map(() => 0);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await count(items[index]!);
      }
    }),
  );
  return results;
}

export async function countRelatedTests(options: ReplayOptions) {
  const { root, jj } = options;
  // Vitest keys modules by real path; a symlinked temporary directory would never match.
  const scratch = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-landing-replay-")),
  );
  const totals = new Map<string, number>();
  let previous: { commit: string; tracked: ReadonlySet<string> } | undefined;
  let half = 0;
  let narrowed = 0;
  try {
    console.log("commit | selected/complete test files | selection");
    for (const commit of options.commits) {
      const { plan, workspaces, tracked } = options.plan(commit);
      const current = new Set(tracked.filter((file) => TREE.test(file)));
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
      for (const workspace of workspaces) {
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
      // A workspace's total only changes when a test file or its manifest does.
      const dirty = new Set(
        [...delta]
          .filter((file) => TEST_NAME.test(file) || /(?:^|\/)package\.json$/.test(file))
          .map((file) => workspaces.find((w) => file.startsWith(`${w.directory}/`))?.directory),
      );
      const stale = workspaces.filter(
        (workspace) =>
          workspace.test && (!totals.has(workspace.directory) || dirty.has(workspace.directory)),
      );
      const counted = await countAll(stale, (workspace) =>
        countFiles(scratch, workspace, undefined),
      );
      stale.forEach((workspace, index) => totals.set(workspace.directory, counted[index]!));
      const total = [...totals.entries()]
        .filter(([directory]) => workspaces.some((w) => w.directory === directory && w.test))
        .reduce((sum, [, count]) => sum + count, 0);
      previous = { commit, tracked: current };
      let selected = 0;
      if (plan.kind === "complete") selected = total;
      else if (plan.kind === "related") {
        const counts = await countAll(plan.runs, (run) =>
          run.mode === "all"
            ? Promise.resolve(totals.get(run.directory) ?? 0)
            : countFiles(
                scratch,
                workspaces.find((w) => w.directory === run.directory)!,
                run.files,
              ),
        );
        selected = counts.reduce((sum, count) => sum + count, 0);
      }
      if (selected <= total / 2) half++;
      if (plan.kind !== "complete") narrowed++;
      console.log(
        `${commit.slice(0, 12)} | ${selected}/${total} | ${plan.kind === "complete" ? `complete: ${plan.reason}` : plan.kind === "none" ? "none" : `related in ${plan.runs.map((run) => run.directory).join(", ")}`}`,
      );
    }
    console.log(
      `Narrowed (not complete): ${narrowed}/${options.commits.length}; at most half of the complete suite: ${half}/${options.commits.length}. Integration branch pinned at ${options.pinned}.`,
    );
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log(`COUNT ${await countInProcess(JSON.parse(process.argv[2]!) as CountRequest)}`);
}
