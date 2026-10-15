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
  it.effect(
    "accepts sources hard-linked only into pnpm's install of a local file: dependency",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const workspace = `${root}/workspace`;
        const source = `${workspace}/modules/native/index.ts`;
        yield* fs.makeDirectory(`${workspace}/modules/native`, { recursive: true });
        yield* fs.writeFileString(source, "source");
        const installed = `${workspace}/node_modules/.pnpm/native@file+modules+native/node_modules/native`;
        yield* fs.makeDirectory(installed, { recursive: true });
        yield* fs.link(source, `${installed}/index.ts`);
        yield* checkWriterWorkspace(workspace);

        yield* fs.link(source, `${root}/outside`);
        expect((yield* checkWriterWorkspace(workspace).pipe(Effect.flip)).path).toBe(source);
      }),
  );
  it.effect("does not count links reached through a symlinked store or store entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const symlinked of ["entry", "store"] as const) {
        const root = yield* fs.makeTempDirectoryScoped();
        const workspace = `${root}/workspace`;
        const source = `${workspace}/src.ts`;
        yield* fs.makeDirectory(`${root}/outside/native`, { recursive: true });
        yield* fs.makeDirectory(`${workspace}/node_modules`, { recursive: true });
        yield* fs.writeFileString(source, "source");
        yield* fs.link(source, `${root}/outside/native/index.ts`);
        if (symlinked === "entry") {
          yield* fs.makeDirectory(`${workspace}/node_modules/.pnpm`);
          yield* fs.symlink(
            `${root}/outside/native`,
            `${workspace}/node_modules/.pnpm/native@file+native`,
          );
        } else {
          yield* fs.makeDirectory(`${root}/outside/store`);
          yield* fs.symlink(`${root}/outside/native`, `${root}/outside/store/native@file+native`);
          yield* fs.symlink(`${root}/outside/store`, `${workspace}/node_modules/.pnpm`);
        }
        expect((yield* checkWriterWorkspace(workspace).pipe(Effect.flip)).path).toBe(source);
      }
    }),
  );
  it.effect("still refuses sources hard-linked into other pnpm store entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const workspace = `${root}/workspace`;
      const source = `${workspace}/src.ts`;
      yield* fs.makeDirectory(`${workspace}/node_modules/.pnpm/pkg@1.0.0`, { recursive: true });
      yield* fs.writeFileString(source, "source");
      yield* fs.link(source, `${workspace}/node_modules/.pnpm/pkg@1.0.0/src.ts`);
      expect((yield* checkWriterWorkspace(workspace).pipe(Effect.flip)).path).toBe(source);
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
