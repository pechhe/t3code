import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  pickAccount,
  pooledModelOf,
  pooledModels,
  selectionAccountId,
  selectionOnAccount,
  type PooledAccount,
  type PooledModel,
  type RoutingContext,
} from "@t3tools/shared/accountPools";

import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { useRoutingContext } from "../accounts/AccountAvailability";
import { selectModelSlotLabels, withPooledModelLabels } from "./modelLabels";
import type { ModelPickerPooling } from "./modelPickerPooling";

/**
 * The selection a pooled-model pick makes. An account pins it; the model alone keeps the account
 * the selection is already on for that model, or else takes the one its route picks now.
 */
export function pooledModelSelection(input: {
  readonly model: PooledModel;
  readonly account: PooledAccount | null;
  readonly current: ModelSelection | null;
  readonly routing: RoutingContext;
}): ModelSelection | undefined {
  const options = input.current?.options;
  if (input.account !== null) return selectionOnAccount(input.account, options, true);
  const current = input.current;
  const staying =
    current === null
      ? undefined
      : input.model.accounts.find(
          (entry) =>
            entry.tier !== "off" &&
            entry.provider.instanceId === current.instanceId &&
            entry.model === current.model,
        );
  if (staying !== undefined) return selectionOnAccount(staying, options);
  const pick = pickAccount(input.model, input.routing);
  const target = pick.type === "account" ? pick.target : pick.coolingDown;
  return target === undefined ? undefined : selectionOnAccount(target, options);
}

/** The model picker's pooled models for the composer's selection. */
export function useComposerPooling(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly onSelect: ModelPickerPooling["onSelect"];
}): ModelPickerPooling {
  const modelAccounts = useEnvironmentSettings(input.environmentId, (s) => s.modelAccounts);
  const modelRouting = useEnvironmentSettings(input.environmentId, (s) => s.modelRouting);
  const modelLinks = useEnvironmentSettings(input.environmentId, (s) => s.modelLinks);
  const routing = useRoutingContext(input.environmentId);
  const pooledModelKeys = useEnvironmentSettings(
    input.environmentId,
    (s) => s.pooledModelKeys ?? [],
  );
  const providerModelPreferences = useEnvironmentSettings(
    input.environmentId,
    (s) => s.providerModelPreferences,
  );
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const models = withPooledModelLabels(
    pooledModels(input.providers, {
      pooledModelKeys,
      modelRouting,
      modelAccounts,
      modelLinks,
      providerModelPreferences,
    }),
    slotLabels,
  );
  return modelPickerPooling({ ...input, models, routing });
}

/** The model picker's pooling for a selection, given the environment's labelled pooled models. */
export function modelPickerPooling(input: {
  readonly models: ReadonlyArray<PooledModel>;
  readonly routing: ModelPickerPooling["routing"];
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly onSelect: ModelPickerPooling["onSelect"];
}): ModelPickerPooling {
  const pooled = pooledModelOf(input.models, input.selection);
  const account = selectionAccountId(input.providers, input.selection);
  return {
    models: input.models,
    routing: input.routing,
    active:
      pooled === undefined
        ? null
        : { key: pooled.key, pinned: input.selection.pinned === true ? account : null, account },
    onSelect: input.onSelect,
  };
}
