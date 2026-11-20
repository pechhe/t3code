/**
 * A pool is one model the user added to their pooled models, served by several accounts and tried
 * in that model's own account order. Usage readings fill the Usage bars and supply reset times; they
 * never decide routing.
 */
import type {
  AccountId,
  AccountSkip,
  AccountSkips,
  ModelSelection,
  PooledModelKey,
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

export type AccountRoutingSettings = Pick<ServerSettings, "pooledModelKeys" | "accountSkips"> & {
  /** Absent, or absent for a model, means it runs on every subscription account serving it. */
  readonly modelAccounts?: ServerSettings["modelAccounts"] | undefined;
  /** A model hidden on an account is one that account does not offer. */
  readonly providerModelPreferences?: ServerSettings["providerModelPreferences"] | undefined;
  /** Models the user counts as another one. */
  readonly modelLinks?: ServerSettings["modelLinks"] | undefined;
};

// ── Usage readings ──────────────────────────────────────────────────────────────────────────

/** Whether the provider can take a turn now, ignoring usage limits. */
const isProviderRoutable = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status === "authenticated";

/** A window at its limit counts until its reported reset has passed. */
export const isProviderUsageExhausted = (provider: ServerProvider, nowMs: number): boolean =>
  provider.usageLimits?.windows.some(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  ) === true;

/** The Pi sub-provider a model slug names, which is its account key. */
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

/** The quota metering that governs `model` on `provider`: a Pi slot meters as its sub-provider. */
export const usageMeterOf = (provider: Pick<ServerProvider, "driver">, modelSlug: string): string =>
  provider.driver === "pi" && piAccountKeyOf(modelSlug) === "antigravity"
    ? "antigravity"
    : provider.driver;

/**
 * The usage reading governing `(provider, model)`: a Pi slot reads its own sub-provider entry,
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
const applicableSlotUsageWindows = (
  provider: ServerProvider | undefined,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> => {
  const windows = (slotUsageLimits(provider, model)?.windows ?? []).filter(
    (window) =>
      (window.modelIds === undefined || window.modelIds.includes(model)) &&
      (window.providerIds === undefined || window.providerIds.includes(model.split("/")[0] ?? "")),
  );
  if (provider === undefined) return windows;
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

/** Subscription conservation (T3-611) holds `model` back from new managed subagents. */
export const isConserved = (provider: ServerProvider, model: string): boolean => {
  const conservation = provider.subagentConservation;
  return (
    conservation !== undefined &&
    conservation.state !== "ready" &&
    conservation.models.includes(model)
  );
};

// ── Accounts ────────────────────────────────────────────────────────────────────────────────

/** The account a model slug runs on: the instance, or for Pi the instance's sub-provider. */
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
  /** The account's own name: the instance's, or the Pi sub-provider's. */
  readonly label: string;
  /** Where the account lives: the provider instance's name for a Pi sub-provider. */
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

export interface PooledAccount {
  readonly account: AccountInfo;
  readonly provider: ServerProvider;
  /** The slug this account runs the model under. */
  readonly model: string;
  /** Off this model: left out of the user's list for it, or billed per use and never added. */
  readonly removed: boolean;
  /** Billed per use, so it serves a model only once the user adds it there. */
  readonly metered: boolean;
}

export interface PooledModel {
  readonly key: PooledModelKey;
  readonly displayName: string;
  /** Every account offering the model, in the model's order, the ones off it last. */
  readonly accounts: ReadonlyArray<PooledAccount>;
  /** Models the user counts as this one that an account serves. */
  readonly linked?: ReadonlyArray<PooledModelKey>;
}

type ServingSettings = Pick<
  AccountRoutingSettings,
  "modelAccounts" | "providerModelPreferences" | "modelLinks"
>;

/** A Pi sub-provider billed per use, as its usage slot reports. */
const isMeteredAccount = (provider: ServerProvider, modelSlug: string): boolean => {
  if (provider.driver !== "pi") return false;
  const accountKey = piAccountKeyOf(modelSlug);
  return (
    accountKey !== undefined &&
    provider.usageSlots?.some((slot) => slot.accountKey === accountKey && slot.metered === true) ===
      true
  );
};

const servingEntries = (providers: ReadonlyArray<ServerProvider>, settings: ServingSettings) => {
  const byKey = new Map<
    PooledModelKey,
    { names: string[]; accounts: PooledAccount[]; linked: Set<PooledModelKey> }
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const hidden = settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels ?? [];
    for (const model of provider.models) {
      if (hidden.includes(model.slug)) continue;
      const own = pooledModelKeyOf(provider, model);
      if (own === undefined) continue;
      const key = linkedModelKey(settings.modelLinks, own);
      const account = accountInfo(provider, model.slug);
      const entry = byKey.get(key) ?? { names: [], accounts: [], linked: new Set() };
      if (own !== key) entry.linked.add(own);
      // One account offering a model twice (an alias and its target) serves it once.
      if (entry.accounts.some((existing) => existing.account.id === account.id)) continue;
      entry.names.push(model.name);
      entry.accounts.push({
        account,
        provider,
        model: model.slug,
        removed: false,
        metered: isMeteredAccount(provider, model.slug),
      });
      byKey.set(key, entry);
    }
  }
  for (const [key, entry] of byKey) {
    entry.accounts = arrangeAccounts(entry.accounts, settings.modelAccounts?.[key]);
  }
  return byKey;
};

