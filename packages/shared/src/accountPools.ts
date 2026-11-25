/**
 * Model routing (fork/differences.md `account-pools`): a routed model is one model the user added,
 * served by several accounts. Its Primary accounts are tried first, by soonest reset or in the
 * user's order, then its Overflow accounts. One evaluator reads each account's usage, reserve and
 * the server's runtime blocks into one state, and every caller picks through it.
 */
import type {
  AccountBlock,
  AccountId,
  AccountReserve,
  ModelRoute,
  ModelSelection,
  PooledModelKey,
  PrimaryOrder,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderModel,
  ServerSettingsPatch,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { inferPiAccountFamily } from "./piAccounts.ts";

export type AccountRoutingSettings = Pick<ServerSettings, "pooledModelKeys"> & {
  /** Each routed model's tiers and order; absent for a model means its default route. */
  readonly modelRouting?: ServerSettings["modelRouting"] | undefined;
  /** Each account's reserve and the models allowed into it. */
  readonly accountReserves?: ServerSettings["accountReserves"] | undefined;
  /** Retired order, read only as the starting route of a model with no `modelRouting`. */
  readonly modelAccounts?: ServerSettings["modelAccounts"] | undefined;
  /** Picker visibility; a hidden model routes only on a known subscription. */
  readonly providerModelPreferences?: ServerSettings["providerModelPreferences"] | undefined;
  /** Models the user counts as another one. */
  readonly modelLinks?: ServerSettings["modelLinks"] | undefined;
};

// ── Usage readings ──────────────────────────────────────────────────────────────────────────

/** Whether the provider can take a turn now, ignoring usage. */
export const isProviderRoutable = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status === "authenticated";

/** The Pi provider ID a model slug names, which is its account key. */
const piAccountKeyOf = (modelSlug: string): string | undefined => {
  const separator = modelSlug.indexOf("/");
  return separator <= 0 ? undefined : modelSlug.slice(0, separator);
};

/**
 * Whether an Antigravity quota window governs `model`: `gemini-*` windows govern Gemini,
 * `3p-*` Claude and GPT, and a window naming no family every model. A Pi slug is read by its
 * model part, so a spent Claude quota never holds back Gemini on the same account.
 */
export const antigravityWindowGoverns = (windowId: string, modelSlug: string): boolean => {
  const family = modelSlug.slice(modelSlug.indexOf("/") + 1).match(/^(gemini|claude|gpt)-/)?.[1];
  const quota = windowId.match(/^(gemini|claude|gpt|3p)-/)?.[1];
  return (
    quota === undefined ||
    family === undefined ||
    quota === family ||
    (quota === "3p" && (family === "claude" || family === "gpt"))
  );
};

/**
 * The quota metering that governs `model` on `provider`: a Pi credential meters as its family,
 * which its usage slot reports, so every Antigravity login scopes its quotas alike.
 */
export const usageMeterOf = (
  provider: Pick<ServerProvider, "driver" | "usageSlots">,
  modelSlug: string,
): string => {
  if (provider.driver !== "pi") return provider.driver;
  const accountKey = piAccountKeyOf(modelSlug);
  if (accountKey === undefined) return provider.driver;
  const family =
    provider.usageSlots?.find((slot) => slot.accountKey === accountKey)?.providerFamily ??
    inferPiAccountFamily(accountKey, undefined);
  return family === "antigravity" ? "antigravity" : provider.driver;
};

/**
 * The usage reading governing `(provider, model)`: a Pi slot reads its own credential's entry,
 * other providers their own reading.
 */
const slotUsageLimits = (
  provider: ServerProvider | undefined,
  model: string,
): ServerProviderUsageLimits | undefined => {
  if (provider === undefined) return undefined;
  if (provider.driver === "pi") {
    const accountKey = piAccountKeyOf(model);
    return accountKey === undefined
      ? undefined
      : provider.usageSlots?.find((slot) => slot.accountKey === accountKey)?.usageLimits;
  }
  return provider.usageLimits;
};

/** Usage windows governing `model` on `provider`, preserving driver-specific window scoping. */
export const governingUsageWindows = (
  provider: ServerProvider | undefined,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> => {
  const windows = (slotUsageLimits(provider, model)?.windows ?? []).filter(
    (window) =>
      (window.modelIds === undefined || window.modelIds.includes(model)) &&
      (window.providerIds === undefined || window.providerIds.includes(model.split("/")[0] ?? "")),
  );
  if (provider === undefined) return windows;
  const scope = provider.conservationScope;
  if (scope !== undefined && !scope.providerIds.includes(model.split("/")[0] ?? "")) return [];
  switch (usageMeterOf(provider, model)) {
    case "cursor": {
      const api = windows.filter((window) => window.id === "apiPercentUsed");
      const auto = windows.filter((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? [...auto, ...api] : api;
    }
    case "antigravity":
      return windows.filter((window) => antigravityWindowGoverns(window.id, model));
    case "codex": {
      const hasPlanWindows = windows.some(
        (window) => window.id === "primary" || window.id === "secondary",
      );
      return windows.filter((window) => window.id !== "individual" || !hasPlanWindows);
    }
    case "opencode":
      return windows.filter(
        (window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"),
      );
    default:
      return windows;
  }
};

// ── Accounts ────────────────────────────────────────────────────────────────────────────────

/** The account a model slug runs on: the instance, or for Pi the instance's credential. */
export const accountIdOf = (
  provider: Pick<ServerProvider, "driver" | "instanceId">,
  modelSlug: string,
): AccountId => {
  if (provider.driver !== "pi") return provider.instanceId;
  return `${provider.instanceId}:${piAccountKeyOf(modelSlug) ?? modelSlug}`;
};

/** The account a selection runs on. */
export const selectionAccountId = (
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): AccountId => {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider === undefined ? selection.instanceId : accountIdOf(provider, selection.model);
};

export interface AccountInfo {
  readonly id: AccountId;
  readonly instanceId: ProviderInstanceId;
  /** The account's own name: the instance's, or the Pi credential's. */
  readonly label: string;
  /** Where the account lives: the provider instance's name for a Pi credential. */
  readonly source: string;
  readonly driver: ServerProvider["driver"];
  readonly accentColor?: string | undefined;
}

const providerName = (provider: ServerProvider) =>
  provider.displayName ?? String(provider.instanceId);

const accountInfo = (provider: ServerProvider, modelSlug: string): AccountInfo => {
  const subProvider = provider.driver === "pi" ? piAccountKeyOf(modelSlug) : undefined;
  return {
    id: accountIdOf(provider, modelSlug),
    instanceId: provider.instanceId,
    label: subProvider ?? providerName(provider),
    source: subProvider === undefined ? provider.driver : providerName(provider),
    driver: provider.driver,
    ...(provider.accentColor === undefined ? {} : { accentColor: provider.accentColor }),
  };
};

// ── Matching models across accounts ─────────────────────────────────────────────────────────

/** Catalog entries that stand for whatever the provider picks, never one model. */
const GENERIC_MODEL_IDS = new Set(["default", "auto"]);
const DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER_TOKEN = /\b\d{4}\b/g;
const ALIAS_NAME = /\blatest\b/i;

/** The name without parentheticals, keeping one that only holds a date or build number. */
const nameTokensSource = (name: string) =>
  name.replace(/\(([^)]*)\)/g, (whole, inner: string) => (/^[\d\s-]+$/.test(inner) ? inner : ""));

/**
 * The model a catalog entry is, provider labels removed (`anthropic/claude-opus-5.5` is
 * `claude-opus-5-5`). Variants never merge: `:batch`, `:free` and `[1m]` suffixes, aliases
 * (marked `@latest`) and name-only dates stay in the key. Generic `default` entries never pool.
 */
export const pooledModelKeyOf = (
  provider: Pick<ServerProvider, "driver">,
  model: Pick<ServerProviderModel, "slug" | "name">,
): PooledModelKey | undefined => {
  let id = model.slug;
  if (provider.driver === "pi") id = id.slice(id.indexOf("/") + 1);
  const alias = id.startsWith("~") || ALIAS_NAME.test(model.name);
  id = id.replace(/^~/, "");
  // Pi slugs such as `openrouter/anthropic/claude-opus-5.5` name the model maker before it.
  const colon = id.indexOf(":");
  const path = colon < 0 ? id : id.slice(0, colon);
  const variant = colon < 0 ? "" : id.slice(colon).toLowerCase();
  const base = path
    .slice(path.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/\./g, "-");
  if (base.length === 0 || GENERIC_MODEL_IDS.has(base)) return undefined;
  const source = nameTokensSource(model.name);
  const dates = source.match(DATE_TOKEN) ?? [];
  const numbers = source.replace(DATE_TOKEN, " ").match(NUMBER_TOKEN) ?? [];
  const extra = [...dates, ...numbers].filter((token) => !base.includes(token));
  return `${[base, ...extra].join("-")}${variant}${alias ? "@latest" : ""}`;
};

/** The model a key runs as once the user's links are followed. */
export const linkedModelKey = (
  links: ServerSettings["modelLinks"],
  key: PooledModelKey,
): PooledModelKey => {
  const seen = new Set<PooledModelKey>();
  let current = key;
  while (links?.[current] !== undefined && !seen.has(current)) {
    seen.add(current);
    current = links[current]!;
  }
  return current;
};

/** An account's model's pooled key, counting the user's links. */
export const pooledKeyIn = (
  settings: Pick<AccountRoutingSettings, "modelLinks">,
  provider: Pick<ServerProvider, "driver">,
  model: Pick<ServerProviderModel, "slug" | "name">,
): PooledModelKey | undefined => {
  const key = pooledModelKeyOf(provider, model);
  return key === undefined ? undefined : linkedModelKey(settings.modelLinks, key);
};

/** The name a pooled model shows: provider labels and an account's own suffix removed. */
const plainModelName = (name: string) =>
  name
    .replace(/^[^:()]+:\s+/, "")
    .replace(/\s*\((?![^)]*(?:latest|batch|exp|\d))[^)]*\)\s*$/i, "")
    .replace(/\s*\([^)]*@[^)]*\)\s*$/, "")
    .trim();

