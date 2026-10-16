import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { CheckpointRef, VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const layerJjContract = JjVcsDriver.layerVcs.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

// What `slipjay status` prints to the driver; null makes the CLI fail as if absent.
let slipJayStatus: unknown = null;

// The real driver and Jujutsu, with SlipJay answered by `slipJayStatus`.
const layerJjWithSlipJay = JjVcsDriver.layerVcs.pipe(
  Layer.provideMerge(
    Layer.effect(
      VcsProcess.VcsProcess,
      Effect.gen(function* () {
        const real = yield* VcsProcess.VcsProcess;
        return VcsProcess.VcsProcess.of({
          run: (input) =>
            input.command !== "slipjay"
              ? real.run(input)
              : slipJayStatus === null
                ? Effect.fail(
                    new VcsProcessExitError({
                      operation: input.operation,
                      command: "slipjay",
                      cwd: input.cwd,
                      exitCode: 127,
                      detail: "not installed",
                    }),
                  )
                : Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: JSON.stringify(slipJayStatus),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
        });
      }),
    ).pipe(Layer.provide(VcsProcess.layer)),
  ),
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

it.layer(layerJjWithSlipJay)("Jujutsu VCS driver", (it) => {
  const makeRepo = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-vcs-" });
    yield* createPlainRepo(cwd);
    return cwd;
  });

  it.effect(
    "retains exact turn snapshots through abandoned-change and operation garbage collection",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo;
        const driver = yield* VcsDriver.VcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkpoints = driver.checkpoints!;
        const before = CheckpointRef.make("refs/t3/checkpoints/test/before");
        const after = CheckpointRef.make("refs/t3/checkpoints/test/after");
        yield* writeFile(cwd, "keep.ts", "before\n");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: before });
        yield* writeFile(cwd, "keep.ts", "after\n");
        yield* writeFile(cwd, "new.ts", "new\n");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: after });
        const diff = yield* checkpoints.diffCheckpoints({
          cwd,
          fromCheckpointRef: before,
          toCheckpointRef: after,
          ignoreWhitespace: false,
        });
        assert.include(diff, "+after");
        assert.include(diff, "+new");
        // With an unmoved base the turn is the whole diff, so no path filter applies.
        assert.isNull(
          yield* checkpoints.listAuthoredPaths({
            cwd,
            fromCheckpointRef: before,
            toCheckpointRef: after,
          }),
        );
        yield* runJj(cwd, ["abandon", "@"]);
        yield* runJj(cwd, ["op", "abandon", "..@-"]);
        yield* runJj(cwd, ["util", "gc", "--expire", "now"]);
        assert.isTrue(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: after }));
        assert.isTrue(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: after }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "keep.ts")), "after\n");
        assert.equal(yield* fs.readFileString(path.join(cwd, "new.ts")), "new\n");
        yield* writeFile(cwd, ".gitignore", "ignored.log\n");
        yield* writeFile(cwd, "ignored.log", "preserved\n");
        assert.isTrue(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: before }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "keep.ts")), "before\n");
        assert.isFalse(yield* fs.exists(path.join(cwd, "new.ts")));
        assert.equal(yield* fs.readFileString(path.join(cwd, "ignored.log")), "preserved\n");
        yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: [before, after] });
        assert.isFalse(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: before }));
        assert.isFalse(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: before }));
      }),
  );

  it.effect(
    "restores a shared JJ workspace without changing its peer or the shared Git index",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoint-shared-" });
        const cwd = path.join(parent, "main");
        const peer = path.join(parent, "peer workspace");
        yield* fs.makeDirectory(cwd);
        yield* runJj(cwd, ["git", "init", "--colocate", "."]);
        yield* writeFile(cwd, "file.txt", "main\n");
        yield* runJj(cwd, ["commit", "-m", "base"]);
        yield* runJj(cwd, ["workspace", "add", "--name", "peer", peer]);
        const driver = yield* VcsDriver.VcsDriver;
        const ref = CheckpointRef.make("refs/t3/checkpoints/test/shared");
        yield* writeFile(peer, "file.txt", "peer snapshot\n");
        yield* driver.checkpoints!.captureCheckpoint({ cwd: peer, checkpointRef: ref });
        yield* writeFile(peer, "file.txt", "peer changed\n");
        yield* writeFile(cwd, "file.txt", "main unsaved\n");
        const index = path.join(cwd, ".git", "index");
        const before = yield* fs.readFile(index);
        assert.isTrue(
          yield* driver.checkpoints!.restoreCheckpoint({ cwd: peer, checkpointRef: ref }),
        );
        assert.equal(yield* fs.readFileString(path.join(peer, "file.txt")), "peer snapshot\n");
        assert.equal(yield* fs.readFileString(path.join(cwd, "file.txt")), "main unsaved\n");
        assert.deepEqual(yield* fs.readFile(index), before);
        const store = yield* runJj(peer, ["git", "root", "--ignore-working-copy"]);
        assert.isEmpty(
          (yield* fs.readDirectory(store.stdout.trim())).filter((name) =>
            name.startsWith("t3-jj-checkpoint-index-"),
          ),
        );
      }),
  );

  it.effect(
    "reports the configured integration base, changed files and movement behind integration",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeRepo;
        const driver = yield* VcsDriver.VcsDriver;
        yield* writeFile(cwd, "slipjay.json", JSON.stringify({ integrationBranch: "develop" }));
        yield* writeFile(cwd, "base.txt", "base\n");
        yield* runJj(cwd, ["bookmark", "set", "develop", "-r", "@"]);
        yield* runJj(cwd, ["new"]);
        yield* writeFile(cwd, "changed.txt", "changed\n");
        slipJayStatus = {
          workspace: { name: "t3-29", issueNumber: 29 },
          integration: { name: "default" },
        };
        const first = yield* driver.getStatus!({ cwd });
        assert.deepEqual(first.slipJay, {
          integration: "develop",
          hasReleaseBranch: false,
          workspace: { name: "t3-29", issueNumber: 29, isIntegration: false },
        });
        assert.equal(first.refName, "develop");
        assert.equal(first.otherVcsKind, "jj");
        assert.equal(first.isRepo, false);
        assert.equal(first.behindCount, 0);
        assert.deepEqual(
          first.workingTree.files.map((file) => file.path),
          ["changed.txt"],
        );
        yield* runJj(cwd, ["new", "develop", "--no-edit", "-m", "integration advanced"]);
        const next = yield* runJj(cwd, [
          "log",
          "--no-graph",
          "-r",
          "children(develop) ~ @",
          "-T",
          "commit_id",
        ]);
        yield* runJj(cwd, [
          "bookmark",
          "set",
          "develop",
          "-r",
          next.stdout.trim(),
          "--allow-backwards",
        ]);
        const behind = yield* driver.getStatus!({ cwd });
        assert.equal(behind.behindCount, 1);
        yield* writeFile(cwd, "another.txt", "another\n");
        const edited = yield* driver.getStatus!({ cwd });
        assert.sameMembers(
          edited.workingTree.files.map((file) => file.path),
          ["changed.txt", "another.txt"],
        );
      }),
  );

  it.effect("names the integration checkout, and leaves a Git-free repository unmarked", () =>
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      const plain = yield* makeRepo;
      assert.isUndefined((yield* driver.getStatus!({ cwd: plain })).slipJay);
      const cwd = yield* makeRepo;
      yield* writeFile(cwd, "slipjay.json", JSON.stringify({ integrationBranch: "develop" }));
      slipJayStatus = { workspace: { name: "default" }, integration: { name: "default" } };
      assert.deepEqual((yield* driver.getStatus!({ cwd })).slipJay?.workspace, {
        name: "default",
        isIntegration: true,
      });
    }),
  );

  it.effect("still reports a SlipJay project whose config or CLI cannot be used", () =>
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      slipJayStatus = null;
      const malformed = yield* makeRepo;
      yield* writeFile(malformed, "slipjay.json", "{ not json");
      const unreadable = yield* driver.getStatus!({ cwd: malformed });
      assert.deepEqual(unreadable.slipJay, { integration: null, hasReleaseBranch: false });
      assert.isNull(unreadable.refName);
      // The bookmark slipjay.json names does not exist yet.
      const unborn = yield* makeRepo;
      yield* writeFile(unborn, "slipjay.json", JSON.stringify({ integrationBranch: "develop" }));
      const missing = yield* driver.getStatus!({ cwd: unborn });
      assert.deepEqual(missing.slipJay, { integration: "develop", hasReleaseBranch: false });
      assert.equal(missing.behindCount, 0);
      const releasing = yield* makeRepo;
      yield* writeFile(
        releasing,
        "slipjay.json",
        JSON.stringify({ integrationBranch: "develop", releaseBranch: "master" }),
      );
      const releasable = yield* driver.getStatus!({ cwd: releasing });
      assert.deepEqual(releasable.slipJay, { integration: "develop", hasReleaseBranch: true });
    }),
  );

  it.effect("finds the change SlipJay would land and whether integration contains it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      const changeOf = (revision: string) =>
        runJj(cwd, ["log", "--no-graph", "-r", revision, "-T", "change_id"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        );
      yield* writeFile(cwd, "work.txt", "work\n");
      const work = yield* changeOf("@");
      assert.deepEqual(yield* driver.slipJayLandCandidate!({ cwd, integration: "develop" }), {
        changeId: work,
        integrated: false,
      });
      // An empty working copy lands its parent.
      yield* runJj(cwd, ["new"]);
      assert.deepEqual(yield* driver.slipJayLandCandidate!({ cwd, integration: "develop" }), {
        changeId: work,
        integrated: false,
      });
      yield* runJj(cwd, ["bookmark", "set", "develop", "-r", "@-"]);
      assert.deepEqual(yield* driver.slipJayLandCandidate!({ cwd, integration: "develop" }), {
        changeId: work,
        integrated: true,
      });
    }),
  );

  it.effect("counts only a turn's own edits as authored, not earlier working-copy edits", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints!;
      const before = CheckpointRef.make("refs/t3/checkpoints/test/turn-before");
      const after = CheckpointRef.make("refs/t3/checkpoints/test/turn-after");
      yield* writeFile(cwd, "base.ts", "base\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      yield* writeFile(cwd, "earlier.ts", "an earlier turn\n");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: before });
      yield* writeFile(cwd, "turn.ts", "this turn\n");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: after });
      // The base did not move, so the turn is exactly the diff between its checkpoints.
      assert.isNull(
        yield* checkpoints.listAuthoredPaths({
          cwd,
          fromCheckpointRef: before,
          toCheckpointRef: after,
        }),
      );
      const diff = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: before,
        toCheckpointRef: after,
        ignoreWhitespace: false,
      });
      assert.include(diff, "turn.ts");
      assert.notInclude(diff, "earlier.ts");
    }),
  );

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

  it.effect("reads the named base as a bookmark, never as a revset expression", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const driver = yield* VcsDriver.VcsDriver;
      yield* writeFile(cwd, "a.ts", "one\n");
      yield* runJj(cwd, ["commit", "-m", "base"]);
      yield* runJj(cwd, ["bookmark", "create", "release+1", "-r", "@-"]);
      yield* runJj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
      yield* writeFile(cwd, "b.ts", "two\n");
      yield* runJj(cwd, ["commit", "-m", "work"]);
      const rangeFiles = (baseRef: string | undefined) =>
        driver.getDiffPreview!({ cwd, ...(baseRef === undefined ? {} : { baseRef }) }).pipe(
          Effect.map(({ sources }) =>
            sources.find(({ kind }) => kind === "branch-range")!.files?.map(({ path }) => path),
          ),
        );

      assert.deepStrictEqual(yield* rangeFiles("release+1"), ["b.ts"]);
      // As an expression this would be the fork point of root() and @, the whole history.
      assert.deepStrictEqual(yield* rangeFiles("root() | main"), []);
      // With no base named, trunk() is the base; a plain repository has none.
      yield* runJj(cwd, ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"]);
      assert.deepStrictEqual(yield* rangeFiles(undefined), ["b.ts"]);
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
