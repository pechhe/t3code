import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import {
  pooledModelKeyOf,
  pooledModels,
  type AccountRoutingSettings,
  type PooledModel,
} from "@t3tools/shared/accountPools";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import {
  AGENT_ROLE_TITLE_LABEL,
  AgentPolicyManifest,
  AgentRole,
  REVIEWER_WRAP_UP_TOOL_CALLS,
  type AgentPolicySettings,
  type EnvironmentId,
  type DelegationStance,
  modelMaker,
  modelNote,
  type AgentListEntry,
  type PooledModelKey,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";

type Manifest = AgentPolicyManifest;
type RoutingSettings = Pick<
  AccountRoutingSettings,
  "accountOrder" | "pooledModelKeys" | "modelAccountsRemoved" | "providerModelPreferences"
>;
const EMPTY_ROUTING: RoutingSettings = {
  accountOrder: [],
  pooledModelKeys: [],
  modelAccountsRemoved: {},
};

export const isAnyAccountBinding = (binding: Pick<Binding, "anyAccount" | "poolId">): boolean =>
  binding.anyAccount === true || binding.poolId !== undefined;

export function pooledModelForBinding(
  binding: Pick<Binding, "driverKind" | "model">,
  pools: ReadonlyArray<PooledModel>,
): PooledModel | undefined {
  const direct = pools.find((pool) =>
    pool.accounts.some(
      (entry) => entry.provider.driver === binding.driverKind && entry.model === binding.model,
    ),
  );
  if (direct !== undefined) return direct;
  const key = pooledModelKeyOf(
    { driver: binding.driverKind },
    { slug: binding.model, name: binding.model },
  );
  return key === undefined ? undefined : pools.find((pool) => pool.key === key);
}

export function matchesCatalogModel(
  binding: Pick<Binding, "driverKind" | "model" | "anyAccount" | "poolId">,
  model: CatalogModel,
  pools: ReadonlyArray<PooledModel> = [],
): boolean {
  if (model.pooledKey !== undefined) {
    if (!isAnyAccountBinding(binding)) return false;
    return (
      (binding.driverKind === model.binding.driverKind && binding.model === model.binding.model) ||
      pooledModelForBinding(binding, pools)?.key === model.pooledKey
    );
  }
  return (
    !isAnyAccountBinding(binding) &&
    binding.driverKind === model.binding.driverKind &&
    binding.model === model.binding.model
  );
}

const coveredByPooledModel = (
  binding: Binding,
  key: PooledModelKey,
  pools: ReadonlyArray<PooledModel>,
) => pooledModelForBinding(binding, pools)?.key === key;

/** A pooled model's shared note: an `anyAccount` binding's first, else any covered account's. */
export function pooledNote(
  manifest: Manifest,
  key: PooledModelKey,
  pools: ReadonlyArray<PooledModel>,
): string | undefined {
  const covered = Object.values(manifest.models).filter((binding) =>
    coveredByPooledModel(binding, key, pools),
  );
  return (
    covered.find((binding) => isAnyAccountBinding(binding) && binding.note)?.note ??
    covered.find((binding) => binding.note)?.note
  );
}

/** A model's default delegation stance, shared across every alias binding it. */
export function modelDefaultStance(
  manifest: Manifest,
  model: string,
): DelegationStance | undefined {
  return Object.values(manifest.models).find(
    (binding) => binding.model === model && binding.defaultStance !== undefined,
  )?.defaultStance;
}

/** A pooled model's shared default stance: an `anyAccount` binding's first, else any covered account's. */
export function pooledDefaultStance(
  manifest: Manifest,
  key: PooledModelKey,
  pools: ReadonlyArray<PooledModel>,
): DelegationStance | undefined {
  const covered = Object.values(manifest.models).filter((binding) =>
    coveredByPooledModel(binding, key, pools),
  );
  return (
    covered.find((binding) => isAnyAccountBinding(binding) && binding.defaultStance)
      ?.defaultStance ?? covered.find((binding) => binding.defaultStance)?.defaultStance
  );
}
type Binding = Manifest["models"][string];
export type RolePolicy = NonNullable<Manifest["roles"][AgentRole]>;

/** A role the page lists; only roles the policy configures are listed. */
export function rolePolicy(manifest: Manifest, role: AgentRole): RolePolicy {
  const policy = manifest.roles[role];
  if (policy === undefined) throw new Error(`The policy does not configure ${role}.`);
  return policy;
}

/** Removes the retired role and discovers reasoning controls added since a model was saved. */
export function editableManifest(
  manifest: Manifest,
  catalog: ReadonlyArray<CatalogModel> = [],
  pools: ReadonlyArray<PooledModel> = [],
): Manifest {
  const { "ui-verifier": _retired, ...roles } = manifest.roles;
  const discovered = new Map<string, CatalogModel>();
  const models = Object.fromEntries(
    Object.entries(manifest.models).map(([alias, binding]) => {
      const model = catalog.find((candidate) => matchesCatalogModel(binding, candidate, pools));
      if (binding.effortOption !== undefined || model?.binding.effortOption === undefined)
        return [alias, binding];
      discovered.set(alias, model);
      return [alias, { ...binding, effortOption: model.binding.effortOption }];
    }),
  );
  const lists = Object.fromEntries(
    Object.entries(manifest.lists).map(([name, entries]) => [
      name,
      entries.map((entry) => {
        const model = discovered.get(entry.model);
        return model === undefined
          ? entry
          : { ...entry, effort: effortForModel(model, entry.effort) };
      }),
    ]),
  );
  return { ...manifest, roles, models, lists };
}

/** The jobs in the order the page lists them; roles sharing a list appear together. */
const ROLE_ORDER: ReadonlyArray<AgentRole> = [
  "lead",
  "implementer",
  "reviewer",
  "advisor",
  "browser",
  "researcher",
  "scout",
];

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  implementer: "Code and UI changes",
  reviewer: "Reviews a change or a Spec before it lands",
  advisor: "Second opinion",
  browser: "Drives web pages",
  "ui-verifier": "Checks the running app",
  researcher: "Researches docs and the web",
  scout: "Maps the codebase",
  lead: "Owns one whole Spec and lands it",
};

