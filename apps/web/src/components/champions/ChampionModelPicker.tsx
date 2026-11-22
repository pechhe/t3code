import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { pooledModels } from "@t3tools/shared/accountPools";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { modelPickerPooling, pooledModelSelection } from "../chat/useComposerPooling";
import { useRoutingContext } from "../accounts/AccountAvailability";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { useInstanceEntries } from "../settings/useInstanceEntries";

/**
 * One Champion model slot, chosen with the composer's own model picker: pooled models included (picking the model
 * alone leaves the account to routing, picking an account pins it) and the effort setting beside it.
 */
export function ChampionModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly ariaLabel: string;
  /** Marks a backup slot: it can be left empty, and cleared. */
  readonly backup?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  const { environmentId, selection } = props;
  const { settings, providers, entries } = useInstanceEntries(environmentId);
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const instanceId = selection?.instanceId ?? entries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const model = selection?.model ?? "";
  const activeEntry = entries.find((entry) => entry.instanceId === instanceId);
  const routing = useRoutingContext(environmentId);
  const pooling = modelPickerPooling({
    models: withPooledModelLabels(pooledModels(providers, settings), slotLabels),
    routing,
    providers,
    selection: selection ?? createModelSelection(instanceId, model),
    onSelect: (pooled, account) => {
      const picked = pooledModelSelection({
        model: pooled,
        account,
        current: selection,
        routing,
      });
      if (picked !== undefined) props.onChange(picked);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label={props.ariaLabel} role="group">
      {props.backup ? <span className="text-muted-foreground text-xs">Backup</span> : null}
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={instanceId}
        model={model}
        pooling={pooling}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          settings,
          providers,
          instanceId,
          model,
        )}
        isComposerOwned={false}
        disabled={props.disabled ?? false}
        {...(selection === null
          ? { triggerLabel: props.backup ? "Choose backup" : "Choose model" }
          : {})}
        onInstanceModelChange={(pickedInstance, slug) =>
          props.onChange(pickModelSelection(selection, pickedInstance, slug))
        }
      />
      {selection !== null && activeEntry !== undefined && !props.backup ? (
        <TraitsPicker
          provider={activeEntry.driverKind}
          models={activeEntry.models}
          model={selection.model}
          modelOptions={selection.options ?? []}
          allowPromptInjectedEffort={false}
          disabled={props.disabled ?? false}
          onModelOptionsChange={(next) =>
            props.onChange({
              ...createModelSelection(selection.instanceId, selection.model, next),
              ...(selection.pinned === true ? { pinned: true } : {}),
            })
          }
        />
      ) : null}
      {props.backup && selection !== null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Remove backup"
          disabled={props.disabled ?? false}
          onClick={() => props.onChange(null)}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
