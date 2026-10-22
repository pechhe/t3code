import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPolicyManifest,
  EnvironmentId,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import type { ReactElement } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import type { CatalogModel } from "./DelegationSettings.logic";

type Binding = AgentPolicyManifest["models"][string];

/** The environment's provider instances in the order and with the settings the composer uses. */
function useInstanceEntries(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers: ReadonlyArray<ServerProvider> =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  return { settings, providers, entries };
}

/**
 * Chooses a delegation model with the composer's own model picker. Policy models name a
 * provider kind rather than an account, so any account of that kind stands for it. Every
 * installed model can be picked; one with an effort setting also gets the effort picker.
 */
export function PolicyModelPicker(props: {
  environmentId: EnvironmentId;
  catalog: ReadonlyArray<CatalogModel>;
  binding: Binding | undefined;
  disabled?: boolean;
  /** Replaces the model trigger, e.g. an "Add model" button. */
  trigger?: ReactElement;
  /** Why a catalog model cannot be picked here, such as being listed already. */
  pickDisabledReason?: (model: CatalogModel) => string | null;
  onPick: (model: CatalogModel) => void;
}) {
  const { settings, providers, entries } = useInstanceEntries(props.environmentId);
  const active =
    entries.find((entry) => entry.driverKind === props.binding?.driverKind && entry.isDefault) ??
    entries.find((entry) => entry.driverKind === props.binding?.driverKind) ??
    entries[0];
  const instanceId = active?.instanceId ?? ("" as ProviderInstanceId);
  const model = props.binding?.model ?? "";
  const options = getCustomModelOptionsByInstance(settings, providers, instanceId, model);
  const catalogModel = (pickedInstance: ProviderInstanceId, slug: string) => {
    const driver = entries.find((entry) => entry.instanceId === pickedInstance)?.driverKind;
    return props.catalog.find(
      (candidate) => candidate.binding.driverKind === driver && candidate.binding.model === slug,
    );
  };
  return (
    <ProviderModelPicker
      environmentId={props.environmentId}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      isComposerOwned={false}
      disabled={props.disabled ?? false}
      {...(props.trigger ? { trigger: props.trigger } : {})}
      {...(props.binding ? {} : { triggerLabel: "Choose model" })}
      getModelDisabledReason={(pickedInstance, slug) => {
        const picked = catalogModel(pickedInstance, slug);
        if (picked === undefined) return "Not listed by an installed account";
        return props.pickDisabledReason?.(picked) ?? null;
      }}
      onInstanceModelChange={(pickedInstance, slug) => {
        const picked = catalogModel(pickedInstance, slug);
        if (picked !== undefined) props.onPick(picked);
      }}
    />
  );
}

/** The effort a delegation model runs at, chosen with the composer's reasoning picker. */
export function PolicyEffortPicker(props: {
  environmentId: EnvironmentId;
  binding: Binding | undefined;
  effort: string | undefined;
  disabled?: boolean;
  onChange: (effort: string) => void;
  /** Other traits the model offers, such as its service tier, which the policy fixes per model. */
  onModelOptionsChange?: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
}) {
  const { settings, entries } = useInstanceEntries(props.environmentId);
  const binding = props.binding;
  const entry =
    entries.find(
      (candidate) => candidate.driverKind === binding?.driverKind && candidate.isDefault,
    ) ?? entries.find((candidate) => candidate.driverKind === binding?.driverKind);
  if (binding === undefined || entry === undefined) {
    return <span className="text-muted-foreground text-xs">{props.effort}</span>;
  }
  const effortOption = binding.effortOption;
  if (effortOption === undefined) return null;
  return (
    <TraitsPicker
      provider={entry.driverKind}
      models={entry.models}
      model={binding.model}
      modelOptions={[
        { id: effortOption, value: props.effort ?? "" },
        ...Object.entries(binding.options ?? {}).map(([id, value]) => ({ id, value })),
      ]}
      allowPromptInjectedEffort={false}
      planModeEnabled={settings.planModeEnabled}
      disabled={props.disabled ?? false}
      onModelOptionsChange={(options) => {
        const value = options?.find((option) => option.id === effortOption)?.value;
        if (typeof value === "string" && value !== props.effort) props.onChange(value);
        else props.onModelOptionsChange?.(options);
      }}
    />
  );
}
