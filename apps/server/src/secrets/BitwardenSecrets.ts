import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

export class BitwardenSecretsError extends Schema.TaggedError<BitwardenSecretsError>()(
  "BitwardenSecretsError",
  {
    /** `not-installed`: this host has no `bws`, as on a fork that never set one up. */
    reason: Schema.Literals(["not-installed", "failed"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.reason === "not-installed"
      ? "Bitwarden Secrets Manager's bws is not installed on this server."
      : "Bitwarden Secrets could not be read.";
  }
}

export interface SecretEntry {
  readonly key: string;
  readonly value: string;
  readonly note: string;
}

/** Runtime secrets held in Bitwarden Secrets Manager, read through the host's `bws` wrapper. */
export class BitwardenSecrets extends Context.Service<
  BitwardenSecrets,
  {
    readonly read: (key: string) => Effect.Effect<Option.Option<string>, BitwardenSecretsError>;
    /**
     * Lists the store and keeps only what `select` returns: every other value is dropped with
     * the listing, so a caller never holds a secret it did not ask for.
     */
    readonly select: <A>(
      select: (entries: ReadonlyArray<SecretEntry>) => A,
    ) => Effect.Effect<A, BitwardenSecretsError>;
  }
>()("t3/secrets/BitwardenSecrets") {}

const decodeSecrets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        value: Schema.String,
        note: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
);

const failed = (cause: unknown) => new BitwardenSecretsError({ reason: "failed", cause });

export const layer = Layer.effect(
  BitwardenSecrets,
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const select = Effect.fn("BitwardenSecrets.select")(function* <A>(
      pick: (entries: ReadonlyArray<SecretEntry>) => A,
    ) {
      const home = NodeOS.homedir();
      const environment = yield* HostProcess.Environment;
      // Values reach this process only through stdout; never put a key in argv or a log.
      const result = yield* processes
        .run({
          command: "bws",
          args: ["secret", "list"],
          timeout: "30 seconds",
          env: {
            ...environment,
            PATH: `${home}/.local/bin:${home}/.bun/bin:${home}/.local/share/bws/bin:/opt/homebrew/bin:/usr/local/bin:${environment.PATH ?? ""}`,
          },
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            // The platform reports a missing executable as `NotFound`; Node's own code is ENOENT.
            cause._tag === "ProcessSpawnError" && /NotFound|ENOENT/.test(String(cause.cause))
              ? new BitwardenSecretsError({ reason: "not-installed", cause })
              : failed(cause),
          ),
        );
      if (result.code !== 0) return yield* failed(new Error("bws failed"));
      // A decode error quotes its input, which holds every value: keep it out of the cause.
      const secrets = yield* decodeSecrets(result.stdout).pipe(
        Effect.mapError(() => failed(new Error("bws output was not a list"))),
      );
      return pick(secrets.map(({ key, value, note }) => ({ key, value, note: note ?? "" })));
    });
    const read = Effect.fn("BitwardenSecrets.read")(function* (key: string) {
      return yield* select((secrets) => {
        const value = secrets.find((secret) => secret.key === key)?.value.trim();
        return value ? Option.some(value) : Option.none<string>();
      });
    });
    return BitwardenSecrets.of({ select, read });
  }),
);