/** Which of T3's two permission classes a role's tasks are in. */
export const roleClassLabel = (policy: Pick<RolePolicy, "sourceAccess">) =>
  policy.sourceAccess === "read-only" ? "Read-only" : "Editor";

export interface RoleGroup {
  readonly list: string;
  readonly roles: ReadonlyArray<AgentRole>;
}

export function roleGroups(manifest: Manifest): RoleGroup[] {
  const groups: Array<{
    list: string;
    roles: AgentRole[];
  }> = [];
  for (const role of ROLE_ORDER) {
    const policy = manifest.roles[role];
    if (policy === undefined) continue;
    const list = policy.list;
    let group = groups.find((candidate) => candidate.list === list);
    if (group === undefined) {
      group = { list, roles: [] };
      groups.push(group);
    }
    if (!group.roles.includes(role)) group.roles.push(role);
  }
  return groups;
}

/**
 * Why a model cannot take work now, mirroring the server's account checks; null when it can.
 */
export function unavailableReason(
  binding: Binding | undefined,
  providers: ReadonlyArray<ServerProvider>,
  {
    now = Date.now(),
    pools,
    routing,
  }: { now?: number; pools?: ReadonlyArray<PooledModel>; routing?: RoutingSettings } = {},
): string | null {
  if (binding === undefined) return "not configured";
  if (isAnyAccountBinding(binding)) {
    const resolvedPools = pools ?? pooledModels(providers, routing ?? EMPTY_ROUTING);
    const pool = pooledModelForBinding(binding, resolvedPools);
    if (pool !== undefined) {
      const active = pool.accounts.filter((entry) => !entry.removed);
      if (active.length === 0) return "no accounts switched on";
      const reasons = active.map((entry) =>
        unavailableReason(
          { driverKind: entry.provider.driver, model: entry.model },
          [entry.provider],
          {
            now,
          },
        ),
      );
      return reasons.includes(null) ? null : (reasons[0] ?? null);
    }
  }
  const accounts = providers.filter((provider) => provider.driver === binding.driverKind);
  if (accounts.length === 0) return "not installed";
  const reasons = accounts.map((provider) => {
    if (!provider.enabled || provider.status === "disabled") return "disabled";
    if (!provider.installed) return "not installed";
    if (provider.availability === "unavailable" || provider.status === "error")
      return "unavailable";
    if (provider.auth.status !== "authenticated") return "signed out";
    if (!provider.models.some((model) => model.slug === binding.model)) return "model unavailable";
    return exhaustedUsageWindow(provider, now, binding.model) ? "rate limited" : null;
  });
  return reasons.includes(null) ? null : (reasons[0] ?? null);
}

