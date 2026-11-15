import { describe, expect, it } from "@effect/vitest";
import type { SubagentConservationRule } from "@t3tools/contracts";
import { codex } from "../agents/agentPolicy.testkit.ts";
import { conservationNeedsRefresh, evaluateConservation } from "./subagentConservation.ts";

const now = Date.parse("2026-11-12T10:00:00Z");
const rule: SubagentConservationRule = {
  enabled: true,
  remainingPercent: 20,
  window: "any",
  windowIds: ["session", "weekly"],
  models: ["astra"],
};
const account = (used: number, weekly: number | undefined = 30) => ({
  ...codex,
  usageLimits: {
    credentialFingerprint: "account-one",
    checkedAt: "2026-11-12T10:00:00Z",
    windows: [
      {
        id: "session",
        label: "Session",
        kind: "session" as const,
        usedPercent: used,
        resetsAt: "2026-11-12T11:00:00Z",
      },
      ...(weekly === undefined
        ? []
        : [{ id: "weekly", label: "Weekly", kind: "weekly" as const, usedPercent: weekly }]),
    ],
  },
});

describe("subscription conservation", () => {
  it("activates at the threshold in any window and recovers only from fresh usage", () => {
    for (const [used, weekly, expected] of [
      [79, 79, "ready"],
      [80, 10, "active"],
      [10, 80, "active"],
    ] as const)
      expect(evaluateConservation(account(used, weekly), rule, now).status.state).toBe(expected);
    const active = evaluateConservation(account(80), rule, now).memory;
    expect(evaluateConservation(account(1), rule, now + 60_000, active).status).toMatchObject({
      state: "active",
      unavailable: true,
    });
    expect(evaluateConservation(account(1), rule, now, active).status.state).toBe("ready");
    expect(
      evaluateConservation(account(10, 99), { ...rule, window: "session" }, now).status.state,
    ).toBe("ready");
  });
  it("handles missing windows, failed reads, reset expiry and first unknown readings", () => {
    const partial = account(80);
    partial.usageLimits.windows = partial.usageLimits.windows.slice(0, 1);
    expect(evaluateConservation(partial, rule, now).status).toMatchObject({
      state: "active",
      unavailable: true,
    });
    const ready = evaluateConservation(account(10), rule, now).memory;
    partial.usageLimits.windows[0]!.usedPercent = 10;
    expect(evaluateConservation(partial, rule, now).status.state).toBe("unknown");
    expect(evaluateConservation(partial, rule, now, ready).status).toMatchObject({
      state: "ready",
      unavailable: true,
    });
    const failed = {
      ...account(99),
      usageLimits: { ...account(99).usageLimits, unavailable: { reason: "probeFailed" as const } },
    };
    expect(evaluateConservation(failed, rule, now, ready).status.state).toBe("ready");
    const expired = account(1);
    expired.usageLimits.windows[0]!.resetsAt = "2026-11-12T10:00:00Z";
    expect(conservationNeedsRefresh(expired, rule, now)).toBe(true);
    expect(evaluateConservation(expired, rule, now).status.state).toBe("unknown");
    expect(conservationNeedsRefresh(account(10), rule, now + 59_999)).toBe(false);
    expect(conservationNeedsRefresh(account(10), rule, now + 60_000)).toBe(true);
  });
  it("reuses saved state only for the same identified account and rule", () => {
    const memory = JSON.parse(JSON.stringify(evaluateConservation(account(10), rule, now).memory));
    const stale = account(10);
    expect(evaluateConservation(stale, rule, now + 60_000, memory).status.state).toBe("ready");
    stale.usageLimits.credentialFingerprint = "account-two";
    expect(evaluateConservation(stale, rule, now + 60_000, memory).status.state).toBe("unknown");
    const unidentified = {
      ...stale,
      usageLimits: { ...stale.usageLimits, credentialFingerprint: undefined },
    };
    expect(evaluateConservation(unidentified, rule, now, memory).status.state).toBe("unknown");
    expect(
      evaluateConservation(account(10), { ...rule, remainingPercent: 30 }, now + 60_000, memory)
        .status.state,
    ).toBe("unknown");
  });
  it("invalidates both fresh readings and remembered states when the current credential differs", () => {
    for (const used of [10, 90]) {
      const provider = account(used);
      const memory = evaluateConservation(provider, rule, now).memory;
      for (const current of ["account-two", undefined]) {
        expect(evaluateConservation(provider, rule, now, memory, { current }).status.state).toBe(
          "unknown",
        );
        expect(
          evaluateConservation(provider, rule, now + 60_000, memory, { current }).status.state,
        ).toBe("unknown");
      }
      expect(
        evaluateConservation(provider, rule, now, memory, {
          current: provider.usageLimits.credentialFingerprint,
        }).status.state,
      ).toBe(used === 10 ? "ready" : "active");
    }
  });
  it("does not offer conservation for unverified model bindings even when usage has an account fingerprint", () => {
    const reason = "The serving credential cannot be verified.";
    const provider = { ...account(90), conservationScope: { providerIds: [], reason } };
    const result = evaluateConservation(provider, rule, now);
    expect(result.status).toMatchObject({
      state: "unknown",
      unavailable: true,
      models: [],
      message: reason,
    });
    expect(result.memory).toBeUndefined();
  });
});
