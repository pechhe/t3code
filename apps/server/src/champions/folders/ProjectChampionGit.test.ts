import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import { blobId } from "./AgentConfigGit.ts";
import * as ProjectChampionGit from "./ProjectChampionGit.ts";

const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const output = yield* processes.run({ command: "git", args, cwd, timeout: "30 seconds" });
    assert.equal(output.code, 0, output.stderr);
    return output.stdout.trim();
  });

const setup = (options: { readonly slipjay?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "project-champion-origin-" });
    yield* git(remote, "init", "--bare", "-b", "main");
    yield* git(remote, "config", "uploadpack.allowFilter", "true");
    yield* git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = Effect.fn("clone")(function* (prefix: string) {
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      yield* git(dir, "clone", remote, ".");
      yield* git(dir, "config", "user.email", "test@example.com");
      yield* git(dir, "config", "user.name", "Test");
      return dir;
    });
    const seed = yield* clone("project-champion-seed-");
    yield* git(seed, "checkout", "-b", "main");
    yield* fs.makeDirectory(path.join(seed, ".agents/champions/a"), { recursive: true });
    yield* fs.writeFileString(path.join(seed, ".agents/champions/a/one.md"), "one\n");
    yield* fs.writeFileString(path.join(seed, ".agents/champions/two.md"), "two\n");
    yield* fs.writeFileString(path.join(seed, "README.md"), "readme\n");
    yield* fs.writeFileString(path.join(seed, "src.ts"), "export {};\n");
    if (options.slipjay !== undefined)
      yield* fs.writeFileString(path.join(seed, "slipjay.json"), options.slipjay);
    yield* git(seed, "add", ".");
    yield* git(seed, "commit", "-m", "seed");
    yield* git(seed, "push", "origin", "HEAD:main");
    if (options.slipjay !== undefined) {
      yield* git(seed, "checkout", "-b", "trunk");
      yield* fs.writeFileString(path.join(seed, ".agents/champions/two.md"), "trunk two\n");
      yield* git(seed, "commit", "-am", "trunk");
      yield* git(seed, "push", "origin", "HEAD:trunk");
    }
    const checkout = yield* clone("project-champion-checkout-");
    const mirrorsRoot = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "mirrors-" }), "m");
    const input = { mirrorsRoot, canonicalKey: "github.com/pechhe/yardsmith", checkout };
    return { fs, path, remote, seed, checkout, mirrorsRoot, input, clone };
  });

const summarize = (files: ReadonlyArray<{ path: string; content: string }>) =>
  files.map((file) => [file.path, file.content]);

it.layer(layer)("ProjectChampionGit", (it) => {
  it.effect("reads the prefix at the integration branch named by slipjay.json", () =>
    Effect.gen(function* () {
      const { input, seed } = yield* setup({ slipjay: '{"integrationBranch":"trunk"}' });
      const result = yield* ProjectChampionGit.readPublished(input);
      assert.equal(result?.branch, "trunk");
      assert.equal(result?.commit, yield* git(seed, "rev-parse", "trunk"));
      assert.deepEqual(summarize(result?.files ?? []), [
        [".agents/champions/a/one.md", "one\n"],
        [".agents/champions/two.md", "trunk two\n"],
      ]);
      for (const file of result?.files ?? []) assert.equal(file.blob, blobId(file.content));
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to the default branch without slipjay.json", () =>
    Effect.gen(function* () {
      const { input, seed } = yield* setup();
      const result = yield* ProjectChampionGit.readPublished(input);
      assert.equal(result?.branch, "main");
      assert.equal(result?.commit, yield* git(seed, "rev-parse", "main"));
      assert.deepEqual(summarize(result?.files ?? []), [
        [".agents/champions/a/one.md", "one\n"],
        [".agents/champions/two.md", "two\n"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores uncommitted edits and leaves the checkout untouched", () =>
    Effect.gen(function* () {
      const { fs, path, checkout, input } = yield* setup();
      yield* fs.writeFileString(path.join(checkout, ".agents/champions/two.md"), "dirty");
      const snapshot = Effect.gen(function* () {
        return {
          refs: yield* git(checkout, "for-each-ref"),
          objects: (yield* fs.readDirectory(path.join(checkout, ".git/objects"), {
            recursive: true,
          })).toSorted(),
          config: yield* fs.readFileString(path.join(checkout, ".git/config")),
        };
      });
      const before = yield* snapshot;
      const result = yield* ProjectChampionGit.readPublished(input);
      assert.deepEqual(yield* snapshot, before);
      assert.equal(result?.files.find((file) => file.path.endsWith("two.md"))?.content, "two\n");
    }).pipe(Effect.scoped),
  );

  it.effect("sees a new landing on the next call", () =>
    Effect.gen(function* () {
      const { fs, path, clone, input } = yield* setup();
      const first = yield* ProjectChampionGit.readPublished(input);
      const other = yield* clone("project-champion-other-");
      yield* fs.writeFileString(path.join(other, ".agents/champions/two.md"), "newer\n");
      yield* git(other, "commit", "-am", "newer");
      yield* git(other, "push", "origin", "HEAD:main");
      const second = yield* ProjectChampionGit.readPublished(input);
      assert.notEqual(second?.commit, first?.commit);
      assert.equal(second?.commit, yield* git(other, "rev-parse", "HEAD"));
      assert.equal(second?.files.find((file) => file.path.endsWith("two.md"))?.content, "newer\n");
    }).pipe(Effect.scoped),
  );

  it.effect("returns null without an origin and [] without the prefix", () =>
    Effect.gen(function* () {
      const { fs, path, checkout, input, clone } = yield* setup();
      yield* git(checkout, "remote", "remove", "origin");
      assert.equal(yield* ProjectChampionGit.readPublished(input), null);

      const other = yield* clone("project-champion-empty-");
      yield* git(other, "rm", "-r", "-q", ".agents");
      yield* git(other, "commit", "-m", "drop champions");
      yield* git(other, "push", "origin", "HEAD:main");
      yield* fs.writeFileString(path.join(checkout, "x"), "");
      yield* git(
        checkout,
        "remote",
        "add",
        "origin",
        yield* git(other, "remote", "get-url", "origin"),
      );
      const result = yield* ProjectChampionGit.readPublished(input);
      assert.deepEqual(result?.files, []);
    }).pipe(Effect.scoped),
  );

  it.effect("holds no blob outside the prefix in the mirror", () =>
    Effect.gen(function* () {
      const { fs, path, input, mirrorsRoot } = yield* setup();
      const result = yield* ProjectChampionGit.readPublished(input);
      const [mirrorName] = yield* fs.readDirectory(mirrorsRoot);
      assert.ok(mirrorName);
      const listing = yield* git(
        path.join(mirrorsRoot, mirrorName),
        "cat-file",
        "--batch-all-objects",
        "--batch-check",
      );
      const blobs = listing
        .split("\n")
        .filter((line) => line.split(" ")[1] === "blob")
        .map((line) => line.split(" ")[0])
        .toSorted();
      assert.deepEqual(blobs, (result?.files ?? []).map((file) => file.blob).toSorted());
    }).pipe(Effect.scoped),
  );
});
