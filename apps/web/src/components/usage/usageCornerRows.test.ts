import { ProviderDriverKind } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { usageCornerRows } from "./usageCornerRows";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const session = (usedPercent: number, resetsAt = "2026-09-03T14:00:00.000Z") =>
  ({
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    windowDurationMins: 300,
    resetsAt,
  }) as const;

const weekly = (usedPercent: number, resetsAt = "2026-09-04T02:00:00.000Z", id = "seven_day") =>
  ({
    id,
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    windowDurationMins: 7 * 24 * 60,
    resetsAt,
  }) as const;

const account = (
  key: string,
  windows: LimitAccount["limits"]["windows"],
  driver = "claudeAgent",
): LimitAccount => ({
  key,
  driver: ProviderDriverKind.make(driver),
  displayName: key,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
});

const rows = (accounts: LimitAccount[]) => usageCornerRows(collectLimitPools(accounts, now), now);

describe("usageCornerRows", () => {
  it("adds each account's tightest window, so two accounts reach 200%", () => {
    const [claude] = rows([
      account("yardsmith", [session(5), weekly(68)]),
      account("hfpetch", [session(0), weekly(0)]),
    ]);
    expect(claude?.remainingPercent).toBe(132);
    expect(claude?.accounts.map(({ name, remainingPercent }) => [name, remainingPercent])).toEqual(
      expect.arrayContaining([
        ["yardsmith", 32],
        ["hfpetch", 100],
      ]),
    );
  });

  it("leaves model-only weekly buckets to the Usage page", () => {
    const [claude] = rows([account("a", [weekly(20), weekly(100, undefined, "seven_day_fable")])]);
    expect(claude?.remainingPercent).toBe(80);
  });

  it("is out once every account is spent, back when the soonest account's windows have all reset", () => {
    const [claude] = rows([
      account("a", [session(100, "2026-09-03T13:00:00.000Z"), weekly(100)]),
      account("b", [session(100, "2026-09-03T15:00:00.000Z"), weekly(40)]),
    ]);
    expect(claude).toMatchObject({
      remainingPercent: 0,
      backAt: Date.parse("2026-09-03T15:00:00.000Z"),
    });
  });

  it("warns when spending outruns the time left before reset", () => {
    // 40% of the five hours is gone; 90% of the allowance is gone.
    const [fast] = rows([account("a", [session(90)])]);
    const [steady] = rows([account("a", [session(40)])]);
    expect(fast?.ahead).toBe(true);
    expect(steady?.ahead).toBe(false);
  });

  it("counts an Antigravity account by its model family with most left, not a spent family", () => {
    const bucket = (id: string, kind: "session" | "weekly", usedPercent: number) => ({
      id,
      kind,
      label: id,
      usedPercent,
      windowDurationMins: kind === "session" ? 300 : 7 * 24 * 60,
      resetsAt: "2026-09-04T02:00:00.000Z",
    });
    const [usable] = rows([
      account(
        "g",
        [
          bucket("gemini-weekly", "weekly", 4),
          bucket("gemini-5h", "session", 9),
          bucket("3p-weekly", "weekly", 100),
          bucket("3p-5h", "session", 56),
        ],
        "antigravity",
      ),
    ]);
    expect(usable).toMatchObject({ remainingPercent: 91, backAt: null });
    const [spent] = rows([
      account(
        "g",
        [bucket("gemini-weekly", "weekly", 100), bucket("3p-weekly", "weekly", 100)],
        "antigravity",
      ),
    ]);
    expect(spent).toMatchObject({
      remainingPercent: 0,
      backAt: Date.parse("2026-09-04T02:00:00.000Z"),
    });
  });

  it("gives each provider its own row", () => {
    const result = rows([account("c", [weekly(30)], "codex"), account("a", [session(10)])]);
    expect(result.map((row) => [row.pool.driver, row.remainingPercent])).toEqual(
      expect.arrayContaining([
        ["codex", 70],
        ["claudeAgent", 90],
      ]),
    );
  });
});
