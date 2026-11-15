import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import type { CodexHomeLayout } from "./CodexHomeLayout.ts";

export const makeCodexUsageCredentialReader = Effect.fn("makeCodexUsageCredentialReader")(
  function* (layout: CodexHomeLayout) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const file = path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
    return fs.readFile(file).pipe(
      Effect.flatMap((bytes) => digest.digest(Digest.sha256, bytes)),
      Effect.map(Hex.encode),
      Effect.orElseSucceed(() => undefined),
    );
  },
);
