import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

/** @public */
const makeAtDirectory = Effect.fn(function* (secretsDir: string) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fileSystem.makeDirectory(secretsDir, { recursive: true });
  yield* fileSystem.chmod(secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${secretsDir}`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(secretsDir, `${name}.bin`);

  // Some readers check a secret on every thread event, and each read queues on Node's I/O pool.
  // Another process (the `t3 connect` CLI) can rewrite these files, so reads are cached only
  // while the directory watcher runs, and any change in the directory clears the cache.
  const cache = new Map<string, Option.Option<Uint8Array>>();
  let cacheGeneration = 0;
  let watching = false;
  const forget = () => {
    cacheGeneration += 1;
    cache.clear();
  };
  yield* fileSystem.watch(secretsDir).pipe(
    Stream.runForEach(() => Effect.sync(forget)),
    Effect.catchCause((cause) => Effect.logWarning("secret cache disabled", { cause })),
    Effect.ensuring(
      Effect.sync(() => {
        watching = false;
        forget();
      }),
    ),
    Effect.forkScoped,
  );
  watching = true;

  const readSecret = (name: string) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(
              new SecretStoreReadError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    Effect.suspend(() => {
      const cached = cache.get(name);
      if (cached !== undefined) {
        return Effect.succeed(Option.map(cached, (bytes) => Uint8Array.from(bytes)));
      }
      const generation = cacheGeneration;
      return readSecret(name).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (watching && generation === cacheGeneration) {
              cache.set(
                name,
                Option.map(value, (bytes) => Uint8Array.from(bytes)),
              );
            }
          }),
        ),
      );
    });

  const set: ServerSecretStore["Service"]["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
      Effect.flatMap((uuid) => {
        const tempPath = `${secretPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* fileSystem.writeFile(tempPath, value);
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.rename(tempPath, secretPath);
          yield* fileSystem.chmod(secretPath, 0o600);
        }).pipe(
          Effect.catch((cause) =>
            fileSystem.remove(tempPath).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      }),
      Effect.ensuring(Effect.sync(forget)),
      Effect.withSpan("ServerSecretStore.set"),
    );
  };

  // `link` publishes the fully written temp file under the final name, or fails with
  // AlreadyExists, so a concurrent reader never observes a partially written secret.
  const create: ServerSecretStore["Service"]["create"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
      Effect.flatMap((uuid) => {
        const tempPath = `${secretPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(value);
              yield* file.sync;
            }),
          );
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.link(tempPath, secretPath);
        }).pipe(
          Effect.ensuring(fileSystem.remove(tempPath).pipe(Effect.ignore)),
          Effect.mapError(
            (cause) =>
              new SecretStorePersistError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
        );
      }),
      Effect.ensuring(Effect.sync(forget)),
    );
  };

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.ensuring(Effect.sync(forget)),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  return ServerSecretStore.of({
    directory: secretsDir,
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* makeAtDirectory(config.secretsDir);
});
export const layer = Layer.effect(ServerSecretStore, make);
/** Uses the same secure file store for an independent client credential directory. */
export const layerAtDirectory = (directory: string) =>
  Layer.effect(ServerSecretStore, makeAtDirectory(directory));
