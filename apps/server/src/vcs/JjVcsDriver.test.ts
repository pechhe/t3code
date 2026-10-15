import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import type { VcsError } from "@t3tools/contracts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const layerJjContract = JjVcsDriver.layerVcs.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runJj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* VcsDriver.VcsDriver;
    return yield* driver.execute({
      operation: "JjVcsDriver.contract.jj",
      cwd,
      args,
      timeoutMs: 20_000,
    });
  });

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

const createPlainRepo = (cwd: string) => runJj(cwd, ["git", "init", "--no-colocate", "."]);

type JjContractError = VcsError | PlatformError.PlatformError;

runVcsDriverContractSuite<VcsDriver.VcsDriver, JjContractError>({
  name: "Jujutsu",
  kind: "jj",
  layer: layerJjContract,
  fixture: {
    createRepo: createPlainRepo,
    writeFile,
    trackFile: () => Effect.void,
    commit: (cwd, message) => runJj(cwd, ["commit", "-m", message]).pipe(Effect.asVoid),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.layer(layerJjContract)("Jujutsu VCS driver", (it) => {
  const makeRepo = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-vcs-" });
    yield* createPlainRepo(cwd);
    return cwd;
  });

  it.effect("diffs the working copy against its parent, with whole-patch totals", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, "a.ts", "one\ntwo\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      yield* writeFile(cwd, "a.ts", "one\nthree\nfour\n");
      yield* writeFile(cwd, "new file.ts", "hello\n");

      const preview = yield* driver.getDiffPreview!({ cwd });
      const source = preview.sources.find(({ kind }) => kind === "working-tree")!;
      assert.deepStrictEqual(
        [...(source.files ?? [])].toSorted((a, b) => a.path.localeCompare(b.path)),
        [
          { path: "a.ts", previousPath: null, additions: 2, deletions: 1 },
          { path: "new file.ts", previousPath: null, additions: 1, deletions: 0 },
        ],
      );
      assert.include(source.diff, "+three");
      assert.isFalse(source.truncated);

      const single = yield* driver.getDiffPreview!({
        cwd,
        file: { path: "new file.ts", previousPath: null, sourceKind: "working-tree" },
      });
      assert.deepStrictEqual(
        single.sources.find(({ kind }) => kind === "working-tree")?.files?.map(({ path }) => path),
        ["new file.ts"],
      );
    }),
  );

  it.effect("shows no range for a repository without a trunk, and no sources outside one", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, "a.ts", "one\n");
      const preview = yield* driver.getDiffPreview!({ cwd });
      assert.equal(preview.sources.find(({ kind }) => kind === "branch-range")?.diff, "");

      const fileSystem = yield* FileSystem.FileSystem;
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-none-" });
      assert.deepStrictEqual((yield* driver.getDiffPreview!({ cwd: outside })).sources, []);
    }),
  );

  it.effect("diffs a branch against its fork point from a named base", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, "a.ts", "one\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      yield* runJj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
      yield* writeFile(cwd, "b.ts", "two\n");
      yield* runJj(cwd, ["commit", "-m", "work"]);

      const preview = yield* driver.getDiffPreview!({ cwd, baseRef: "main" });
      const range = preview.sources.find(({ kind }) => kind === "branch-range")!;
      assert.deepStrictEqual(
        range.files?.map(({ path }) => path),
        ["b.ts"],
      );
    }),
  );

  it.effect("reads both sides of a changed file, and refuses binary files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, "a.ts", "old\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      yield* writeFile(cwd, "a.ts", "new\n");
      const contents = yield* driver.getDiffFileContents!({
        cwd,
        sourceKind: "working-tree",
        changeType: "change",
        baseRef: null,
        headRef: null,
        oldPath: "a.ts",
        newPath: "a.ts",
      });
      assert.deepStrictEqual(contents, { oldContents: "old\n", newContents: "new\n" });

      yield* writeFile(cwd, "bin.dat", "a\0b");
      const failure = yield* driver.getDiffFileContents!({
        cwd,
        sourceKind: "working-tree",
        changeType: "new",
        baseRef: null,
        headRef: null,
        oldPath: "bin.dat",
        newPath: "bin.dat",
      }).pipe(Effect.flip);
      assert.include(failure.message, "binary");
    }),
  );

  it.effect("reads a workspace that has no .git of its own", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, ".gitignore", "*.log\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      const workspace = path.join(yield* fileSystem.makeTempDirectoryScoped(), "second");
      yield* runJj(cwd, ["workspace", "add", workspace]);
      yield* writeFile(workspace, "kept.ts", "x\n");
      yield* writeFile(workspace, "noise.log", "x\n");

      assert.isFalse(yield* fileSystem.exists(path.join(workspace, ".git")));
      assert.equal((yield* driver.detectRepository(workspace))?.kind, "jj");
      const files = yield* driver.listWorkspaceFiles(workspace);
      assert.include(files.paths, "kept.ts");
      assert.notInclude(files.paths, "noise.log");
      assert.deepStrictEqual(yield* driver.filterIgnoredPaths(workspace, ["kept.ts", "x.log"]), [
        "kept.ts",
      ]);
    }),
  );

  it.effect("lists remotes and refuses to initialise a repository", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* runJj(cwd, ["git", "remote", "add", "origin", "https://example.com/a.git"]);
      const { remotes } = yield* driver.listRemotes(cwd);
      assert.deepStrictEqual(
        remotes.map(({ name, url, isPrimary }) => ({ name, url, isPrimary })),
        [{ name: "origin", url: "https://example.com/a.git", isPrimary: true }],
      );
      const failure = yield* driver.initRepository({ cwd }).pipe(Effect.flip);
      assert.equal(failure._tag, "VcsUnsupportedOperationError");
    }),
  );
});

it("counts additions and deletions per file, following renames", () => {
  assert.deepStrictEqual(
    JjVcsDriver.parseGitPatchStats(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1,2 +1,2 @@",
        "-a",
        "+b",
        " same",
        "diff --git a/bin.png b/bin.png",
        "Binary files differ",
      ].join("\n"),
    ),
    [
      { path: "new.ts", previousPath: "old.ts", additions: 1, deletions: 1 },
      { path: "bin.png", previousPath: null, additions: 0, deletions: 0 },
    ],
  );
});
