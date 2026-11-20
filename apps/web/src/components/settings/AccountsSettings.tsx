import {
  AuthProvidersManageScope,
  type AccountId,
  type EnvironmentId,
  type PooledModelKey,
} from "@t3tools/contracts";
import {
  listedPooledModels,
  multiAccountModels,
  type AccountInfo,
  type PooledModel,
  type PooledAccount,
  editedModelAccounts,
} from "@t3tools/shared/accountPools";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useClientSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import {
  AccountSkipBadge,
  accountSource,
  UseAgainNowButton,
  useAccountSkip,
} from "../accounts/AccountSkip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useInstanceEntries } from "./useInstanceEntries";

/** Settings → Accounts: the models T3 picks the account for, each with its accounts in order. */
export function AccountsSettings() {
  const { environments, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? environments[0]?.environmentId;
  return (
    <SettingsPageContainer>
      {environmentId === undefined ? (
        <p className="px-4 text-sm text-muted-foreground">
          Connect an environment to manage its accounts.
        </p>
      ) : (
        <EnvironmentAccounts key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function AccountIcon({ account }: { account: AccountInfo }) {
  return (
    <ProviderInstanceIcon
      driverKind={account.driver}
      subProvider={account.source === account.driver ? undefined : account.label}
      displayName={account.label}
      accentColor={account.accentColor}
      className="size-4 shrink-0"
      iconClassName="size-4"
    />
  );
}

function EnvironmentAccounts({ environmentId }: { environmentId: EnvironmentId }) {
  const { settings, providers } = useInstanceEntries(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const listed = settings.pooledModelKeys ?? [];
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const models = withPooledModelLabels(
    listedPooledModels(providers, settings),
    slotLabels,
  ).toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  const candidates = withPooledModelLabels(multiAccountModels(providers, settings), slotLabels)
    .filter((model) => !listed.includes(model.key))
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  const setAccounts = (model: PooledModel, inUse: ReadonlyArray<AccountId>) =>
    update({
      modelAccounts: {
        [model.key]: editedModelAccounts(
          settings.modelAccounts?.[model.key],
          model.accounts.map((entry) => entry.account.id),
          inUse,
        ),
      },
    });
  const addModel = (key: PooledModelKey) => update({ pooledModelKeys: [...listed, key] });
  const removeModel = (key: PooledModelKey) =>
    update({ pooledModelKeys: listed.filter((listedKey) => listedKey !== key) });
  return (
    <SettingsSection title="Models" id="accounts">
      <SettingsRow
        title="Models T3 Code picks the account for"
        description="Each model you add is one picker choice. New threads run on its first account that isn't skipped, moving down the list when one runs out. Models you haven't added run on the account you pick."
        control={<AddModelPicker candidates={candidates} disabled={!canManage} onAdd={addModel} />}
      />
      {models.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          No models are added yet. Add one to let T3 Code choose between the accounts that serve it.
        </p>
      ) : null}
      {models.map((model) => (
        <PooledModelRow
          key={model.key}
          model={model}
          environmentId={environmentId}
          disabled={!canManage}
          onRemove={() => removeModel(model.key)}
          onSetAccounts={(accounts) => setAccounts(model, accounts)}
        />
      ))}
    </SettingsSection>
  );
}

function PooledModelRow(props: {
  model: PooledModel;
  environmentId: EnvironmentId;
  disabled: boolean;
  onRemove: () => void;
  onSetAccounts: (accounts: ReadonlyArray<AccountId>) => void;
}) {
  const { model } = props;
  const inUse = model.accounts.flatMap((entry) => (entry.removed ? [] : [entry.account.id]));
  const status =
    model.accounts.length === 0
      ? "No enabled accounts currently serve this model"
      : model.accounts.length === 1
        ? `${inUse.length} of 1 in use · needs 2 accounts to pool`
        : `${inUse.length} of ${model.accounts.length} in use`;
  const move = (id: AccountId, steps: number) => {
    const from = inUse.indexOf(id);
    const to = Math.max(0, Math.min(inUse.length - 1, from + steps));
    if (from === -1 || from === to) return;
    const next = inUse.filter((candidate) => candidate !== id);
    next.splice(to, 0, id);
    props.onSetAccounts(next);
  };
  const setInUse = (id: AccountId, use: boolean) =>
    props.onSetAccounts(use ? [...inUse, id] : inUse.filter((candidate) => candidate !== id));
  return (
    <SettingsRow
      title={model.displayName}
      status={status}
      control={
        <RemoveModelButton
          label={model.displayName}
          disabled={props.disabled}
          onRemove={props.onRemove}
        />
      }
    >
      {model.accounts.length > 0 ? (
        <ol
          aria-label={`Accounts for ${model.displayName}, tried first at the top`}
          className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {model.accounts.map((entry) => (
            <ModelAccountRow
              key={entry.account.id}
              entry={entry}
              modelKey={model.key}
              modelName={model.displayName}
              environmentId={props.environmentId}
              position={entry.removed ? undefined : inUse.indexOf(entry.account.id) + 1}
              count={inUse.length}
              disabled={props.disabled}
              onMove={(steps) => move(entry.account.id, steps)}
              onSetInUse={(use) => setInUse(entry.account.id, use)}
            />
          ))}
        </ol>
      ) : null}
    </SettingsRow>
  );
}

function ModelAccountRow(props: {
  entry: PooledAccount;
  modelKey: PooledModelKey;
  modelName: string;
  environmentId: EnvironmentId;
  /** Its place in the model's order; undefined while it is off the model. */
  position: number | undefined;
  count: number;
  disabled: boolean;
  onMove: (steps: number) => void;
  onSetInUse: (use: boolean) => void;
}) {
  const { account } = props.entry;
  const skip = useAccountSkip(props.environmentId, account.id, props.modelKey);
  const off = props.position === undefined;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ps-3 pe-1.5">
      <span className="w-4 text-xs tabular-nums text-muted-foreground">{props.position}</span>
      <AccountIcon account={account} />
      <span className={cn("min-w-0 truncate text-sm", off && "text-muted-foreground line-through")}>
        {account.label}
      </span>
      <Link
        to="/settings/providers"
        search={{ environmentId: props.environmentId, instanceId: account.instanceId }}
        className="min-w-0 truncate text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-current"
      >
        {accountSource(account)}
      </Link>
      {props.entry.metered ? (
        <span className="text-xs text-muted-foreground">pay as you go</span>
      ) : null}
      {skip !== undefined && !off ? (
        <>
          <AccountSkipBadge skip={skip} />
          <UseAgainNowButton
            environmentId={props.environmentId}
            account={account.id}
            model={props.modelKey}
          />
        </>
      ) : null}
      <span className="ms-auto flex items-center gap-0.5">
        {off ? null : (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || props.position === 1}
              aria-label={`Move ${account.label} up for ${props.modelName}`}
              onClick={() => props.onMove(-1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || props.position === props.count}
              aria-label={`Move ${account.label} down for ${props.modelName}`}
              onClick={() => props.onMove(1)}
            >
              <ArrowDownIcon />
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled}
          aria-label={`${off ? "Use" : "Don't use"} ${account.label} for ${props.modelName}`}
          onClick={() => props.onSetInUse(off)}
        >
          {off ? <PlusIcon /> : <XIcon />}
        </Button>
      </span>
    </li>
  );
}

function RemoveModelButton(props: { label: string; disabled: boolean; onRemove: () => void }) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost-muted"
      disabled={props.disabled}
      aria-label={`Remove ${props.label} from the models T3 Code picks an account for`}
      onClick={props.onRemove}
    >
      <XIcon />
    </Button>
  );
}

/** Adds a model T3 Code may pick the account for, searching the ones several accounts serve. */
function AddModelPicker(props: {
  candidates: ReadonlyArray<PooledModel>;
  disabled: boolean;
  onAdd: (key: PooledModelKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const shown = props.candidates.filter(
    (model) =>
      normalized.length === 0 ||
      model.displayName.toLowerCase().includes(normalized) ||
      model.accounts.some((entry) => entry.account.label.toLowerCase().includes(normalized)),
  );
  const keys = shown.map((model) => model.key);
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <Combobox
      items={keys}
      filteredItems={keys}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      onValueChange={(key) => {
        if (typeof key !== "string") return;
        props.onAdd(key as PooledModelKey);
        close();
      }}
    >
      <ComboboxTrigger
        aria-label="Add a model T3 Code picks the account for"
        disabled={props.disabled || props.candidates.length === 0}
        render={<Button size="xs" variant="outline" />}
      >
        <PlusIcon />
        Add model
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-80">
        <ComboboxSearchInput
          aria-label="Search models"
          placeholder="Search models..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No models are left to add.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {shown.map((model, index) => (
            <ComboboxItem key={model.key} index={index} value={model.key}>
              <span className="flex min-w-0 flex-col">
                <span className="block truncate">{model.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {model.accounts.map((entry) => entry.account.label).join(", ")}
                </span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
