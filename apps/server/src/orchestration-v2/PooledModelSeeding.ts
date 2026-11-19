import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { seedPooledModelKeys } from "@t3tools/shared/accountPools";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AgentPolicy from "../agents/AgentPolicySettingsService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

export type RoleModel = {
  readonly driver: ProviderDriverKind;
  readonly model: string;
};

/** The models the policy's role lists use; a model it defines but no list names is left out. */
export const roleModels = (manifest: {
  readonly models: Readonly<
    Record<string, { readonly driverKind: ProviderDriverKind; readonly model: string }>
  >;
  readonly lists: Readonly<Record<string, ReadonlyArray<{ readonly model: string }>>>;
}): ReadonlyArray<RoleModel> =>
  Object.values(manifest.lists)
    .flat()
    .flatMap((entry) => {
      const binding = manifest.models[entry.model];
      return binding === undefined ? [] : [{ driver: binding.driverKind, model: binding.model }];
    });

/**
 * Pools the models in use the first time the server writes the list: the user's favorites and the
 * models their delegation roles name. Returns whether it wrote, so an already written list, including
 * one the user emptied, is left alone.
 */
export const seedPooledModelKeysOnce = Effect.fn("PooledModelSeeding.seedOnce")(function* (input: {
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly roles: () => Effect.Effect<ReadonlyArray<RoleModel>>;
}) {
  const current = yield* input.settings.getSettings;
  if (current.pooledModelKeys !== undefined) return false;
  const roles = yield* input.roles();
  yield* input.settings.updateSettings({
    pooledModelKeys: seedPooledModelKeys({
      providers: input.providers,
      favorites: current.favorites ?? [],
      roleModels: roles,
    }),
  });
  return true;
});

/**
 * Seeds a machine's pooled models. Providers load after settings, so an unseeded list waits for the
 * first snapshot that carries models rather than writing an empty one.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    if (Option.isNone(registry)) return;
    const roles = Effect.gen(function* () {
      const policy = yield* Effect.serviceOption(AgentPolicy.AgentPolicySettingsService);
      if (Option.isNone(policy)) return [];
      return yield* policy.value.read().pipe(
        Effect.map((snapshot) => roleModels(snapshot.snapshot.manifest)),
        Effect.orElseSucceed((): ReadonlyArray<RoleModel> => []),
      );
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<RoleModel> => []));
    const seed = Effect.fn("PooledModelSeeding.seed")(function* (
      providers: ReadonlyArray<ServerProvider>,
    ) {
      if (!providers.some((provider) => provider.models.length > 0)) return false;
      return yield* seedPooledModelKeysOnce({ settings, providers, roles: () => roles });
    });
    const written = yield* registry.value.getProviders.pipe(
      Effect.flatMap(seed),
      Effect.orElseSucceed(() => false),
    );
    if (written) return;
    yield* forkParked(
      registry.value.streamChanges.pipe(
        Stream.mapEffect(seed),
        Stream.takeUntil((seeded) => seeded),
        Stream.runDrain,
        Effect.catchCause((cause) => Effect.logWarning("Pooled models were not seeded", cause)),
      ),
    );
  }),
);
