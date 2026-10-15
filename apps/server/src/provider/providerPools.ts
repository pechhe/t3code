/**
 * Account pools: a configured instance whose turns run on one of its member
 * instances (for example several Claude subscriptions).
 *
 * A pooled turn goes to the member whose usage resets soonest among those
 * with allowance left, so allowance that would otherwise lapse at a reset is
 * spent first. A thread already on a member stays there while it has
 * allowance, which avoids a provider switch and its context handoff.
 *
 * @module provider/providerPools
 */
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export interface ProviderPool {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly members: ReadonlyArray<ProviderInstanceId>;
}

/** Whether the provider can take a turn now, ignoring usage limits. */
export const isProviderRoutable = (provider: ServerProvider): boolean =>
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

const nextUsageResetMs = (provider: ServerProvider, nowMs: number): number => {
  let soonest = Number.POSITIVE_INFINITY;
  for (const window of provider.usageLimits?.windows ?? []) {
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (resetMs > nowMs && resetMs < soonest) soonest = resetMs;
  }
  return soonest;
};

/**
 * Order accounts for a pooled turn: those with allowance left before those
 * at a limit, then by soonest usage reset. Ties keep their input order.
 */
export const compareByUsageReset =
  (nowMs: number) =>
  (a: ServerProvider, b: ServerProvider): number =>
    Number(isProviderUsageExhausted(a, nowMs)) - Number(isProviderUsageExhausted(b, nowMs)) ||
    // Two accounts with no known reset subtract to NaN, which ties.
    nextUsageResetMs(a, nowMs) - nextUsageResetMs(b, nowMs) ||
    0;

/**
 * The member a pooled turn should run on, or `undefined` when no member can
 * take a turn. When every member is at a limit, the one resetting soonest is
 * returned so the turn fails onto the earliest usage-limit recovery.
 */
export const pickPoolMember = (input: {
  readonly pool: Pick<ProviderPool, "driver" | "members">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /** The member the thread is already on, kept while it has allowance. */
  readonly current?: ProviderInstanceId | undefined;
}): ProviderInstanceId | undefined => {
  const candidates = input.pool.members.flatMap((member) => {
    const provider = input.providers.find((candidate) => candidate.instanceId === member);
    return provider !== undefined &&
      provider.driver === input.pool.driver &&
      provider.poolMembers === undefined &&
      isProviderRoutable(provider)
      ? [provider]
      : [];
  });
  const current = candidates.find((provider) => provider.instanceId === input.current);
  if (current !== undefined && !isProviderUsageExhausted(current, input.nowMs)) {
    return current.instanceId;
  }
  return candidates.toSorted(compareByUsageReset(input.nowMs))[0]?.instanceId;
};

/**
 * Append one snapshot per pool, presented as the member a turn would use now
 * (or its first configured member). Account-specific fields stay with the
 * members so usage, sign-in and native sessions are never shown twice.
 */
export const withPoolSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
  pools: ReadonlyArray<ProviderPool>,
  nowMs: number,
): ReadonlyArray<ServerProvider> => {
  if (pools.length === 0) return providers;
  const poolSnapshots = pools.flatMap((pool): ReadonlyArray<ServerProvider> => {
    const baseId =
      pickPoolMember({ pool, providers, nowMs }) ??
      pool.members.find((member) => providers.some((provider) => provider.instanceId === member));
    const base = providers.find((provider) => provider.instanceId === baseId);
    if (base === undefined) return [];
    const {
      usageLimits: _usageLimits,
      runtimePaths: _runtimePaths,
      nativeSessions: _nativeSessions,
      setup: _setup,
      updateState: _updateState,
      displayName: _displayName,
      accentColor: _accentColor,
      ...shared
    } = base;
    return [
      {
        ...shared,
        instanceId: pool.instanceId,
        driver: pool.driver,
        ...(pool.displayName === undefined ? {} : { displayName: pool.displayName }),
        ...(pool.accentColor === undefined ? {} : { accentColor: pool.accentColor }),
        enabled: pool.enabled && base.enabled,
        poolMembers: pool.members,
      },
    ];
  });
  return [...providers, ...poolSnapshots];
};
