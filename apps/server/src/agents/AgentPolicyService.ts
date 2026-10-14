import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest, AgentPolicySnapshot } from "@t3tools/contracts";

export class AgentPolicyLoadError extends Schema.TaggedError<AgentPolicyLoadError>()(
  "AgentPolicyLoadError",
  {
    reason: Schema.Literals(["read", "invalid", "outside-root", "too-large"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to load agent policy (${this.reason}).`;
  }
}

export class AgentPolicyService extends Context.Service<
  AgentPolicyService,
  {
    readonly snapshot: (
      sourceRoot: string,
    ) => Effect.Effect<AgentPolicySnapshot, AgentPolicyLoadError>;
  }
>()("t3/agents/AgentPolicyService") {}

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(AgentPolicyManifest));
const decodeSnapshot = Schema.decodeUnknownEffect(AgentPolicySnapshot);
function freeze<A>(value: A): A {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hash = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  return AgentPolicyService.of({
    snapshot: Effect.fn("AgentPolicyService.snapshot")(function* (sourceRoot) {
      const root = yield* fs
        .realPath(sourceRoot)
        .pipe(Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "read", cause })));
      const read = Effect.fn(function* (relative: string) {
        const file = yield* fs
          .realPath(path.join(root, relative))
          .pipe(Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "read", cause })));
        if (!file.startsWith(root + path.sep)) {
          return yield* new AgentPolicyLoadError({ reason: "outside-root" });
        }
        const stat = yield* fs
          .stat(file)
          .pipe(Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "read", cause })));
        if (stat.size > 65_536n) return yield* new AgentPolicyLoadError({ reason: "too-large" });
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "read", cause })));
        if (Buffer.byteLength(text) > 65_536)
          return yield* new AgentPolicyLoadError({ reason: "too-large" });
        return text;
      });
      const manifestText = yield* read("roles/policy.json");
      const manifest = yield* decodeManifest(manifestText).pipe(
        Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "invalid", cause })),
      );
      const entries = yield* Effect.forEach(Object.entries(manifest.roles), ([role, policy]) =>
        Effect.gen(function* () {
          const text = yield* read(policy.brief);
          return [role, { hash: yield* hash(text), text }] as const;
        }),
      );
      // Content identity includes every brief, not just the user-maintained revision label.
      const snapshot = yield* decodeSnapshot({
        hash: yield* hash(
          [
            yield* hash(manifestText),
            ...entries.map(([role, brief]) => `${role}:${brief.hash}`),
          ].join("\n"),
        ),
        sourceRevision: manifest.revision,
        manifest,
        briefs: Object.fromEntries(entries),
      }).pipe(Effect.mapError((cause) => new AgentPolicyLoadError({ reason: "invalid", cause })));
      return freeze(snapshot);
    }),
  });
});

export const layer = Layer.effect(AgentPolicyService, make);
