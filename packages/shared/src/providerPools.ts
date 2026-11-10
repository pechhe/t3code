/**
 * Account pools: a configured instance whose turns run on one of its member instances.
 * `rankAccounts` is the one rule that places new work, pooled turns and delegated tasks alike;
 * a thread stays on its member while it has allowance, avoiding a provider switch.
 *
 * @module providerPools
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderPoolPolicy,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ProviderPool {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly members: ReadonlyArray<ProviderInstanceId>;
  readonly policy?: ProviderPoolPolicy | undefined;
}

export type PoolRoute = Pick<ProviderPool, "driver" | "members" | "policy">;

/** The usage a member must reach to count as out: its real limit unless the pool keeps a reserve. */
export const limitPercentOf = (pool: Pick<ProviderPool, "policy">): number =>
  pool.policy?.reservePercent ?? 100;

/** Whether the provider can take a turn now, ignoring usage limits. */
const isProviderRoutable = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status === "authenticated";

/**
 * A window at its limit (or at `limitPercent`, for a pool keeping a reserve)
 * counts until its reported reset has passed.
 */
export const isProviderUsageExhausted = (
  provider: ServerProvider,
  nowMs: number,
  limitPercent = 100,
): boolean =>
  provider.usageLimits?.windows.some(
    (window) =>
      window.usedPercent >= limitPercent &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  ) === true;

/** A reading older than this is re-read before a turn trusts it near a limit. */
export const USAGE_REFRESH_STALE_MS = 60_000;

/** A window this used is close enough to its limit for a stale reading to hide exhaustion. */
const USAGE_REFRESH_NEAR_LIMIT_PERCENT = 95;

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
 * Tier 0: some allowance will lapse unused (a weekly window behind pace, or only session
 * windows), by the soonest reset that loses it. Tier 1: every weekly window is on or ahead of
 * pace, so nothing lapses; the soonest weekly reset only says which refills first.
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
export const usableAgainMs = (
  provider: ServerProvider,
  nowMs: number,
  limitPercent = 100,
): number => {
  let latest = nowMs;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < limitPercent) continue;
    const resetMs =
      window.resetsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.resetsAt);
    if (resetMs > latest) latest = resetMs;
  }
  return latest;
};

/** Whether an account has any usage reading to rank it by. */
const hasUsageReading = (provider: ServerProvider): boolean =>
  (provider.usageLimits?.windows.length ?? 0) > 0;

/**
 * Where an account stands for new work: allowance known to be left, no
 * reading at all (never read, or the read is unavailable), or out.
 */
export type AccountStanding = "available" | "unknown" | "out";

export const accountStanding = (
  provider: ServerProvider,
  nowMs: number,
  limitPercent = 100,
): AccountStanding =>
  isProviderUsageExhausted(provider, nowMs, limitPercent)
    ? "out"
    : hasUsageReading(provider)
      ? "available"
      : "unknown";

const STANDING_RANK: Record<AccountStanding, number> = { available: 0, unknown: 1, out: 2 };

/**
 * Accounts with allowance left come first, ranked by `preference`; then those
 * with no reading, by the same preference; then those at a limit, by which
 * can take a turn again soonest. Ties keep their input order.
 */
const byAllowance =
  (
    nowMs: number,
    limitPercentFor: (provider: ServerProvider) => number,
    preference: (a: ServerProvider, b: ServerProvider) => number,
  ) =>
  (a: ServerProvider, b: ServerProvider): number => {
    const aStanding = accountStanding(a, nowMs, limitPercentFor(a));
    const standing =
      STANDING_RANK[aStanding] - STANDING_RANK[accountStanding(b, nowMs, limitPercentFor(b))];
    if (standing !== 0) return standing;
    if (aStanding === "out") {
      return (
        usableAgainMs(a, nowMs, limitPercentFor(a)) - usableAgainMs(b, nowMs, limitPercentFor(b)) ||
        0
      );
    }
    return preference(a, b);
  };

/** Spend first the allowance that would otherwise lapse unused soonest: by `spendUrgency`. */
const bySpendUrgency =
  (nowMs: number) =>
  (a: ServerProvider, b: ServerProvider): number => {
    const urgencyA = spendUrgency(a, nowMs);
    const urgencyB = spendUrgency(b, nowMs);
    // Two accounts with no known reset subtract to NaN, which ties.
    return urgencyA.tier - urgencyB.tier || urgencyA.deadlineMs - urgencyB.deadlineMs || 0;
  };

