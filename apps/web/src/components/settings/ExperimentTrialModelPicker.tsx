import { isModelInDelegation, selectionEffort } from "@t3tools/client-runtime/experiments";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { effortForModel } from "./DelegationSettings.logic";
import type { TrialEnvironment } from "./ExperimentParts";

/** One variant's model and effort, offering only what the server would accept for a trial. */
export function TrialModelPicker({
  environmentId,
  setup,
  selection,
  onChange,
}: {
  environmentId: EnvironmentId;
  setup: TrialEnvironment;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const { entries, catalog, settings, manifest } = setup;
  const instanceId = selection?.instanceId ?? entries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const model = selection?.model ?? "";
  const options = getCustomModelOptionsByInstance(settings, setup.providers, instanceId, model);
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        isComposerOwned={false}
        {...(selection ? {} : { triggerLabel: "Choose model" })}
        getModelDisabledReason={(_instance, slug) =>
          manifest !== null && !isModelInDelegation(manifest, slug)
            ? "Not in a Delegation list"
            : null
        }
        onInstanceModelChange={(pickedInstance, slug) => {
          const driverKind = entries.find(
            (entry) => entry.instanceId === pickedInstance,
          )?.driverKind;
          const picked = catalog.find(
            (candidate) =>
              candidate.binding.driverKind === driverKind && candidate.binding.model === slug,
          );
          const effort =
            picked === undefined
              ? undefined
              : effortForModel(picked, (selection && selectionEffort(selection)) ?? undefined);
          onChange(
            createModelSelection(
              pickedInstance,
              slug,
              picked?.binding.effortOption !== undefined && effort !== undefined
                ? [{ id: picked.binding.effortOption, value: effort }]
                : undefined,
            ),
          );
        }}
      />
      {selection && activeEntry ? (
        <TraitsPicker
          provider={activeEntry.driverKind}
          models={activeEntry.models}
          model={selection.model}
          modelOptions={selection.options ?? []}
          allowPromptInjectedEffort={false}
          onModelOptionsChange={(next) =>
            onChange(createModelSelection(selection.instanceId, selection.model, next))
          }
        />
      ) : null}
    </div>
  );
}