export type AccountTier = "primary" | "overflow" | "off";

export interface PooledAccount {
  readonly account: AccountInfo;
  readonly provider: ServerProvider;
  /** The slug this account runs the model under. */
  readonly model: string;
  /** Where the model's route puts it: tried first, tried after Primary, or not used. */
  readonly tier: AccountTier;
  /** Billed per use, so it serves a model only once the user adds it there. */
  readonly metered: boolean;
  /** Remaining percent at or below which it is held back for this model. */
  readonly reserve?: number | undefined;
  /** The account keeps a reserve this model is allowed into, so it serves the model to 0%. */
  readonly usesReserve?: boolean | undefined;
}

export interface PooledModel {
  readonly key: PooledModelKey;
  readonly displayName: string;
  /** Every account offering the model: Primary and Overflow in the route's order, then the rest. */
  readonly accounts: ReadonlyArray<PooledAccount>;
  readonly primaryOrder: PrimaryOrder;
  /** Models the user counts as this one that an account serves. */
  readonly linked?: ReadonlyArray<PooledModelKey>;
}

type ServingSettings = Pick<
  AccountRoutingSettings,
  "modelRouting" | "modelAccounts" | "providerModelPreferences" | "modelLinks" | "accountReserves"
>;

/** A Pi credential billed per use, as its usage slot reports. */
const isMeteredAccount = (provider: ServerProvider, modelSlug: string): boolean => {
  if (provider.driver !== "pi") return false;
  const accountKey = piAccountKeyOf(modelSlug);
  return (
    accountKey !== undefined &&
    provider.usageSlots?.some((slot) => slot.accountKey === accountKey && slot.metered === true) ===
      true
  );
};

/**
 * Positive evidence an account is a subscription, not credits: a Pi usage slot that is not
 * metered, or a native provider's usage windows. A missing reading proves nothing.
 */
