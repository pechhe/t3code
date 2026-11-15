import type { UsageSlotBudget } from "@t3tools/contracts";

export type UsageSlotBudgetEdit = {
  monthlyBudgetUsd: number;
  resetDayOfMonth: number;
  cycleSpendUsd: number;
  correct?: true;
};

/** The editor holds text so a half-typed figure is never sent; saving validates it. */
export interface UsageSlotBudgetForm {
  readonly monthlyBudgetUsd: string;
  readonly resetDayOfMonth: string;
  readonly cycleSpendUsd: string;
}

export const usageSlotBudgetForm = (budget?: UsageSlotBudget): UsageSlotBudgetForm => ({
  monthlyBudgetUsd: budget?.monthlyBudgetUsd.toString() ?? "",
  resetDayOfMonth: budget?.resetDayOfMonth.toString() ?? "1",
  cycleSpendUsd: budget?.cycleSpendUsd.toString() ?? "0",
});

const parseUsd = (value: string): number | null => {
  const trimmed = value.trim().replace(/^\$/, "");
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Builds the settings patch for the editor. A correction is stated explicitly rather than
 * inferred from the figure: a form that re-sends an unchanged figure is an ordinary edit, and
 * treating it as a correction would silently drop the spend recorded since the last one.
 */
export function usageSlotBudgetPatch(
  previous: UsageSlotBudget | undefined,
  form: UsageSlotBudgetForm,
): { readonly patch: UsageSlotBudgetEdit } | { readonly error: string } {
  const monthlyBudgetUsd = parseUsd(form.monthlyBudgetUsd);
  if (monthlyBudgetUsd === null || monthlyBudgetUsd <= 0) {
    return { error: "Enter a monthly budget above 0." };
  }
  const resetDay = Number(form.resetDayOfMonth.trim());
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) {
    return { error: "Enter a reset day between 1 and 31." };
  }
  const cycleSpendUsd = parseUsd(form.cycleSpendUsd);
  if (cycleSpendUsd === null || cycleSpendUsd < 0) {
    return { error: "Enter the spend so far this cycle, or 0." };
  }
  const patch: UsageSlotBudgetEdit = {
    monthlyBudgetUsd,
    resetDayOfMonth: resetDay,
    cycleSpendUsd,
    // A budget created with spend already in it has no other way to state that spend, so
    // creation anchors the cycle; a correction on an existing budget is always explicit.
    ...(previous === undefined && cycleSpendUsd > 0 ? { correct: true as const } : {}),
  };
  return { patch };
}

/** Explicitly re-anchor the cycle, even when the corrected figure equals the stored figure. */
export function usageSlotBudgetCorrection(
  previous: UsageSlotBudget | undefined,
  form: UsageSlotBudgetForm,
): { readonly patch: UsageSlotBudgetEdit } | { readonly error: string } {
  const result = usageSlotBudgetPatch(previous, form);
  return "error" in result ? result : { patch: { ...result.patch, correct: true } };
}
