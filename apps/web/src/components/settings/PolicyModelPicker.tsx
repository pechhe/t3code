import type {
  AgentPolicyManifest,
  EnvironmentId,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { pooledModels } from "@t3tools/shared/accountPools";
import type { ReactElement } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import type { ModelPickerPooling } from "../chat/modelPickerPooling";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  isAnyAccountBinding,
  pooledModelForBinding,
  type CatalogModel,
} from "./DelegationSettings.logic";
import { useInstanceEntries } from "./useInstanceEntries";

type Binding = AgentPolicyManifest["models"][string];

/**
 * Chooses a delegation model with the composer's own model picker. Policy models name either a
 * provider kind and model slug (for a specific account) or `anyAccount` (the model alone, any
 * account in the user's order). Every installed model can be picked; one with an effort setting
 * also gets the effort picker.
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
      (candidate) =>
        candidate.pooledKey === undefined &&
        candidate.binding.driverKind === driver &&
        candidate.binding.model === slug,
    );
  };
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const pools = withPooledModelLabels(pooledModels(providers, settings), slotLabels);
  const activePool =
    props.binding !== undefined && isAnyAccountBinding(props.binding)
      ? pooledModelForBinding(props.binding, pools)
      : undefined;
  const pooling: ModelPickerPooling = {
    models: pools,
    skips: settings.accountSkips,
    active: activePool ? { key: activePool.key, pinned: null } : null,
    onSelect: (pickedModel, account) => {
      const picked =
        account === null
          ? props.catalog.find((candidate) => candidate.pooledKey === pickedModel.key)
          : catalogModel(account.provider.instanceId, account.model);
      if (picked !== undefined && props.pickDisabledReason?.(picked) == null) {
        props.onPick(picked);
      }
    },
  };
  return (
    <ProviderModelPicker
      environmentId={props.environmentId}
      activeInstanceId={instanceId}
      model={model}
      pooling={pooling}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      isComposerOwned={false}
      disabled={props.disabled ?? false}
      {...(props.trigger ? { trigger: props.trigger } : {})}
      {...(props.binding
        ? activePool
          ? { triggerLabel: activePool.displayName }
          : {}
        : { triggerLabel: "Choose model" })}
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
  const { entries } = useInstanceEntries(props.environmentId);
  const binding = props.binding;
  const entry =
    entries.find(
      (candidate) =>
        candidate.driverKind === binding?.driverKind &&
        candidate.models.some((model) => model.slug === binding.model),
    ) ??
    entries.find(
      (candidate) => candidate.driverKind === binding?.driverKind && candidate.isDefault,
    ) ??
    entries.find((candidate) => candidate.driverKind === binding?.driverKind);
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
      disabled={props.disabled ?? false}
      onModelOptionsChange={(options) => {
        const value = options?.find((option) => option.id === effortOption)?.value;
        if (typeof value === "string" && value !== props.effort) props.onChange(value);
        else props.onModelOptionsChange?.(options);
      }}
    />
  );
}