const isKnownSubscription = (provider: ServerProvider, modelSlug: string): boolean => {
  if (provider.driver !== "pi") return (provider.usageLimits?.windows.length ?? 0) > 0;
  const accountKey = piAccountKeyOf(modelSlug);
  const slot = provider.usageSlots?.find((candidate) => candidate.accountKey === accountKey);
  return accountKey !== undefined && slot !== undefined && slot.metered !== true;
};

type ServingAccount = Omit<PooledAccount, "tier" | "reserve" | "usesReserve">;

const hiddenOn = (
  settings: Pick<ServingSettings, "providerModelPreferences">,
  instanceId: ProviderInstanceId,
  slug: string,
) => settings.providerModelPreferences?.[instanceId]?.hiddenModels.includes(slug) === true;

const servingEntries = (providers: ReadonlyArray<ServerProvider>, settings: ServingSettings) => {
  const byKey = new Map<
    PooledModelKey,
    {
      names: string[];
      serving: ServingAccount[];
      linked: Set<PooledModelKey>;
      /** Accounts the model is hidden on that are not known subscriptions. */
      hiddenSpend: Set<AccountId>;
    }
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    // Hiding a model only tidies the picker; a route's Off tier leaves an account out.
    for (const model of provider.models) {
      const own = pooledModelKeyOf(provider, model);
      if (own === undefined) continue;
      const key = linkedModelKey(settings.modelLinks, own);
      const account = accountInfo(provider, model.slug);
      const entry = byKey.get(key) ?? {
        names: [],
        serving: [],
        linked: new Set(),
        hiddenSpend: new Set(),
      };
      if (own !== key) entry.linked.add(own);
      if (
        hiddenOn(settings, provider.instanceId, model.slug) &&
        !isKnownSubscription(provider, model.slug)
      )
        entry.hiddenSpend.add(account.id);
      // One account offering a model twice (an alias and its target) serves it once.
      if (entry.serving.some((existing) => existing.account.id === account.id)) continue;
      entry.names.push(model.name);
      entry.serving.push({
        account,
        provider,
        model: model.slug,
        metered: isMeteredAccount(provider, model.slug),
      });
      byKey.set(key, entry);
    }
  }
  return new Map(
    [...byKey].map(([key, entry]) => {
      const route = effectiveRoute(settings, key, entry.serving, entry.hiddenSpend);
      return [
        key,
        {
          names: entry.names,
          linked: entry.linked,
          primaryOrder: route.primaryOrder,
          accounts: arrangeAccounts(entry.serving, route, (id) =>
            reserveForModel(settings, id, key),
          ),
        },
      ] as const;
    }),
  );
};

/**
 * A model's route: the saved one, else the retired order's (subscriptions Primary, the rest
 * Overflow), else every subscription Primary, never placing `hiddenSpend` (unhiding opts one in).
 * An account in no tier is not used for the model.
 */
const effectiveRoute = (
  settings: Pick<ServingSettings, "modelRouting" | "modelAccounts">,
  key: PooledModelKey,
  serving: ReadonlyArray<Pick<ServingAccount, "account" | "metered">>,
  hiddenSpend: ReadonlySet<AccountId>,
): ModelRoute => {
  const route = placedRoute(settings, key, serving);
  const unhidden = (ids: ReadonlyArray<AccountId>) => ids.filter((id) => !hiddenSpend.has(id));
  return { ...route, primary: unhidden(route.primary), overflow: unhidden(route.overflow) };
};

const placedRoute = (
  settings: Pick<ServingSettings, "modelRouting" | "modelAccounts">,
  key: PooledModelKey,
  serving: ReadonlyArray<Pick<ServingAccount, "account" | "metered">>,
): ModelRoute => {
  const saved = settings.modelRouting?.[key];
  if (saved !== undefined) return saved;
  const legacy = settings.modelAccounts?.[key];
  const subscription = new Set(
    serving.flatMap((entry) => (entry.metered ? [] : [entry.account.id])),
  );
  if (legacy !== undefined)
    return {
      primary: legacy.filter((id) => subscription.has(id)),
      overflow: legacy.filter((id) => !subscription.has(id)),
      primaryOrder: "soonest",
    };
  return { primary: [...subscription], overflow: [], primaryOrder: "soonest" };
};

/** Whether a reserve lets a routed model in, following the user's model links. */
export const reserveAllows = (
  links: ServerSettings["modelLinks"],
  reserve: AccountReserve,
  key: PooledModelKey,
) => reserve.allowedModels.some((model) => linkedModelKey(links, model) === key);

/**
 * How an account's reserve applies to one routed model: a cutoff for a model not allowed into it,
 * none for one that is (it serves to 0%), and nothing when the account keeps no reserve.
 */
const reserveForModel = (
  settings: Pick<AccountRoutingSettings, "accountReserves" | "modelLinks">,
  account: AccountId,
  key: PooledModelKey,
): Pick<PooledAccount, "reserve" | "usesReserve"> => {
  const reserve = settings.accountReserves?.[account];
  if (reserve === undefined) return {};
  return reserveAllows(settings.modelLinks, reserve, key)
    ? { usesReserve: true }
    : { reserve: reserve.percent };
};

/** A model's accounts in route order: Primary, then Overflow, then those it does not use. */
const arrangeAccounts = (
  serving: ReadonlyArray<ServingAccount>,
  route: ModelRoute,
  reserveOf: (id: AccountId) => Pick<PooledAccount, "reserve" | "usesReserve">,
): PooledAccount[] => {
  const tierOf = (id: AccountId): AccountTier =>
    route.primary.includes(id) ? "primary" : route.overflow.includes(id) ? "overflow" : "off";
  const rank = (entry: ServingAccount) => {
    const id = entry.account.id;
    const primary = route.primary.indexOf(id);
    if (primary >= 0) return primary;
    const overflow = route.overflow.indexOf(id);
    return overflow >= 0 ? route.primary.length + overflow : Number.MAX_SAFE_INTEGER;
  };
  return serving
    .map((entry) => ({
      ...entry,
      tier: tierOf(entry.account.id),
      ...reserveOf(entry.account.id),
    }))
    .sort((a, b) => rank(a) - rank(b));
};

