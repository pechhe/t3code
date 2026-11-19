import type { AccountId, PooledModelKey } from "@t3tools/contracts";
import {
  activeSkip,
  firstAccount,
  type PooledAccount,
  type PooledModel,
} from "@t3tools/shared/accountPools";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { AccountSkipBadge, accountSource } from "../accounts/AccountSkip";
import { Button } from "../ui/button";
import { ComboboxItem } from "../ui/combobox";
import type { ModelPickerPooling } from "./modelPickerPooling";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const MODEL_PREFIX = "pooled:";
const ANY_PREFIX = "pooled-any:";
const ACCOUNT_PREFIX = "pooled-account:";

const modelKey = (key: PooledModelKey) => `${MODEL_PREFIX}${key}`;
const anyKey = (key: PooledModelKey) => `${ANY_PREFIX}${key}`;
const accountKey = (key: PooledModelKey, account: AccountId) =>
  `${ACCOUNT_PREFIX}${encodeURIComponent(key)}/${encodeURIComponent(account)}`;

type Row =
  | { readonly kind: "model"; readonly model: PooledModel }
  | { readonly kind: "any"; readonly model: PooledModel }
  | { readonly kind: "account"; readonly model: PooledModel; readonly entry: PooledAccount };

const serving = (model: PooledModel) => model.accounts.filter((entry) => !entry.removed);

function AccountIcon({ entry }: { entry: PooledAccount }) {
  return (
    <ProviderInstanceIcon
      driverKind={entry.provider.driver}
      model={entry.model}
      displayName={entry.account.label}
      accentColor={entry.account.accentColor}
      className="size-4"
      iconClassName="size-4"
      indicatorBackground="var(--popover)"
    />
  );
}

/**
 * The picker's entries for models several accounts serve: one row per model, which follows the
 * user's account order, and under it on request the model's accounts, each of which pins.
 */
