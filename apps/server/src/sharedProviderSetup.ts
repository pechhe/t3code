// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type {
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerSettings,
  SharedProviderSetupState,
} from "@t3tools/contracts";

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );

/** Identifies a provider list as clients see it, so a secret's value never affects it. */
export const digestProviderInstances = (redactedInstances: ProviderInstanceConfigMap): string =>
  NodeCrypto.createHash("sha256").update(canonicalJson(redactedInstances)).digest("hex");

/** A change this server didn't receive from the shared setup is a new edit to it. */
export const stampLocalEdit = (
  state: SharedProviderSetupState,
  digest: string,
  changedAt: string,
): SharedProviderSetupState =>
  state.digest === digest
    ? state
    : {
        ...state,
        digest,
        changedAt,
        version: state.version + 1,
        baseVersion: state.version > state.baseVersion ? state.baseVersion : state.version,
      };

const homePathOf = (instance: ProviderInstanceConfigMap[ProviderInstanceId]): string | null => {
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  const homePath = (config as { readonly homePath?: unknown }).homePath;
  return typeof homePath === "string" && homePath.length > 0 ? homePath : null;
};

/** The same account is the same driver on the same home; only those local ids are renamed. */
/** Repoints older aliases at a renamed id, so every alias stays one hop from a live instance. */
export const withAliasesAdded = (
  aliases: NonNullable<ServerSettings["providerInstanceAliases"]>,
  renames: ReadonlyMap<ProviderInstanceId, ProviderInstanceId>,
): NonNullable<ServerSettings["providerInstanceAliases"]> =>
  ({
    ...Object.fromEntries(
      Object.entries(aliases).map(([former, current]) => [former, renames.get(current) ?? current]),
    ),
    ...Object.fromEntries(renames),
  }) as NonNullable<ServerSettings["providerInstanceAliases"]>;

export function planInstanceRenames(
  local: ProviderInstanceConfigMap,
  incoming: ProviderInstanceConfigMap,
): ReadonlyMap<ProviderInstanceId, ProviderInstanceId> {
  const renames = new Map<ProviderInstanceId, ProviderInstanceId>();
  const incomingEntries = Object.entries(incoming);
  for (const [id, instance] of Object.entries(local)) {
    if (Object.hasOwn(incoming, id)) continue;
    const homePath = homePathOf(instance);
    if (homePath === null) continue;
    const match = incomingEntries.find(
      ([, candidate]) => candidate.driver === instance.driver && homePathOf(candidate) === homePath,
    );
    if (match) renames.set(id as ProviderInstanceId, match[0] as ProviderInstanceId);
  }
  return renames;
}

/** Replaces each id wherever settings name it, as a value or as a key. */
export function renameInstanceIds(
  encoded: unknown,
  renames: ReadonlyMap<ProviderInstanceId, ProviderInstanceId>,
): unknown {
  const lookup = new Map<string, string>(renames);
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return lookup.get(value) ?? value;
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [lookup.get(key) ?? key, visit(entry)]),
    );
  };
  return visit(encoded);
}

/** A pool that names an instance the setup doesn't have can route a turn nowhere. */
export function withoutDanglingPoolMembers(
  instances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  return Object.fromEntries(
    Object.entries(instances).map(([id, instance]) => {
      if (instance.pool === undefined) return [id, instance];
      const pool = instance.pool.filter((member) => Object.hasOwn(instances, member));
      const { preferredMember, ...rest } = instance;
      return [
        id,
        {
          ...rest,
          pool,
          ...(preferredMember !== undefined && pool.includes(preferredMember)
            ? { preferredMember }
            : {}),
        },
      ];
    }),
  ) as ProviderInstanceConfigMap;
}

export const UNSHARED_PROVIDER_SETUP: SharedProviderSetupState = {
  shared: false,
  version: 0,
  baseVersion: 0,
  changedAt: "1970-01-01T00:00:00.000Z",
  digest: "",
};

export const sharedProviderSetupOf = (settings: ServerSettings): SharedProviderSetupState =>
  settings.sharedProviderSetup ?? UNSHARED_PROVIDER_SETUP;

const REMEMBERED_REMOVALS = 64;

/** Remembers instances a write removed, and forgets one that is back. */
export const withRemovalsTracked = (
  state: SharedProviderSetupState,
  before: ProviderInstanceConfigMap,
  after: ProviderInstanceConfigMap,
): SharedProviderSetupState => {
  const gone = Object.keys(before).filter((id) => !Object.hasOwn(after, id));
  const removed = [...new Set([...gone, ...(state.removedInstanceIds ?? [])])]
    .filter((id) => !Object.hasOwn(after, id))
    .slice(0, REMEMBERED_REMOVALS);
  const previous = state.removedInstanceIds ?? [];
  if (removed.length === previous.length && removed.every((id, index) => id === previous[index])) {
    return state;
  }
  return { ...state, removedInstanceIds: removed };
};

/** Instance keys shipped upstream clients don't know, so their whole-list writes omit them. */
const FORK_ONLY_INSTANCE_KEYS = ["preferredMember", "poolPolicy"] as const;

/**
 * A whole provider list comes from a client's copy: it can't revive a removed instance (adding one
 * back goes through an explicit upsert), and it keeps keys an older client couldn't have sent.
 */
export const asWholeListWrite = (
  state: SharedProviderSetupState,
  current: ProviderInstanceConfigMap,
  written: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap => {
  const removed = new Set(state.shared ? (state.removedInstanceIds ?? []) : []);
  return Object.fromEntries(
    Object.entries(written)
      .filter(([id]) => !removed.has(id) || Object.hasOwn(current, id))
      .map(([id, instance]) => {
        const before = current[id as ProviderInstanceId];
        if (before === undefined) return [id, instance];
        const kept = Object.fromEntries(
          FORK_ONLY_INSTANCE_KEYS.flatMap((key) =>
            before[key] !== undefined && !Object.hasOwn(instance, key) ? [[key, before[key]]] : [],
          ),
        );
        if (
          kept.preferredMember !== undefined &&
          !(instance.pool ?? []).includes(kept.preferredMember as ProviderInstanceId)
        ) {
          delete kept.preferredMember;
        }
        return [id, { ...instance, ...kept }];
      }),
  ) as ProviderInstanceConfigMap;
};
