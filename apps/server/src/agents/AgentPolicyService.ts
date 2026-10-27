import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import { lock } from "proper-lockfile";
import { AgentPolicyManifest, AgentPolicySnapshot } from "@t3tools/contracts";

export class AgentPolicyLoadError extends Schema.TaggedError<AgentPolicyLoadError>()(
  "AgentPolicyLoadError",
  {
    reason: Schema.Literals(["read", "invalid", "outside-root", "too-large"]),
    /** The policy file the loader opened, relative to the policy root. */
    path: Schema.optional(Schema.String),
    /** Where in an invalid file decoding failed, as a JSON property path such as `["revision"]`. */
    field: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const file = this.path === undefined ? "" : ` ${this.path}`;
    const field = this.field === undefined ? "" : ` at ${this.field}`;
    return `Unable to load agent policy${file} (${this.reason})${field}`;
  }

  static invalid(path: string, cause: Schema.SchemaError): AgentPolicyLoadError {
    const field = issuePath(cause.issue);
    return new AgentPolicyLoadError({
      reason: "invalid",
      path,
      ...(field.length === 0 ? {} : { field: JSON.stringify(field.map(String)) }),
      cause,
    });
  }
}

/** The property path of the first failing issue, so a refusal can name the field without its text. */
function issuePath(issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> {
  switch (issue._tag) {
    case "Pointer":
      return [...issue.path, ...issuePath(issue.issue)];
    case "Filter":
    case "Encoding":
      return issuePath(issue.issue);
    case "Composite":
    case "AnyOf":
      return issue.issues.length === 0 ? [] : issuePath(issue.issues[0]!);
    default:
      return [];
  }
}

export class AgentPolicySaveError extends Schema.TaggedError<AgentPolicySaveError>()(
  "AgentPolicySaveError",
  {
    reason: Schema.Literals(["stale", "busy", "invalid", "too-large", "write"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "stale"
      ? "Agent policy changed since it was loaded. Reload it before saving."
      : this.reason === "busy"
        ? "Another policy save is in progress. Try again."
        : `Unable to save agent policy (${this.reason}).`;
  }
}

export class AgentPolicyService extends Context.Service<
  AgentPolicyService,
  {
    readonly snapshot: (
      sourceRoot: string,
    ) => Effect.Effect<AgentPolicySnapshot, AgentPolicyLoadError>;
    /** Internal file operation; an owner-client transport must authorize before calling it. */
    readonly save: (
      sourceRoot: string,
      edit: { readonly expectedHash: string; readonly manifest: unknown },
    ) => Effect.Effect<AgentPolicySnapshot, AgentPolicyLoadError | AgentPolicySaveError>;
  }
>()("t3/agents/AgentPolicyService") {}

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(AgentPolicyManifest));
const decodeEdit = Schema.decodeUnknownEffect(AgentPolicyManifest, { onExcessProperty: "error" });
const encodeManifest = Schema.encodeEffect(
  Schema.fromJsonString(AgentPolicyManifest, { space: 2 }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(AgentPolicySnapshot);
const manifestPath = "roles/policy.json";
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
  const edits = yield* Semaphore.make(1);
  const hash = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const rootPath = (sourceRoot: string) =>
    fs
      .realPath(sourceRoot)
      .pipe(
        Effect.mapError(
          (cause) => new AgentPolicyLoadError({ reason: "read", path: sourceRoot, cause }),
        ),
      );
  const filePath = Effect.fn(function* (root: string, relative: string) {
    const file = yield* fs
      .realPath(path.join(root, relative))
      .pipe(
        Effect.mapError(
          (cause) => new AgentPolicyLoadError({ reason: "read", path: relative, cause }),
        ),
      );
    if (!file.startsWith(root + path.sep)) {
      return yield* new AgentPolicyLoadError({ reason: "outside-root", path: relative });
    }
    return file;
  });
  const read = Effect.fn(function* (root: string, relative: string) {
    const file = yield* filePath(root, relative);
    const stat = yield* fs
      .stat(file)
      .pipe(
        Effect.mapError(
          (cause) => new AgentPolicyLoadError({ reason: "read", path: relative, cause }),
        ),
      );
    if (stat.size > 65_536n)
      return yield* new AgentPolicyLoadError({ reason: "too-large", path: relative });
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (cause) => new AgentPolicyLoadError({ reason: "read", path: relative, cause }),
        ),
      );
    if (Buffer.byteLength(text) > 65_536)
      return yield* new AgentPolicyLoadError({ reason: "too-large", path: relative });
    return text;
  });
  const load = Effect.fn(function* (root: string, proposedText?: string) {
    const manifestText = proposedText ?? (yield* read(root, manifestPath));
    const manifest = yield* decodeManifest(manifestText).pipe(
      Effect.mapError((cause) => AgentPolicyLoadError.invalid(manifestPath, cause)),
    );
    const entries = yield* Effect.forEach(Object.entries(manifest.roles), ([role, policy]) =>
      Effect.gen(function* () {
        const text = yield* read(root, policy.brief);
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
    }).pipe(Effect.mapError((cause) => AgentPolicyLoadError.invalid(manifestPath, cause)));
    return freeze(snapshot);
  });
  return AgentPolicyService.of({
    snapshot: Effect.fn("AgentPolicyService.snapshot")(function* (sourceRoot) {
      return yield* load(yield* rootPath(sourceRoot));
    }),
    save: Effect.fn("AgentPolicyService.save")(
      function* (sourceRoot, edit) {
        const root = yield* rootPath(sourceRoot);
        const current = yield* load(root);
        if (current.hash !== edit.expectedHash)
          return yield* new AgentPolicySaveError({ reason: "stale" });
        const proposed = yield* decodeEdit(edit.manifest).pipe(
          Effect.mapError((cause) => new AgentPolicySaveError({ reason: "invalid", cause })),
        );
        // Revision labels are opaque to consumers. Continue a numeric suffix when present,
        // otherwise append the first edit number; the caller cannot reuse its own label.
        const suffix = /^(.*)\.(\d+)$/.exec(current.sourceRevision);
        const revision = suffix
          ? `${suffix[1]}.${BigInt(suffix[2]!) + 1n}`
          : `${current.sourceRevision}.1`;
        const text =
          (yield* encodeManifest({ ...proposed, revision }).pipe(
            Effect.mapError((cause) => new AgentPolicySaveError({ reason: "invalid", cause })),
          )) + "\n";
        if (Buffer.byteLength(text) > 65_536)
          return yield* new AgentPolicySaveError({ reason: "too-large" });
        // Use the same loader and brief validation as a launch, before touching the source.
        const next = yield* load(root, text);
        const target = yield* filePath(root, manifestPath);
        const mode = (yield* fs
          .stat(target)
          .pipe(Effect.mapError((cause) => new AgentPolicySaveError({ reason: "write", cause }))))
          .mode;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // Multiple T3 environments may share agent-config on one machine. Use
            // the existing filesystem lock implementation as well as the local semaphore.
            let compromised: Error | undefined;
            yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  lock(target, {
                    realpath: false,
                    retries: 0,
                    stale: 30_000,
                    onCompromised: (error) => {
                      compromised = error;
                    },
                  }),
                catch: (cause) =>
                  new AgentPolicySaveError({
                    reason:
                      typeof cause === "object" &&
                      cause !== null &&
                      "code" in cause &&
                      cause.code === "ELOCKED"
                        ? "busy"
                        : "write",
                    cause,
                  }),
              }),
              (release) => Effect.promise(() => release()).pipe(Effect.ignore),
            );
            const directory = yield* fs
              .makeTempDirectoryScoped({
                directory: path.dirname(target),
                prefix: ".policy-edit-",
              })
              .pipe(
                Effect.mapError((cause) => new AgentPolicySaveError({ reason: "write", cause })),
              );
            const staged = path.join(directory, "policy.json");
            yield* fs
              .writeFileString(staged, text)
              .pipe(
                Effect.mapError((cause) => new AgentPolicySaveError({ reason: "write", cause })),
              );
            yield* fs
              .chmod(staged, mode)
              .pipe(
                Effect.mapError((cause) => new AgentPolicySaveError({ reason: "write", cause })),
              );
            // Serialize editor saves and re-read after staging to catch external file/brief
            // edits. Rename publishes one complete file, never a truncated live policy.
            const latest = yield* load(root);
            if (
              latest.hash !== edit.expectedHash ||
              (yield* filePath(root, manifestPath)) !== target
            )
              return yield* new AgentPolicySaveError({ reason: "stale" });
            if (compromised !== undefined)
              return yield* new AgentPolicySaveError({ reason: "write", cause: compromised });
            yield* fs.rename(staged, target).pipe(
              Effect.mapError((cause) => new AgentPolicySaveError({ reason: "write", cause })),
              Effect.uninterruptible,
            );
            return next;
          }),
        );
      },
      (effect) => edits.withPermit(effect),
    ),
  });
});

export const layer = Layer.effect(AgentPolicyService, make);