export function usePooledPickerEntries(input: {
  pooling: ModelPickerPooling | undefined;
  /** Off where the picker is locked to one provider. */
  enabled: boolean;
  query: string;
  /** Pooled models list on the Favorites tab, and anywhere while searching. */
  showWithoutQuery: boolean;
  /** Favourited models; without a query only pooled models among them (or the active one) list. */
  favorites: ReadonlyArray<{ readonly provider: string; readonly model: string }>;
}) {
  const { pooling } = input;
  const skips = pooling?.skips ?? {};
  const [openKey, setOpenKey] = useState<PooledModelKey | null>(pooling?.active?.key ?? null);
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const models = input.enabled ? (pooling?.models ?? []) : [];
  const query = input.query.trim().toLowerCase();
  const favorite = (model: PooledModel) =>
    pooling?.active?.key === model.key ||
    model.accounts.some((entry) =>
      input.favorites.some(
        (saved) => saved.provider === entry.provider.instanceId && saved.model === entry.model,
      ),
    );
  const visible = models.filter((model) =>
    query.length > 0
      ? model.displayName.toLowerCase().includes(query) ||
        model.accounts.some((entry) => entry.account.label.toLowerCase().includes(query))
      : input.showWithoutQuery && favorite(model),
  );

  const rows = new Map<string, Row>();
  for (const model of visible) {
    rows.set(modelKey(model.key), { kind: "model", model });
    if (openKey !== model.key) continue;
    rows.set(anyKey(model.key), { kind: "any", model });
    for (const entry of serving(model))
      rows.set(accountKey(model.key, entry.account.id), { kind: "account", model, entry });
  }
  const allKeys = models.flatMap((model) => [
    modelKey(model.key),
    anyKey(model.key),
    ...serving(model).map((entry) => accountKey(model.key, entry.account.id)),
  ]);

  const active = pooling?.active ?? null;
  const activeKey =
    active === null
      ? null
      : active.pinned !== null && openKey === active.key
        ? accountKey(active.key, active.pinned)
        : modelKey(active.key);

  const toggle = (key: PooledModelKey) => setOpenKey((open) => (open === key ? null : key));

  const select = (key: string | null): boolean => {
    const row = key === null ? undefined : rows.get(key);
    if (row === undefined || pooling === undefined) return false;
    pooling.onSelect(row.model, row.kind === "account" ? row.entry : null);
    return true;
  };

  /** Right opens a highlighted model's accounts and Left closes them. */
  const onKeyDown = (
    event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> & {
      preventDefault(): void;
      stopPropagation(): void;
    },
    highlighted: string | null,
  ): boolean => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const row = highlighted === null ? undefined : rows.get(highlighted);
    if (row === undefined) return false;
    const open = event.key === "ArrowRight";
    if ((openKey === row.model.key) === open) return false;
    event.preventDefault();
    event.stopPropagation();
    setOpenKey(open ? row.model.key : null);
    return true;
  };

  const render = (key: string, index: number): ReactNode => {
    const row = rows.get(key);
    if (row === undefined) return null;
    const isActive = active?.key === row.model.key;
    if (row.kind === "model") {
      const accounts = serving(row.model);
      const current = isActive
        ? accounts.find((entry) => entry.account.id === active.account)
        : undefined;
      const isOpen = openKey === row.model.key;
      return (
        <ComboboxItem
          key={key}
          hideIndicator
          selectedFill={false}
          index={index}
          value={key}
          data-pooled-model={row.model.key}
          className="group w-full !min-w-0 max-w-full cursor-pointer"
        >
          <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {accounts.slice(0, 3).map((entry) => (
              <AccountIcon key={entry.account.id} entry={entry} />
            ))}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 truncate text-sm leading-snug">{row.model.displayName}</span>
            {isActive && active.pinned === null ? (
              <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
            ) : null}
            <span className="min-w-0 truncate text-xs text-muted-foreground/70">
              {current !== undefined
                ? `${active?.pinned === null ? "via" : "pinned:"} ${current.account.label}`
                : `${accounts.length} accounts`}
            </span>
          </span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Hide" : "Show"} accounts for ${row.model.displayName}`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggle(row.model.key);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        </ComboboxItem>
      );
    }
    if (row.kind === "any") {
      const next = firstAccount(row.model, skips, nowMs);
      return (
        <ComboboxItem
          key={key}
          hideIndicator
          selectedFill={false}
          index={index}
          value={key}
          className="w-full !min-w-0 max-w-full cursor-pointer"
        >
          <span aria-hidden="true" className="w-4 shrink-0" />
          <span className="min-w-0 truncate text-sm leading-snug">Any account, in your order</span>
          {isActive && active.pinned === null ? (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
          ) : null}
          {next !== undefined ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground/70">
              next: {next.account.label}
            </span>
          ) : null}
        </ComboboxItem>
      );
    }
    const position = serving(row.model).indexOf(row.entry) + 1;
    const skip = activeSkip(skips, row.entry.account.id, row.model.key, nowMs);
    return (
      <ComboboxItem
        key={key}
        hideIndicator
        selectedFill={false}
        index={index}
        value={key}
        title="Pinning runs this account even while it's skipped."
        className="w-full !min-w-0 max-w-full cursor-pointer"
      >
        <span aria-hidden="true" className="w-4 shrink-0" />
        <AccountIcon entry={row.entry} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 truncate text-sm leading-snug">
            {position}. {row.entry.account.label}
          </span>
          {isActive && active.pinned === row.entry.account.id ? (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
          ) : null}
          <span className={cn("min-w-0 truncate text-xs text-muted-foreground/70")}>
            {accountSource(row.entry.account)}
          </span>
        </span>
        {skip !== undefined ? <AccountSkipBadge skip={skip} /> : null}
      </ComboboxItem>
    );
  };

  return { keys: [...rows.keys()], allKeys, activeKey, select, onKeyDown, render };
}
