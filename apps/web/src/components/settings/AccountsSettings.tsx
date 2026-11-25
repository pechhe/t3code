import {
  AuthProvidersManageScope,
  type AccountId,
  type EnvironmentId,
  type ModelRoute,
  type PooledModelKey,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  accountAvailability,
  governingUsageWindows,
  isProviderRoutable,
  linkedModelKey,
  linkModelPatch,
  listedPooledModels,
  modelRoutePatch,
  multiAccountModels,
  pickAccount,
  pooledModels,
  primaryInOrder,
  rankingResetMs,
  routedModelsOn,
  servedModels,
  unlinkModelPatch,
  type AccountInfo,
  type AccountTier,
  type PooledAccount,
  type PooledModel,
  type RoutingContext,
} from "@t3tools/shared/accountPools";
import * as DateTime from "effect/DateTime";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useClientSettings,
  useEnvironmentSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import {
  AccountStateBadge,
  accountSource,
  TryNowButton,
  useRoutingContext,
} from "../accounts/AccountAvailability";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
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
import { LimitWindows } from "../usage/UsageLimits";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AccountReserveControl } from "./AccountReserveControl";
import { PiCredentials } from "./PiCredentials";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settingsLayout";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettingsMixed, useUpdateEnvironmentScopedSettings } from "./useScopedSettings";
import { useInstanceEntries } from "./useInstanceEntries";

/** Settings → Accounts: each Pi credential, and the models T3 picks the account for. */
export function AccountsSettings() {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const target = environment ?? environments[0];
  const environmentId = target?.environmentId;
  return (
    <SettingsPageContainer>
      {environmentId === undefined ? (
        <p className="px-4 text-sm text-muted-foreground">
          <T>Connect an environment to manage its accounts.</T>
        </p>
      ) : (
        <AccountsViews
          key={environmentId}
          environmentId={environmentId}
          environmentLabel={target?.label}
          allEnvironments={scope.kind === "all" && connectedEnvironments.length > 1}
        />
      )}
    </SettingsPageContainer>
  );
}

/**
 * One page: the accounts and what each keeps in reserve, then the order each routed model tries
 * them in, so a reserve and the routes it affects are read together.
 */
function AccountsViews({
  environmentId,
  environmentLabel,
  allEnvironments,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string | undefined;
  allEnvironments: boolean;
}) {
  const gt = useGT();
  const { settings: environmentSettings, providers } = useInstanceEntries(environmentId);
  const settings = useOptionalSettingsScope()?.target?.settings ?? environmentSettings;
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const routedModels = withPooledModelLabels(pooledModels(providers, settings), slotLabels);
  return (
    <>
      <SettingsSearchTarget id="pi-credentials" className="flex flex-col gap-6">
        <SettingsSection
          title={gt("Accounts and credentials")}
          headerAction={
            environmentLabel ? (
              <span className="text-xs text-muted-foreground">
                {allEnvironments ? (
                  <T>
                    All environments · showing <Var>{environmentLabel}</Var>
                  </T>
                ) : (
                  <T>
                    Environment: <Var>{environmentLabel}</Var>
                  </T>
                )}
              </span>
            ) : undefined
          }
        >
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            <T>
              The subscriptions and API keys this environment runs models on. A reserve keeps an
              account&apos;s last few percent of quota or monthly budget for the models you allow
              into it; every other routed model, including any you add later, moves on to its next
              account.
            </T>
          </p>
        </SettingsSection>
        <PiCredentials
          environmentId={environmentId}
          providers={providers}
          routedModels={routedModels}
        />
        <ProviderAccountReserves
          environmentId={environmentId}
          providers={providers}
          routedModels={routedModels}
          disabled={!canManage}
        />
      </SettingsSearchTarget>
      <EnvironmentAccounts environmentId={environmentId} />
    </>
  );
}

