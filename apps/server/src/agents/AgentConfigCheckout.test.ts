import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const jj = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const output = yield* processes.run({ command: "jj", args, cwd, timeout: "30 seconds" });
    assert.equal(output.code, 0, output.stderr);
    return output.stdout.trim();
  });

it.layer(layer)("AgentConfigCheckout", (it) => {
  it.effect("matches jj's revision, unlanded state and distance behind main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-checkout-" });
      yield* jj(repo, "git", "init", "--colocate", ".");
      yield* jj(repo, "config", "set", "--repo", "user.email", "test@example.com");
      yield* jj(repo, "config", "set", "--repo", "user.name", "Test");
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "v1");
      yield* jj(repo, "commit", "-m", "v1");
      const installed = yield* jj(repo, "log", "-r", "@-", "--no-graph", "-T", "commit_id");
      yield* jj(repo, "bookmark", "create", "main", "-r", "@-");
      // main moves on by two commits; the installed checkout stays on v1.
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "v2");
      yield* jj(repo, "commit", "-m", "v2");
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "v3");
      yield* jj(repo, "commit", "-m", "v3");
      yield* jj(repo, "bookmark", "set", "main", "-r", "@-");
      yield* jj(repo, "new", installed);

      const clean = yield* AgentConfigCheckout.read(repo);
      assert.equal(clean.revision, installed);
      assert.isFalse(clean.hasLocalChanges);
      assert.equal(yield* AgentConfigCheckout.commitsBehindMain(repo), 2);

      // An edit jj has not snapshotted yet still counts as unlanded.
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "local edit");
      assert.isTrue((yield* AgentConfigCheckout.read(repo)).hasLocalChanges);
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
