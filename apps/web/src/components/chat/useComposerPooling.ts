import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  firstAccount,
  pooledModelOf,
  pooledModels,
  selectionAccountId,
  selectionOnAccount,
  type AccountRoutingSettings,
  type PooledAccount,
  type PooledModel,
} from "@t3tools/shared/accountPools";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { ModelPickerPooling } from "./modelPickerPooling";

/**
 * The selection a pooled-model pick makes. An account pins it; the model alone keeps the account
 * the selection is already on for that model, or else takes the first in the user's order.
 */
export function pooledModelSelection(input: {
  readonly model: PooledModel;
  readonly account: PooledAccount | null;
  readonly current: ModelSelection | null;
  readonly settings: Pick<AccountRoutingSettings, "accountSkips">;
  readonly nowMs: number;
}): ModelSelection | undefined {
  const options = input.current?.options;
  if (input.account !== null) return selectionOnAccount(input.account, options, true);
  const current = input.current;
  const staying =
    current === null
      ? undefined
      : input.model.accounts.find(
          (entry) =>
            !entry.removed &&
            entry.provider.instanceId === current.instanceId &&
            entry.model === current.model,
        );
  if (staying !== undefined) return selectionOnAccount(staying, options);
  const first = firstAccount(input.model, input.settings.accountSkips, input.nowMs);
  return first === undefined ? undefined : selectionOnAccount(first, options);
}

/** The model picker's pooled models for the composer's selection. */
export function useComposerPooling(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly onSelect: ModelPickerPooling["onSelect"];
}): ModelPickerPooling {
  const accountOrder = useEnvironmentSettings(input.environmentId, (s) => s.accountOrder);
  const modelAccountsRemoved = useEnvironmentSettings(
    input.environmentId,
    (s) => s.modelAccountsRemoved,
  );
  const skips = useEnvironmentSettings(input.environmentId, (s) => s.accountSkips);
  const models = pooledModels(input.providers, { accountOrder, modelAccountsRemoved });
  const pooled = pooledModelOf(models, input.selection);
  const account = selectionAccountId(input.providers, input.selection);
  return {
    models,
    skips,
    active:
      pooled === undefined
        ? null
        : { key: pooled.key, pinned: input.selection.pinned === true ? account : null, account },
    onSelect: input.onSelect,
  };
}
