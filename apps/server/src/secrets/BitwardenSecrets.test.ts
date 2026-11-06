import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as BitwardenSecrets from "./BitwardenSecrets.ts";

const read = (stdout: string, code = 0, key = "TYPESAFE_API_KEY") => {
  const argv: Array<ReadonlyArray<string>> = [];
  const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        argv.push([input.command, ...input.args]);
        return {
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  return BitwardenSecrets.BitwardenSecrets.pipe(
    Effect.flatMap((secrets) => secrets.read(key)),
    Effect.provide(
      BitwardenSecrets.layer.pipe(
        Layer.provide(runner),
        Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin" })),
      ),
    ),
    Effect.map((value) => ({ value, argv })),
  );
};

const listing = JSON.stringify([
  { key: "OTHER", value: "synthetic-other" },
  { key: "TYPESAFE_API_KEY", value: " synthetic-jev \n" },
]);

it.effect("returns the named value, trimmed, without putting a key in argv", () =>
  Effect.gen(function* () {
    const { value, argv } = yield* read(listing);
    expect(value).toEqual(Option.some("synthetic-jev"));
    expect(argv).toEqual([["bws", "secret", "list"]]);
  }),
);

it.effect("returns none for a missing or blank value", () =>
  Effect.gen(function* () {
    expect((yield* read(listing, 0, "ABSENT")).value).toEqual(Option.none());
    const blank = JSON.stringify([{ key: "TYPESAFE_API_KEY", value: "  " }]);
    expect((yield* read(blank)).value).toEqual(Option.none());
  }),
);

it.effect("fails without quoting the listing when bws fails or prints something else", () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(read(listing, 1));
    expect(failed._tag).toBe("BitwardenSecretsError");
    const garbled = yield* Effect.flip(read('[{"key":"TYPESAFE_API_KEY","value":"synthetic-jev"'));
    expect(JSON.stringify(garbled)).not.toContain("synthetic-jev");
    expect(String(garbled.cause)).not.toContain("synthetic-jev");
  }),
);

it.effect("names a host without bws apart from a failing store", () =>
  Effect.gen(function* () {
    const missing = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("PlatformError: NotFound: ChildProcess.spawn (bws)"),
          }),
        ),
    });
    const error = yield* BitwardenSecrets.BitwardenSecrets.pipe(
      Effect.flatMap((secrets) => secrets.read("TYPESAFE_API_KEY")),
      Effect.flip,
      Effect.provide(
        BitwardenSecrets.layer.pipe(
          Layer.provide(missing),
          Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin" })),
        ),
      ),
    );
    expect(error.reason).toBe("not-installed");
    expect((yield* Effect.flip(read(listing, 1))).reason).toBe("failed");
  }),
);