/**
 * A model's accounts in its order: the ones the user listed for it, or else every subscription in
 * the order the providers list them. The rest follow, off the model.
 */
const arrangeAccounts = (
  accounts: ReadonlyArray<PooledAccount>,
  listed: ReadonlyArray<AccountId> | undefined,
): PooledAccount[] => {
  const inUse = listed ?? accounts.flatMap((entry) => (entry.metered ? [] : [entry.account.id]));
  const rank = new Map(inUse.map((id, index) => [id, index]));
  const rankOf = (entry: PooledAccount) => rank.get(entry.account.id) ?? inUse.length;
  return accounts
    .map((entry) => ({ ...entry, removed: !rank.has(entry.account.id) }))
    .sort((a, b) => rankOf(a) - rankOf(b));
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

const modelsServed = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings,
): ReadonlyArray<PooledModel> =>
  [...servingEntries(providers, settings)].map(([key, entry]) => ({
    key,
    displayName: shortestPlainName(entry.names),
    accounts: entry.accounts,
    ...(entry.linked.size === 0 ? {} : { linked: [...entry.linked] }),
  }));

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
      if (entry === undefined) return { key, displayName: key, accounts: [] };
      return {
        key,
        displayName: shortestPlainName(entry.names),
        accounts: entry.accounts,
        ...(entry.linked.size === 0 ? {} : { linked: [...entry.linked] }),
      };
    }),
  );
};

/**
 * The models the user added to their pooled models that more than one account serves. Any other
 * model is an ordinary model of each account: it runs on the account picked, and no limit moves it.
 */
export const pooledModels = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServingSettings & Pick<AccountRoutingSettings, "pooledModelKeys">,
): ReadonlyArray<PooledModel> => {
  const listed = new Set(settings.pooledModelKeys ?? []);
  return multiAccountModels(providers, settings).filter((pool) => listed.has(pool.key));
};

type LinkSettings = Pick<
  AccountRoutingSettings,
  "pooledModelKeys" | "modelAccounts" | "modelLinks" | "providerModelPreferences"
>;

/**
 * Counts `source` as `target`: the source stops being a pooled model of its own, and an
 * arranged target takes the source's subscriptions at the bottom (pay-as-you-go ones stay off).
 */
