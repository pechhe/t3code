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
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useInstanceEntries } from "./useInstanceEntries";

/** Settings → Accounts: the order T3 tries accounts in, and which accounts serve each model. */
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
  const models = pooledModels(providers, settings).toSorted((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
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
      <SettingsSection title="Models on several accounts" id="accounts-models">
        <PooledModelsList models={models} disabled={!canManage} onSetRemoved={setRemoved} />
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
  disabled: boolean;
  onSetRemoved: (key: PooledModelKey, account: AccountId, removed: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const shown = props.models.filter(
    (model) =>
      normalized.length === 0 ||
      model.displayName.toLowerCase().includes(normalized) ||
      model.accounts.some((entry) => entry.account.label.toLowerCase().includes(normalized)),
  );
  return (
    <>
      <SettingsRow
        title="Matched by name"
        description="Each model here is one choice in the model picker. Remove an account from a model if the match is wrong or you don't want it used for that model."
        control={
          <Input
            size="sm"
            type="search"
            placeholder="Filter models"
            aria-label="Filter models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
      />
      {shown.map((model) => {
        const inUse = model.accounts.filter((entry) => !entry.removed).length;
        return (
          <SettingsRow
            key={model.key}
            title={model.displayName}
            status={`${inUse} of ${model.accounts.length} in use`}
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
