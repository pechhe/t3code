// @effect-diagnostics nodeBuiltinImport:off - Proves restart behaviour of the real dev watcher in a fixture worktree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const SERVER_ROOT = NodePath.resolve(import.meta.dirname, "..");
const REPO_ROOT = NodePath.resolve(SERVER_ROOT, "../..");
const WATCH_PATH_PREFIX = "--watch-path=";
const CHANGE_REPORT_PATTERN = /Change detected in '([^']+)'/g;

function devServerArgs(): Array<string> {
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(SERVER_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  return packageJson.scripts.dev!.split(" ");
}

function watchPaths(args: ReadonlyArray<string>): Array<string> {
  return args
    .filter((arg) => arg.startsWith(WATCH_PATH_PREFIX))
    .map((arg) => arg.slice(WATCH_PATH_PREFIX.length));
}

function workspacePackageNames(): Array<string> {
  return NodeFS.readdirSync(NodePath.join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        NodeFS.existsSync(NodePath.join(REPO_ROOT, "packages", entry.name, "src")),
    )
    .map((entry) => entry.name)
    .sort();
}

// Node restarts on anything beneath a watched directory, so no watch path may
// reach a dependency folder, however an ancestor or explicit path is spelled.
function containsPath(directory: string, target: string): boolean {
  const relative = NodePath.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function workspaceDependencyFolders(): Array<string> {
  return [
    NodePath.join(REPO_ROOT, "node_modules"),
    ...workspacePackageNames().map((name) =>
      NodePath.join(REPO_ROOT, "packages", name, "node_modules"),
    ),
  ].filter((folder) => NodeFS.existsSync(folder));
}

type BootWaiter = { readonly after: number; readonly settle: (error?: Error) => void };

type DevWatcher = {
  readonly packageSourceDir: string;
  readonly packageDependencyBin: string;
  readonly serverDir: string;
  readonly boots: () => number;
  readonly changeReports: () => Array<string>;
  readonly nextBoot: (after: number) => Promise<void>;
  readonly write: (path: string, contents: string) => void;
  readonly stop: () => Promise<void>;
};

function startDevWatcher(): DevWatcher {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-watch-"));
  const serverDir = NodePath.join(root, "apps", "server");
  NodeFS.mkdirSync(NodePath.join(serverDir, "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(serverDir, "package.json"), "{}\n");
  NodeFS.writeFileSync(
    NodePath.join(serverDir, "src", "bin.ts"),
    'console.log("boot");\nsetInterval(() => {}, 1000);\n',
  );

  const packageName = workspacePackageNames()[0];
  if (packageName === undefined) throw new Error("the repository has no workspace package");
  const packageDir = NodePath.join(root, "packages", packageName);
  NodeFS.mkdirSync(NodePath.join(packageDir, "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(packageDir, "src", "index.ts"), "export const value = 1;\n");
  // A real package keeps pnpm's dependency links beside its sources, which an
  // install rewrites; watching the package directory would restart on them too.
  NodeFS.mkdirSync(NodePath.join(packageDir, "node_modules", ".bin"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(packageDir, "node_modules", ".bin", "vpx"), "#!/bin/sh\n");

  const args = devServerArgs();
  for (const watchPath of watchPaths(args)) {
    const target = NodePath.resolve(serverDir, watchPath);
    if (!NodeFS.existsSync(target)) NodeFS.mkdirSync(target, { recursive: true });
  }

  const [, ...nodeArgs] = args;
  const child = NodeChildProcess.spawn(process.execPath, nodeArgs, {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let failure: Error | undefined;
  const waiters = new Set<BootWaiter>();
  const boots = () => output.split("boot").length - 1;
  const settleWaiters = (error?: Error) => {
    for (const waiter of waiters) {
      waiters.delete(waiter);
      waiter.settle(error);
    }
  };
  const collect = (chunk: string) => {
    output += chunk;
    for (const waiter of waiters) {
      if (boots() <= waiter.after) continue;
      waiters.delete(waiter);
      waiter.settle();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  // `--watch` stops its supervised process on SIGTERM, so awaiting the
  // supervisor's exit is enough to know the fixture's server is gone too.
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const finish = () => {
      exited = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  child.on("error", (error) => {
    failure = error;
    settleWaiters(error);
  });
  child.on("exit", (code, signal) => {
    const error = new Error(
      `dev watcher exited (code ${code}, signal ${signal}) before restarting:\n${output}`,
    );
    failure ??= error;
    settleWaiters(error);
  });

  return {
    packageSourceDir: NodePath.join(packageDir, "src"),
    packageDependencyBin: NodePath.join(packageDir, "node_modules", ".bin", "vpx"),
    serverDir,
    boots,
    changeReports: () => [...output.matchAll(CHANGE_REPORT_PATTERN)].map((match) => match[1]!),
    nextBoot: (after) => {
      if (failure !== undefined) return Promise.reject(failure);
      if (boots() > after) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.add({ after, settle: (error) => (error ? reject(error) : resolve()) });
      });
    },
    write: (path, contents) => NodeFS.writeFileSync(path, contents),
    stop: async () => {
      try {
        if (!exited) child.kill("SIGTERM");
        await exit;
      } finally {
        NodeFS.rmSync(root, { force: true, recursive: true });
      }
    },
  };
}

describe("dev server watcher", () => {
  it("restarts on workspace package and server source edits", async () => {
    const watcher = startDevWatcher();
    try {
      await watcher.nextBoot(0);
      expect(watcher.boots()).toBe(1);

      watcher.write(
        NodePath.join(watcher.packageSourceDir, "index.ts"),
        "export const value = 2;\n",
      );
      await watcher.nextBoot(1);
      expect(watcher.changeReports()).toContainEqual(
        expect.stringContaining(`${NodePath.sep}index.ts`),
      );

      const beforeDependencyChange = watcher.boots();
      watcher.write(watcher.packageDependencyBin, "#!/bin/sh\n# reinstalled\n");
      watcher.write(
        NodePath.join(watcher.packageSourceDir, "other.ts"),
        "export const other = 1;\n",
      );
      await watcher.nextBoot(beforeDependencyChange);
      expect(watcher.changeReports()).toContainEqual(
        expect.stringContaining(`${NodePath.sep}other.ts`),
      );
      expect(watcher.changeReports()).not.toContainEqual(expect.stringContaining("node_modules"));

      const beforeServerSource = watcher.boots();
      watcher.write(NodePath.join(watcher.serverDir, "src", "extra.ts"), "export {};\n");
      await watcher.nextBoot(beforeServerSource);
      expect(watcher.changeReports()).toContainEqual(
        expect.stringContaining(`${NodePath.sep}extra.ts`),
      );
    } finally {
      await watcher.stop();
    }
  });

  it("watches every workspace package's sources and no dependency folders", () => {
    const paths = watchPaths(devServerArgs());
    expect(paths).toContain("src");
    expect(paths).toContain("package.json");
    expect(paths).toEqual(
      expect.arrayContaining(workspacePackageNames().map((name) => `../../packages/${name}/src`)),
    );

    const dependencyFolders = workspaceDependencyFolders();
    expect(dependencyFolders.length).toBeGreaterThan(0);
    for (const watchPath of paths) {
      const watched = NodePath.resolve(SERVER_ROOT, watchPath);
      for (const dependencyFolder of dependencyFolders) {
        expect(
          containsPath(watched, dependencyFolder),
          `${watchPath} also watches ${NodePath.relative(watched, dependencyFolder)}`,
        ).toBe(false);
      }
    }
  });
});
