import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "./SlipJayProject.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const jj = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const output = yield* processes.run({ command: "jj", args, cwd, timeout: "30 seconds" });
    assert.equal(output.code, 0, output.stderr);
  });

it.layer(layer)("findSlipJayProject", (it) => {
  it.effect(
    "reads the policy committed on SlipJay's integration bookmark when the checkout predates it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* fs.makeTempDirectoryScoped();
        yield* jj(repo, "git", "init", "--no-colocate", ".");
        yield* jj(repo, "config", "set", "--repo", "user.email", "test@example.com");
        yield* jj(repo, "config", "set", "--repo", "user.name", "Test");
        // Nothing is committed on an integration bookmark yet: an ordinary Jujutsu repository.
        assert.isNull(yield* findSlipJayProject(repo));

        yield* fs.writeFileString(
          `${repo}/slipjay.json`,
          JSON.stringify({ integrationBranch: "dev", remote: "upstream" }),
        );
        yield* jj(repo, "commit", "-m", "adopt SlipJay");
        yield* jj(repo, "bookmark", "create", "dev", "-r", "@-");
        yield* jj(repo, "new", "root()");
        assert.isFalse(yield* fs.exists(`${repo}/slipjay.json`));
        // Only origin/HEAD names `dev`; neither main nor master exists.
        assert.isNull(yield* findSlipJayProject(repo));
        const processes = yield* ProcessRunner.ProcessRunner;
        const gitDir = (yield* processes.run({
          command: "jj",
          args: ["git", "root"],
          cwd: repo,
        })).stdout.trim();
        yield* processes.run({
          command: "git",
          args: [
            "--git-dir",
            gitDir,
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/dev",
          ],
          cwd: repo,
        });
        // jj's own trunk() pointing elsewhere does not matter.
        yield* jj(repo, "config", "set", "--repo", 'revset-aliases."trunk()"', "root()");

        const expected = {
          root: repo,
          integration: "dev",
          hasReleaseBranch: false,
          remote: "upstream",
        };
        assert.deepEqual(yield* findSlipJayProject(repo), expected);

        // Without origin/HEAD, `main` is next.
        yield* processes.run({
          command: "git",
          args: ["--git-dir", gitDir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
          cwd: repo,
        });
        assert.isNull(yield* findSlipJayProject(repo));
        yield* jj(repo, "bookmark", "rename", "dev", "main");
        assert.deepEqual(yield* findSlipJayProject(repo), expected);
      }),
  );
});
