import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolvePiSdkEntry } from "./accountLogin.ts";

describe("resolvePiSdkEntry", () => {
  it.effect(
    "signs in with the Pi package on PATH when the configured binary is a compiled build",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-sdk-" });
        const pkg = `${root}/lib/node_modules/@earendil-works/pi-coding-agent`;
        yield* fs.makeDirectory(`${pkg}/dist`, { recursive: true });
        yield* fs.writeFileString(
          `${pkg}/package.json`,
          JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
        );
        yield* fs.writeFileString(`${pkg}/dist/index.js`, "export {};");
        yield* fs.writeFileString(`${pkg}/dist/cli.js`, "");
        yield* fs.makeDirectory(`${root}/bin`);
        yield* fs.symlink(`${pkg}/dist/cli.js`, `${root}/bin/pi`);
        yield* fs.makeDirectory(`${root}/bolt`);
        yield* fs.writeFileString(`${root}/bolt/pi-bolt`, "compiled");
        const environment = { PATH: `${root}/bolt:${root}/bin` };

        const entry = yield* resolvePiSdkEntry("pi-bolt", environment);
        expect(entry).toBe(`${yield* fs.realPath(pkg)}/dist/index.js`);
        expect(yield* resolvePiSdkEntry("pi-bolt", { PATH: `${root}/bolt` })).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
