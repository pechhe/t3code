import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { makeCodexUsageCredentialReader } from "./codexUsageIdentity.ts";

it.effect("identifies the probed shadow account independently of shared credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const sharedHomePath = path.join(root, "shared");
    const effectiveHomePath = path.join(root, "shadow");
    yield* fs.makeDirectory(sharedHomePath);
    yield* fs.makeDirectory(effectiveHomePath);
    const shared = path.join(sharedHomePath, "auth.json");
    const shadow = path.join(effectiveHomePath, "auth.json");
    yield* fs.writeFileString(shared, "shared-account");
    yield* fs.writeFileString(shadow, "shadow-account");
    const layout = {
      mode: "authOverlay" as const,
      sharedHomePath,
      effectiveHomePath,
      continuationKey: "shared",
    };
    const read = yield* makeCodexUsageCredentialReader(layout);
    const first = yield* read;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    yield* fs.writeFileString(shared, "another-shared-account");
    expect(yield* read).toBe(first);
    yield* fs.writeFileString(shadow, "another-shadow-account");
    expect(yield* read).not.toBe(first);
    const direct = yield* makeCodexUsageCredentialReader({
      ...layout,
      mode: "direct",
      effectiveHomePath: undefined,
    });
    expect(yield* direct).not.toBe(yield* read);
    yield* fs.remove(shadow);
    expect(yield* read).toBeUndefined();
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
