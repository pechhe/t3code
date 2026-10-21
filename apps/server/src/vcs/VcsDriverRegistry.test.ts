import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (rootDir: string, calls: string[]) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === "rev-parse --is-inside-work-tree") return processOutput("true\n");
              if (command === "rev-parse --show-toplevel") return processOutput(`${repoDir}\n`);
              if (command === "rev-parse --git-common-dir") {
                return processOutput(`${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`);
              }
              return processOutput("");
            }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
        }),
      ),
    );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads Jujutsu workspaces and colocated checkouts through Jujutsu, and a nested Git repository through Git",
    () => {
      const processLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
      const layer = Layer.mergeAll(
        Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
          Layer.provide(VcsProjectConfig.layer),
          Layer.provide(processLayer),
          Layer.provide(NodeServices.layer),
        ),
        processLayer,
        NodeServices.layer,
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const process = yield* VcsProcess.VcsProcess;
        const jj = (cwd: string, args: ReadonlyArray<string>) =>
          process.run({ operation: "test.jj", command: "jj", args, cwd });
        const plain = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-jj-" });
        yield* jj(plain, ["git", "init", "--no-colocate", "."]);
        const colocated = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-jj-" });
        yield* jj(colocated, ["git", "init", "--colocate", "."]);

        const nested = `${plain}/vendor/lib`;
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* process.run({ operation: "test.git", command: "git", args: ["init"], cwd: nested });

        assert.equal((yield* registry.detect({ cwd: plain }))?.kind, "jj");
        assert.equal((yield* registry.detect({ cwd: colocated }))?.kind, "jj");
        assert.equal((yield* registry.detect({ cwd: nested }))?.kind, "git");
        // A colocated checkout can still be read through Git when the project asks for it.
        assert.equal(
          (yield* registry.detect({ cwd: colocated, requestedKind: "git" }))?.kind,
          "git",
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );
});
