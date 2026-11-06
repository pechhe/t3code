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
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Bitwarden Secrets could not be read.";
  }
}

/** Runtime secrets held in Bitwarden Secrets Manager, read through the host's `bws` wrapper. */
export class BitwardenSecrets extends Context.Service<
  BitwardenSecrets,
  {
    readonly read: (key: string) => Effect.Effect<Option.Option<string>, BitwardenSecretsError>;
  }
>()("t3/secrets/BitwardenSecrets") {}

const decodeSecrets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
);

export const layer = Layer.effect(
  BitwardenSecrets,
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    return BitwardenSecrets.of({
      read: Effect.fn("BitwardenSecrets.read")(function* (key: string) {
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
          .pipe(Effect.mapError((cause) => new BitwardenSecretsError({ cause })));
        if (result.code !== 0)
          return yield* new BitwardenSecretsError({ cause: new Error("bws failed") });
        // A decode error quotes its input, which holds every value: keep it out of the cause.
        const secrets = yield* decodeSecrets(result.stdout).pipe(
          Effect.mapError(
            () => new BitwardenSecretsError({ cause: new Error("bws output was not a list") }),
          ),
        );
        const value = secrets.find((secret) => secret.key === key)?.value.trim();
        return value ? Option.some(value) : Option.none();
      }),
    });
  }),
);