/** The pool an account belongs to, if any. */
export const poolOf = (
  pools: ReadonlyArray<PoolRoute>,
  provider: ServerProvider,
): PoolRoute | undefined =>
  pools.find(
    (pool) => pool.driver === provider.driver && pool.members.includes(provider.instanceId),
  );

/**
 * Orders accounts that could serve the same work and drops members their pool switches off:
 * allowance left (against the pool's reserve) first by the pool's strategy, then no reading,
 * then out, soonest back first. Accounts in no pool rank by spend urgency.
 */
export const rankAccounts = (input: {
  readonly accounts: ReadonlyArray<ServerProvider>;
  readonly pools: ReadonlyArray<PoolRoute>;
  readonly nowMs: number;
}): ReadonlyArray<ServerProvider> => {
  const pools = new Map(
    input.accounts.map((provider) => [provider, poolOf(input.pools, provider)]),
  );
  const spend = bySpendUrgency(input.nowMs);
  return input.accounts
    .filter(
      (provider) =>
        pools.get(provider)?.policy?.disabledMembers?.includes(provider.instanceId) !== true,
    )
    .sort(
      byAllowance(
        input.nowMs,
        (provider) => {
          const pool = pools.get(provider);
          return pool === undefined ? 100 : limitPercentOf(pool);
        },
        (a, b) => {
          const pool = pools.get(a);
          return pool !== undefined && pool === pools.get(b) && pool.policy?.strategy === "order"
            ? pool.members.indexOf(a.instanceId) - pool.members.indexOf(b.instanceId)
            : spend(a, b);
        },
      ),
    );
};

