import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProviderInstanceConfigMap } from "./providerInstance.ts";
import {
  ModelFavorites,
  ProviderModelPreferences,
  ServerSettings,
  ServerSettingsError,
} from "./settings.ts";

export const SHARED_PROVIDER_SETUP_WS_METHODS = {
  serverApplySharedProviderSetup: "server.applySharedProviderSetup",
  serverApplySharedModelPreferences: "server.applySharedModelPreferences",
  serverSetProviderSetupSharing: "server.setProviderSetupSharing",
} as const;

export const WsServerApplySharedProviderSetupRpc = Rpc.make(
  SHARED_PROVIDER_SETUP_WS_METHODS.serverApplySharedProviderSetup,
  {
    payload: Schema.Struct({
      instances: ProviderInstanceConfigMap,
      version: Schema.Number,
      changedAt: Schema.String,
      /** Refuses the write if this environment changed after the client planned it. */
      expectedDigest: Schema.String,
      join: Schema.Boolean,
    }),
    success: ServerSettings,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  },
);

export const WsServerApplySharedModelPreferencesRpc = Rpc.make(
  SHARED_PROVIDER_SETUP_WS_METHODS.serverApplySharedModelPreferences,
  {
    payload: Schema.Struct({
      favorites: Schema.NullOr(ModelFavorites),
      providerModelPreferences: Schema.NullOr(ProviderModelPreferences),
      version: Schema.Number,
      changedAt: Schema.String,
      /** Refuses the write if this environment's model preferences changed after the client planned it. */
      expectedDigest: Schema.String,
    }),
    success: ServerSettings,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  },
);

export const WsServerSetProviderSetupSharingRpc = Rpc.make(
  SHARED_PROVIDER_SETUP_WS_METHODS.serverSetProviderSetupSharing,
  {
    payload: Schema.Struct({ shared: Schema.Boolean }),
    success: ServerSettings,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  },
);
