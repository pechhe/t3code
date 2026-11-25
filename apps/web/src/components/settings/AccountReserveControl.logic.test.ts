import {
  AuthProvidersManageScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  requiredScopesForServerSettingsPatch,
  type AccountId,
  type AccountReserve,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { accountReserveIsMixed } from "./accountScope";
import { planScopedSettingsPatch, type ScopedSettingsTarget } from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const A = "acct-a" as AccountId;
const B = "acct-b" as AccountId;
const reserve: AccountReserve = { percent: 10, allowedModels: [] };

const target = (id: string, accountReserves?: ServerSettings["accountReserves"]) =>
  ({
    environmentId: EnvironmentId.make(id),
    label: id,
    projectId: null,
    settings: { ...DEFAULT_SERVER_SETTINGS, accountReserves },
    sources: {},
  }) as unknown as ScopedSettingsTarget;

describe("accountReserveIsMixed", () => {
  it("is false for one target or matching targets", () => {
    expect(accountReserveIsMixed([target("e1", { [A]: reserve })], A)).toBe(false);
    expect(
      accountReserveIsMixed([target("e1", { [A]: reserve }), target("e2", { [A]: reserve })], A),
    ).toBe(false);
  });

  it("is true when one target differs on that account only", () => {
    const targets = [target("e1", { [A]: reserve }), target("e2")];
    expect(accountReserveIsMixed(targets, A)).toBe(true);
    expect(accountReserveIsMixed(targets, B)).toBe(false);
  });
});

describe("account settings across environments", () => {
  const environments = ["e1", "e2", "e3"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: id === "e3" ? ("offline" as const) : ("connected" as const) },
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  }));
  const all = resolveSettingsScope({}, [], environments);

  it("writes every account key to each connected environment and skips offline ones", () => {
    const patches: ServerSettingsPatch[] = [
      { accountReserves: { [A]: reserve } },
      { modelRouting: {} },
      { pooledModelKeys: [] },
      { modelLinks: {} },
      { usageSlotBudgets: { slot: null } },
    ];
    for (const patch of patches) {
      const plan = planScopedSettingsPatch(all, environments, patch);
      expect(plan.serverWrites.map((write) => write.environmentId)).toEqual(["e1", "e2"]);
      expect(requiredScopesForServerSettingsPatch(patch)).toContain(AuthProvidersManageScope);
    }
  });
});
