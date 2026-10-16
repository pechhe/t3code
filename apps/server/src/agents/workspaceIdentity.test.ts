import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "../processRunner.ts";
import { checkoutRoot } from "./workspaceIdentity.ts";

const gitTopLevel = (stdout: string) =>
  Layer.mock(Processes.ProcessRunner)({
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

it.layer(NodeServices.layer)("workspaceIdentity.checkoutRoot", (it) => {
  it.effect("resolves a subdirectory of a jj checkout to the checkout root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(`${root}/.jj`);
      yield* fs.makeDirectory(`${root}/apps/web`, { recursive: true });
      expect(yield* checkoutRoot(`${root}/apps/web`).pipe(Effect.provide(gitTopLevel("")))).toBe(
        root,
      );
    }),
  );

  it.effect("keeps a Git-only repository nested in a jj checkout as its own root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outer = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(`${outer}/.jj`);
      const nested = `${outer}/clones/project`;
      yield* fs.makeDirectory(`${nested}/.git`, { recursive: true });
      yield* fs.makeDirectory(`${nested}/src`);
      // Git reports the nested repository's own top level, as it would for a real clone.
      for (const directory of [nested, `${nested}/src`]) {
        expect(
          yield* checkoutRoot(directory).pipe(Effect.provide(gitTopLevel(`${nested}\n`))),
        ).toBe(nested);
      }
    }),
  );
});
