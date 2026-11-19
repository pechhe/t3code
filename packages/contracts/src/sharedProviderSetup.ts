import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type { ServerSettings } from "./settings.ts";

/** Where this environment stands in the provider setup it shares with others. */
export const SharedProviderSetupState = Schema.Struct({
  shared: Schema.Boolean,
  /** Raised by each edit here, and taken from the winner when a setup is received. */
  version: Schema.Number,
  /** The version last agreed with others; lower than `version` while an edit is unspread. */
  baseVersion: Schema.Number,
  changedAt: Schema.String,
  digest: Schema.String,
  /** Per instance, the secrets its settings expect that this machine doesn't hold. */
  missingSecrets: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Recently removed instances, so a client still listing one can't bring it back. */
  removedInstanceIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Same monotonic version/baseVersion/changedAt/digest state for model favorites and preferences. */
  modelPreferencesVersion: Schema.optionalKey(Schema.Number),
  modelPreferencesBaseVersion: Schema.optionalKey(Schema.Number),
  modelPreferencesChangedAt: Schema.optionalKey(Schema.String),
  modelPreferencesDigest: Schema.optionalKey(Schema.String),
});
export type SharedProviderSetupState = typeof SharedProviderSetupState.Type;

/** A thread on an id that joining a shared setup renamed runs as the instance it was renamed to. */
export const currentProviderInstanceId = (
  settings: Pick<ServerSettings, "providerInstances"> &
    Partial<Pick<ServerSettings, "providerInstanceAliases">>,
  instanceId: ProviderInstanceId,
): ProviderInstanceId =>
  Object.hasOwn(settings.providerInstances, instanceId)
    ? instanceId
    : (settings.providerInstanceAliases?.[instanceId] ?? instanceId);

/** A project's own switch for an instance, and that instance, whichever alias its id arrived under. */
export const resolveProjectProviderInstanceOverride = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> &
    Partial<Pick<ServerSettings, "providerInstanceAliases">>,
  projectId: ProjectId | null,
  requestedInstanceId: ProviderInstanceId,
): { readonly instanceId: ProviderInstanceId; readonly enabled: boolean | undefined } => {
  const instanceId = currentProviderInstanceId(settings, requestedInstanceId);
  const overrides =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances;
  return {
    instanceId,
    enabled: overrides?.[instanceId]?.enabled ?? overrides?.[requestedInstanceId]?.enabled,
  };
};