export const linkModelPatch = (
  settings: LinkSettings,
  target: PooledModel,
  source: PooledModel,
): ServerSettingsPatch => {
  const listed = settings.pooledModelKeys ?? [];
  const saved = settings.modelAccounts?.[target.key];
  const joining = source.accounts.flatMap((entry) =>
    entry.metered || saved?.includes(entry.account.id) ? [] : [entry.account.id],
  );
  return {
    modelLinks: { [source.key]: target.key },
    ...(listed.includes(source.key)
      ? { pooledModelKeys: listed.filter((key) => key !== source.key) }
      : {}),
    ...(saved === undefined ? {} : { modelAccounts: { [target.key]: [...saved, ...joining] } }),
  };
};

/**
 * Separates `source` from `target` again: the source becomes a pooled model of its own if
 * the target is one, and the target's list drops the accounts that served it only through the link.
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
  const apart = servedModels(providers, { ...settings, modelLinks: links });
  const accountsOf = (key: PooledModelKey) =>
    new Set(
      apart.find((model) => model.key === key)?.accounts.map((entry) => entry.account.id) ?? [],
    );
  const stillServing = accountsOf(target);
  const leaving = [...accountsOf(source)].filter((id) => !stillServing.has(id));
  const saved = settings.modelAccounts?.[target];
  return {
    modelLinks: { [source]: null },
    ...(listed.includes(target) && !listed.includes(source)
      ? { pooledModelKeys: [...listed, source] }
      : {}),
    ...(saved === undefined
      ? {}
      : { modelAccounts: { [target]: saved.filter((id) => !leaving.includes(id)) } }),
  };
};

/**
 * A model's account list after an edit of the accounts it shows: the ones in use, in order, then
 * the saved ones not shown now (a disabled provider, a hidden model), so an edit keeps them.
 */
export const editedModelAccounts = (
  saved: ReadonlyArray<AccountId> | undefined,
  shown: ReadonlyArray<AccountId>,
  inUse: ReadonlyArray<AccountId>,
): AccountId[] => {
  const visible = new Set(shown);
  return [...inUse, ...(saved ?? []).filter((id) => !visible.has(id))];
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

// ── Skips ───────────────────────────────────────────────────────────────────────────────────

/** The account's skip for `key` while it lasts. */
export const activeSkip = (
  skips: AccountSkips,
  account: AccountId,
  key: PooledModelKey,
  nowMs: number,
): AccountSkip | undefined => {
  const skip = skips[account]?.[key];
  return skip !== undefined && Date.parse(skip.until) > nowMs ? skip : undefined;
};

/** The account's skips that still last, by model key. */
export const activeSkipsOf = (
  skips: AccountSkips,
  account: AccountId,
  nowMs: number,
): ReadonlyArray<readonly [PooledModelKey, AccountSkip]> =>
  Object.entries(skips[account] ?? {}).filter(([, skip]) => Date.parse(skip.until) > nowMs);

/** The next midnight on this process's clock. */
export const nextLocalMidnightMs = (nowMs: number): number => {
  const today = DateTime.startOf(
    DateTime.makeZonedUnsafe(nowMs, { timeZone: DateTime.zoneMakeLocal() }),
    "day",
  );
  return DateTime.toEpochMillis(DateTime.add(today, { days: 1 }));
};

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * How long an account is skipped after a usage limit: to the reset the failure reported, or
 * the one its latest reading shows for that model, or with neither, to the next midnight.
 */
export const skipAfterLimit = (input: {
  readonly failureResetAt?: string | null | undefined;
  readonly provider: ServerProvider | undefined;
  readonly model: string;
  readonly nowMs: number;
  readonly midnightMs: number;
}): AccountSkip => {
  const failureMs = input.failureResetAt == null ? Number.NaN : Date.parse(input.failureResetAt);
  if (Number.isFinite(failureMs) && failureMs > input.nowMs)
    return { until: isoOf(failureMs), reportedReset: true };
  const readingMs = applicableSlotUsageWindows(input.provider, input.model)
    .filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined)
    .map((window) => Date.parse(window.resetsAt!))
    .filter((resetMs) => Number.isFinite(resetMs) && resetMs > input.nowMs);
  if (readingMs.length > 0) return { until: isoOf(Math.max(...readingMs)), reportedReset: true };
  return { until: isoOf(input.midnightMs), reportedReset: false };
};

