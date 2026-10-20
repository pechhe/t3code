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
  pickPoolSwitchMember,
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
});

describe("pool policy", () => {
  const id = ProviderInstanceId.make;
  const providers = [
    account("a", [{ usedPercent: 10, resetsAt: at(1) }]),
    account("b", [{ usedPercent: 10, resetsAt: at(4) }]),
    account("c", [{ usedPercent: 10, resetsAt: at(3) }]),
  ];
  const withPolicy = (policy: NonNullable<ProviderPool["policy"]>): ProviderPool => ({
    ...pool,
    members: [id("c"), id("b"), id("a")],
    policy,
  });

  it("order strategy takes the first member in the pool's list with allowance", () => {
    const ordered = withPolicy({ strategy: "order" });
    expect(pickPoolMember({ pool: ordered, providers, nowMs: NOW })).toBe("c");
    const cOut = [
      providers[0]!,
      providers[1]!,
      account("c", [{ usedPercent: 100, resetsAt: at(2) }]),
    ];
    expect(pickPoolMember({ pool: ordered, providers: cOut, nowMs: NOW })).toBe("b");
    expect(
      pickPoolFailoverMember({ pool: ordered, providers: cOut, nowMs: NOW, limited: id("b") }),
    ).toBe("a");
  });

  it("a preferred member still takes precedence over the order", () => {
    const pinned = { ...withPolicy({ strategy: "order" }), preferredMember: id("a") };
    expect(pickPoolMember({ pool: pinned, providers, nowMs: NOW })).toBe("a");
  });

  it("never routes to a disabled member, even as the only one left", () => {
    const disabled = withPolicy({ disabledMembers: [id("a"), id("c")] });
    expect(pickPoolMember({ pool: disabled, providers, nowMs: NOW })).toBe("b");
    expect(
      pickPoolFailoverMember({ pool: disabled, providers, nowMs: NOW, limited: id("b") }),
    ).toBeUndefined();
  });

  it("a reserve counts a member as out before its real limit, but keeps a running thread", () => {
    const reserve = withPolicy({ strategy: "order", reservePercent: 90 });
    const nearLimit = [
      providers[0]!,
      providers[1]!,
      account("c", [{ usedPercent: 92, resetsAt: at(2) }]),
    ];
    expect(pickPoolMember({ pool: reserve, providers: nearLimit, nowMs: NOW })).toBe("b");
    expect(
      pickPoolMember({ pool: reserve, providers: nearLimit, nowMs: NOW, current: id("c") }),
    ).toBe("c");
    expect(
      pickPoolFailoverMember({ pool: reserve, providers: nearLimit, nowMs: NOW, limited: id("b") }),
    ).toBe("a");
  });

  it("passes the policy on to the pool's snapshot", () => {
    const policy = { strategy: "order", reservePercent: 90 } as const;
    const snapshot = withPoolSnapshots(providers, [withPolicy(policy)], NOW).at(-1);
    expect(snapshot?.poolPolicy).toEqual(policy);
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

describe("pickPoolSwitchMember", () => {
  const id = ProviderInstanceId.make;
  const fresh = (name: string) => account(name, [{ usedPercent: 10, resetsAt: at(2) }]);
  const out = (name: string) => account(name, [{ usedPercent: 100, resetsAt: at(2) }]);
  const switchFrom = (
    current: string,
    providers: ReadonlyArray<ServerProvider>,
    policy?: ProviderPool["policy"],
  ) =>
    pickPoolSwitchMember({
      pool: { ...pool, ...(policy === undefined ? {} : { policy }) },
      providers,
      nowMs: NOW,
      current: id(current),
    });

  it("moves to the next member in the pool's order and wraps around", () => {
    const all = [fresh("a"), fresh("b"), fresh("c")];
    expect(switchFrom("a", all)).toBe("b");
    expect(switchFrom("b", all)).toBe("c");
    expect(switchFrom("c", all)).toBe("a");
  });

  it("skips members without allowance and members switched off", () => {
    expect(switchFrom("a", [fresh("a"), out("b"), fresh("c")])).toBe("c");
    expect(
      switchFrom("a", [fresh("a"), fresh("b"), fresh("c")], { disabledMembers: [id("b")] }),
    ).toBe("c");
  });

  it("skips members past the reserve threshold", () => {
    const used = (name: string) => account(name, [{ usedPercent: 85, resetsAt: at(2) }]);
    expect(switchFrom("a", [fresh("a"), used("b"), fresh("c")], { reservePercent: 80 })).toBe("c");
  });

  it("offers nothing when no other member can take a turn", () => {
    expect(switchFrom("a", [fresh("a"), out("b"), out("c")])).toBeUndefined();
  });
});
