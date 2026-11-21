import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import * as AgentConfigGit from "./AgentConfigGit.ts";

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

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-origin-" });
  yield* git(remote, "init", "--bare", "-b", "main");
  const clone = Effect.fn("clone")(function* (prefix: string) {
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* git(dir, "clone", remote, ".");
    yield* git(dir, "config", "user.email", "test@example.com");
    yield* git(dir, "config", "user.name", "Test");
    return dir;
  });
  const seed = yield* clone("agent-config-seed-");
  yield* git(seed, "checkout", "-b", "main");
  yield* fs.makeDirectory(path.join(seed, "champions/a"), { recursive: true });
  yield* fs.writeFileString(path.join(seed, "champions/a/one.md"), "one\n");
  yield* fs.writeFileString(path.join(seed, "champions/two.md"), "two é\n");
  yield* fs.writeFileString(path.join(seed, "AGENTS.md"), "rules\n");
  yield* fs.writeFileString(path.join(seed, "notes.md"), "notes\n");
  yield* git(seed, "add", ".");
  yield* git(seed, "commit", "-m", "seed");
  yield* git(seed, "push", "origin", "HEAD:main");
  const repo = yield* clone("agent-config-repo-");
  const other = yield* clone("agent-config-other-");
  return { fs, path, repo, other };
});

it.layer(layer)("AgentConfigGit", (it) => {
  it.effect("reads committed files under a prefix, never the working tree", () =>
    Effect.gen(function* () {
      const { fs, path, repo } = yield* setup;
      yield* fs.writeFileString(path.join(repo, "champions/two.md"), "dirty");
      const main = yield* AgentConfigGit.fetchMain(repo);
      const files = yield* AgentConfigGit.readFiles(repo, main, "champions/");
      assert.deepEqual(
        files.map((file) => [file.path, file.content]),
        [
          ["champions/a/one.md", "one\n"],
          ["champions/two.md", "two é\n"],
        ],
      );
      for (const file of files) assert.equal(file.blob, AgentConfigGit.blobId(file.content));
      assert.deepEqual(yield* AgentConfigGit.readFiles(repo, main, "missing/"), []);
    }).pipe(Effect.scoped),
  );

  it.effect("blobId matches git", () =>
    Effect.gen(function* () {
      const { fs, path, repo } = yield* setup;
      for (const content of ["", "hello\n", "héllo ✓"]) {
        yield* fs.writeFileString(path.join(repo, "probe"), content);
        assert.equal(AgentConfigGit.blobId(content), yield* git(repo, "hash-object", "probe"));
      }
    }).pipe(Effect.scoped),
  );

  it.effect("publishes adds, edits and deletes without touching the checkout", () =>
    Effect.gen(function* () {
      const { fs, path, repo, other } = yield* setup;
      yield* fs.writeFileString(path.join(repo, "notes.md"), "local edit\n");
      yield* fs.writeFileString(path.join(repo, "staged.md"), "staged\n");
      yield* git(repo, "add", "staged.md");
      const head = yield* git(repo, "rev-parse", "HEAD");
      const status = yield* git(repo, "status", "--porcelain");
      const index = yield* git(repo, "ls-files", "-s");

      const base = yield* AgentConfigGit.fetchMain(repo);
      const commit = yield* AgentConfigGit.commitChanges(repo, {
        base,
        message: "update champions",
        changes: [
          { path: "champions/new.md", content: "new\n" },
          { path: "champions/two.md", content: "two edited\n" },
          { path: "champions/a/one.md", content: null },
          { path: "champions/never.md", content: null },
        ],
      });
      assert.isString(commit);
      assert.equal(yield* AgentConfigGit.pushToMain(repo, commit!), "pushed");

      assert.equal(yield* git(repo, "rev-parse", "HEAD"), head);
      assert.equal(yield* git(repo, "status", "--porcelain"), status);
      assert.equal(yield* git(repo, "ls-files", "-s"), index);
      assert.equal(yield* git(repo, "rev-parse", "origin/main"), commit);
      assert.equal(yield* git(repo, "rev-parse", "main"), head);

      yield* git(other, "pull", "--ff-only");
      assert.equal(yield* fs.readFileString(path.join(other, "champions/new.md")), "new\n");
      assert.equal(yield* fs.readFileString(path.join(other, "champions/two.md")), "two edited\n");
      assert.isFalse(yield* fs.exists(path.join(other, "champions/a/one.md")));
      assert.equal(yield* fs.readFileString(path.join(other, "notes.md")), "notes\n");
      assert.equal(yield* fs.readFileString(path.join(other, "AGENTS.md")), "rules\n");
    }).pipe(Effect.scoped),
  );

  it.effect("returns null when nothing changes", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;
      const base = yield* AgentConfigGit.fetchMain(repo);
      assert.isNull(
        yield* AgentConfigGit.commitChanges(repo, {
          base,
          message: "noop",
          changes: [
            { path: "champions/two.md", content: "two é\n" },
            { path: "champions/gone.md", content: null },
          ],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a stale push and publish retries on the new main", () =>
    Effect.gen(function* () {
      const { fs, path, repo, other } = yield* setup;
      const base = yield* AgentConfigGit.fetchMain(repo);
      const stale = yield* AgentConfigGit.commitChanges(repo, {
        base,
        message: "mine",
        changes: [{ path: "champions/mine.md", content: "mine\n" }],
      });
      yield* fs.writeFileString(path.join(other, "champions/theirs.md"), "theirs\n");
      yield* git(other, "add", ".");
      yield* git(other, "commit", "-m", "theirs");
      yield* git(other, "push", "origin", "HEAD:main");
      assert.equal(yield* AgentConfigGit.pushToMain(repo, stale!), "rejected");

      let calls = 0;
      const result = yield* AgentConfigGit.publish(repo, {
        prefix: "champions/",
        message: "mine",
        changes: (files) =>
          Effect.sync(() => {
            calls += 1;
            return [{ path: "champions/mine.md", content: `mine ${files.length}\n` }];
          }),
      });
      assert.equal(result.outcome, "pushed");
      assert.equal(calls, 1);
      yield* git(other, "pull", "--ff-only");
      assert.equal(yield* fs.readFileString(path.join(other, "champions/theirs.md")), "theirs\n");
      assert.equal(yield* fs.readFileString(path.join(other, "champions/mine.md")), "mine 3\n");

      const again = yield* AgentConfigGit.publish(repo, {
        prefix: "champions/",
        message: "same",
        changes: () => Effect.succeed([{ path: "champions/mine.md", content: "mine 3\n" }]),
      });
      assert.equal(again.outcome, "unchanged");
    }).pipe(Effect.scoped),
  );
});
