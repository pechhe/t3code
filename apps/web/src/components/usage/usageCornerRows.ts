import {
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

interface UsageCornerAccount {
  readonly account: LimitAccount;
  readonly name: string;
  /** What is left in the account's tightest window. */
  readonly remainingPercent: number;
}

export interface UsageCornerRow {
  readonly pool: LimitPool;
  /** The accounts' remaining percentages added up, so two accounts reach 200%. */
  readonly remainingPercent: number;
  /** When every account is out: the soonest moment one becomes usable again, if known. */
  readonly backAt: number | null;
  /** Spending faster than an even rate to each account's reset. */
  readonly ahead: boolean;
  readonly accounts: readonly UsageCornerAccount[];
}

/**
 * The session, weekly and monthly windows of each provider pool. Claude also reports weekly buckets
 * for single models (`seven_day_fable`), which the corner leaves to the Usage page.
 */
function cornerWindows(pool: LimitPool): LimitPoolWindow[] {
  return pool.windows.filter(
    (window) =>
      (window.kind === "session" || window.kind === "weekly" || window.kind === "monthly") &&
      !(pool.driver === "claudeAgent" && window.kind === "weekly" && window.id !== "seven_day"),
  );
}

/**
 * Antigravity meters each model family apart (`gemini-5h`, `3p-weekly`), so a spent family
 * leaves the others usable; every other provider's windows gate the whole account.
 */
function windowFamily(pool: LimitPool, window: ServerProviderUsageWindow): string {
  return pool.driver === "antigravity" ? window.id.replace(/-(5h|weekly|quota)$/, "") : "";
}

/**
 * A short name telling accounts apart: the instance's display name, else its instance id
 * (`claude_ys` → `ys`). Emails stay off the card, as on the Usage page.
 */
function accountName(account: LimitAccount): string {
  if (account.displayName) return account.displayName;
  const id = account.key.slice(account.key.indexOf(":") + 1).replace(/\.json$/i, "");
  return id.replace(/^(claude|codex)[_-]/i, "") || id;
}

function resetAt(window: ServerProviderUsageWindow): number | null {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** When a spent family can run again: every spent window in it has to reset. */
function familyBackAt(windows: readonly ServerProviderUsageWindow[]): number | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    if (remainingPercent(window) > 0) continue;
    const at = resetAt(window);
    if (at === null) return null;
    latest = Math.max(latest, at);
  }
  return Number.isFinite(latest) ? latest : null;
}

/** The account's binding window: the tightest window of the family with most left. */
function accountLimit(pool: LimitPool, windows: readonly ServerProviderUsageWindow[]) {
  const families = new Map<string, ServerProviderUsageWindow[]>();
  for (const window of windows) {
    const key = windowFamily(pool, window);
    families.set(key, [...(families.get(key) ?? []), window]);
  }
  let best: ServerProviderUsageWindow | null = null;
  const backTimes: number[] = [];
  for (const family of families.values()) {
    const tightest = family.reduce((least, window) =>
      remainingPercent(window) < remainingPercent(least) ? window : least,
    );
    if (best === null || remainingPercent(tightest) > remainingPercent(best)) best = tightest;
    const back = familyBackAt(family);
    if (back !== null) backTimes.push(back);
  }
  return best
    ? { tightest: best, backAt: backTimes.length > 0 ? Math.min(...backTimes) : null }
    : null;
}

export function usageCornerRows(pools: readonly LimitPool[], now: number): UsageCornerRow[] {
  return pools.flatMap((pool) => {
    const windows = cornerWindows(pool);
    const accounts = pool.accounts.flatMap((account) => {
      const own = windows.flatMap((window) => {
        const column = window.columns.find((column) => column.account.key === account.key);
        return column?.window ? [column.window] : [];
      });
      const limit = accountLimit(pool, own);
      return limit ? [{ account, ...limit }] : [];
    });
    if (accounts.length === 0) return [];
    const remaining = accounts.reduce((sum, { tightest }) => sum + remainingPercent(tightest), 0);
    const paced = accounts.flatMap(({ tightest }) => {
      const even = paceRemainingPercent(tightest, now);
      return even === null ? [] : [{ left: remainingPercent(tightest), even }];
    });
    const backTimes = accounts.flatMap(({ backAt }) => (backAt === null ? [] : [backAt]));
    return [
      {
        pool,
        remainingPercent: remaining,
        backAt: remaining === 0 && backTimes.length > 0 ? Math.min(...backTimes) : null,
        ahead:
          remaining > 0 &&
          paced.length > 0 &&
          paced.reduce((sum, p) => sum + p.even - p.left, 0) > 5 * paced.length,
        accounts: accounts.map(({ account, tightest }) => ({
          account,
          name: accountName(account),
          remainingPercent: remainingPercent(tightest),
        })),
      },
    ];
  });
}
