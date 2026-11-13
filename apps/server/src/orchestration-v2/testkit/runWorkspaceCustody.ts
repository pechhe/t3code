import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Custody from "../RunWorkspaceCustody.ts";

/** These provider fixtures have no SlipJay checkout or external cleanup authority. */
export const layerNonSlipJay = Layer.succeed(Custody.RunWorkspaceCustody, {
  admit: () => Effect.void,
  register: () => Effect.void,
  acknowledge: () => Effect.void,
  settle: () => Effect.void,
  endAdmission: () => Effect.void,
  recover: () => Effect.void,
});

/** Delivery and watch fixtures model named checkouts without creating host-level paths. */
export const layerSyntheticWorkspaces = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => ({
    ...fs,
    exists: (path: string) =>
      path.startsWith("/workspace/") || path.startsWith("/workspaces/")
        ? Effect.succeed(true)
        : fs.exists(path),
  })),
).pipe(Layer.provide(NodeFileSystem.layer));