const shortestPlainName = (names: ReadonlyArray<string>): string =>
  names
    .map(plainModelName)
    .reduce((shortest, name) => (name.length < shortest.length ? name : shortest));

const disambiguateDisplayNames = (
  pools: ReadonlyArray<PooledModel>,
): ReadonlyArray<PooledModel> => {
  // Models kept apart (an alias beside its dated model) can share a name; the key tells them apart.
  const named = new Map<string, number>();
  for (const pool of pools) named.set(pool.displayName, (named.get(pool.displayName) ?? 0) + 1);
  return pools.map((pool) =>
    named.get(pool.displayName)! > 1
      ? { ...pool, displayName: `${pool.displayName} (${pool.key})` }
      : pool,
  );
};

type ServedEntry = ReturnType<typeof servingEntries> extends Map<unknown, infer V> ? V : never;

const pooledModelFrom = (key: PooledModelKey, entry: ServedEntry): PooledModel => ({
  key,
  displayName: shortestPlainName(entry.names),
  accounts: entry.accounts,
  primaryOrder: entry.primaryOrder,
  ...(entry.linked.size === 0 ? {} : { linked: [...entry.linked] }),
});

const modelsServed = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings,
): ReadonlyArray<PooledModel> =>
  [...servingEntries(providers, settings)].map(([key, entry]) => pooledModelFrom(key, entry));

/** Every model an account serves, each with its accounts in the model's order. */
export const servedModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings,
): ReadonlyArray<PooledModel> => disambiguateDisplayNames(modelsServed(providers, settings));

/** Every model more than one account serves, each with its accounts in the model's order. */
export const multiAccountModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings,
): ReadonlyArray<PooledModel> =>
  disambiguateDisplayNames(
    modelsServed(providers, settings).filter((model) => model.accounts.length >= 2),
  );

/**
 * Every model the user listed, including keys currently served by fewer than two enabled accounts,
 * so Settings → Accounts always keeps a way to inspect and remove them. Routing uses `pooledModels`.
 */
export const listedPooledModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings & Pick<AccountRoutingSettings, "pooledModelKeys">,
): ReadonlyArray<PooledModel> => {
  const entries = servingEntries(providers, settings);
  return disambiguateDisplayNames(
    [...new Set(settings.pooledModelKeys ?? [])].map((key) => {
      const entry = entries.get(key);
      return entry === undefined
        ? { key, displayName: key, accounts: [], primaryOrder: "soonest" as const }
        : pooledModelFrom(key, entry);
    }),
  );
};

/**
 * The models the user added to Model routing that an account serves, even while only one does, so
 * its route and reserves still hold. Any other model is an ordinary model of each account: it runs
 * on the account picked, and no limit moves it.
 */
export const pooledModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings & Pick<AccountRoutingSettings, "pooledModelKeys">,
): ReadonlyArray<PooledModel> => {
  const listed = new Set(settings.pooledModelKeys ?? []);
  return disambiguateDisplayNames(
    modelsServed(providers, settings).filter(
      (pool) => listed.has(pool.key) && pool.accounts.length > 0,
    ),
  );
};

/**
 * The routed model a policy binding names: through an account serving its exact slug, else as a
 * routed model's key, else by the key its slug reads as, so a binding outlives the account it was
 * written against.
 */
export const pooledModelOfBinding = (
  pools: ReadonlyArray<PooledModel>,
  settings: Pick<AccountRoutingSettings, "modelLinks">,
  binding: { readonly driverKind: ServerProvider["driver"]; readonly model: string },
): PooledModel | undefined => {
  const anchored = pools.find((pool) =>
    pool.accounts.some(
      (entry) => entry.provider.driver === binding.driverKind && entry.model === binding.model,
    ),
  );
  if (anchored !== undefined) return anchored;
  const canonical = linkedModelKey(settings.modelLinks, binding.model as PooledModelKey);
  const named = pools.find((pool) => pool.key === canonical);
  if (named !== undefined) return named;
  const key = pooledKeyIn(
    settings,
    { driver: binding.driverKind },
    { slug: binding.model, name: binding.model },
  );
  return key === undefined ? undefined : pools.find((pool) => pool.key === key);
};

type LinkSettings = Pick<
  AccountRoutingSettings,
  "pooledModelKeys" | "modelRouting" | "modelAccounts" | "modelLinks"
>;

/** The accounts a shown model does not use, which a route rebuilt from it keeps unused. */
const offAccounts = (pool: Pick<PooledModel, "accounts">): ReadonlySet<AccountId> =>
  new Set(pool.accounts.flatMap((entry) => (entry.tier === "off" ? [entry.account.id] : [])));

/** The route a model has saved, including the retired order, or undefined while it is the default. */
const savedRoute = (
  settings: Pick<LinkSettings, "modelRouting" | "modelAccounts">,
  pool: Pick<PooledModel, "key" | "accounts">,
): ModelRoute | undefined =>
  settings.modelRouting?.[pool.key] === undefined &&
  settings.modelAccounts?.[pool.key] === undefined
    ? undefined
    : effectiveRoute(settings, pool.key, pool.accounts, offAccounts(pool));

/** Saves a model's route, retiring its old account order. */
const routeWrite = (
  settings: Pick<LinkSettings, "modelAccounts">,
  key: PooledModelKey,
  { primary, overflow, primaryOrder }: ModelRoute,
): ServerSettingsPatch => ({
  modelRouting: { [key]: { primary, overflow, primaryOrder } },
  ...(settings.modelAccounts?.[key] === undefined ? {} : { modelAccounts: { [key]: null } }),
});

/**
 * Counts `source` as `target`: the source stops being a routed model of its own, and an
 * arranged target takes the source's subscriptions at the bottom of Primary (pay-as-you-go ones
 * stay off).
 */
