import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BitwardenSecrets from "./BitwardenSecrets.ts";
import * as DecisionKeys from "./decisionKeys.ts";

const text = (value: Option.Option<Uint8Array>) =>
  Option.map(value, (bytes) => new TextDecoder().decode(bytes));

const setup = (options: {
  stored?: Record<string, string>;
  env?: Record<string, string>;
  bitwarden: string | null | "fails";
}) => {
  const reads: string[] = [];
  const store = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) =>
      Effect.succeed(
        Option.map(Option.fromNullishOr(options.stored?.[name]), (value) =>
          new TextEncoder().encode(value),
        ),
      ),
  });
  const bitwarden = Layer.succeed(BitwardenSecrets.BitwardenSecrets, {
    read: (key) =>
      Effect.suspend(() => {
        reads.push(key);
        return options.bitwarden === "fails"
          ? Effect.fail(new BitwardenSecrets.BitwardenSecretsError({ cause: new Error("bws") }))
          : Effect.succeed(Option.fromNullishOr(options.bitwarden));
      }),
  });
  return ServerSecretStore.ServerSecretStore.pipe(
    Effect.provide(
      DecisionKeys.layerSecretStore.pipe(
        Layer.provide(Layer.mergeAll(store, bitwarden)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.env ?? {}))),
      ),
    ),
    Effect.map((secrets) => ({ secrets, reads })),
  );
};

it.effect("fills an empty Jev slot from Bitwarden Secrets and reads it once", () =>
  Effect.gen(function* () {
    const { secrets, reads } = yield* setup({ bitwarden: "synthetic-jev" });
    expect(text(yield* secrets.get("decision-api-key-jev"))).toEqual(Option.some("synthetic-jev"));
    expect(text(yield* secrets.get("decision-api-key-jev"))).toEqual(Option.some("synthetic-jev"));
    expect(reads).toEqual(["TYPESAFE_API_KEY"]);
  }),
);

it.effect("keeps the stored key, the environment and every other slot ahead of Bitwarden", () =>
  Effect.gen(function* () {
    const stored = yield* setup({
      stored: { "decision-api-key-jev": "synthetic-stored" },
      bitwarden: "synthetic-jev",
    });
    expect(text(yield* stored.secrets.get("decision-api-key-jev"))).toEqual(
      Option.some("synthetic-stored"),
    );
    const env = yield* setup({ env: { TYPESAFE_API_KEY: "synthetic-env" }, bitwarden: "x" });
    expect(yield* env.secrets.get("decision-api-key-jev")).toEqual(Option.none());
    const luna = yield* setup({ bitwarden: "synthetic-jev" });
    expect(yield* luna.secrets.get("decision-api-key-luna")).toEqual(Option.none());
    expect([...stored.reads, ...env.reads, ...luna.reads]).toEqual([]);
  }),
);

it.effect("leaves the slot empty when Bitwarden has no key or cannot be read", () =>
  Effect.gen(function* () {
    for (const bitwarden of [null, "fails"] as const) {
      const { secrets } = yield* setup({ bitwarden });
      expect(yield* secrets.get("decision-api-key-jev")).toEqual(Option.none());
    }
  }),
);
