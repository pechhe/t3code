import {
  AgentRole,
  type AgentListEntry,
  type AgentPolicyManifest,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";

type Manifest = AgentPolicyManifest;
type Binding = Manifest["models"][string];
export type RolePolicy = NonNullable<Manifest["roles"][AgentRole]>;

/** A role the page lists; only roles the policy configures are listed. */
export function rolePolicy(manifest: Manifest, role: AgentRole): RolePolicy {
  const policy = manifest.roles[role];
  if (policy === undefined) throw new Error(`The policy does not configure ${role}.`);
  return policy;
}

/** The jobs in the order the page lists them; roles sharing a list appear together. */
export const ROLE_ORDER: ReadonlyArray<AgentRole> = [
  "implementation-worker",
  "ui-worker",
  "ticket-reviewer",
  "spec-reviewer",
  "advisor",
  "chore-worker",
  "browser",
  "ui-verifier",
  "researcher",
  "scout",
];

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  "implementation-worker": "Non-UI code changes",
  "ui-worker": "UI changes",
  "ticket-reviewer": "Reviews a Ticket's change before it lands",
  "spec-reviewer": "Reviews a finished Spec across its landings",
  advisor: "Read-only second opinion",
  "chore-worker": "Mechanical edits",
  browser: "Drives web pages",
  "ui-verifier": "Checks the running app",
  researcher: "Researches docs and the web",
  scout: "Maps the codebase",
};

export interface RoleGroup {
  readonly list: string;
  readonly roles: ReadonlyArray<AgentRole>;
}

export function roleGroups(manifest: Manifest): RoleGroup[] {
  const groups: Array<{ list: string; roles: AgentRole[] }> = [];
  for (const role of ROLE_ORDER) {
    const list = manifest.roles[role]?.list;
    if (list === undefined) continue;
    const group = groups.find((candidate) => candidate.list === list);
    if (group) group.roles.push(role);
    else groups.push({ list, roles: [role] });
  }
  return groups;
}

/**
 * Why a model cannot take work now, mirroring the server's account checks; null when it can.
 */
export function unavailableReason(
  binding: Binding | undefined,
  providers: ReadonlyArray<ServerProvider>,
  { now = Date.now() }: { now?: number } = {},
): string | null {
  if (binding === undefined) return "not configured";
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
): string {
  if (binding === undefined) return alias;
  return (
    providers
      .filter((provider) => provider.driver === binding.driverKind)
      .flatMap((provider) => provider.models)
      .find((model) => model.slug === binding.model)?.name ?? binding.model
  );
}

/** The effort values a model offers, or none when its account is not installed here. */
export function effortChoices(
  binding: Binding | undefined,
  providers: ReadonlyArray<ServerProvider>,
): string[] {
  if (binding === undefined) return [];
  return [
    ...new Set(
      providers
        .filter((provider) => provider.driver === binding.driverKind)
        .flatMap((provider) => provider.models.filter((model) => model.slug === binding.model))
        .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
        .filter((option) => option.id === binding.effortOption)
        .flatMap((option) =>
          option.type === "select" ? option.options.map((choice) => choice.id) : [],
        ),
    ),
  ];
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

/** The provider option ids that carry a model's reasoning effort, under the names adapters use. */
const EFFORT_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
  "thinking",
  "variant",
]);

export interface CatalogModel {
  readonly key: string;
  readonly label: string;
  readonly binding: Binding;
  readonly efforts: ReadonlyArray<string>;
}

/** Every model an installed account offers, with its effort settings when it has any. */
export function catalogModels(providers: ReadonlyArray<ServerProvider>): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const provider of providers) {
    if (provider.poolMembers !== undefined) continue;
    for (const model of provider.models) {
      const option = model.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id),
      );
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
export function ensureModel(manifest: Manifest, model: CatalogModel): [Manifest, string] {
  const existing = Object.entries(manifest.models).find(
    ([, binding]) =>
      binding.driverKind === model.binding.driverKind && binding.model === model.binding.model,
  );
  if (existing) return [manifest, existing[0]];
  const base = `m-${model.binding.model.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 60);
  let alias = base;
  for (let suffix = 2; manifest.models[alias] !== undefined; suffix++) alias = `${base}-${suffix}`;
  return [{ ...manifest, models: { ...manifest.models, [alias]: model.binding } }, alias];
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
    next = withRole(next, role, ({ large, callers, ...policy }) => {
      const kept = Object.entries(callers ?? {}).filter(([, first]) => first !== model);
      return {
        ...policy,
        ...(large === undefined || large.model === model ? {} : { large }),
        ...(kept.length === 0 ? {} : { callers: Object.fromEntries(kept) }),
      };
    });
  }
  return next;
}

/**
 * The alias of `model` in `list`, adding the model to the manifest and to the end of the
 * list when it is not there yet: a large-task or per-agent choice must be one of the job's
 * listed models.
 */
export function listModel(
  manifest: Manifest,
  list: string,
  model: CatalogModel,
  effort: string | undefined,
): [Manifest, string] {
  const [next, alias] = ensureModel(manifest, model);
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
): Manifest {
  const [withModel, alias] = ensureModel(manifest, model);
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
    next = withRole(next, role, ({ large, callers, ...policy }) => ({
      ...policy,
      ...(large === undefined
        ? {}
        : { large: large.model === from ? { ...large, model: alias } : large }),
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

export function setLarge(manifest: Manifest, role: AgentRole, large: AgentListEntry | undefined) {
  return withRole(manifest, role, ({ large: _previous, ...policy }) =>
    large === undefined ? policy : { ...policy, large },
  );
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
    const list = manifest.lists[role] === undefined || role === group.list ? role : `${role}-list`;
    next = withRole(withList(next, list, entries), role, (policy) => ({ ...policy, list }));
  }
  const { [group.list]: _shared, ...lists } = next.lists;
  return group.roles.some((role) => next.roles[role]?.list === group.list)
    ? next
    : { ...next, lists };
}