export const linkModelPatch = (
  settings: LinkSettings,
  target: PooledModel,
  source: PooledModel,
): ServerSettingsPatch => {
  const listed = settings.pooledModelKeys ?? [];
  const saved = savedRoute(settings, target);
  const placed = new Set([...(saved?.primary ?? []), ...(saved?.overflow ?? [])]);
  const joining = source.accounts.flatMap((entry) =>
    entry.metered || placed.has(entry.account.id) ? [] : [entry.account.id],
  );
  return {
    modelLinks: { [source.key]: target.key },
    ...(listed.includes(source.key)
      ? { pooledModelKeys: listed.filter((key) => key !== source.key) }
      : {}),
    ...(saved === undefined
      ? {}
      : routeWrite(settings, target.key, { ...saved, primary: [...saved.primary, ...joining] })),
  };
};

/**
 * Separates `source` from `target` again: the source becomes a routed model of its own if the
 * target is one, and the target's route drops the accounts that served it only through the link.
 */
export const unlinkModelPatch = (
  providers: ReadonlyArray<ServerProvider>,
  settings: LinkSettings,
  target: PooledModelKey,
  source: PooledModelKey,
): ServerSettingsPatch => {
  const listed = settings.pooledModelKeys ?? [];
  const links = Object.fromEntries(
    Object.entries(settings.modelLinks ?? {}).filter(([key]) => key !== source),
  );
  const joined = servedModels(providers, settings).find((model) => model.key === target);
  const apart = servedModels(providers, { ...settings, modelLinks: links });
  const accountsOf = (key: PooledModelKey) =>
    new Set(
      apart.find((model) => model.key === key)?.accounts.map((entry) => entry.account.id) ?? [],
    );
  const stillServing = accountsOf(target);
  const leaving = new Set([...accountsOf(source)].filter((id) => !stillServing.has(id)));
  const saved = joined === undefined ? undefined : savedRoute(settings, joined);
  const keep = (ids: ReadonlyArray<AccountId>) => ids.filter((id) => !leaving.has(id));
  return {
    modelLinks: { [source]: null },
    ...(listed.includes(target) && !listed.includes(source)
      ? { pooledModelKeys: [...listed, source] }
      : {}),
    ...(saved === undefined
      ? {}
      : routeWrite(settings, target, {
          ...saved,
          primary: keep(saved.primary),
          overflow: keep(saved.overflow),
        })),
  };
};

/** The route a model shows now, as an edit starts from it. */
const modelRouteOf = (settings: ServingSettings, pool: PooledModel): ModelRoute =>
  effectiveRoute(settings, pool.key, pool.accounts, offAccounts(pool));

/**
 * The patch saving an edit of the accounts a model shows: the edited tiers, order and primary
 * order, keeping the saved accounts not shown now (a disabled provider).
 */
export const modelRoutePatch = (
  settings: ServingSettings,
  pool: PooledModel,
  edit: ModelRoute,
): ServerSettingsPatch => {
  const before = modelRouteOf(settings, pool);
  const shown = new Set(pool.accounts.map((entry) => entry.account.id));
  const hidden = (ids: ReadonlyArray<AccountId>) => ids.filter((id) => !shown.has(id));
  const placed = new Set([...edit.primary, ...edit.overflow]);
  // Placing an account the model is hidden on, not known to be a subscription, opts it in.
  const unhide = pool.accounts.flatMap((entry) =>
    !isKnownSubscription(entry.provider, entry.model) &&
    placed.has(entry.account.id) &&
    hiddenOn(settings, entry.provider.instanceId, entry.model)
      ? [{ provider: entry.provider.instanceId, model: entry.model, hidden: false }]
      : [],
  );
  return {
    ...routeWrite(settings, pool.key, {
      primary: [...edit.primary, ...hidden(before.primary)],
      overflow: [...edit.overflow, ...hidden(before.overflow)],
      primaryOrder: edit.primaryOrder,
    }),
    ...(unhide.length === 0 ? {} : { setModelsHidden: unhide }),
  };
};

// ── Account reserves ────────────────────────────────────────────────────────────────────────

/** The routed models an account serves in Primary or Overflow: those its reserve can hold back. */
export const routedModelsOn = (
  pools: ReadonlyArray<PooledModel>,
  account: AccountId,
): ReadonlyArray<PooledModel> =>
  pools.filter((pool) =>
    pool.accounts.some((entry) => entry.account.id === account && entry.tier !== "off"),
  );

/**
 * Moves retired per-model reserves onto their accounts at the highest percent any model held; models
 * that ran on it unreserved (saved routes through it, default-route models) are allowed in, so they
 * keep serving to 0%. An account's own reserve wins. Routes lose `reserves`.
 */
export const foldRouteReserves = <
  S extends Pick<ServerSettings, "modelRouting" | "accountReserves" | "pooledModelKeys">,
>(
  settings: S,
): S => {
  const routes = settings.modelRouting;
  if (routes === undefined || !Object.values(routes).some((route) => route.reserves !== undefined))
    return settings;
  const percents = new Map<AccountId, number>();
  for (const route of Object.values(routes))
    for (const [account, percent] of Object.entries(route.reserves ?? {}))
      percents.set(account, Math.max(percents.get(account) ?? 0, percent));
  const onDefaultRoute = [...new Set(settings.pooledModelKeys ?? [])].filter(
    (key) => routes[key] === undefined,
  );
  const folded: Record<AccountId, AccountReserve> = {};
  for (const [account, percent] of percents) {
    if (settings.accountReserves?.[account] !== undefined) continue;
    folded[account] = {
      percent,
      allowedModels: [
        ...Object.entries(routes).flatMap(([key, route]) =>
          [...route.primary, ...route.overflow].includes(account) &&
          route.reserves?.[account] === undefined
            ? [key]
            : [],
        ),
        ...onDefaultRoute,
      ],
    };
  }
  return {
    ...settings,
    modelRouting: Object.fromEntries(
      Object.entries(routes).map(([key, { reserves: _retired, ...route }]) => [key, route]),
    ),
    ...(Object.keys(folded).length === 0
      ? {}
      : { accountReserves: { ...settings.accountReserves, ...folded } }),
  };
};

const POOLED_FAVORITE_PREFIX = "pooled:";

