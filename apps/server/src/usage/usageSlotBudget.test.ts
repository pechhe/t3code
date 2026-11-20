// @effect-diagnostics globalDateInEffect:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeUsageSlotBudgetWindow,
  usageCycleBounds,
  usageSlotSpend,
  withUsageSlotSpend,
} from "./usageSlotBudget.ts";

const budget = {
  monthlyBudgetUsd: 20,
  resetDayOfMonth: 31,
  cycleSpendUsd: 5,
};

describe("usage slot budget windows", () => {
  it.effect(
    "reports spend on pay-as-you-go slots only, and a budget window on any budgeted slot",
    () =>
      Effect.sync(() => {
        const nowMs = Date.parse("2026-11-20T12:00:00.000Z");
        const buckets = [{ provider: "pi", accountKey: "key", day: "2026-11-12", costUsd: 6 }];
        const slot = (metered: boolean) => ({
          accountKey: "key",
          label: "key",
          ...(metered ? { metered: true } : {}),
          usageLimits: { checkedAt: "2026-11-20T11:00:00.000Z", windows: [] },
        });
        const spend = (metered: boolean, withBudget: boolean) =>
          withUsageSlotSpend(slot(metered), {
            budget: withBudget ? { ...budget, resetDayOfMonth: 1 } : undefined,
            nowMs,
            buckets,
            readAt: "2026-11-20T12:00:00.000Z",
          });
        expect(spend(true, false).spentUsd).toBe(6);
        expect(spend(true, true)).toMatchObject({
          spentUsd: 6,
          usageLimits: { windows: [{ id: "budget", usedUsd: 6, limitUsd: 20 }] },
        });
        expect(spend(false, true).spentUsd).toBeUndefined();
        expect(spend(false, true).usageLimits.windows).toMatchObject([
          { id: "budget", usedUsd: 6 },
        ]);
        expect(spend(false, false)).toEqual(slot(false));
      }),
  );

  it.effect(
    "counts a metered account's own spend from the 1st without a budget, else from its cycle",
    () =>
      Effect.sync(() => {
        const buckets = [
          { provider: "pi", accountKey: "openai", day: "2026-10-31", costUsd: 4 },
          { provider: "pi", accountKey: "openai", day: "2026-11-01", costUsd: 1.5 },
          { provider: "pi", accountKey: "openai", day: "2026-11-12", costUsd: 2 },
          { provider: "pi", accountKey: "anthropic", day: "2026-11-12", costUsd: 9 },
          { provider: "codex", accountKey: "openai", day: "2026-11-12", costUsd: 7 },
        ];
        const nowMs = Date.parse("2026-11-20T12:00:00.000Z");
        expect(
          usageSlotSpend({ budget: undefined, nowMs, accountKey: "openai", buckets }).cycleUsd,
        ).toBe(3.5);
        expect(
          usageSlotSpend({
            budget: { ...budget, resetDayOfMonth: 10 },
            nowMs,
            accountKey: "openai",
            buckets,
          }).cycleUsd,
        ).toBe(2);
      }),
  );

  it.effect("clamps reset days to short months", () =>
    Effect.sync(() => {
      const bounds = usageCycleBounds(Date.parse("2026-02-28T12:00:00.000Z"), 31);
      expect(new Date(bounds.startMs).toISOString()).toBe("2026-02-28T00:00:00.000Z");
      expect(new Date(bounds.nextResetMs).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    }),
  );

  it.effect("uses local cycle spend until a correction and adds only spend after it", () =>
    Effect.sync(() => {
      const nowMs = Date.parse("2026-11-15T12:00:00.000Z");
      expect(
        makeUsageSlotBudgetWindow({
          budget,
          nowMs,
          spend: { cycleUsd: 8, sinceCorrectionUsd: 100 },
        }).usedUsd,
      ).toBe(8);

      expect(
        makeUsageSlotBudgetWindow({
          budget: { ...budget, correctedAt: "2026-11-10T09:00:00.000Z" },
          nowMs,
          spend: { cycleUsd: 8, sinceCorrectionUsd: 2 },
        }),
      ).toMatchObject({ usedUsd: 7, usedPercent: 35 });

      expect(
        makeUsageSlotBudgetWindow({
          budget: { ...budget, correctedAt: "2026-10-01T00:00:00.000Z" },
          nowMs,
          spend: { cycleUsd: 8, sinceCorrectionUsd: 100 },
        }).usedUsd,
      ).toBe(8);
    }),
  );

  it.effect(
    "keeps a plain budget edit at the same spend and re-anchors an explicit same-value correction",
    () =>
      Effect.sync(() => {
        const nowMs = Date.parse("2026-11-15T12:00:00.000Z");
        const previouslyCorrected = {
          ...budget,
          cycleSpendUsd: 100,
          correctedAt: "2026-11-10T09:00:00.000Z",
        };
        const before = makeUsageSlotBudgetWindow({
          budget: previouslyCorrected,
          nowMs,
          spend: { cycleUsd: 30, sinceCorrectionUsd: 10 },
        });
        const budgetOnlyEdit = makeUsageSlotBudgetWindow({
          budget: { ...previouslyCorrected, monthlyBudgetUsd: 200 },
          nowMs,
          spend: { cycleUsd: 30, sinceCorrectionUsd: 10 },
        });
        expect(before.usedUsd).toBe(110);
        expect(budgetOnlyEdit.usedUsd).toBe(110);

        const correction = makeUsageSlotBudgetWindow({
          budget: {
            ...previouslyCorrected,
            cycleSpendUsd: 110,
            correctedAt: "2026-11-15T11:00:00.000Z",
          },
          nowMs,
          spend: { cycleUsd: 30, sinceCorrectionUsd: 0 },
        });
        expect(correction.usedUsd).toBe(110);
      }),
  );
});
