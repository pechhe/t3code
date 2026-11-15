import { describe, expect, it } from "vite-plus/test";

import type { ServerProvider } from "@t3tools/contracts";
import { isSlotCooled } from "./UsageSlotClearCooldown";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

const providerWithReset = (resetsAt: string): ServerProvider =>
  ({
    instanceId: "codex",
    usageSlots: [
      {
        accountKey: "account",
        label: "Account",
        usageLimits: {
          checkedAt: "2026-11-15T11:00:00.000Z",
          windows: [
            {
              id: "t3-usage-limit",
              kind: "other",
              label: "Usage limit reached",
              usedPercent: 100,
              resetsAt,
            },
          ],
        },
      },
    ],
  }) as unknown as ServerProvider;

describe("isSlotCooled", () => {
  it("recognizes an active cooldown", () => {
    expect(isSlotCooled(providerWithReset("2026-11-15T13:00:00.000Z"), "account", NOW)).toBe(true);
  });

  it("ignores an expired cooldown", () => {
    expect(isSlotCooled(providerWithReset("2026-11-15T11:00:00.000Z"), "account", NOW)).toBe(false);
  });

  it("returns false when the account was never cooled", () => {
    expect(isSlotCooled(undefined, "account", NOW)).toBe(false);
    expect(isSlotCooled(providerWithReset("2026-11-15T13:00:00.000Z"), "other", NOW)).toBe(false);
  });
});