/**
 * Accounts outside Pi (a native Claude or Codex login) that serve a routed model, so their
 * reserve is set here too.
 */
function ProviderAccountReserves(props: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  routedModels: ReadonlyArray<PooledModel>;
  disabled: boolean;
}) {
  const gt = useGT();
  const environmentReserves = useEnvironmentSettings(props.environmentId, (s) => s.accountReserves);
  const scoped = useOptionalSettingsScope()?.target;
  const reserves = scoped ? scoped.settings.accountReserves : environmentReserves;
  const now = Date.parse(`${useNowMinute()}Z`);
  const accounts = props.providers.filter(
    (provider) =>
      provider.driver !== "pi" &&
      (reserves?.[provider.instanceId] !== undefined ||
        ((provider.usageLimits?.windows.length ?? 0) > 0 &&
          routedModelsOn(props.routedModels, provider.instanceId).length > 0)),
  );
  if (accounts.length === 0) return null;
  return (
    <SettingsSection title={gt("Provider accounts")}>
      {accounts.map((provider) => {
        const windows = provider.usageLimits?.windows ?? [];
        const label = provider.displayName ?? provider.instanceId;
        return (
          <SettingsRow
            key={provider.instanceId}
            title={label}
            description={<code className="font-mono text-xs">{provider.instanceId}</code>}
          >
            <div className="mt-2 flex flex-col gap-2">
              {windows.length > 0 ? (
                <LimitWindows
                  driver={provider.driver}
                  accentColor={provider.accentColor}
                  windows={windows}
                  now={now}
                  reserve={reserves?.[provider.instanceId]?.percent}
                  compact
                />
              ) : null}
              <AccountReserveControl
                environmentId={props.environmentId}
                account={provider.instanceId}
                accountLabel={label}
                routedModels={props.routedModels}
                metered={windows.length > 0}
                disabled={props.disabled}
              />
            </div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
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
  const gt = useGT();
  const { settings: environmentSettings, providers } = useInstanceEntries(environmentId);
  const settings = useOptionalSettingsScope()?.target?.settings ?? environmentSettings;
  const allScope = useSettingsScope().scope.kind === "all";
  const mixed = useScopedSettingsMixed(["pooledModelKeys", "modelRouting", "modelLinks"]);
  const showMixed = mixed && allScope;
  const update = useUpdateEnvironmentScopedSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const routing = useRoutingContext(environmentId);
  const listed = settings.pooledModelKeys ?? [];
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const models = withPooledModelLabels(
    listedPooledModels(providers, settings),
    slotLabels,
  ).toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  const candidates = withPooledModelLabels(multiAccountModels(providers, settings), slotLabels)
    .filter((model) => !listed.includes(model.key))
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  const links = settings.modelLinks ?? {};
  // Names of the models linked into another, as their accounts call them on their own.
  const unlinked = servedModels(providers, { ...settings, modelLinks: undefined });
  const served = servedModels(providers, settings);
  const linkedInto = (key: PooledModelKey) =>
    Object.keys(links)
      .filter((source) => linkedModelKey(links, source) === key)
      .map((source) => ({
        key: source,
        name: unlinked.find((model) => model.key === source)?.displayName ?? source,
      }));
  const addModel = (key: PooledModelKey) => update({ pooledModelKeys: [...listed, key] });
  const removeModel = (key: PooledModelKey) =>
    update({ pooledModelKeys: listed.filter((listedKey) => listedKey !== key) });
  return (
    <>
      <SettingsSection
        title={gt("Model routing")}
        id="accounts"
        headerAction={
          <AddModelPicker
            candidates={candidates}
            disabled={!canManage}
            onAdd={addModel}
            label={gt("Add model")}
            ariaLabel={gt("Add a model T3 Code picks the account for")}
          />
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>
            New threads, delegated tasks and Champions run each model on its first available Primary
            account, and on Overflow only once no Primary account is available. An account&apos;s
            reserve, set above, holds it back from the models it doesn&apos;t allow. A thread keeps
            its account while that account stays available, so its prompt cache keeps paying off.
            Models you haven&apos;t added run on the account you pick.
          </T>
        </p>
        {showMixed ? (
          <p className="px-3 pb-2.5 text-xs text-muted-foreground sm:px-4">
            <T>
              Model routing differs across environments. Edits apply to all selected environments.
            </T>
          </p>
        ) : null}
        {models.length === 0 ? (
          <p className="px-3 pb-2.5 text-sm text-muted-foreground sm:px-4">
            <T>
              No models are added yet. Add one to let T3 Code choose between the accounts that serve
              it.
            </T>
          </p>
        ) : null}
      </SettingsSection>
      {models.map((model) => (
        <ModelRouteCard
          key={model.key}
          model={model}
          environmentId={environmentId}
          routing={routing}
          disabled={!canManage}
          onRemove={() => removeModel(model.key)}
          onSetRoute={(route) => update(modelRoutePatch(settings, model, route))}
          linked={linkedInto(model.key)}
          linkCandidates={served.filter(
            (candidate) => candidate.key !== model.key && candidate.accounts.length > 0,
          )}
          onLink={(source) => update(linkModelPatch(settings, model, source))}
          onUnlink={(source) => update(unlinkModelPatch(providers, settings, model.key, source))}
        />
      ))}
    </>
  );
}

/** The route a model shows, from the accounts it shows, as an edit starts from it. */
const shownRoute = (model: PooledModel): ModelRoute => ({
  primary: model.accounts.flatMap((entry) => (entry.tier === "primary" ? [entry.account.id] : [])),
  overflow: model.accounts.flatMap((entry) =>
    entry.tier === "overflow" ? [entry.account.id] : [],
  ),
  primaryOrder: model.primaryOrder,
});

/** One routed model: its live pick, Primary and Overflow, the accounts it does not use and links. */
function ModelRouteCard(props: {
  model: PooledModel;
  environmentId: EnvironmentId;
  routing: RoutingContext;
  disabled: boolean;
  onRemove: () => void;
  onSetRoute: (route: ModelRoute) => void;
  /** Models counted as this one, as their accounts name them. */
  linked: ReadonlyArray<{ key: PooledModelKey; name: string }>;
  linkCandidates: ReadonlyArray<PooledModel>;
  onLink: (source: PooledModel) => void;
  onUnlink: (source: PooledModelKey) => void;
}) {
  const { model, routing } = props;
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const route = shownRoute(model);
  const pick = pickAccount(model, routing);
  const next = pick.type === "account" ? pick.target : undefined;
  const primary = primaryInOrder(model, routing.nowMs);
  const overflow = model.accounts.filter((entry) => entry.tier === "overflow");
  const off = model.accounts.filter((entry) => entry.tier === "off");
  const returnsAt =
    pick.type === "unavailable" && pick.returnsAt !== undefined
      ? formatUpcomingTimestamp(pick.returnsAt, timestampFormat, undefined, undefined, resolve)
      : undefined;
  const moveTier = (id: AccountId, to: AccountTier) => {
    const without = (ids: ReadonlyArray<AccountId>) => ids.filter((candidate) => candidate !== id);
    props.onSetRoute({
      ...route,
      primary: to === "primary" ? [...without(route.primary), id] : without(route.primary),
      overflow: to === "overflow" ? [...without(route.overflow), id] : without(route.overflow),
    });
  };
  const reorder = (tier: "primary" | "overflow", id: AccountId, steps: number) => {
    const ids = [...route[tier]];
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + steps));
    if (from === -1 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    props.onSetRoute({ ...route, [tier]: ids });
  };
  const rows = (entries: ReadonlyArray<PooledAccount>, tier: "primary" | "overflow") =>
    entries.length === 0 ? (
      <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        {tier === "primary"
          ? gt("No accounts in Primary. Move one here, or add one below.")
          : gt("No accounts in Overflow. Move one here, or add one below.")}
      </p>
    ) : (
      <ol
        aria-label={gt(
          "{tier, select, primary {{model} Primary accounts, tried first at the top} other {{model} Overflow accounts, tried first at the top}}",
          { tier, model: model.displayName },
        )}
        className="divide-y divide-border/60 rounded-lg border border-border/60"
      >
        {entries.map((entry, index) => (
          <RouteAccountRow
            key={entry.account.id}
            entry={entry}
            modelKey={model.key}
            modelName={model.displayName}
            environmentId={props.environmentId}
            routing={routing}
            position={index + 1}
            next={next?.account.id === entry.account.id}
            reorderable={tier === "overflow" || model.primaryOrder === "manual"}
            first={index === 0}
            last={index === entries.length - 1}
            tier={tier}
            disabled={props.disabled}
            onMove={(steps) => reorder(tier, entry.account.id, steps)}
            onTier={(to) => moveTier(entry.account.id, to)}
          />
        ))}
      </ol>
    );
  return (
    <SettingsSection
      title={model.displayName}
      titleAction={
        model.accounts.length === 0 ? null : next !== undefined ? (
          <Badge variant={next.tier === "overflow" ? "warning" : "success"} size="sm">
            {next.tier === "overflow"
              ? gt("Overflow → {account}", { account: next.account.label })
              : gt("Next up: {account}", { account: next.account.label })}
          </Badge>
        ) : (
          <Badge variant="error" size="sm">
            {returnsAt === undefined
              ? gt("All accounts unavailable")
              : gt("All accounts unavailable until {until}", { until: returnsAt })}
          </Badge>
        )
      }
      headerAction={
        <span className="flex items-center gap-1">
          <ToggleGroup
            aria-label={gt("How {model} picks among Primary accounts", {
              model: model.displayName,
            })}
            variant="segmented"
            value={[model.primaryOrder]}
            disabled={props.disabled}
            onValueChange={(value) => {
              const order = value[0];
              if (order === "soonest" || order === "manual")
                props.onSetRoute({ ...route, primaryOrder: order });
            }}
          >
            <Toggle value="soonest">
              <T>Soonest reset</T>
            </Toggle>
            <Toggle value="manual">
              <T>Manual order</T>
            </Toggle>
          </ToggleGroup>
          <RemoveModelButton
            label={model.displayName}
            disabled={props.disabled}
            onRemove={props.onRemove}
          />
        </span>
      }
    >
      {model.accounts.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
          <T>No enabled accounts serve this model now.</T>
        </p>
      ) : (
        <>
          <RouteTier
            label={gt("Primary", { $context: "account routing tier" })}
            hint={
              model.primaryOrder === "soonest"
                ? gt("Picks the available account whose longest allowance resets soonest")
                : gt("Tried top to bottom")
            }
          >
            {rows(primary, "primary")}
          </RouteTier>
          <RouteTier
            label={gt("Overflow", { $context: "account routing tier" })}
            hint={gt("API credits and backups, used only once Primary is out or past its reserve")}
          >
            {rows(overflow, "overflow")}
          </RouteTier>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {off.length > 0 ? (
          <span>
            <T>Not used:</T>
          </span>
        ) : null}
        {off.map((entry) => (
          <Button
            key={entry.account.id}
            type="button"
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={gt("Use {account} for {model} in Overflow", {
              account: entry.account.label,
              model: model.displayName,
            })}
            onClick={() => moveTier(entry.account.id, "overflow")}
          >
            <PlusIcon />
            {entry.account.label}
          </Button>
        ))}
        {props.linked.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            <span>
              <T>Also counts:</T>
            </span>
            {props.linked.map((source) => (
              <span
                key={source.key}
                className="inline-flex items-center gap-0.5 rounded-md border border-border/60 ps-1.5"
              >
                {source.name}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={props.disabled}
                  aria-label={gt("Stop counting {source} as {model}", {
                    source: source.name,
                    model: model.displayName,
                  })}
                  onClick={() => props.onUnlink(source.key)}
                >
                  <XIcon />
                </Button>
              </span>
            ))}
          </span>
        ) : null}
        <span className="ms-auto">
          <AddModelPicker
            candidates={props.linkCandidates}
            disabled={props.disabled}
            onAdd={(key) => {
              const source = props.linkCandidates.find((candidate) => candidate.key === key);
              if (source !== undefined) props.onLink(source);
            }}
            label={gt("Count another model")}
            ariaLabel={gt("Count another model's accounts as {model}", {
              model: model.displayName,
            })}
          />
        </span>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <span>{gt("What agents see in {tool}", { tool: "agent_roles" })}</span>
        <code className="font-mono text-foreground/80">
          {JSON.stringify({
            model: model.key,
            available: next !== undefined,
            ...(pick.type === "unavailable" && pick.returnsAt !== undefined
              ? { returnsAt: pick.returnsAt }
              : {}),
          })}
        </code>
      </p>
    </SettingsSection>
  );
}

function RouteTier(props: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium text-foreground">{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.hint}</span>
      </p>
      {props.children}
    </div>
  );
}

/** Remaining usage, with a notch at the reserve below which the account is held back. */
function QuotaMeter(props: { remaining: number; reserve: number | undefined; state: string }) {
  const remaining = Math.max(0, Math.min(100, props.remaining));
  return (
    <span aria-hidden className="relative inline-block h-1.5 w-20 shrink-0 rounded-full bg-muted">
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          props.state === "exhausted"
            ? "bg-destructive"
            : props.state === "available"
              ? "bg-success"
              : "bg-warning",
        )}
        style={{ width: `${remaining}%` }}
      />
      {props.reserve !== undefined && props.reserve > 0 ? (
        <span
          className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-warning"
          style={{ left: `${props.reserve}%` }}
        />
      ) : null}
    </span>
  );
}

function RouteAccountRow(props: {
  entry: PooledAccount;
  modelKey: PooledModelKey;
  modelName: string;
  environmentId: EnvironmentId;
  routing: RoutingContext;
  position: number;
  next: boolean;
  reorderable: boolean;
  first: boolean;
  last: boolean;
  tier: "primary" | "overflow";
  disabled: boolean;
  onMove: (steps: number) => void;
  onTier: (to: AccountTier) => void;
}) {
  const { entry } = props;
  const { account } = entry;
  const gt = useGT();
  const resolve = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const availability = accountAvailability(props.modelKey, entry, props.routing);
  const resetMs = rankingResetMs(entry, props.routing.nowMs);
  const budget = governingUsageWindows(entry.provider, entry.model).find(
    (window) => window.limitUsd !== undefined && window.usedUsd !== undefined,
  );
  const remaining = availability.remainingPercent;
  const routable = isProviderRoutable(entry.provider);
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ps-3 pe-1.5",
        props.next && "bg-success/4",
      )}
    >
      <span className="w-4 text-xs tabular-nums text-muted-foreground">{props.position}</span>
      <AccountIcon account={account} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              availability.state !== "available" && "text-muted-foreground",
            )}
          >
            {account.label}
          </span>
          <Link
            to="/settings/providers"
            search={{ environmentId: props.environmentId, instanceId: account.instanceId }}
            className="min-w-0 truncate text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-current"
          >
            {accountSource(account)}
          </Link>
          {props.next ? (
            <Badge variant="success" size="sm">
              <T>Next up</T>
            </Badge>
          ) : null}
          <AccountStateBadge availability={availability} reserve={entry.reserve} />
          {entry.usesReserve === true ? (
            <Badge
              variant="success"
              size="sm"
              title={gt("{model} is allowed into this account's reserve, so it can use it to 0%.", {
                model: props.modelName,
              })}
            >
              <T>Uses reserve</T>
            </Badge>
          ) : entry.reserve !== undefined && availability.state === "available" ? (
            <Badge
              variant="outline"
              size="sm"
              title={gt(
                "At or below {percent}% left, this account holds its reserve back from {model}.",
                { percent: entry.reserve, model: props.modelName },
              )}
            >
              {gt("Stops at {percent}%", { percent: entry.reserve })}
            </Badge>
          ) : null}
          {routable ? null : (
            <span className="text-xs text-muted-foreground">
              <T>provider unavailable</T>
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
          {remaining === undefined ? (
            <span>{entry.metered ? gt("Pay as you go") : gt("No usage reading")}</span>
          ) : (
            <>
              <QuotaMeter
                remaining={remaining}
                reserve={entry.reserve}
                state={availability.state}
              />
              <span className="text-foreground/80">
                {gt("{percent}% left", { percent: Math.round(remaining) })}
              </span>
            </>
          )}
          {budget?.limitUsd !== undefined && budget.usedUsd !== undefined ? (
            <span>
              {gt("{left} / {limit} left", {
                left: `$${Math.max(0, budget.limitUsd - budget.usedUsd).toFixed(2)}`,
                limit: `$${budget.limitUsd}`,
              })}
            </span>
          ) : null}
          {resetMs !== undefined ? (
            <span>
              {gt("resets {when}", {
                when: formatUpcomingTimestamp(
                  isoOf(resetMs),
                  timestampFormat,
                  props.routing.nowMs,
                  undefined,
                  resolve,
                ),
              })}
            </span>
          ) : null}
        </span>
      </span>
      <span className="ms-auto flex items-center gap-0.5">
        {availability.block !== undefined ? (
          <TryNowButton
            environmentId={props.environmentId}
            account={account.id}
            model={props.modelKey}
          />
        ) : null}
        {props.reorderable ? (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || props.first}
              aria-label={gt("Move {account} up for {model}", {
                account: account.label,
                model: props.modelName,
              })}
              onClick={() => props.onMove(-1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={props.disabled || props.last}
              aria-label={gt("Move {account} down for {model}", {
                account: account.label,
                model: props.modelName,
              })}
              onClick={() => props.onMove(1)}
            >
              <ArrowDownIcon />
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={props.disabled}
          onClick={() => props.onTier(props.tier === "primary" ? "overflow" : "primary")}
        >
          {props.tier === "primary" ? gt("To Overflow") : gt("To Primary")}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.disabled}
          aria-label={gt("Don't use {account} for {model}", {
            account: account.label,
            model: props.modelName,
          })}
          onClick={() => props.onTier("off")}
        >
          <XIcon />
        </Button>
      </span>
    </li>
  );
}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function RemoveModelButton(props: { label: string; disabled: boolean; onRemove: () => void }) {
  const gt = useGT();
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost-muted"
      disabled={props.disabled}
      aria-label={gt("Remove {model} from the models T3 Code picks an account for", {
        model: props.label,
      })}
      onClick={props.onRemove}
    >
      <XIcon />
    </Button>
  );
}

/** Searches models by name or account, for adding one as a pooled model or into another. */
function AddModelPicker(props: {
  candidates: ReadonlyArray<PooledModel>;
  disabled: boolean;
  onAdd: (key: PooledModelKey) => void;
  label: string;
  ariaLabel: string;
}) {
  const gt = useGT();
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
        aria-label={props.ariaLabel}
        disabled={props.disabled || props.candidates.length === 0}
        render={<Button size="xs" variant="outline" />}
      >
        <PlusIcon />
        {props.label}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-80">
        <ComboboxSearchInput
          aria-label={gt("Search models")}
          placeholder={gt("Search models...")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          <T>No models are left to add.</T>
        </ComboboxEmpty>
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