/**
 * A pooled model saved among the favorites: its key behind a prefix no provider's model slug
 * starts with, beside the instance of an account serving it, so other clients pass it over.
 */
export const pooledFavoriteModel = (key: PooledModelKey): string => POOLED_FAVORITE_PREFIX + key;

/** The pooled model a saved favorite names, if it names one. */
export const pooledKeyOfFavorite = (favorite: { readonly model: string }) =>
  favorite.model.startsWith(POOLED_FAVORITE_PREFIX)
    ? favorite.model.slice(POOLED_FAVORITE_PREFIX.length)
    : undefined;

/** The pooled model a selection runs, when its model is offered by more than one account. */
export const pooledModelOf = (
  pools: ReadonlyArray<PooledModel>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): PooledModel | undefined =>
  pools.find((pool) =>
    pool.accounts.some(
      (entry) =>
        entry.provider.instanceId === selection.instanceId && entry.model === selection.model,
    ),
  );

/** How routing remembers an account's model: its instance and slug. */
const servedModelId = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

/**
 * Each account model the routed models are served by, with the key its own catalog entry reads
 * as before any link, so a recovery follows the links in force then, not those seen now.
 */
export const routedModelIds = (
  pools: ReadonlyArray<PooledModel>,
): ReadonlyArray<readonly [string, PooledModelKey]> =>
  pools.flatMap((pool) =>
    pool.accounts.flatMap((entry) => {
      const model = entry.provider.models.find((candidate) => candidate.slug === entry.model);
      const key = model === undefined ? undefined : pooledModelKeyOf(entry.provider, model);
      const id = servedModelId({ instanceId: entry.provider.instanceId, model: entry.model });
      return key === undefined ? [] : [[id, key] as const];
    }),
  );

/**
 * The routed model a selection runs, even on an account that no longer serves it (disabled,
 * removed, or the model hidden there): from its catalog entry while the account lists it, else
 * from `seen` (`routedModelIds` as routing last saw them). Never from the slug alone: the catalog
 * name decides dates and `@latest`, so a guess could change the model.
 */
export const pooledModelOfSelection = (
  pools: ReadonlyArray<PooledModel>,
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<AccountRoutingSettings, "modelLinks">,
  selection: Pick<ModelSelection, "instanceId" | "model">,
  seen: ReadonlyMap<string, PooledModelKey> = new Map(),
): PooledModel | undefined => {
  const served = pooledModelOf(pools, selection);
  if (served !== undefined) return served;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  const key =
    provider !== undefined && model !== undefined
      ? pooledKeyIn(settings, provider, model)
      : seen.get(servedModelId(selection));
  if (key === undefined) return undefined;
  const routed = linkedModelKey(settings.modelLinks, key);
  return pools.find((pool) => pool.key === routed);
};

/** The pooled key of a named model, read from the first enabled account that serves it. */
const keyOfNamedModel = (
  providers: ReadonlyArray<ServerProvider>,
  find: (provider: ServerProvider) => ServerProviderModel | undefined,
): PooledModelKey | undefined => {
  for (const provider of providers) {
    const model = provider.enabled ? find(provider) : undefined;
    if (model === undefined) continue;
    const key = pooledModelKeyOf(provider, model);
    if (key !== undefined) return key;
  }
  return undefined;
};

/**
 * The models to pool when the setting is first written: those the user favorited and those their
 * delegation roles name, so nobody loses pooling they already had. A mention fewer than two accounts
 * serve is left out, as the list never shows it; the list is the user's from then on.
 */
export const seedPooledModelKeys = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly favorites: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
  readonly roleModels: ReadonlyArray<{
    readonly driver: ProviderDriverKind;
    readonly model: string;
  }>;
}): ReadonlyArray<PooledModelKey> => {
  const keys = [
    ...input.favorites.map((favorite) =>
      keyOfNamedModel(input.providers, (provider) =>
        provider.instanceId === favorite.provider
          ? provider.models.find((model) => model.slug === favorite.model)
          : undefined,
      ),
    ),
    ...input.roleModels.map((binding) =>
      keyOfNamedModel(input.providers, (provider) =>
        provider.driver === binding.driver
          ? provider.models.find((model) => model.slug === binding.model)
          : undefined,
      ),
    ),
  ];
  const offered = new Set(multiAccountModels(input.providers, {}).map((model) => model.key));
  return [...new Set(keys)].filter(
    (key): key is PooledModelKey => key !== undefined && offered.has(key),
  );
};

// ── Availability ────────────────────────────────────────────────────────────────────────

/** What the evaluator reads besides usage: the server's runtime blocks, at one instant. */
export interface RoutingContext {
  readonly blocks: ReadonlyArray<AccountBlock>;
  readonly nowMs: number;
}

export type AccountState = "available" | "reserved" | "exhausted" | "cooldown";

/** One account's state for one model. */
export interface AccountAvailability {
  readonly state: AccountState;
  /** The lowest remaining percent among the windows governing the model, when any is read. */
  readonly remainingPercent?: number;
  /** When it can serve again: the latest end of what holds it back, when every end is known. */
  readonly returnsAt?: string;
  /** The runtime block holding it back, when one does. */
  readonly block?: AccountBlock;
}

/** Headroom above the reserve a newer reading must show on every window to clear a block. */
const PROBE_CLEAR_HEADROOM_PERCENT = 5;

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const remainingOf = (window: ServerProviderUsageWindow) => 100 - window.usedPercent;

/** A window whose reported reset has passed says nothing about now. */
const isCurrent = (window: ServerProviderUsageWindow, nowMs: number) => {
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return !Number.isFinite(resetMs) || resetMs > nowMs;
};

/**
 * Whether a reading taken after `block` started shows more than the headroom above the reserve on
 * every window governing the model. A failed or unsupported probe, an older reading, one with
 * only T3's own budget window, or one missing a window that governed when the block began is no
 * evidence, so it never clears a block.
 */