/** The patch recording a skip on an account, dropping the account's skips that have lapsed. */
export const skipPatch = (
  skips: AccountSkips,
  account: AccountId,
  key: PooledModelKey,
  skip: AccountSkip,
  nowMs: number,
): Readonly<Record<PooledModelKey, AccountSkip | null>> => {
  const active = new Set(activeSkipsOf(skips, account, nowMs).map(([model]) => model));
  return {
    ...Object.fromEntries(
      Object.keys(skips[account] ?? {}).flatMap((model) =>
        active.has(model) ? [] : [[model, null]],
      ),
    ),
    [key]: skip,
  };
};

// ── Routing ─────────────────────────────────────────────────────────────────────────────────

export interface AccountTarget {
  readonly provider: ServerProvider;
  readonly model: string;
  readonly account: AccountInfo;
}

export interface PickOptions {
  /** Only accounts that enforce read-only source access, for a read-only task. */
  readonly readOnly?: boolean | undefined;
  /** Leave out accounts subscription conservation holds back from new managed subagents. */
  readonly enforceConservation?: boolean | undefined;
}

const usable = (entry: PooledAccount, options: PickOptions | undefined) =>
  !entry.removed &&
  isProviderRoutable(entry.provider) &&
  (options?.readOnly !== true || entry.provider.readOnlySourceAccess === "enforced") &&
  (options?.enforceConservation !== true || !isConserved(entry.provider, entry.model));

/** Whether new work on `pool`'s model may start on `entry`: usable, and not skipped. */
export const isAccountFree = (
  pool: PooledModel,
  entry: PooledAccount,
  skips: AccountSkips,
  nowMs: number,
  options?: PickOptions,
) => usable(entry, options) && activeSkip(skips, entry.account.id, pool.key, nowMs) === undefined;

const toTarget = (entry: PooledAccount): AccountTarget => ({
  provider: entry.provider,
  model: entry.model,
  account: entry.account,
});

/**
 * The account a new thread on `pool`'s model runs on: the first in the model's order that is
 * usable and not skipped. With every usable account skipped, the one whose skip ends soonest,
 * so the turn is tried rather than refused.
 */
export const firstAccount = (
  pool: PooledModel,
  skips: AccountSkips,
  nowMs: number,
  options?: PickOptions,
): AccountTarget | undefined => {
  const candidates = pool.accounts.filter((entry) => usable(entry, options));
  const free = candidates.find((entry) => isAccountFree(pool, entry, skips, nowMs, options));
  if (free !== undefined) return toTarget(free);
  const soonest = [...candidates].sort(
    (a, b) =>
      Date.parse(activeSkip(skips, a.account.id, pool.key, nowMs)?.until ?? "") -
      Date.parse(activeSkip(skips, b.account.id, pool.key, nowMs)?.until ?? ""),
  )[0];
  return soonest === undefined ? undefined : toTarget(soonest);
};

/**
 * Where a thread whose account failed with a usage limit moves: the first usable account in
 * the order, other than the failed one, that is not skipped. None leaves the thread waiting.
 */
export const nextAccount = (
  pool: PooledModel,
  failed: AccountId,
  skips: AccountSkips,
  nowMs: number,
  options?: PickOptions,
): AccountTarget | undefined => {
  const next = pool.accounts.find(
    (entry) =>
      entry.account.id !== failed &&
      usable(entry, options) &&
      activeSkip(skips, entry.account.id, pool.key, nowMs) === undefined,
  );
  return next === undefined ? undefined : toTarget(next);
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
