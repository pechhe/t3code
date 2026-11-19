import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthProvidersManageScope,
  type AccountId,
  type EnvironmentId,
  type PooledModelKey,
} from "@t3tools/contracts";
import {
  listAccounts,
  multiAccountModels,
  pooledModels,
  type AccountInfo,
  type PooledModel,
} from "@t3tools/shared/accountPools";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import {
  AccountSkipBadge,
  accountSource,
  TryAgainNowButton,
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

/** Settings → Accounts: the order T3 tries accounts in, and the models it picks an account for. */
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
  const accounts = listAccounts(providers, settings.accountOrder);
  const listed = settings.pooledModelKeys ?? [];
  const models = pooledModels(providers, settings).toSorted((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
  const candidates = multiAccountModels(providers, settings)
    .filter((model) => !listed.includes(model.key))
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  const ids = accounts.map((account) => account.id);
  const move = (id: AccountId, steps: number) => {
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + steps));
    if (from === -1 || from === to) return;
    const next = ids.filter((candidate) => candidate !== id);
    next.splice(to, 0, id);
    update({ accountOrder: next });
  };
  const setRemoved = (key: PooledModelKey, account: AccountId, removed: boolean) => {
    const current = settings.modelAccountsRemoved[key] ?? [];
    const next = removed
      ? [...current.filter((id) => id !== account), account]
      : current.filter((id) => id !== account);
    update({ modelAccountsRemoved: { [key]: next.length > 0 ? next : null } });
  };
  const addModel = (key: PooledModelKey) => update({ pooledModelKeys: [...listed, key] });
  const removeModel = (key: PooledModelKey) =>
    update({ pooledModelKeys: listed.filter((listedKey) => listedKey !== key) });
  return (
    <>
      <SettingsSection title="Account order" id="accounts">
        <SettingsRow
          title="Tried top to bottom"
          description="A new thread runs on the first account serving its model that isn't skipped, and stays there until it runs out. A skip lasts until the reported reset, or midnight."
        >
          <AccountOrderList
            accounts={accounts}
            environmentId={environmentId}
            disabled={!canManage}
            onMove={move}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Models" id="accounts-models">
        <PooledModelsList
          models={models}
          candidates={candidates}
          disabled={!canManage}
          onAdd={addModel}
          onRemove={removeModel}
          onSetRemoved={setRemoved}
        />
      </SettingsSection>
    </>
  );
}

function AccountOrderList(props: {
  accounts: ReadonlyArray<AccountInfo>;
  environmentId: EnvironmentId;
  disabled: boolean;
  onMove: (id: AccountId, steps: number) => void;
}) {
  const ids = props.accounts.map((account) => account.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1) props.onMove(String(event.active.id), to - from);
  };
  if (props.accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">No accounts are set up yet.</p>;
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol
          aria-label="Accounts, tried first at the top"
          className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {props.accounts.map((account, index) => (
            <AccountOrderRow
              key={account.id}
              account={account}
              environmentId={props.environmentId}
              position={index + 1}
              count={props.accounts.length}
              disabled={props.disabled}
              onMove={(steps) => props.onMove(account.id, steps)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function AccountOrderRow(props: {
  account: AccountInfo;
  environmentId: EnvironmentId;
  position: number;
  count: number;
  disabled: boolean;
  onMove: (steps: number) => void;
}) {
  const { account } = props;
  const skip = useAccountSkip(props.environmentId, account.id);
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: account.id, disabled: props.disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ps-3 pe-1.5",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <span className="w-4 text-xs tabular-nums text-muted-foreground">{props.position}</span>
      <AccountIcon account={account} />
      <span className="min-w-0 truncate text-sm">{account.label}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {accountSource(account)}
      </span>
      {skip !== undefined ? (
        <>
          <AccountSkipBadge skip={skip} />
          <TryAgainNowButton environmentId={props.environmentId} account={account.id} />
        </>
      ) : null}
      <span className="ms-auto flex items-center gap-0.5">
        <span
          ref={setActivatorNodeRef}
          {...listeners}
          aria-hidden
          className="hidden size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing sm:flex"
        >
          <GripVerticalIcon className="size-3.5" />
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === 1}
          aria-label={`Move ${account.label} up`}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled || props.position === props.count}
          aria-label={`Move ${account.label} down`}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
      </span>
    </li>
  );
}

function PooledModelsList(props: {
  models: ReadonlyArray<PooledModel>;
  candidates: ReadonlyArray<PooledModel>;
  disabled: boolean;
  onAdd: (key: PooledModelKey) => void;
  onRemove: (key: PooledModelKey) => void;
  onSetRemoved: (key: PooledModelKey, account: AccountId, removed: boolean) => void;
}) {
  return (
    <>
      <SettingsRow
        title="Models T3 Code picks the account for"
        description="Each model you add is one choice in the model picker, run on its accounts in the order above. Take an account off a model with ×. Models you haven't added run on the account you pick."
        control={
          <AddModelPicker
            candidates={props.candidates}
            disabled={props.disabled}
            onAdd={props.onAdd}
          />
        }
      />
      {props.models.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          No models are added yet. Add one to let T3 Code choose between the accounts that serve it.
        </p>
      ) : null}
      {props.models.map((model) => {
        const inUse = model.accounts.filter((entry) => !entry.removed).length;
        return (
          <SettingsRow
            key={model.key}
            title={model.displayName}
            status={`${inUse} of ${model.accounts.length} in use`}
            control={
              <RemoveModelButton
                label={model.displayName}
                disabled={props.disabled}
                onRemove={() => props.onRemove(model.key)}
              />
            }
          >
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {model.accounts.map((entry) => (
                <span
                  key={entry.account.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border/60 py-0.5 ps-1.5 pe-0.5 text-xs",
                    entry.removed && "text-muted-foreground line-through",
                  )}
                >
                  <AccountIcon account={entry.account} />
                  {entry.account.label}
                  <Button
                    type="button"
                    size="icon-tiny"
                    variant="ghost-muted"
                    disabled={props.disabled}
                    aria-label={`${entry.removed ? "Use" : "Don't use"} ${entry.account.label} for ${model.displayName}`}
                    onClick={() => props.onSetRemoved(model.key, entry.account.id, !entry.removed)}
                  >
                    {entry.removed ? <PlusIcon /> : <XIcon />}
                  </Button>
                </span>
              ))}
            </div>
          </SettingsRow>
        );
      })}
    </>
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