export const blockClearedByReading = (
  block: AccountBlock,
  entry: Pick<PooledAccount, "provider" | "model" | "reserve">,
): boolean => {
  const limits = slotUsageLimits(entry.provider, entry.model);
  if (limits === undefined || limits.unavailable !== undefined) return false;
  if (!(Date.parse(limits.checkedAt) > Date.parse(block.since))) return false;
  const windows = governingUsageWindows(entry.provider, entry.model).filter(
    (window) => window.id !== "budget",
  );
  if (block.windowIds?.some((id) => !windows.some((window) => window.id === id)) === true)
    return false;
  const floor = (entry.reserve ?? 0) + PROBE_CLEAR_HEADROOM_PERCENT;
  return windows.length > 0 && windows.every((window) => remainingOf(window) > floor);
};

/**
 * What the usage reading behind an account's state says now: when it was taken and the current
 * governing window with the least left. Read-only, for recording a routing decision.
 */
export const usageReadingOf = (
  entry: Pick<PooledAccount, "provider" | "model">,
  nowMs: number,
):
  | { readonly checkedAt: string; readonly tightest: ServerProviderUsageWindow | undefined }
  | undefined => {
  const limits = slotUsageLimits(entry.provider, entry.model);
  if (limits === undefined) return undefined;
  const tightest = governingUsageWindows(entry.provider, entry.model)
    .filter((window) => isCurrent(window, nowMs))
    .reduce<ServerProviderUsageWindow | undefined>(
      (least, window) =>
        least === undefined || remainingOf(window) < remainingOf(least) ? window : least,
      undefined,
    );
  return { checkedAt: limits.checkedAt, tightest };
};

/** The block still holding an account back for `key`. */
const activeBlock = (
  key: PooledModelKey,
  entry: Pick<PooledAccount, "account" | "provider" | "model" | "reserve">,
  context: RoutingContext,
): AccountBlock | undefined => {
  const block = context.blocks.find(
    (candidate) => candidate.account === entry.account.id && candidate.model === key,
  );
  if (block === undefined || Date.parse(block.until) <= context.nowMs) return undefined;
  return blockClearedByReading(block, entry) ? undefined : block;
};

/**
 * One account's state for `key`: exhausted when a governing window is spent or a failure reported
 * its reset, reserved when a window is at or below the account's reserve, cooling down while a
 * backoff lasts, else available.
 */
export const accountAvailability = (
  key: PooledModelKey,
  entry: Pick<PooledAccount, "account" | "provider" | "model" | "reserve">,
  context: RoutingContext,
): AccountAvailability => {
  const windows = governingUsageWindows(entry.provider, entry.model).filter((window) =>
    isCurrent(window, context.nowMs),
  );
  const reserve = entry.reserve ?? 0;
  const holds: Array<{
    readonly state: Exclude<AccountState, "available">;
    readonly until: string | undefined;
  }> = [];
  for (const window of windows) {
    const left = remainingOf(window);
    if (left <= 0) holds.push({ state: "exhausted", until: window.resetsAt });
    else if (reserve > 0 && left <= reserve)
      holds.push({ state: "reserved", until: window.resetsAt });
  }
  // A limit the provider gave a reset for is spent until then; a backoff is a guess.
  const block = activeBlock(key, entry, context);
  if (block !== undefined)
    holds.push({ state: block.reportedReset ? "exhausted" : "cooldown", until: block.until });
  const remaining =
    windows.length === 0 ? {} : { remainingPercent: Math.min(...windows.map(remainingOf)) };
  if (holds.length === 0) return { state: "available", ...remaining };
  const state = holds.some((hold) => hold.state === "exhausted")
    ? "exhausted"
    : holds.some((hold) => hold.state === "reserved")
      ? "reserved"
      : "cooldown";
  const ends = holds.map((hold) =>
    hold.until === undefined ? Number.NaN : Date.parse(hold.until),
  );
  return {
    state,
    ...remaining,
    ...(ends.every(Number.isFinite) ? { returnsAt: isoOf(Math.max(...ends)) } : {}),
    ...(block === undefined ? {} : { block }),
  };
};

/**
 * The state of a model on an account it is not routed through: its usage and runtime blocks,
 * with no reserve.
 */
export const standaloneAvailability = (
  settings: Pick<AccountRoutingSettings, "modelLinks">,
  provider: ServerProvider,
  modelSlug: string,
  context: RoutingContext,
): AccountAvailability => {
  const model = provider.models.find((candidate) => candidate.slug === modelSlug);
  const key = model === undefined ? undefined : pooledKeyIn(settings, provider, model);
  const entry = { account: accountInfo(provider, modelSlug), provider, model: modelSlug };
  return accountAvailability(key ?? modelSlug, entry, context);
};

// ── Routing ─────────────────────────────────────────────────────────────────────────────────

export interface AccountTarget {
  readonly provider: ServerProvider;
  readonly model: string;
  readonly account: AccountInfo;
  readonly tier?: AccountTier;
}

export interface RouteOptions {
  /** Only accounts that enforce read-only source access, for a read-only task. */
  readonly readOnly?: boolean | undefined;
}

export interface RankedAccount {
  readonly entry: PooledAccount;
  readonly availability: AccountAvailability;
}

const usable = (entry: PooledAccount, options: RouteOptions | undefined) =>
  entry.tier !== "off" &&
  isProviderRoutable(entry.provider) &&
  (options?.readOnly !== true || entry.provider.readOnlySourceAccess === "enforced");

const WINDOW_KIND_MINUTES: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
  other: 0,
};

/**
 * When an account's allowance resets for Soonest reset: the reset of its longest governing window
 * with a known future reset, so a weekly quota expiring sooner is never hidden by a 5-hour timer.
 */
export const rankingResetMs = (
  entry: Pick<PooledAccount, "provider" | "model">,
  nowMs: number,
): number | undefined => {
  let best: { minutes: number; resetMs: number } | undefined;
  for (const window of governingUsageWindows(entry.provider, entry.model)) {
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    const minutes = window.windowDurationMins ?? WINDOW_KIND_MINUTES[window.kind];
    if (
      best === undefined ||
      minutes > best.minutes ||
      (minutes === best.minutes && resetMs > best.resetMs)
    )
      best = { minutes, resetMs };
  }
  return best?.resetMs;
};

