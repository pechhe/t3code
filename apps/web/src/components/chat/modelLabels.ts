import type { ClientSettings, PooledModelKey, ProviderInstanceId } from "@t3tools/contracts";

import { updateClientSettings } from "~/hooks/useSettings";
import { providerModelKey } from "~/modelOrdering";

export const selectModelSlotLabels = (settings: ClientSettings) => settings.modelSlotLabels;

export function getCustomModelLabel(
  slotLabels: Readonly<Record<string, string>>,
  instanceId: ProviderInstanceId,
  slug: string,
): string | undefined {
  return slotLabels[providerModelKey(instanceId, slug)];
}

export function buildNextModelSlotLabels(input: {
  readonly slotLabels: Readonly<Record<string, string>>;
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly nextName: string;
  readonly defaultNames?: ReadonlyArray<string | undefined>;
}): Record<string, string> | null {
  return buildNextLabels({ ...input, key: providerModelKey(input.instanceId, input.slug) });
}

function buildNextLabels(input: {
  readonly slotLabels: Readonly<Record<string, string>>;
  readonly key: string;
  readonly nextName: string;
  readonly defaultNames?: ReadonlyArray<string | undefined> | undefined;
}): Record<string, string> | null {
  const key = input.key;
  const label = input.nextName.trim();
  const matchesDefault =
    label.length > 0 && (input.defaultNames?.some((candidate) => candidate === label) ?? false);
  const others = { ...input.slotLabels };
  delete others[key];
  const next = label.length > 0 && !matchesDefault ? { ...others, [key]: label } : others;
  return next[key] === input.slotLabels[key] ? null : next;
}

export function saveModelLabel(input: {
  readonly slotLabels: Readonly<Record<string, string>>;
  readonly instanceId: ProviderInstanceId;
  readonly slug: string;
  readonly nextName: string;
  readonly defaultNames?: ReadonlyArray<string | undefined>;
}): void {
  const next = buildNextModelSlotLabels(input);
  if (next !== null) {
    void updateClientSettings({ modelSlotLabels: next });
  }
}

/** A pooled model's own name, kept beside the per-account labels; "@" never starts an instance id. */
const pooledLabelKey = (key: PooledModelKey) => "@pooled:" + key;

export const getPooledModelLabel = (
  slotLabels: Readonly<Record<string, string>>,
  key: PooledModelKey,
): string | undefined => slotLabels[pooledLabelKey(key)];

/** Pooled models under the names the user gave them. */
export const withPooledModelLabels = <
  M extends { readonly key: PooledModelKey; readonly displayName: string },
>(
  models: ReadonlyArray<M>,
  slotLabels: Readonly<Record<string, string>>,
): ReadonlyArray<M> =>
  models.map((model) => {
    const label = getPooledModelLabel(slotLabels, model.key);
    return label === undefined ? model : { ...model, displayName: label };
  });

export function savePooledModelLabel(input: {
  readonly slotLabels: Readonly<Record<string, string>>;
  readonly key: PooledModelKey;
  readonly nextName: string;
}): void {
  const next = buildNextLabels({
    slotLabels: input.slotLabels,
    key: pooledLabelKey(input.key),
    nextName: input.nextName,
  });
  if (next !== null) {
    void updateClientSettings({ modelSlotLabels: next });
  }
}