const routableMembers = (
  pool: PoolRoute,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  pool.members.flatMap((member) => {
    if (pool.policy?.disabledMembers?.includes(member) === true) return [];
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

/** Why a new pooled turn goes to the account `explainPoolPick` names. */
export type PoolPickReason =
  /** The only member with usage left. */
  | "only-available"
  /** The pool's strategy ranks it first: its unspent allowance lapses soonest. */
  | "lapses-soonest"
  /** The first member with usage left in the pool's own order. */
  | "pool-order"
  /** No member has a usage reading to rank by, so the pool's order decides. */
  | "no-reading"
  /** Every member is out; the turn waits for this one, back soonest. */
  | "all-out";

export interface PoolAccountStanding {
  readonly provider: ServerProvider;
  readonly standing: AccountStanding;
  /** When an account that is out can take a turn again. */
  readonly outUntilMs?: number | undefined;
}

/**
 * The account a new pooled turn goes to and why, from the same rule the
 * server routes by, with each routable member's standing in pool order.
 */
export const explainPoolPick = (input: {
  readonly pool: PoolRoute;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}):
  | {
      readonly member: ServerProvider;
      readonly reason: PoolPickReason;
      readonly accounts: ReadonlyArray<PoolAccountStanding>;
    }
  | undefined => {
  const members = routableMembers(input.pool, input.providers);
  const member = orderForPool(input.pool, members, input.nowMs)[0];
  if (member === undefined) return undefined;
  const limitPercent = limitPercentOf(input.pool);
  const accounts = members.map((provider): PoolAccountStanding => {
    const standing = accountStanding(provider, input.nowMs, limitPercent);
    return standing === "out"
      ? { provider, standing, outUntilMs: usableAgainMs(provider, input.nowMs, limitPercent) }
      : { provider, standing };
  });
  const usable = accounts.filter((account) => account.standing !== "out");
  const chosen = accounts.find((account) => account.provider === member)!;
  const reason: PoolPickReason =
    chosen.standing === "out"
      ? "all-out"
      : usable.length === 1
        ? "only-available"
        : chosen.standing === "unknown"
          ? "no-reading"
          : input.pool.policy?.strategy === "order"
            ? "pool-order"
            : "lapses-soonest";
  return { member, reason, accounts };
};

/** The pool's strategy order: spend, or the pool's own member order. */
const orderForPool = (
  pool: PoolRoute,
  candidates: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyArray<ServerProvider> => rankAccounts({ accounts: candidates, pools: [pool], nowMs });

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
        provider.instanceId !== input.limited &&
        !isProviderUsageExhausted(provider, input.nowMs, limitPercentOf(input.pool)),
    ),
    input.nowMs,
  )[0]?.instanceId;

/**
 * The member a user-requested switch moves a running thread to: the next one
 * in the pool's own order after `current`, wrapping around, skipping members
 * with no allowance left (at the pool's reserve limit). `undefined` when no
 * other member qualifies.
 */
export const pickPoolSwitchMember = (input: {
  readonly pool: PoolRoute;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly current: ProviderInstanceId;
}): ProviderInstanceId | undefined => {
  const members = routableMembers(input.pool, input.providers);
  const start = members.findIndex((provider) => provider.instanceId === input.current);
  const limitPercent = limitPercentOf(input.pool);
  return [...members.slice(start + 1), ...members.slice(0, Math.max(start, 0))].find(
    (provider) =>
      provider.instanceId !== input.current &&
      !isProviderUsageExhausted(provider, input.nowMs, limitPercent),
  )?.instanceId;
};

/** The window a remembered usage limit adds to an account's reading. */
export const REMEMBERED_LIMIT_WINDOW_ID = "t3-usage-limit";

/**
 * Adds each limit a run reported to its account's reading, until that limit's reset, so every
 * pick treats the account as out even when a later read fails or still shows allowance.
 */
export const withRememberedLimits = (
  providers: ReadonlyArray<ServerProvider>,
  limits: ReadonlyMap<ProviderInstanceId, number>,
  nowMs: number,
): ReadonlyArray<ServerProvider> => {
  if (limits.size === 0) return providers;
  return providers.map((provider) => {
    const resetMs = limits.get(provider.instanceId);
    if (resetMs === undefined || resetMs <= nowMs) return provider;
    const resetsAt = DateTime.formatIso(DateTime.makeUnsafe(resetMs));
    const usage = provider.usageLimits;
    return {
      ...provider,
      usageLimits: {
        ...usage,
        checkedAt: usage?.checkedAt ?? resetsAt,
        windows: [
          ...(usage?.windows ?? []).filter((window) => window.id !== REMEMBERED_LIMIT_WINDOW_ID),
          {
            id: REMEMBERED_LIMIT_WINDOW_ID,
            kind: "other",
            label: "Usage limit reached",
            usedPercent: 100,
            resetsAt,
          },
        ],
      },
    };
  });
};

/** The routing view of every pool snapshot in a provider list. */
export const poolRoutesOf = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<PoolRoute> =>
  providers.flatMap((provider) =>
    provider.poolMembers === undefined
      ? []
      : [{ driver: provider.driver, members: provider.poolMembers, policy: provider.poolPolicy }],
  );

/**
 * Whether `provider` is the named account, a pool it belongs to, or a sibling in that pool:
 * narrowing work to a named account keeps these, so a sibling can serve when it is out.
 */
export const sharesPoolWith = (
  providers: ReadonlyArray<ServerProvider>,
  named: ProviderInstanceId,
  provider: ServerProvider,
): boolean =>
  provider.instanceId === named ||
  providers.some(
    (pool) =>
      pool.poolMembers?.includes(named) === true &&
      (pool === provider || pool.poolMembers.includes(provider.instanceId)),
  );

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
      readOnlySourceAccess: _readOnlySourceAccess,
      displayName: _displayName,
      accentColor: _accentColor,
      ...shared
    } = base;
    return [
      {
        ...shared,
        ...(pool.members.every((member) =>
          providers.some(
            (provider) =>
              provider.instanceId === member && provider.readOnlySourceAccess === "enforced",
          ),
        )
          ? { readOnlySourceAccess: "enforced" as const }
          : {}),
        instanceId: pool.instanceId,
        driver: pool.driver,
        ...(pool.displayName === undefined ? {} : { displayName: pool.displayName }),
        ...(pool.accentColor === undefined ? {} : { accentColor: pool.accentColor }),
        enabled: pool.enabled && base.enabled,
        poolMembers: pool.members,
        ...(pool.policy === undefined ? {} : { poolPolicy: pool.policy }),
      },
    ];
  });
  return [...providers, ...poolSnapshots];
};
