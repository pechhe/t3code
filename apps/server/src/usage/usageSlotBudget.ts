// @effect-diagnostics globalDate:off
// UTC Date arithmetic keeps calendar-month clamping independent of host timezone.
import type { ServerProviderUsageWindow, UsageSlotBudget } from "@t3tools/contracts";

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
