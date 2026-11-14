import type { ClientSettings, ProviderInstanceId } from "@t3tools/contracts";

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
  const key = providerModelKey(input.instanceId, input.slug);
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
