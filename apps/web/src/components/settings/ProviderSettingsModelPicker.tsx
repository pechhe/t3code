import {
  isProviderTextGenerationCapable,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SettingResetButton } from "./settingsLayout";
import { clearedModelChoiceConfig, nextModelChoiceConfig } from "./providerSettingsModelChoice";
import { useInstanceEntries } from "./useInstanceEntries";

function readConfigString(value: unknown, key: string): string {
  if (value === null || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

/**
 * A provider setting that names a model on any account, stored as the model slug plus the account
 * that runs it. The composer's picker is reused, so every installed model is searchable and
 * favourites come first; the empty choice leaves it to the conversation's own model.
 */
export function ProviderSettingsModelPicker(props: {
  environmentId: EnvironmentId;
  /** The account this settings card belongs to, which the picker starts on. */
  instanceId: ProviderInstanceId;
  /** The config the row shows, which includes a value inherited from an account pool. */
  value: unknown;
  /** The config a choice writes into: a pool member's own stored settings. Defaults to `value`. */
  base?: unknown | undefined;
  modelKey: string;
  instanceKey: string;
  emptyLabel: string;
  /** A pool-shared field stores an explicit empty choice, so it never falls back silently. */
  storeEmptyChoice?: boolean;
  disabled?: boolean;
  onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}) {
  const { settings, providers, entries } = useInstanceEntries(props.environmentId);
  const model = readConfigString(props.value, props.modelKey);
  const configuredInstanceId = readConfigString(props.value, props.instanceKey);
  const activeInstanceId =
    entries.find((entry) => entry.instanceId === configuredInstanceId)?.instanceId ??
    entries.find((entry) => entry.instanceId === props.instanceId)?.instanceId ??
    entries[0]?.instanceId ??
    props.instanceId;
  // Only an account that writes application text can summarise a conversation.
  const cannotSummarise = new Set(
    entries
      .filter((entry) => !isProviderTextGenerationCapable(entry.snapshot))
      .map((entry) => entry.instanceId),
  );
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    model === "" ? undefined : model,
  );

  const base = props.base ?? props.value;

  const clear = () => {
    props.onChange(
      clearedModelChoiceConfig({
        base,
        modelKey: props.modelKey,
        instanceKey: props.instanceKey,
        storeEmptyChoice: props.storeEmptyChoice === true,
      }),
    );
  };

  return (
    <div className="flex items-center justify-end gap-1.5">
      {model === "" ? null : (
        <SettingResetButton
          label="Compact with"
          tooltip={props.emptyLabel}
          disabled={props.disabled ?? false}
          onClick={clear}
        />
      )}
      <ProviderModelPicker
        environmentId={props.environmentId}
        triggerAriaLabel="Compact with"
        activeInstanceId={activeInstanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        isComposerOwned={false}
        disabled={props.disabled ?? false}
        {...(model === "" ? { triggerLabel: props.emptyLabel } : {})}
        getModelDisabledReason={(instanceId) =>
          cannotSummarise.has(instanceId) ? "This account cannot write text" : null
        }
        onInstanceModelChange={(instanceId, nextModel) => {
          props.onChange(
            nextModelChoiceConfig({
              base,
              modelKey: props.modelKey,
              instanceKey: props.instanceKey,
              model: nextModel,
              instanceId,
            }),
          );
        }}
      />
    </div>
  );
}
