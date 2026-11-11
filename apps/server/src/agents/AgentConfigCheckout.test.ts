import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";

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

const configure = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, "config", "user.email", "test@example.com");
    yield* git(cwd, "config", "user.name", "Test");
  });

it.layer(layer)("AgentConfigCheckout", (it) => {
  it.effect("reports HEAD, uncommitted changes and the commits behind origin/main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-checkout-" });
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-origin-" });
      yield* git(repo, "init", "-b", "main");
      yield* configure(repo);
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "v1");
      yield* git(repo, "add", "AGENTS.md");
      yield* git(repo, "commit", "-m", "v1");
      const installed = yield* git(repo, "rev-parse", "HEAD");
      yield* git(remote, "init", "--bare", "-b", "main");
      yield* git(repo, "remote", "add", "origin", remote);
      yield* git(repo, "push", "origin", "HEAD:main");

      // Someone else pushes two commits to main; this checkout stays on v1.
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-other-" });
      yield* git(other, "clone", remote, ".");
      yield* configure(other);
      for (const version of ["v2", "v3"]) {
        yield* fs.writeFileString(path.join(other, "AGENTS.md"), version);
        yield* git(other, "commit", "-am", version);
      }
      yield* git(other, "push", "origin", "HEAD:main");
      yield* git(repo, "fetch", "origin");

      const clean = yield* AgentConfigCheckout.read(repo);
      assert.equal(clean.revision, installed);
      assert.equal(clean.workingCopyRevision, installed);
      assert.isFalse(clean.hasLocalChanges);
      assert.equal(yield* AgentConfigCheckout.commitsBehindMain(repo), 2);

      // An edit the checkout has not committed still counts as unlanded.
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "local edit");
      assert.isTrue((yield* AgentConfigCheckout.read(repo)).hasLocalChanges);
    }).pipe(Effect.scoped),
  );

  it.effect("publishes a save whose identical change another checkout already pushed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-origin-" });
      yield* git(remote, "init", "--bare", "-b", "main");
      const clone = (prefix: string) =>
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix });
          yield* git(dir, "clone", remote, ".");
          yield* configure(dir);
          yield* git(dir, "checkout", "-B", "main");
          return dir;
        });
      const seed = yield* clone("agent-config-seed-");
      yield* fs.makeDirectory(path.join(seed, "roles"));
      yield* fs.writeFileString(path.join(seed, "roles/policy.json"), "v1");
      yield* git(seed, "add", "roles/policy.json");
      yield* git(seed, "commit", "-m", "v1");
      yield* git(seed, "push", "origin", "HEAD:main");

      const first = yield* clone("agent-config-first-");
      const second = yield* clone("agent-config-second-");
      for (const checkout of [first, second]) {
        yield* fs.writeFileString(path.join(checkout, "roles/policy.json"), "v2");
      }
      assert.deepEqual(yield* AgentConfigCheckout.publishPolicy(first, "2"), {
        pushed: true,
        detail: null,
      });
      assert.deepEqual(yield* AgentConfigCheckout.publishPolicy(second, "2"), {
        pushed: true,
        detail: null,
      });
      assert.equal(
        yield* git(second, "rev-parse", "HEAD"),
        yield* git(remote, "rev-parse", "main"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unavailable checkout as unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-plain-" });
      assert.deepEqual(yield* AgentConfigCheckout.read(plain), {
        root: plain,
        revision: null,
        workingCopyRevision: null,
        hasLocalChanges: null,
      });
      assert.isNull(yield* AgentConfigCheckout.commitsBehindMain(plain));
    }).pipe(Effect.scoped),
  );
});
