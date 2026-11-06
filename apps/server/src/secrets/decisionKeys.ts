import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BitwardenSecrets from "./BitwardenSecrets.ts";

const JEV_SLOT = "decision-api-key-jev";
const CACHE_MS = 10 * 60_000;

/**
 * The secret store DecisionService sees on an installed server: an empty Jev slot is filled from
 * `TYPESAFE_API_KEY` in Bitwarden Secrets, unless the environment already sets it. Kept out of
 * `decisions/` because retained evaluation runs pin that directory's files.
 */
export const layerSecretStore = Layer.effect(
  ServerSecretStore.ServerSecretStore,
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const bitwarden = yield* BitwardenSecrets.BitwardenSecrets;
    const environment = yield* Config.option(Config.Redacted("TYPESAFE_API_KEY")).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    const environmentSet = Option.isSome(environment) && !!Redacted.value(environment.value).trim();
    let cached: { readonly key: Redacted.Redacted<Uint8Array>; readonly at: number } | undefined;
    const fromBitwarden = Effect.gen(function* () {
      if (environmentSet) return Option.none<Uint8Array>();
      const now = yield* Clock.currentTimeMillis;
      if (cached && now - cached.at < CACHE_MS) return Option.some(Redacted.value(cached.key));
      const read = yield* bitwarden
        .read("TYPESAFE_API_KEY")
        .pipe(Effect.orElseSucceed(() => Option.none<string>()));
      if (Option.isNone(read)) return Option.none<Uint8Array>();
      const key = new TextEncoder().encode(read.value);
      cached = { key: Redacted.make(key), at: now };
      return Option.some(key);
    });
    const get = Effect.fn("DecisionKeys.get")(function* (name: string) {
      const stored = yield* store.get(name);
      if (name !== JEV_SLOT || Option.isSome(stored)) return stored;
      return yield* fromBitwarden;
    });
    return ServerSecretStore.ServerSecretStore.of({ ...store, get });
  }),
);