export function modelLabel(
  binding: Binding | undefined,
  alias: string,
  providers: ReadonlyArray<ServerProvider>,
  pools: ReadonlyArray<PooledModel> = [],
): string {
  if (binding === undefined) return alias;
  if (isAnyAccountBinding(binding)) {
    const pooled = pooledModelForBinding(binding, pools);
    if (pooled !== undefined) return pooled.displayName;
  }
  return (
    providers
      .filter((provider) => provider.driver === binding.driverKind)
      .flatMap((provider) => provider.models)
      .find((model) => model.slug === binding.model)?.name ?? binding.model
  );
}

/** Keeps an effort the model offers, else its medium, else its first choice. */
export function effortFor(choices: ReadonlyArray<string>, current?: string): string {
  if (current !== undefined && (choices.length === 0 || choices.includes(current))) return current;
  return choices.includes("medium") ? "medium" : (choices[0] ?? current ?? "medium");
}

/** The effort to record for a freshly chosen model, or none when the model has no effort setting. */
export function effortForModel(model: CatalogModel, current?: string): string | undefined {
  return model.efforts.length === 0 ? undefined : effortFor(model.efforts, current);
}

export interface CatalogModel {
  readonly key: string;
  readonly label: string;
  readonly binding: Binding;
  readonly efforts: ReadonlyArray<string>;
  /** Set for a pooled model: delegation names the model alone and T3 picks an account in order. */
  readonly pooledKey?: PooledModelKey;
}

/**
 * Installed providers that do not declare read-only enforcement, by name: dispatch never places a
 * reader there, so a model of theirs serves only writer jobs.
 */