/** Soonest reset first; accounts with no known reset after them; ties keep the user's order. */
const soonestFirst = (entries: ReadonlyArray<PooledAccount>, nowMs: number) =>
  entries
    .map((entry, index) => ({ entry, index, resetMs: rankingResetMs(entry, nowMs) }))
    .sort(
      (a, b) =>
        Number(a.resetMs === undefined) - Number(b.resetMs === undefined) ||
        (a.resetMs ?? 0) - (b.resetMs ?? 0) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);

/** A routed model's Primary accounts in the order it tries them: soonest reset, or the user's. */
export const primaryInOrder = (pool: PooledModel, nowMs: number): ReadonlyArray<PooledAccount> => {
  const primary = pool.accounts.filter((entry) => entry.tier === "primary");
  return pool.primaryOrder === "manual" ? primary : soonestFirst(primary, nowMs);
};

/** A routed model's usable accounts in the order new work tries them, each with its state. */
export const rankAccounts = (
  pool: PooledModel,
  context: RoutingContext,
  options?: RouteOptions,
): ReadonlyArray<RankedAccount> =>
  [
    ...primaryInOrder(pool, context.nowMs),
    ...pool.accounts.filter((entry) => entry.tier === "overflow"),
  ]
    .filter((entry) => usable(entry, options))
    .map((entry) => ({ entry, availability: accountAvailability(pool.key, entry, context) }));

const toTarget = (entry: PooledAccount): AccountTarget => ({
  provider: entry.provider,
  model: entry.model,
  account: entry.account,
  tier: entry.tier,
});

export type AccountPick =
  | { readonly type: "account"; readonly target: AccountTarget }
  | {
      readonly type: "unavailable";
      /** The earliest an account returns, when one's return is known. */
      readonly returnsAt?: string;
      /**
       * The cooling account that returns soonest, when one is: a cool-down is a guess, so work may
       * try it rather than wait. Reserved and exhausted accounts are never offered.
       */
      readonly coolingDown?: AccountTarget;
    };

/** When a model returns: the earliest known return among its accounts. */
const unavailablePick = (ranked: ReadonlyArray<RankedAccount>): AccountPick => {
  const returns = ranked.flatMap(({ availability }) =>
    availability.returnsAt === undefined ? [] : [Date.parse(availability.returnsAt)],
  );
  const cooling = [...ranked]
    .filter(({ availability }) => availability.state === "cooldown")
    .sort(
      (a, b) =>
        Date.parse(a.availability.returnsAt ?? "") - Date.parse(b.availability.returnsAt ?? ""),
    )[0];
  return {
    type: "unavailable",
    ...(returns.length === 0 ? {} : { returnsAt: isoOf(Math.min(...returns)) }),
    ...(cooling === undefined ? {} : { coolingDown: toTarget(cooling.entry) }),
  };
};

/**
 * The account work on `pool`'s model runs on. A thread's `current` account keeps it while it is
 * available, so its prompt cache keeps paying off, even on Overflow; otherwise the first available
 * account in the order: Primary, then Overflow. `exclude` is an account that just failed.
 */
export const pickAccount = (
  pool: PooledModel,
  context: RoutingContext,
  options?: RouteOptions & {
    readonly current?: AccountId | undefined;
    readonly exclude?: AccountId | undefined;
  },
): AccountPick => {
  const ranked = rankAccounts(pool, context, options).filter(
    ({ entry }) => entry.account.id !== options?.exclude,
  );
  const available = ranked.filter(({ availability }) => availability.state === "available");
  const chosen =
    available.find(({ entry }) => entry.account.id === options?.current) ?? available[0];
  return chosen === undefined
    ? unavailablePick(ranked)
    : { type: "account", target: toTarget(chosen.entry) };
};

const REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "reasoning_effort",
  "effort",
  "thinking",
  "thought_level",
]);

const isReasoningDescriptor = (descriptor: ProviderOptionDescriptor): boolean =>
  (descriptor.type === "select" && descriptor.role === "reasoning") ||
  REASONING_OPTION_IDS.has(descriptor.id);

/**
 * The selection that runs the model on `target`: options the target offers are kept, a
 * reasoning effort carries across to the target's own effort option, and the rest are dropped.
 */
export const selectionOnAccount = (
  target: Pick<AccountTarget, "provider" | "model">,
  baseOptions: ReadonlyArray<ProviderOptionSelection> | undefined,
  pinned?: boolean,
): ModelSelection => {
  const model = target.provider.models.find((candidate) => candidate.slug === target.model);
  const descriptors = model?.capabilities?.optionDescriptors;
  const base = {
    instanceId: target.provider.instanceId,
    model: target.model,
    ...(pinned === true ? { pinned: true } : {}),
  };
  if (descriptors === undefined) {
    // A catalog without descriptors (tests, a provider still loading) keeps the options as given.
    const keep = target.provider.models.length === 0 ? baseOptions : undefined;
    return keep !== undefined && keep.length > 0 ? { ...base, options: keep } : base;
  }
  const options: ProviderOptionSelection[] = [];
  const requested = baseOptions ?? [];
  const reasoning = requested.find(
    (option) => typeof option.value === "string" && REASONING_OPTION_IDS.has(option.id),
  );
  for (const descriptor of descriptors) {
    const exact = requested.find((option) => option.id === descriptor.id);
    if (
      exact !== undefined &&
      ((descriptor.type === "select" &&
        typeof exact.value === "string" &&
        descriptor.options.some((choice) => choice.id === exact.value)) ||
        (descriptor.type === "boolean" && typeof exact.value === "boolean"))
    ) {
      options.push({ id: descriptor.id, value: exact.value });
      continue;
    }
    if (
      descriptor.type === "select" &&
      isReasoningDescriptor(descriptor) &&
      reasoning !== undefined &&
      descriptor.options.some((choice) => choice.id === reasoning.value)
    ) {
      options.push({ id: descriptor.id, value: reasoning.value });
    }
  }
  return options.length > 0 ? { ...base, options } : base;
};
