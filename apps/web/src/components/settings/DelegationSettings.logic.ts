import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import * as Schema from "effect/Schema";
import {
  AGENT_ROLE_TITLE_LABEL,
  AgentPolicyManifest,
  AgentRole,
  type AgentPolicySettings,
  type EnvironmentId,
  type DelegationStance,
  modelMaker,
  modelNote,
  isModelPoolSlotEnabled,
  resolveModelPoolEnabled,
  type AgentListEntry,
  type ModelPoolConfig,
  type ModelPoolId,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";

type Manifest = AgentPolicyManifest;
type ModelPools = Readonly<Record<ModelPoolId, ModelPoolConfig>>;
const NO_POOLS: ModelPools = {};

const sameBinding = (
  left: Pick<Binding, "driverKind" | "model" | "poolId">,
  right: Pick<Binding, "driverKind" | "model" | "poolId">,
) =>
  left.driverKind === right.driverKind &&
  left.model === right.model &&
  left.poolId === right.poolId;

/**
 * The pool a binding belongs to: the one it names, else the only pool listing its model as a
 * slot. A model several pools list keeps its own row, so one note never edits another pool's.
 */
function poolOfBinding(
  binding: Pick<Binding, "model" | "poolId">,
  modelPools: ModelPools,
): ModelPoolId | undefined {
  if (binding.poolId !== undefined && modelPools[binding.poolId] !== undefined)
    return binding.poolId;
  const listing = (Object.keys(modelPools) as ModelPoolId[]).filter((id) =>
    modelPools[id]!.slots.some((slot) => slot.model === binding.model),
  );
  return listing.length === 1 ? listing[0] : undefined;
}

/** The bindings a pool's one note covers: the pool's own, and every member slot's. */
const coveredByPool = (binding: Binding, poolId: ModelPoolId, modelPools: ModelPools) =>
  poolOfBinding(binding, modelPools) === poolId;

/** A pool's shared note: its own binding's, else the first a member slot already carries. */
export function poolNote(
  manifest: Manifest,
  poolId: ModelPoolId,
  modelPools: ModelPools,
): string | undefined {
  const covered = Object.values(manifest.models).filter((binding) =>
    coveredByPool(binding, poolId, modelPools),
  );
  return (
    covered.find((binding) => binding.poolId === poolId && binding.note)?.note ??
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

/** A pool's shared default stance: its own binding's, else the first a member slot carries. */
export function poolDefaultStance(
  manifest: Manifest,
  poolId: ModelPoolId,
  modelPools: ModelPools,
): DelegationStance | undefined {
  const covered = Object.values(manifest.models).filter((binding) =>
    coveredByPool(binding, poolId, modelPools),
  );
  return (
    covered.find((binding) => binding.poolId === poolId && binding.defaultStance)?.defaultStance ??
    covered.find((binding) => binding.defaultStance)?.defaultStance
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
): Manifest {
  const { "ui-verifier": _retired, ...roles } = manifest.roles;
  const discovered = new Map<string, CatalogModel>();
  const models = Object.fromEntries(
    Object.entries(manifest.models).map(([alias, binding]) => {
      const model = catalog.find((candidate) => sameBinding(candidate.binding, binding));
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
  readonly bindings: ReadonlyArray<{
    readonly role: AgentRole;
    readonly field: "list" | "specList";
  }>;
}

export function roleGroups(manifest: Manifest): RoleGroup[] {
  const groups: Array<{
    list: string;
    roles: AgentRole[];
    bindings: Array<{ role: AgentRole; field: "list" | "specList" }>;
  }> = [];
  for (const role of ROLE_ORDER) {
    const policy = manifest.roles[role];
    if (policy === undefined) continue;
    for (const field of ["list", "specList"] as const) {
      const list = policy[field];
      if (list === undefined) continue;
      let group = groups.find((candidate) => candidate.list === list);
      if (group === undefined) {
        group = { list, roles: [], bindings: [] };
        groups.push(group);
      }
      if (!group.roles.includes(role)) group.roles.push(role);
      group.bindings.push({ role, field });
    }
  }
  return groups;
}

/**
 * Why a model cannot take work now, mirroring the server's account checks; null when it can.
 */
export function unavailableReason(
  binding: Binding | undefined,
  providers: ReadonlyArray<ServerProvider>,
  { now = Date.now(), modelPools = NO_POOLS }: { now?: number; modelPools?: ModelPools } = {},
): string | null {
  if (binding === undefined) return "not configured";
  const pool = binding.poolId === undefined ? undefined : modelPools[binding.poolId];
  if (pool !== undefined) {
    if (!resolveModelPoolEnabled(pool)) return "pool switched off";
    const reasons = pool.slots.filter(isModelPoolSlotEnabled).map((slot) => {
      const provider = providers.find(
        (candidate) => candidate.instanceId === slot.providerInstanceId,
      );
      return provider === undefined
        ? "not installed"
        : unavailableReason({ driverKind: provider.driver, model: slot.model }, [provider], {
            now,
          });
    });
    return reasons.length === 0
      ? "no accounts switched on"
      : reasons.includes(null)
        ? null
        : (reasons[0] ?? null);
  }
  const accounts = providers.filter(
    (provider) => provider.poolMembers === undefined && provider.driver === binding.driverKind,
  );
  if (accounts.length === 0) return "not installed";
  const reasons = accounts.map((provider) => {
    if (!provider.enabled || provider.status === "disabled") return "disabled";
    if (!provider.installed) return "not installed";
    if (provider.availability === "unavailable" || provider.status === "error")
      return "unavailable";
    if (provider.auth.status !== "authenticated") return "signed out";
    if (!provider.models.some((model) => model.slug === binding.model)) return "model unavailable";
    const limited = provider.usageLimits?.windows.some(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
    );
    return limited ? "rate limited" : null;
  });
  return reasons.includes(null) ? null : (reasons[0] ?? null);
}

export function modelLabel(
  binding: Binding | undefined,
  alias: string,
  providers: ReadonlyArray<ServerProvider>,
  modelPools: ModelPools = NO_POOLS,
): string {
  if (binding === undefined) return alias;
  if (binding.poolId !== undefined && modelPools[binding.poolId] !== undefined)
    return modelPools[binding.poolId]!.displayName;
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
  /** Set for a model pool: delegation names the pool and T3 picks the slot with allowance. */
  readonly poolId?: ModelPoolId;
}

/**
 * Installed providers that do not declare read-only enforcement, by name: dispatch never places a
 * reader there, so a model of theirs serves only writer jobs.
 */
export function readOnlyUnenforcedProviders(providers: ReadonlyArray<ServerProvider>): string[] {
  const names = new Set<string>();
  for (const provider of providers) {
    if (provider.poolMembers !== undefined || provider.readOnlySourceAccess === "enforced")
      continue;
    if (!provider.enabled || provider.status === "disabled") continue;
    names.add(provider.displayName ?? provider.driver);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Every model an installed account offers, with its effort settings when it has any, then each
 * model pool. A pool's binding names its first installed slot, so older readers still decode it.
 */
export function catalogModels(
  providers: ReadonlyArray<ServerProvider>,
  modelPools: ModelPools = NO_POOLS,
): CatalogModel[] {
  return [...accountCatalogModels(providers), ...poolCatalogModels(providers, modelPools)];
}

function poolCatalogModels(
  providers: ReadonlyArray<ServerProvider>,
  modelPools: ModelPools,
): CatalogModel[] {
  return (Object.entries(modelPools) as Array<[ModelPoolId, ModelPoolConfig]>).flatMap(
    ([poolId, pool]) => {
      if (!resolveModelPoolEnabled(pool)) return [];
      const representative = pool.slots.filter(isModelPoolSlotEnabled).flatMap((slot) => {
        const provider = providers.find(
          (candidate) => candidate.instanceId === slot.providerInstanceId,
        );
        const model = provider?.models.find((candidate) => candidate.slug === slot.model);
        return provider === undefined || model === undefined ? [] : [{ provider, model }];
      })[0];
      if (representative === undefined) return [];
      const option = representative.model.capabilities?.optionDescriptors?.find(isReasoningSelect);
      return [
        {
          key: `pool:${poolId}`,
          label: pool.displayName,
          poolId,
          binding: {
            driverKind: representative.provider.driver,
            model: representative.model.slug,
            poolId,
            ...(option?.type === "select" ? { effortOption: option.id } : {}),
          },
          efforts: option?.type === "select" ? option.options.map((choice) => choice.id) : [],
        },
      ];
    },
  );
}

function accountCatalogModels(providers: ReadonlyArray<ServerProvider>): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const provider of providers) {
    if (provider.poolMembers !== undefined) continue;
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
  modelPools: ModelPools = NO_POOLS,
): [Manifest, string] {
  const existing = Object.entries(manifest.models).find(([, binding]) =>
    sameBinding(binding, model.binding),
  );
  if (existing) return [manifest, existing[0]];
  // A pool carries forward a note its slots already have, and a slot joins its pool's note.
  const pool = poolOfBinding(model.binding, modelPools);
  const note =
    pool === undefined
      ? modelNote(manifest, model.binding.model)
      : poolNote(manifest, pool, modelPools);
  const defaultStance =
    pool === undefined
      ? modelDefaultStance(manifest, model.binding.model)
      : poolDefaultStance(manifest, pool, modelPools);
  const listedOnly = modelListedOnly(
    manifest,
    pool === undefined ? model.binding.model : `pool:${pool}`,
    modelPools,
  );
  const binding = {
    ...model.binding,
    ...(note === undefined ? {} : { note }),
    ...(defaultStance === undefined ? {} : { defaultStance }),
    ...(listedOnly ? { listedOnly } : {}),
  };
  const slug = model.poolId === undefined ? model.binding.model : `pool-${model.poolId}`;
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

/** Rewrites every binding a row covers: each alias of a model, or a pool (`pool:<id>`) and its slots. */
function updateCovered(
  manifest: Manifest,
  model: string,
  modelPools: ModelPools,
  update: (binding: Binding) => Binding,
): Manifest {
  const poolId = model.startsWith("pool:") ? (model.slice(5) as ModelPoolId) : undefined;
  const covers = (binding: Binding) =>
    poolId === undefined ? binding.model === model : coveredByPool(binding, poolId, modelPools);
  const models = Object.fromEntries(
    Object.entries(manifest.models).map(([alias, binding]) => [
      alias,
      covers(binding) ? update(binding) : binding,
    ]),
  );
  return { ...manifest, models };
}

/**
 * Sets what a model is good at on every alias binding it; an empty note removes it. A pool's
 * note (`model` given as `pool:<id>`) covers the pool and every member slot's binding.
 */
export function setModelNote(
  manifest: Manifest,
  model: string,
  note: string,
  modelPools: ModelPools = NO_POOLS,
): Manifest {
  const text = note.trim();
  return updateCovered(manifest, model, modelPools, ({ note: _previous, ...rest }) =>
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
  modelPools: ModelPools = NO_POOLS,
): Manifest {
  return updateCovered(manifest, model, modelPools, ({ defaultStance: _previous, ...rest }) =>
    defaultStance === undefined ? rest : { ...rest, defaultStance },
  );
}

/** Whether a row's model (or `pool:<id>`) is kept to its lists, never an off-list fallback. */
export function modelListedOnly(
  manifest: Manifest,
  model: string,
  modelPools: ModelPools = NO_POOLS,
): boolean {
  const poolId = model.startsWith("pool:") ? (model.slice(5) as ModelPoolId) : undefined;
  return Object.values(manifest.models).some(
    (binding) =>
      binding.listedOnly === true &&
      (poolId === undefined ? binding.model === model : coveredByPool(binding, poolId, modelPools)),
  );
}

/** Keeps a model to its lists on every alias binding it, or lets it serve as an off-list fallback. */
export function setModelListedOnly(
  manifest: Manifest,
  model: string,
  listedOnly: boolean,
  modelPools: ModelPools = NO_POOLS,
): Manifest {
  return updateCovered(manifest, model, modelPools, ({ listedOnly: _previous, ...rest }) =>
    listedOnly ? { ...rest, listedOnly } : rest,
  );
}

interface ListedModel {
  readonly alias: string;
  /** The model slug, or `pool:<id>` for a pool row; it keys the row's note. */
  readonly model: string;
  readonly poolId?: ModelPoolId;
  readonly roles: AgentRole[];
}

/**
 * Each listed model once, in the order the jobs list them, with the roles that use it. A model
 * served by several accounts is one model with one note, and a model pool joins with every
 * member slot listed anywhere into one row.
 */
export function listedModels(
  manifest: Manifest,
  jobs: ReadonlyArray<Job>,
  modelPools: ModelPools = NO_POOLS,
): ListedModel[] {
  const models = new Map<string, ListedModel>();
  for (const job of jobs)
    for (const section of job.sections)
      for (const entry of manifest.lists[section.list] ?? []) {
        const binding = manifest.models[entry.model];
        if (binding === undefined) continue;
        const poolId = poolOfBinding(binding, modelPools);
        const key = poolId === undefined ? binding.model : `pool:${poolId}`;
        const existing = models.get(key);
        const listed: ListedModel =
          existing === undefined
            ? {
                alias: entry.model,
                model: key,
                ...(poolId === undefined ? {} : { poolId }),
                roles: [],
              }
            : // The pool's own binding names the row, so it reads as the pool.
              binding.poolId !== undefined && manifest.models[existing.alias]?.poolId === undefined
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

/** Removes a model from a list, and the exceptions of that list's roles that named it. */
export function removeEntry(manifest: Manifest, list: string, model: string): Manifest {
  let next = withList(
    manifest,
    list,
    (manifest.lists[list] ?? []).filter((entry) => entry.model !== model),
  );
  for (const role of AgentRole.literals) {
    if (next.roles[role]?.list !== list) continue;
    next = withRole(next, role, ({ callers, ...policy }) => {
      const kept = Object.entries(callers ?? {}).filter(([, first]) => first !== model);
      return { ...policy, ...(kept.length === 0 ? {} : { callers: Object.fromEntries(kept) }) };
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
  modelPools: ModelPools = NO_POOLS,
): [Manifest, string] {
  const [next, alias] = ensureModel(manifest, model, modelPools);
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
  modelPools: ModelPools = NO_POOLS,
): Manifest {
  const [withModel, alias] = ensureModel(manifest, model, modelPools);
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
    next = withRole(next, role, ({ callers, ...policy }) => ({
      ...policy,
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
    }));
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
  for (const { role, field } of group.bindings) {
    const base = field === "specList" ? `${role}-spec` : role;
    let list = base;
    for (let suffix = 2; next.lists[list] !== undefined; suffix++) list = `${base}-${suffix}`;
    next = withRole(withList(next, list, entries), role, (policy) => ({
      ...policy,
      [field]: list,
    }));
  }
  const referenced = Object.values(next.roles).some(
    (policy) => policy?.list === group.list || policy?.specList === group.list,
  );
  if (referenced) return next;
  const { [group.list]: _shared, ...lists } = next.lists;
  return { ...next, lists };
}

export interface JobSection {
  readonly list: string;
  readonly title?: string;
  readonly hint?: string;
}

/** A row on the page: roles sharing a list, or the Reviewer with its change and Spec lists. */
export interface Job {
  readonly roles: ReadonlyArray<AgentRole>;
  readonly sections: ReadonlyArray<JobSection>;
  readonly splitGroups: ReadonlyArray<RoleGroup>;
}

const REVIEWER_SECTIONS = {
  list: { title: "Change reviews", hint: "A chore or other work with no Spec" },
  specList: { title: "Spec reviews", hint: "The integrated outcome of a Spec" },
} as const;

export function jobsFor(manifest: Manifest, groups: ReadonlyArray<RoleGroup>): Job[] {
  const reviewer = manifest.roles.reviewer;
  const jobs: Job[] = [];
  const alsoUsedBy = (list: string, hint: string) => {
    const others = groups
      .find((group) => group.list === list)
      ?.roles.filter((role) => role !== "reviewer");
    return others?.length
      ? `${hint}. Also used by ${others.map((role) => AGENT_ROLE_TITLE_LABEL[role]).join(", ")}`
      : hint;
  };
  for (const group of groups) {
    const roles = group.roles.filter((role) => role !== "reviewer");
    const shared = group.bindings.length > 1 ? [group] : [];
    if (roles.length > 0) {
      jobs.push({ roles, sections: [{ list: group.list }], splitGroups: shared });
    }
    if (reviewer === undefined || group.list !== reviewer.list) continue;
    const specList = reviewer.specList ?? reviewer.list;
    jobs.push({
      roles: ["reviewer"],
      sections:
        specList === reviewer.list
          ? [
              {
                list: specList,
                title: "Change and Spec reviews",
                hint: alsoUsedBy(specList, "Both kinds of review use this list"),
              },
            ]
          : [
              {
                list: reviewer.list,
                title: REVIEWER_SECTIONS.list.title,
                hint: alsoUsedBy(reviewer.list, REVIEWER_SECTIONS.list.hint),
              },
              {
                list: specList,
                title: REVIEWER_SECTIONS.specList.title,
                hint: alsoUsedBy(specList, REVIEWER_SECTIONS.specList.hint),
              },
            ],
      splitGroups: groups.filter(
        (candidate) =>
          candidate.bindings.length > 1 &&
          candidate.bindings.some(({ role }) => role === "reviewer"),
      ),
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

/** An older policy without `council` reads as Off. */
export const councilOn = (manifest: Manifest) => manifest.roles.reviewer.council === true;

/** On stores `true`; Off removes the key, so an Off policy matches one that never had it. */
export function setCouncil(manifest: Manifest, on: boolean): Manifest {
  return withRole(manifest, "reviewer", ({ council: _previous, ...policy }) =>
    on ? { ...policy, council: true } : policy,
  );
}

/** The council's members: the reviewer's Spec-review list, each with its model's maker. */
export function councilMembers(manifest: Manifest) {
  const reviewer = rolePolicy(manifest, "reviewer");
  return (manifest.lists[reviewer.specList ?? reviewer.list] ?? []).flatMap((entry) => {
    const binding = manifest.models[entry.model];
    return binding === undefined ? [] : [{ ...entry, maker: modelMaker(binding) }];
  });
}

/** Why a council cannot be saved, or null: it needs at least two makers among its members. */
export function councilIssue(manifest: Manifest): string | null {
  if (!councilOn(manifest)) return null;
  const makers = new Set(councilMembers(manifest).map((member) => member.maker));
  return makers.size >= 2
    ? null
    : "A council needs Spec-review models from at least two makers. Add a model from another maker, or turn the council Off.";
}

/** What the council line says: how many of its makers have a member that can run now. */
export function councilSeating(
  manifest: Manifest,
  providers: ReadonlyArray<ServerProvider>,
  options: { now?: number } = {},
): string {
  const members = councilMembers(manifest);
  const makers = new Set(members.map((member) => member.maker));
  const ready = new Set(
    members
      .filter(
        (member) => unavailableReason(manifest.models[member.model], providers, options) === null,
      )
      .map((member) => member.maker),
  );
  const noun = makers.size === 1 ? "maker" : "makers";
  if (ready.size === makers.size) return `All ${makers.size} ${noun} can sit now.`;
  return ready.size >= 2
    ? `${ready.size} of ${makers.size} ${noun} can sit now.`
    : `${ready.size} of ${makers.size} ${noun} can sit now: the council won't form until another maker is available, so one reviewer runs.`;
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
