// @effect-diagnostics globalDate:off
// UTC Date arithmetic keeps calendar-month clamping independent of host timezone.
import type {
  ServerProviderUsageSlot,
  ServerProviderUsageWindow,
  UsageSlotBudget,
} from "@t3tools/contracts";

export interface UsageSlotSpend {
  readonly cycleUsd: number;
  readonly sinceCorrectionUsd: number;
}

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const cycleDay = (year: number, month: number, requestedDay: number) =>
  Math.min(requestedDay, daysInMonth(year, month));

export const usageCycleBounds = (nowMs: number, resetDayOfMonth: number) => {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = now.getUTCDate();
  const thisMonthDay = cycleDay(year, month, resetDayOfMonth);
  const currentStart =
    today >= thisMonthDay
      ? Date.UTC(year, month, thisMonthDay)
      : Date.UTC(year, month - 1, cycleDay(year, month - 1, resetDayOfMonth));
  const start = new Date(currentStart);
  const nextResetMs = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    cycleDay(start.getUTCFullYear(), start.getUTCMonth() + 1, resetDayOfMonth),
  );
  return { startMs: currentStart, nextResetMs };
};

/**
 * What T3 recorded spending through a Pi slot this cycle, from daily usage buckets: the
 * budget's cycle, or the calendar month for a metered account with no budget.
 */
export const usageSlotSpend = (input: {
  readonly budget: UsageSlotBudget | undefined;
  readonly nowMs: number;
  readonly accountKey: string;
  readonly buckets: ReadonlyArray<{
    readonly provider: string;
    readonly accountKey?: string | undefined;
    readonly day: string;
    readonly costUsd: number;
  }>;
  /** Spend from the correction moment to the end of its day, when it could be read exactly. */
  readonly correctionDayUsd?: number | undefined;
}): UsageSlotSpend => {
  const { budget, nowMs } = input;
  const { startMs } = usageCycleBounds(nowMs, budget?.resetDayOfMonth ?? 1);
  const correctionMs =
    budget?.correctedAt === undefined ? undefined : Date.parse(budget.correctedAt);
  const correctedInCycle =
    correctionMs !== undefined && correctionMs >= startMs && correctionMs <= nowMs;
  const correctionDay =
    correctionMs === undefined
      ? Number.NaN
      : Date.parse(`${new Date(correctionMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  let cycleUsd = 0;
  let sinceCorrectionUsd = 0;
  let correctionDayUsd = 0;
  for (const bucket of input.buckets) {
    if (bucket.provider !== "pi" || bucket.accountKey !== input.accountKey) continue;
    const bucketMs = Date.parse(`${bucket.day}T00:00:00.000Z`);
    if (bucketMs < startMs) continue;
    cycleUsd += bucket.costUsd;
    if (correctedInCycle) {
      if (bucketMs > correctionDay) sinceCorrectionUsd += bucket.costUsd;
      else if (bucketMs === correctionDay) correctionDayUsd += bucket.costUsd;
    }
  }
  if (correctedInCycle) sinceCorrectionUsd += input.correctionDayUsd ?? correctionDayUsd;
  return { cycleUsd, sinceCorrectionUsd };
};

export const makeUsageSlotBudgetWindow = (input: {
  readonly budget: UsageSlotBudget;
  readonly nowMs: number;
  readonly spend: UsageSlotSpend;
}): ServerProviderUsageWindow => {
  const { budget, nowMs, spend } = input;
  const { startMs, nextResetMs } = usageCycleBounds(nowMs, budget.resetDayOfMonth);
  const correctionMs =
    budget.correctedAt === undefined ? undefined : Date.parse(budget.correctedAt);
  const correctedInCycle =
    correctionMs !== undefined && correctionMs >= startMs && correctionMs <= nowMs;
  const usedUsd = correctedInCycle
    ? budget.cycleSpendUsd + spend.sinceCorrectionUsd
    : spend.cycleUsd;
  return {
    id: "budget",
    kind: "monthly",
    label: "Monthly budget",
    usedPercent: Math.max(0, Math.min(100, (usedUsd / budget.monthlyBudgetUsd) * 100)),
    usedUsd,
    limitUsd: budget.monthlyBudgetUsd,
    resetsAt: new Date(nextResetMs).toISOString(),
  };
};

/**
 * A Pi slot with its spend applied: a metered (pay-as-you-go) slot reports what it cost this
 * cycle, and a budgeted slot gets its budget window. A subscription slot reports no spend.
 */
export const withUsageSlotSpend = (
  slot: ServerProviderUsageSlot,
  input: {
    readonly budget: UsageSlotBudget | undefined;
    readonly nowMs: number;
    readonly buckets: Parameters<typeof usageSlotSpend>[0]["buckets"];
    readonly readAt: string;
    readonly correctionDayUsd?: number | undefined;
  },
): ServerProviderUsageSlot => {
  const { budget, nowMs } = input;
  const metered = slot.metered === true;
  if (budget === undefined && !metered) return slot;
  const spend = usageSlotSpend({
    budget,
    nowMs,
    accountKey: slot.accountKey,
    buckets: input.buckets,
    correctionDayUsd: input.correctionDayUsd,
  });
  if (budget === undefined) return { ...slot, spentUsd: spend.cycleUsd };
  const window = makeUsageSlotBudgetWindow({ budget, nowMs, spend });
  const { unavailable: _unavailable, ...limitsWithoutUnavailable } = slot.usageLimits;
  return {
    ...slot,
    ...(metered && window.usedUsd !== undefined ? { spentUsd: window.usedUsd } : {}),
    usageLimits: {
      ...limitsWithoutUnavailable,
      checkedAt: input.readAt,
      windows: [...slot.usageLimits.windows.filter((item) => item.id !== "budget"), window],
    },
  };
};
