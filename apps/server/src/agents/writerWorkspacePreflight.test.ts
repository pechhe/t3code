import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { checkWriterWorkspace } from "./writerWorkspacePreflight.ts";

it.layer(NodeServices.layer)("writer workspace alias guard", (it) => {
  it.effect("rejects nested multiply linked regular files and identifies the alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/workspace/nested`, { recursive: true });
      yield* fs.writeFileString(`${root}/outside`, "preserve");
      const alias = `${root}/workspace/nested/alias`;
      yield* fs.link(`${root}/outside`, alias);
      const result = yield* checkWriterWorkspace(`${root}/workspace`).pipe(Effect.flip);
      expect(result.reason).toBe("hard-link");
      expect(result.path).toBe(alias);
      expect(yield* fs.readFileString(`${root}/outside`)).toBe("preserve");
    }),
  );
  it.effect(
    "skips hard-linked version-control and package stores but still guards source beside them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${root}/store`, "shared");
        for (const store of [
          ".git/objects",
          ".jj/repo",
          "node_modules/pkg",
          "packages/app/node_modules/pkg",
        ]) {
          yield* fs.makeDirectory(`${root}/workspace/${store}`, { recursive: true });
          yield* fs.link(`${root}/store`, `${root}/workspace/${store}/linked`);
        }
        yield* checkWriterWorkspace(`${root}/workspace`);
        const alias = `${root}/workspace/packages/app/src.ts`;
        yield* fs.link(`${root}/store`, alias);
        expect((yield* checkWriterWorkspace(`${root}/workspace`).pipe(Effect.flip)).path).toBe(
          alias,
        );
      }),
  );
  it.effect("accepts ordinary files without following dangling, cyclic or outside symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/workspace`);
      yield* fs.writeFileString(`${root}/outside`, "preserve");
      yield* fs.link(`${root}/outside`, `${root}/outside-alias`);
      yield* fs.writeFileString(`${root}/workspace/plain`, "ordinary");
      for (const [name, target] of [
        ["dangling", `${root}/absent`],
        ["cycle", `${root}/workspace`],
        ["outside", `${root}/outside`],
      ])
        yield* fs.symlink(target!, `${root}/workspace/${name}`);
      yield* checkWriterWorkspace(`${root}/workspace`);
    }),
  );
  it.effect("fails closed if a directory cannot be scanned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const error = yield* checkWriterWorkspace(`${root}/missing`).pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
      expect(error.path).toBe(`${root}/missing`);
    }),
  );
});