export function readOnlyUnenforcedProviders(providers: ReadonlyArray<ServerProvider>): string[] {
  const names = new Set<string>();
  for (const provider of providers) {
    if (provider.readOnlySourceAccess === "enforced") continue;
    if (!provider.enabled || provider.status === "disabled") continue;
    names.add(provider.displayName ?? provider.driver);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Every model an installed account offers, with its effort settings when it has any, then each
 * pooled model ("the model alone", any account in the user's order).
 */
export function catalogModels(
  providers: ReadonlyArray<ServerProvider>,
  routing: RoutingSettings = EMPTY_ROUTING,
): CatalogModel[] {
  return [...accountCatalogModels(providers), ...pooledCatalogModels(providers, routing)];
}

function pooledCatalogModels(
  providers: ReadonlyArray<ServerProvider>,
  routing: RoutingSettings,
): CatalogModel[] {
  return pooledModels(providers, routing).flatMap((pool) => {
    const first = pool.accounts.find((entry) => !entry.removed);
    if (first === undefined) return [];
    const model = first.provider.models.find((candidate) => candidate.slug === first.model);
    const option = model?.capabilities?.optionDescriptors?.find(isReasoningSelect);
    return [
      {
        key: `pooled:${pool.key}`,
        label: pool.displayName,
        pooledKey: pool.key,
        binding: {
          driverKind: first.provider.driver,
          model: first.model,
          anyAccount: true,
          ...(option?.type === "select" ? { effortOption: option.id } : {}),
        },
        efforts: option?.type === "select" ? option.options.map((choice) => choice.id) : [],
      },
    ];
  });
}

function accountCatalogModels(providers: ReadonlyArray<ServerProvider>): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const provider of providers) {
    for (const model of provider.models) {
      const option = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
      const key = `${provider.driver}:${model.slug}`;
      if (models.has(key)) continue;
      models.set(key, {
        key,
        label: model.name,
        binding: {
          driverKind: provider.driver,
          model: model.slug,
          ...(option?.type === "select" ? { effortOption: option.id } : {}),
        },
        efforts: option?.type === "select" ? option.options.map((choice) => choice.id) : [],
      });
    }
  }
  return [...models.values()];
}

/** The alias naming a catalog model, adding one derived from its slug when it has none. */
export function ensureModel(
  manifest: Manifest,
  model: CatalogModel,
  pools: ReadonlyArray<PooledModel> = [],
): [Manifest, string] {
  const existing = Object.entries(manifest.models).find(([, binding]) =>
    matchesCatalogModel(binding, model, pools),
  );
  if (existing) return [manifest, existing[0]];
  // A pooled model carries forward a note its accounts already have, and an account joins its pooled note.
  const pool =
    model.pooledKey !== undefined
      ? pools.find((candidate) => candidate.key === model.pooledKey)
      : pooledModelForBinding(model.binding, pools);
  const note =
    pool === undefined
      ? modelNote(manifest, model.binding.model)
      : (pooledNote(manifest, pool.key, pools) ?? modelNote(manifest, model.binding.model));
  const defaultStance =
    pool === undefined
      ? modelDefaultStance(manifest, model.binding.model)
      : (pooledDefaultStance(manifest, pool.key, pools) ??
        modelDefaultStance(manifest, model.binding.model));
  const listedOnly = modelListedOnly(
    manifest,
    pool === undefined ? model.binding.model : `pooled:${pool.key}`,
    pools,
  );
  const binding = {
    ...model.binding,
    ...(note === undefined ? {} : { note }),
    ...(defaultStance === undefined ? {} : { defaultStance }),
    ...(listedOnly ? { listedOnly } : {}),
  };
  const slug = model.pooledKey === undefined ? model.binding.model : `any-${model.pooledKey}`;
  const base = `m-${slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 60);
  let alias = base;
  for (let suffix = 2; manifest.models[alias] !== undefined; suffix++) alias = `${base}-${suffix}`;
  return [{ ...manifest, models: { ...manifest.models, [alias]: binding } }, alias];
}

const withList = (manifest: Manifest, list: string, entries: ReadonlyArray<AgentListEntry>) => ({
  ...manifest,
  lists: { ...manifest.lists, [list]: entries },
});

const withRole = (
  manifest: Manifest,
  role: AgentRole,
  edit: (policy: RolePolicy) => RolePolicy,
): Manifest => ({
  ...manifest,
  roles: { ...manifest.roles, [role]: edit(rolePolicy(manifest, role)) },
});

export function moveEntry(manifest: Manifest, list: string, index: number, delta: -1 | 1) {
  const entries = [...(manifest.lists[list] ?? [])];
  const target = index + delta;
  if (target < 0 || target >= entries.length) return manifest;
  [entries[index], entries[target]] = [entries[target]!, entries[index]!];
  return withList(manifest, list, entries);
}

export function setEntryEffort(manifest: Manifest, list: string, model: string, effort: string) {
  return withList(
    manifest,
    list,
    (manifest.lists[list] ?? []).map((entry) =>
      entry.model === model ? { ...entry, effort } : entry,
    ),
  );
}

/** The service tier that makes a model faster; a model that offers it can run fast by policy. */
const FAST_OPTION = { id: "serviceTier", value: "fast" } as const;

export function offersFast(
  binding: Binding | undefined,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (binding === undefined) return false;
  return providers
    .filter((provider) => provider.driver === binding.driverKind)
    .flatMap((provider) => provider.models.filter((model) => model.slug === binding.model))
    .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
    .some(
      (option) =>
        option.id === FAST_OPTION.id &&
        option.type === "select" &&
        option.options.some((choice) => choice.id === FAST_OPTION.value),
    );
}

export function runsFast(binding: Binding | undefined): boolean {
  return binding?.options?.[FAST_OPTION.id] === FAST_OPTION.value;
}

/** Fast belongs to the model, so every job that lists it follows the switch. */
export function setModelFast(manifest: Manifest, alias: string, fast: boolean): Manifest {
  const binding = manifest.models[alias];
  if (binding === undefined) return manifest;
  return setModelOptions(manifest, alias, [
    ...Object.entries(binding.options ?? {})
      .filter(([id]) => id !== FAST_OPTION.id)
      .map(([id, value]) => ({ id, value })),
    ...(fast ? [FAST_OPTION] : []),
  ]);
}

/** Replaces a model's fixed traits, such as its service tier, leaving effort to its list entry. */
export function setModelOptions(
  manifest: Manifest,
  alias: string,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): Manifest {
  const binding = manifest.models[alias];
  if (binding === undefined) return manifest;
  const fixed = Object.fromEntries(
    (options ?? [])
      .filter((option) => typeof option.value === "string" && option.id !== binding.effortOption)
      .map((option) => [option.id, option.value as string]),
  );
  const { options: _previous, ...rest } = binding;
  return {
    ...manifest,
    models: {
      ...manifest.models,
      [alias]: Object.keys(fixed).length > 0 ? { ...rest, options: fixed } : rest,
    },
  };
}

/** Rewrites every binding a row covers: each alias of a model, or a pooled model (`pooled:<key>`) and its accounts. */
function updateCovered(
  manifest: Manifest,
  model: string,
  pools: ReadonlyArray<PooledModel>,
  update: (binding: Binding) => Binding,
): Manifest {
  const pooledKey = model.startsWith("pooled:") ? (model.slice(7) as PooledModelKey) : undefined;
  const covers = (binding: Binding) =>
    pooledKey === undefined
      ? binding.model === model
      : coveredByPooledModel(binding, pooledKey, pools);
  const models = Object.fromEntries(
    Object.entries(manifest.models).map(([alias, binding]) => [
      alias,
      covers(binding) ? update(binding) : binding,
    ]),
  );
  return { ...manifest, models };
}

/**
 * Sets what a model is good at on every alias binding it; an empty note removes it. A pooled
 * model's note (`model` given as `pooled:<key>`) covers every account binding that model.
 */
export function setModelNote(
  manifest: Manifest,
  model: string,
  note: string,
  pools: ReadonlyArray<PooledModel> = [],
): Manifest {
  const text = note.trim();
  return updateCovered(manifest, model, pools, ({ note: _previous, ...rest }) =>
    text === "" ? rest : { ...rest, note: text },
  );
}

/**
 * Sets a model's default delegation stance on every alias binding it; `undefined` unsets it
 * so new threads fall back to Flexible unless overridden.
 */
export function setModelDefaultStance(
  manifest: Manifest,
  model: string,
  defaultStance: DelegationStance | undefined,
  pools: ReadonlyArray<PooledModel> = [],
): Manifest {
  return updateCovered(manifest, model, pools, ({ defaultStance: _previous, ...rest }) =>
    defaultStance === undefined ? rest : { ...rest, defaultStance },
  );
}

/** Whether a row's model (or `pooled:<key>`) is kept to its lists, never an off-list fallback. */
export function modelListedOnly(
  manifest: Manifest,
  model: string,
  pools: ReadonlyArray<PooledModel> = [],
): boolean {
  const pooledKey = model.startsWith("pooled:") ? (model.slice(7) as PooledModelKey) : undefined;
  return Object.values(manifest.models).some(
    (binding) =>
      binding.listedOnly === true &&
      (pooledKey === undefined
        ? binding.model === model
        : coveredByPooledModel(binding, pooledKey, pools)),
  );
}

/** Keeps a model to its lists on every alias binding it, or lets it serve as an off-list fallback. */
export function setModelListedOnly(
  manifest: Manifest,
  model: string,
  listedOnly: boolean,
  pools: ReadonlyArray<PooledModel> = [],
): Manifest {
  return updateCovered(manifest, model, pools, ({ listedOnly: _previous, ...rest }) =>
    listedOnly ? { ...rest, listedOnly } : rest,
  );
}

interface ListedModel {
  readonly alias: string;
  /** The model slug, or `pooled:<key>` for a pooled model; it keys the row's note. */
  readonly model: string;
  readonly pooledModel?: PooledModel;
  readonly roles: AgentRole[];
}

/**
 * Each listed model once, in the order the jobs list them, with the roles that use it. A model
 * served by several accounts is one model with one note, joining `anyAccount` and per-account
 * bindings for the same pooled model into one row.
 */
export function listedModels(
  manifest: Manifest,
  jobs: ReadonlyArray<Job>,
  pools: ReadonlyArray<PooledModel> = [],
): ListedModel[] {
  const models = new Map<string, ListedModel>();
  for (const job of jobs)
    for (const section of job.sections)
      for (const entry of manifest.lists[section.list] ?? []) {
        const binding = manifest.models[entry.model];
        if (binding === undefined) continue;
        const pooledModel = pooledModelForBinding(binding, pools);
        const key = pooledModel === undefined ? binding.model : `pooled:${pooledModel.key}`;
        const existing = models.get(key);
        const existingBinding = existing ? manifest.models[existing.alias] : undefined;
        const listed: ListedModel =
          existing === undefined
            ? {
                alias: entry.model,
                model: key,
                ...(pooledModel === undefined ? {} : { pooledModel }),
                roles: [],
              }
            : // An any-account binding names the row as the pooled model rather than one account.
              isAnyAccountBinding(binding) &&
                (existingBinding === undefined || !isAnyAccountBinding(existingBinding))
              ? { ...existing, alias: entry.model }
              : existing;
        for (const role of job.roles) if (!listed.roles.includes(role)) listed.roles.push(role);
        models.set(key, listed);
      }
  return [...models.values()];
}

export function addEntry(manifest: Manifest, list: string, entry: AgentListEntry) {
  return withList(manifest, list, [...(manifest.lists[list] ?? []), entry]);
}

/** Removes a model from a list, its exceptions, and any reviewer council tick naming it. */
export function removeEntry(manifest: Manifest, list: string, model: string): Manifest {
  let next = withList(
    manifest,
    list,
    (manifest.lists[list] ?? []).filter((entry) => entry.model !== model),
  );
  for (const role of AgentRole.literals) {
    if (next.roles[role]?.list !== list) continue;
    next = withRole(next, role, ({ callers, council, ...policy }) => {
      const kept = Object.entries(callers ?? {}).filter(([, first]) => first !== model);
      const nextCouncil =
        role === "reviewer" && council !== undefined
          ? council.filter((alias) => alias !== model)
          : council;
      return {
        ...policy,
        ...(kept.length === 0 ? {} : { callers: Object.fromEntries(kept) }),
        ...(nextCouncil === undefined || nextCouncil.length === 0 ? {} : { council: nextCouncil }),
      };
    });
  }
  return next;
}

/**
 * The alias of `model` in `list`, adding the model to the manifest and to the end of the
 * list when it is not there yet: a per-agent choice must be one of the job's listed models.
 */
export function listModel(
  manifest: Manifest,
  list: string,
  model: CatalogModel,
  effort: string | undefined,
  pools: ReadonlyArray<PooledModel> = [],
): [Manifest, string] {
  const [next, alias] = ensureModel(manifest, model, pools);
  if ((next.lists[list] ?? []).some((entry) => entry.model === alias)) return [next, alias];
  return [
    addEntry(next, list, { model: alias, ...(effort === undefined ? {} : { effort }) }),
    alias,
  ];
}

/** Swaps one listed model for another in place, carrying the exceptions that named it. */
export function replaceEntry(
  manifest: Manifest,
  list: string,
  from: string,
  model: CatalogModel,
  effort: string | undefined,
  pools: ReadonlyArray<PooledModel> = [],
): Manifest {
  const [withModel, alias] = ensureModel(manifest, model, pools);
  const entries = withModel.lists[list] ?? [];
  if (alias === from || entries.some((entry) => entry.model === alias)) return manifest;
  let next = withList(
    withModel,
    list,
    entries.map((entry) =>
      entry.model === from ? { model: alias, ...(effort === undefined ? {} : { effort }) } : entry,
    ),
  );
  for (const role of AgentRole.literals) {
    if (next.roles[role]?.list !== list) continue;
    next = withRole(next, role, ({ callers, council, ...policy }) => {
      // A replaced model keeps its council tick.
      const nextCouncil = council?.map((candidate) => (candidate === from ? alias : candidate));
      return {
        ...policy,
        ...(nextCouncil === undefined ? {} : { council: [...new Set(nextCouncil)] }),
        ...(callers === undefined
          ? {}
          : {
              callers: Object.fromEntries(
                Object.entries(callers).map(([caller, first]) => [
                  caller,
                  first === from ? alias : first,
                ]),
              ),
            }),
      };
    });
  }
  return next;
}

export function setCaller(
  manifest: Manifest,
  role: AgentRole,
  caller: string,
  first: string | undefined,
) {
  return withRole(manifest, role, ({ callers, ...policy }) => {
    const next = { ...callers };
    if (first === undefined) delete next[caller];
    else next[caller] = first;
    return Object.keys(next).length === 0 ? policy : { ...policy, callers: next };
  });
}

export function setPreferOtherAuthorProvider(manifest: Manifest, role: AgentRole, value: boolean) {
  return withRole(manifest, role, (policy) => ({ ...policy, preferOtherAuthorProvider: value }));
}

/** Gives each of the group's roles its own copy of the shared list, named after the role. */
export function splitGroup(manifest: Manifest, group: RoleGroup): Manifest {
  const entries = manifest.lists[group.list] ?? [];
  let next = manifest;
  for (const role of group.roles) {
    let list: string = role;
    for (let suffix = 2; next.lists[list] !== undefined; suffix++) list = `${role}-${suffix}`;
    next = withRole(withList(next, list, entries), role, (policy) => ({
      ...policy,
      list,
    }));
  }
  const referenced = Object.values(next.roles).some((policy) => policy?.list === group.list);
  if (referenced) return next;
  const { [group.list]: _shared, ...lists } = next.lists;
  return { ...next, lists };
}

export interface JobSection {
  readonly list: string;
  readonly title?: string;
  readonly hint?: string;
}

/** A row on the page: roles sharing a list, with Reviewer shown in its own row. */
export interface Job {
  readonly roles: ReadonlyArray<AgentRole>;
  readonly sections: ReadonlyArray<JobSection>;
  readonly splitGroups: ReadonlyArray<RoleGroup>;
}

export function jobsFor(manifest: Manifest, groups: ReadonlyArray<RoleGroup>): Job[] {
  const reviewer = manifest.roles.reviewer;
  const jobs: Job[] = [];
  const alsoUsedBy = (list: string) => {
    const others = groups
      .find((group) => group.list === list)
      ?.roles.filter((role) => role !== "reviewer");
    return others?.length
      ? `Also used by ${others.map((role) => AGENT_ROLE_TITLE_LABEL[role]).join(", ")}`
      : undefined;
  };
  for (const group of groups) {
    const roles = group.roles.filter((role) => role !== "reviewer");
    const shared = group.roles.length > 1 ? [group] : [];
    if (roles.length > 0) {
      jobs.push({ roles, sections: [{ list: group.list }], splitGroups: shared });
    }
    if (reviewer === undefined || group.list !== reviewer.list) continue;
    const hint = alsoUsedBy(reviewer.list);
    jobs.push({
      roles: ["reviewer"],
      sections: [{ list: reviewer.list, ...(hint === undefined ? {} : { hint }) }],
      splitGroups: shared,
    });
  }
  return jobs;
}

export const splitJob = (manifest: Manifest, job: Job) => {
  let next = manifest;
  for (const { list } of job.splitGroups) {
    const group = roleGroups(next).find((candidate) => candidate.list === list);
    if (group !== undefined) next = splitGroup(next, group);
  }
  return next;
};

const MAKER_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  xai: "xAI",
  alibaba: "Alibaba",
  meta: "Meta",
  mistral: "Mistral",
  zhipu: "Zhipu",
};

export const makerName = (maker: string) =>
  MAKER_NAMES[maker] ?? maker.charAt(0).toUpperCase() + maker.slice(1);

/** Whether a reviewer list model is ticked for the review council. */
export const councilTicked = (manifest: Manifest, alias: string): boolean =>
  manifest.roles.reviewer.council?.includes(alias) ?? false;

/** Ticks or unticks a model on the reviewer's list for the review council; empty removes the key. */
export function setCouncilTick(manifest: Manifest, alias: string, ticked: boolean): Manifest {
  return withRole(manifest, "reviewer", ({ council, ...policy }) => {
    const list = manifest.lists[policy.list] ?? [];
    if (ticked && !list.some((entry) => entry.model === alias)) {
      return council === undefined ? policy : { ...policy, council };
    }
    const current = new Set(council ?? []);
    if (ticked) current.add(alias);
    else current.delete(alias);
    const ordered = list.map((entry) => entry.model).filter((model) => current.has(model));
    return ordered.length === 0 ? policy : { ...policy, council: ordered };
  });
}

/** The council's ticked members in list order, each with its model's maker. */
export function councilMembers(manifest: Manifest) {
  const reviewer = rolePolicy(manifest, "reviewer");
  const ticked = new Set(reviewer.council ?? []);
  return (manifest.lists[reviewer.list] ?? []).flatMap((entry) => {
    if (!ticked.has(entry.model)) return [];
    const binding = manifest.models[entry.model];
    return binding === undefined ? [] : [{ ...entry, maker: modelMaker(binding) }];
  });
}

/** What the council line says: whether a council is seated and how many makers can run now. */
export function councilSeating(
  manifest: Manifest,
  providers: ReadonlyArray<ServerProvider>,
  options: { now?: number; pools?: ReadonlyArray<PooledModel>; routing?: RoutingSettings } = {},
): string {
  const members = councilMembers(manifest);
  if (members.length === 0) {
    return "Council off: tick models from two or more makers to seat a council.";
  }
  const makers = [...new Set(members.map((member) => member.maker))];
  if (makers.length < 2) {
    return `Council off: ticked models come from one maker (${makerName(makers[0]!)}), so each Spec review has one reviewer. Tick a model from another maker to seat a council.`;
  }
  const ready = new Set(
    members
      .filter(
        (member) => unavailableReason(manifest.models[member.model], providers, options) === null,
      )
      .map((member) => member.maker),
  );
  const names = makers.map(makerName).join(", ");
  if (ready.size === makers.length) return `${names}. All ${makers.length} makers can sit now.`;
  return ready.size >= 2
    ? `${names}. ${ready.size} of ${makers.length} makers can sit now.`
    : `${names}. ${ready.size} of ${makers.length} makers can sit now: the council won't form until another maker is available, so one reviewer runs.`;
}

/** Tool calls a reviewer task makes before T3 asks it to report. */
export const reviewerWrapUpToolCalls = (manifest: Manifest): number =>
  manifest.roles.reviewer.wrapUpAfterToolCalls ?? REVIEWER_WRAP_UP_TOOL_CALLS;

/** Sets the reviewer wrap-up tool call limit; the default value or undefined removes the key. */
export function setReviewerWrapUpToolCalls(
  manifest: Manifest,
  calls: number | undefined,
): Manifest {
  if (calls !== undefined && (!Number.isInteger(calls) || calls < 1)) return manifest;
  return withRole(manifest, "reviewer", ({ wrapUpAfterToolCalls: _previous, ...policy }) =>
    calls === undefined || calls === REVIEWER_WRAP_UP_TOOL_CALLS
      ? policy
      : { ...policy, wrapUpAfterToolCalls: calls },
  );
}

const sameManifest = Schema.toEquivalence(AgentPolicyManifest);

/** One environment a policy save writes to, with the policy hash the page last read there. */
export interface PolicySaveTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hash: string;
}

