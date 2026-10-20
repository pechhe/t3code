import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { poolSwitchOnLimitOf, withPoolPolicy } from "./PoolAccountsSection.logic";

const id = ProviderInstanceId.make;
const pool: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("claudeAgent"),
  pool: [id("a"), id("b")],
};

describe("withPoolPolicy", () => {
  it("stores only what differs from the defaults", () => {
    const ordered = withPoolPolicy(pool, { strategy: "order", reservePercent: 90 });
    expect(ordered.poolPolicy).toEqual({ strategy: "order", reservePercent: 90 });
    expect(withPoolPolicy(ordered, { strategy: "spend" }).poolPolicy).toEqual({
      reservePercent: 90,
    });
  });

  it("drops the policy once every field is back at its default", () => {
    const set = withPoolPolicy(pool, {
      strategy: "order",
      disabledMembers: [id("b")],
      switchOnLimit: "never",
    });
    expect(set.poolPolicy).toEqual({
      strategy: "order",
      disabledMembers: [id("b")],
      switchOnLimit: false,
    });
    const reset = withPoolPolicy(set, {
      strategy: "spend",
      disabledMembers: [],
      switchOnLimit: "global",
    });
    expect(reset).toEqual(pool);
  });

  it("round-trips the switch-on-limit override", () => {
    const always = withPoolPolicy(pool, { switchOnLimit: "always" });
    expect(poolSwitchOnLimitOf(always.poolPolicy)).toBe("always");
    expect(poolSwitchOnLimitOf(withPoolPolicy(always, { switchOnLimit: "never" }).poolPolicy)).toBe(
      "never",
    );
    expect(poolSwitchOnLimitOf(undefined)).toBe("global");
  });

  it("keeps the other instance fields", () => {
    const named = { ...pool, displayName: "Pool", preferredMember: id("b") };
    expect(withPoolPolicy(named, { reservePercent: 80 })).toMatchObject({
      displayName: "Pool",
      preferredMember: "b",
      pool: ["a", "b"],
    });
  });
});
