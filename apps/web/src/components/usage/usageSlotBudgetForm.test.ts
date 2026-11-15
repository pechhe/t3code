import { describe, expect, it } from "vite-plus/test";

import {
  usageSlotBudgetCorrection,
  usageSlotBudgetForm,
  usageSlotBudgetPatch,
} from "./usageSlotBudgetForm";

describe("usage slot budget form", () => {
  it("anchors the spend a budget is created with", () => {
    const form = { monthlyBudgetUsd: "100", resetDayOfMonth: "1", cycleSpendUsd: "40" };
    expect(usageSlotBudgetPatch(undefined, form)).toMatchObject({
      patch: { cycleSpendUsd: 40, correct: true },
    });
    expect(usageSlotBudgetPatch(undefined, { ...form, cycleSpendUsd: "0" })).not.toMatchObject({
      patch: { correct: true },
    });
  });

  it("re-anchors an equal spend figure only through explicit correction", () => {
    const budget = { monthlyBudgetUsd: 100, resetDayOfMonth: 1, cycleSpendUsd: 25 };
    const form = usageSlotBudgetForm(budget);
    expect(usageSlotBudgetPatch(budget, form)).toMatchObject({ patch: { cycleSpendUsd: 25 } });
    expect(usageSlotBudgetCorrection(budget, form)).toMatchObject({
      patch: { cycleSpendUsd: 25, correct: true },
    });
  });
});
