import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  needsUsageRefresh,
  pickPoolFailoverMember,
  pickPoolMember,
  pickRolloverMember,
  withPoolSnapshots,
  type ProviderPool,
} from "./providerPools.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const claude = ProviderDriverKind.make("claudeAgent");

const account = (
  id: string,
  windows: ReadonlyArray<
    Pick<ServerProviderUsageWindow, "usedPercent" | "resetsAt"> &
      Partial<Pick<ServerProviderUsageWindow, "kind" | "windowDurationMins">>
  >,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: claude,
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at(0),
  models: [{ slug: `model-of-${id}`, name: id, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  runtimePaths: { homePath: `/accounts/${id}`, shadowHomePath: null },
  usageLimits: {
    checkedAt: at(0),
    windows: windows.map((window, index) => ({
      id: `window-${index}`,
      kind: "session",
      label: "Session",
      ...window,
    })),
  },
  ...overrides,
});

const pool: ProviderPool = {
  instanceId: ProviderInstanceId.make("claude_pool"),
  driver: claude,
  displayName: "Claude (pooled)",
  enabled: true,
  members: [
    ProviderInstanceId.make("a"),
    ProviderInstanceId.make("b"),
    ProviderInstanceId.make("c"),
  ],
};

describe("needsUsageRefresh", () => {
  const read = (
    checkedAtHours: number,
    usedPercent: number,
    resetsAt: string | undefined = at(2),
  ) =>
    ({
      ...account("a", [{ usedPercent, resetsAt }]),
      usageLimits: {
        checkedAt: at(checkedAtHours),
        windows: [{ id: "w", kind: "session", label: "Session", usedPercent, resetsAt }],
      },
    }) as ServerProvider;
  const SECOND = 1 / 3600;

  it("refreshes a stale reading at or above 95%", () => {
    expect(needsUsageRefresh(read(0, 95), NOW + 2 * 60_000)).toBe(true);
    expect(needsUsageRefresh(read(0, 100), NOW + 2 * 60_000)).toBe(true);
  });

  it("leaves a stale reading below 95% alone", () => {
    expect(needsUsageRefresh(read(0, 94), NOW + 2 * 60_000)).toBe(false);
  });

  it("leaves a fresh reading alone", () => {
    expect(needsUsageRefresh(read(-30 * SECOND, 99), NOW)).toBe(false);
    expect(needsUsageRefresh(read(-60 * SECOND, 99), NOW)).toBe(true);
  });

  it("ignores a near-limit window whose reset has passed", () => {
    expect(needsUsageRefresh(read(-1, 99, at(-0.5)), NOW)).toBe(false);
  });

  it("has nothing to refresh without a reading", () => {
    const { usageLimits: _usageLimits, ...bare } = account("a", []);
    expect(needsUsageRefresh(bare, NOW)).toBe(false);
  });
});

describe("pickPoolMember", () => {
  it("picks the member with allowance whose usage resets soonest", () => {
    const providers = [
      account("a", [{ usedPercent: 40, resetsAt: at(4) }]),
      account("b", [{ usedPercent: 100, resetsAt: at(1) }]),
      account("c", [{ usedPercent: 90, resetsAt: at(2) }]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("c");
  });

  it("spends the account whose weekly allowance lapses soonest first", () => {
    const providers = [
      account("a", [
        { kind: "session", usedPercent: 20, resetsAt: at(1) },
        { kind: "weekly", usedPercent: 30, resetsAt: at(120) },
      ]),
      account("b", [
        { kind: "session", usedPercent: 20, resetsAt: at(4) },
        { kind: "weekly", usedPercent: 60, resetsAt: at(6) },
      ]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
  });

  it("among accounts behind their weekly pace, spends the soonest session reset first", () => {
    const week = 7 * 24 * 60;
    const providers = [
      account("a", [
        { kind: "session", usedPercent: 10, resetsAt: at(4) },
        { kind: "weekly", usedPercent: 10, resetsAt: at(12), windowDurationMins: week },
      ]),
      account("b", [
        { kind: "session", usedPercent: 10, resetsAt: at(0.5) },
        { kind: "weekly", usedPercent: 10, resetsAt: at(24), windowDurationMins: week },
      ]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
  });

  it("spends an account behind its weekly pace before one that will run out anyway", () => {
    const week = 7 * 24 * 60;
    const providers = [
      account("a", [
        { kind: "session", usedPercent: 10, resetsAt: at(0.5) },
        { kind: "weekly", usedPercent: 95, resetsAt: at(12), windowDurationMins: week },
      ]),
      account("b", [
        { kind: "session", usedPercent: 10, resetsAt: at(3) },
        { kind: "weekly", usedPercent: 30, resetsAt: at(100), windowDurationMins: week },
      ]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
  });

  it("skips members that cannot take a turn and accounts outside the pool", () => {
    const providers = [
      account("a", [{ usedPercent: 10, resetsAt: at(5) }]),
      account("b", [{ usedPercent: 10, resetsAt: at(1) }], {
        auth: { status: "unauthenticated" },
      }),
      account("c", [{ usedPercent: 10, resetsAt: at(2) }], { enabled: false }),
      account("outsider", [{ usedPercent: 0, resetsAt: at(0.5) }]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("a");
  });

  it("keeps the thread's member while it has allowance, then moves on", () => {
    const later = account("a", [{ usedPercent: 50, resetsAt: at(4) }]);
    const sooner = account("b", [{ usedPercent: 50, resetsAt: at(1) }]);
    const current = ProviderInstanceId.make("a");
    expect(pickPoolMember({ pool, providers: [later, sooner], nowMs: NOW, current })).toBe("a");
    const exhausted = account("a", [{ usedPercent: 100, resetsAt: at(4) }]);
    expect(pickPoolMember({ pool, providers: [exhausted, sooner], nowMs: NOW, current })).toBe("b");
  });

  it("treats a limit whose reset has passed as allowance", () => {
    const providers = [
      account("a", [{ usedPercent: 100, resetsAt: at(-1) }]),
      account("b", [{ usedPercent: 0, resetsAt: at(3) }]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
    expect(
      pickPoolMember({ pool, providers, nowMs: NOW, current: ProviderInstanceId.make("a") }),
    ).toBe("a");
  });

  it("falls back to the soonest reset when every member is at a limit", () => {
    const providers = [
      account("a", [{ usedPercent: 100, resetsAt: at(3) }]),
      account("b", [{ usedPercent: 100, resetsAt: at(2) }]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
    expect(pickPoolMember({ pool, providers: [], nowMs: NOW })).toBeUndefined();
  });

  it("when every member is at a limit, picks the one usable again soonest", () => {
    const providers = [
      account("a", [
        { kind: "session", usedPercent: 100, resetsAt: at(4) },
        { kind: "weekly", usedPercent: 50, resetsAt: at(6) },
      ]),
      account("b", [
        { kind: "session", usedPercent: 100, resetsAt: at(1) },
        { kind: "weekly", usedPercent: 50, resetsAt: at(120) },
      ]),
      account("c", [
        { kind: "session", usedPercent: 100, resetsAt: at(0.5) },
        { kind: "weekly", usedPercent: 100, resetsAt: at(48) },
      ]),
    ];
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("b");
  });
});

describe("pickPoolFailoverMember", () => {
  const limited = ProviderInstanceId.make("a");

  it("moves to the other member whose weekly allowance lapses soonest", () => {
    const providers = [
      account("a", [{ kind: "weekly", usedPercent: 100, resetsAt: at(1) }]),
      account("b", [
        { kind: "session", usedPercent: 10, resetsAt: at(1) },
        { kind: "weekly", usedPercent: 10, resetsAt: at(90) },
      ]),
      account("c", [
        { kind: "session", usedPercent: 10, resetsAt: at(4) },
        { kind: "weekly", usedPercent: 80, resetsAt: at(3) },
      ]),
    ];
    expect(pickPoolFailoverMember({ pool, providers, nowMs: NOW, limited })).toBe("c");
  });

  it("moves to the other member with allowance whose usage resets soonest", () => {
    const providers = [
      account("a", [{ usedPercent: 100, resetsAt: at(1) }]),
      account("b", [{ usedPercent: 40, resetsAt: at(4) }]),
      account("c", [{ usedPercent: 40, resetsAt: at(2) }]),
    ];
    expect(pickPoolFailoverMember({ pool, providers, nowMs: NOW, limited })).toBe("c");
  });

  it("leaves the limited member even when its snapshot still shows allowance", () => {
    const providers = [
      account("a", [{ usedPercent: 10, resetsAt: at(1) }]),
      account("b", [{ usedPercent: 90, resetsAt: at(4) }]),
    ];
    expect(pickPoolFailoverMember({ pool, providers, nowMs: NOW, limited })).toBe("b");
  });

  it("returns nothing when every other member is at a limit or cannot take a turn", () => {
    const providers = [
      account("a", [{ usedPercent: 100, resetsAt: at(1) }]),
      account("b", [{ usedPercent: 100, resetsAt: at(2) }]),
      account("c", [{ usedPercent: 0, resetsAt: at(3) }], { auth: { status: "unauthenticated" } }),
    ];
    expect(pickPoolFailoverMember({ pool, providers, nowMs: NOW, limited })).toBeUndefined();
  });
});

describe("preferred member", () => {
  const preferB: ProviderPool = { ...pool, preferredMember: ProviderInstanceId.make("b") };
  const providers = [
    account("a", [{ usedPercent: 10, resetsAt: at(1) }]),
    account("b", [{ usedPercent: 10, resetsAt: at(4) }]),
    account("c", [{ usedPercent: 10, resetsAt: at(3) }]),
  ];

  it("takes new threads ahead of the spend order", () => {
    expect(pickPoolMember({ pool, providers, nowMs: NOW })).toBe("a");
    expect(pickPoolMember({ pool: preferB, providers, nowMs: NOW })).toBe("b");
  });

  it("leaves a thread on its current member while it has allowance", () => {
    expect(
      pickPoolMember({
        pool: preferB,
        providers,
        nowMs: NOW,
        current: ProviderInstanceId.make("c"),
      }),
    ).toBe("c");
  });

  it("falls back to the spend order once the preferred member is at a limit", () => {
    const limited = [providers[0]!, account("b", [{ usedPercent: 100, resetsAt: at(2) }])];
    expect(pickPoolMember({ pool: preferB, providers: limited, nowMs: NOW })).toBe("a");
  });

  it("is where a limited thread fails over to", () => {
    expect(
      pickPoolFailoverMember({
        pool: preferB,
        providers,
        nowMs: NOW,
        limited: ProviderInstanceId.make("c"),
      }),
    ).toBe("b");
  });

  it("is where a rolled-over session moves to", () => {
    const snapshots = withPoolSnapshots(providers, [preferB], NOW);
    expect(snapshots.at(-1)?.poolPreferredMember).toBe("b");
    expect(
      pickRolloverMember({
        providers: snapshots,
        nowMs: NOW,
        member: ProviderInstanceId.make("c"),
      }),
    ).toBe("b");
    expect(
      pickRolloverMember({
        providers: snapshots,
        nowMs: NOW,
        member: ProviderInstanceId.make("outsider"),
      }),
    ).toBe("outsider");
  });

  it("keeps the thread's member when the pool has no usable preference", () => {
    const providers = [
      account("a", [{ usedPercent: 10, resetsAt: at(4) }]),
      account("b", [{ usedPercent: 10, resetsAt: at(1) }]),
      account("c", [{ usedPercent: 10, resetsAt: at(2) }]),
    ];
    const member = ProviderInstanceId.make("a");
    const auto = withPoolSnapshots(providers, [pool], NOW);
    expect(pickRolloverMember({ providers: auto, nowMs: NOW, member })).toBe("a");
    const exhausted = withPoolSnapshots(
      [account("a", []), account("b", [{ usedPercent: 100, resetsAt: at(1) }]), account("c", [])],
      [preferB],
      NOW,
    );
    expect(pickRolloverMember({ providers: exhausted, nowMs: NOW, member })).toBe("a");
  });
});

describe("withPoolSnapshots", () => {
  it("presents a pool as the member a turn would use, without account details", () => {
    const providers = [
      account("a", [{ usedPercent: 10, resetsAt: at(4) }]),
      account("b", [{ usedPercent: 10, resetsAt: at(1) }]),
    ];
    const snapshots = withPoolSnapshots(providers, [pool], NOW);
    expect(snapshots.slice(0, 2)).toEqual(providers);
    const pooled = snapshots[2];
    expect(pooled).toMatchObject({
      instanceId: "claude_pool",
      driver: "claudeAgent",
      displayName: "Claude (pooled)",
      enabled: true,
      poolMembers: ["a", "b", "c"],
      models: providers[1]?.models,
    });
    expect(pooled?.usageLimits).toBeUndefined();
    expect(pooled?.runtimePaths).toBeUndefined();
  });

  it("omits a pool none of whose members exist", () => {
    const providers = [account("outsider", [])];
    expect(withPoolSnapshots(providers, [pool], NOW)).toEqual(providers);
  });
});
