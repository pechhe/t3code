/**
 * Account pools: a configured instance whose turns run on one of its member
 * instances (for example several Claude subscriptions).
 *
 * A pooled turn goes to the pool's preferred member while it has allowance,
 * otherwise to the member whose allowance would otherwise lapse unused soonest,
 * among those with allowance left. A thread already on a member stays there
 * while it has allowance, which avoids a provider switch and its context
 * handoff, unless a preferred member takes over at a context rollover.
 *
 * @module providerPools
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

export interface ProviderPool {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly members: ReadonlyArray<ProviderInstanceId>;
  readonly preferredMember?: ProviderInstanceId | undefined;
}

type PoolRoute = Pick<ProviderPool, "driver" | "members" | "preferredMember">;

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

/** A reading older than this is re-read before a turn trusts it near a limit. */
export const USAGE_REFRESH_STALE_MS = 60_000;

/** A window this used is close enough to its limit for a stale reading to hide exhaustion. */
export const USAGE_REFRESH_NEAR_LIMIT_PERCENT = 95;

/**
 * Whether a turn about to use this account should re-read its usage first:
 * the reading is stale and a window is nearly used up with its reset still
 * ahead. Away from the limit a stale reading cannot hide exhaustion.
 */
export const needsUsageRefresh = (provider: ServerProvider, nowMs: number): boolean => {
  const usage = provider.usageLimits;
  if (usage === undefined || nowMs - Date.parse(usage.checkedAt) < USAGE_REFRESH_STALE_MS) {
    return false;
  }
  return usage.windows.some(
    (window) =>
      window.usedPercent >= USAGE_REFRESH_NEAR_LIMIT_PERCENT &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  );
};

const soonestResetMs = (windows: ReadonlyArray<ServerProviderUsageWindow>, nowMs: number) => {
  let soonest = Number.POSITIVE_INFINITY;
  for (const window of windows) {
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (resetMs > nowMs && resetMs < soonest) soonest = resetMs;
  }
  return soonest;
};

/**
 * Whether a weekly or longer window will reset with allowance unspent at the
 * pace it has been used so far: less of it is used than of its duration has
 * passed.
 */
const isBehindPace = (window: ServerProviderUsageWindow, nowMs: number): boolean => {
  if (window.resetsAt === undefined || !window.windowDurationMins) return false;
  const leftMs = Date.parse(window.resetsAt) - nowMs;
  return leftMs > 0 && window.usedPercent / 100 < 1 - leftMs / (window.windowDurationMins * 60_000);
};

/**
 * How urgently an account's allowance should be spent. Tier 0: some of it
 * will lapse unused, because a weekly window is behind pace (then its session
 * allowance is lost at each session reset too) or the account reports only
 * session windows; the deadline is the soonest reset that loses it. Tier 1:
 * every weekly window is on or ahead of pace, so it runs out before its reset
 * and nothing lapses; the soonest weekly reset only says which refills first.
 */
const spendUrgency = (
  provider: ServerProvider,
  nowMs: number,
): { readonly tier: number; readonly deadlineMs: number } => {
  const windows = provider.usageLimits?.windows ?? [];
  if (windows.length === 0) return { tier: 1, deadlineMs: Number.POSITIVE_INFINITY };
  const banked = windows.filter((window) => window.kind !== "session");
  if (banked.length === 0) return { tier: 0, deadlineMs: soonestResetMs(windows, nowMs) };
  const behind = banked.filter((window) => isBehindPace(window, nowMs));
  if (behind.length === 0) return { tier: 1, deadlineMs: soonestResetMs(banked, nowMs) };
  const sessions = windows.filter((window) => window.kind === "session");
  return { tier: 0, deadlineMs: soonestResetMs([...sessions, ...behind], nowMs) };
};

/** When an exhausted account can take a turn again: its last blocking window's reset. */
const usableAgainMs = (provider: ServerProvider, nowMs: number): number => {
  let latest = nowMs;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < 100) continue;
    const resetMs =
      window.resetsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.resetsAt);
    if (resetMs > latest) latest = resetMs;
  }
  return latest;
};

/**
 * Order accounts for a pooled turn so the least allowance goes unused: those
 * with allowance left first, by `spendUrgency`; then those at a limit, by
 * which can take a turn again soonest. Ties keep their input order.
 */
export const compareByUsageReset =
  (nowMs: number) =>
  (a: ServerProvider, b: ServerProvider): number => {
    const aExhausted = isProviderUsageExhausted(a, nowMs);
    const exhaustion = Number(aExhausted) - Number(isProviderUsageExhausted(b, nowMs));
    if (exhaustion !== 0) return exhaustion;
    if (aExhausted) return usableAgainMs(a, nowMs) - usableAgainMs(b, nowMs) || 0;
    const urgencyA = spendUrgency(a, nowMs);
    const urgencyB = spendUrgency(b, nowMs);
    // Two accounts with no known reset subtract to NaN, which ties.
    return urgencyA.tier - urgencyB.tier || urgencyA.deadlineMs - urgencyB.deadlineMs || 0;
  };

const routableMembers = (
  pool: PoolRoute,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  pool.members.flatMap((member) => {
    const provider = providers.find((candidate) => candidate.instanceId === member);
    return provider !== undefined &&
      provider.driver === pool.driver &&
      provider.poolMembers === undefined &&
      isProviderRoutable(provider)
      ? [provider]
      : [];
  });

/**
 * The member a pooled turn should run on, or `undefined` when no member can
 * take a turn. When every member is at a limit, the one resetting soonest is
 * returned so the turn fails onto the earliest usage-limit recovery.
 */
export const pickPoolMember = (input: {
  readonly pool: PoolRoute;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /** The member the thread is already on, kept while it has allowance. */
  readonly current?: ProviderInstanceId | undefined;
}): ProviderInstanceId | undefined => {
  const candidates = routableMembers(input.pool, input.providers);
  const current = candidates.find((provider) => provider.instanceId === input.current);
  if (current !== undefined && !isProviderUsageExhausted(current, input.nowMs)) {
    return current.instanceId;
  }
  return orderForPool(input.pool, candidates, input.nowMs)[0]?.instanceId;
};

/** Spend order, with the preferred member first unless it is at a limit. */
const orderForPool = (
  pool: PoolRoute,
  candidates: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyArray<ServerProvider> => {
  const ordered = [...candidates].sort(compareByUsageReset(nowMs));
  const preferred = ordered.find((provider) => provider.instanceId === pool.preferredMember);
  if (preferred === undefined || isProviderUsageExhausted(preferred, nowMs)) return ordered;
  return [preferred, ...ordered.filter((provider) => provider !== preferred)];
};

/**
 * The member a thread should move to after `limited` hit its usage limit:
 * another member with allowance left and the soonest reset, or `undefined`
 * when every other member is at a limit too. Unlike `pickPoolMember` it never
 * returns an exhausted member, so a failover cannot cycle between limits.
 */
export const pickPoolFailoverMember = (input: {
  readonly pool: PoolRoute;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly limited: ProviderInstanceId;
}): ProviderInstanceId | undefined =>
  orderForPool(
    input.pool,
    routableMembers(input.pool, input.providers).filter(
      (provider) =>
        provider.instanceId !== input.limited && !isProviderUsageExhausted(provider, input.nowMs),
    ),
    input.nowMs,
  )[0]?.instanceId;

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
        ...(pool.preferredMember === undefined
          ? {}
          : { poolPreferredMember: pool.preferredMember }),
      },
    ];
  });
  return [...providers, ...poolSnapshots];
};