export type PolicySaveAnswer =
  | { readonly ok: true; readonly settings: AgentPolicySettings }
  /** `stale`: refused only because the policy changed since `expectedHash`; nothing needs repair. */
  | { readonly ok: false; readonly message: string; readonly stale: boolean };

/**
 * Writes `manifest` to each target in turn, against the hash the last write there left in
 * `hashes`. Environments can share one policy (one agent-config remote, mirrored between
 * machines), so an earlier target's write makes a later one stale: a target refused as stale that
 * already holds `manifest` counts as saved.
 */
export async function savePolicyToTargets(input: {
  readonly manifest: Manifest;
  readonly targets: ReadonlyArray<PolicySaveTarget>;
  readonly hashes: Map<EnvironmentId, string>;
  readonly save: (
    target: PolicySaveTarget,
    expectedHash: string,
    manifest: Manifest,
  ) => Promise<PolicySaveAnswer>;
  readonly read: (target: PolicySaveTarget) => Promise<AgentPolicySettings | null>;
}): Promise<{ readonly failure: string | null; readonly notPushed: ReadonlyArray<string> }> {
  const { manifest, targets, hashes } = input;
  const named = (target: PolicySaveTarget, message: string) =>
    targets.length > 1 ? `${target.label}: ${message}` : message;
  // The server gives every write a new revision label; the content is what must match.
  const holds = (settings: AgentPolicySettings) =>
    sameManifest({ ...settings.snapshot.manifest, revision: manifest.revision }, manifest);
  const notPushed: string[] = [];
  for (const target of targets) {
    const expectedHash = hashes.get(target.environmentId) ?? target.hash;
    const answer = await input.save(target, expectedHash, manifest);
    if (answer.ok) {
      if (!holds(answer.settings))
        return {
          failure:
            "The policy changed on disk. Your edit is kept here; reload the current values before saving.",
          notPushed,
        };
      hashes.set(target.environmentId, answer.settings.snapshot.hash);
      const publish = answer.settings.publish;
      if (publish !== undefined && !publish.pushed)
        notPushed.push(named(target, publish.detail ?? "no reason given"));
      continue;
    }
    const current = answer.stale ? await input.read(target) : null;
    if (current === null || !holds(current))
      return { failure: named(target, answer.message), notPushed };
    hashes.set(target.environmentId, current.snapshot.hash);
  }
  return { failure: null, notPushed };
}
