import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("deriveProviderInstanceConfigMap", () => {
  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });
});

describe("deriveProviderInstanceConfigMap — account pools", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const poolId = ProviderInstanceId.make("claude_pool");
  const workId = ProviderInstanceId.make("claude_work");
  const personalId = ProviderInstanceId.make("claude_personal");

  it("gives a member the shared settings of the pool it belongs to", () => {
    const settings = settingsWith({
      providerInstances: {
        [poolId]: {
          driver: claude,
          pool: [workId, personalId],
          config: {
            launchArgs: "--chrome",
            autoCompactWindow: "300000",
            idleCompaction: "beforeCacheExpires",
            compactModel: "claude-sonnet-5-5",
            compactOnlyWhenCold: false,
          },
        },
        [workId]: { driver: claude, config: { binaryPath: "/opt/claude" } },
        [personalId]: { driver: claude },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[workId]?.config).toEqual({
      launchArgs: "--chrome",
      autoCompactWindow: "300000",
      idleCompaction: "beforeCacheExpires",
      compactModel: "claude-sonnet-5-5",
      compactOnlyWhenCold: false,
      binaryPath: "/opt/claude",
    });
    expect(merged[personalId]?.config).toEqual({
      launchArgs: "--chrome",
      autoCompactWindow: "300000",
      idleCompaction: "beforeCacheExpires",
      compactModel: "claude-sonnet-5-5",
      compactOnlyWhenCold: false,
    });
  });

  it("keeps a member's own value over the pool's", () => {
    const settings = settingsWith({
      providerInstances: {
        [poolId]: {
          driver: claude,
          pool: [workId],
          config: { autoCompactWindow: "300000", compactModel: "claude-sonnet-5-5" },
        },
        [workId]: { driver: claude, config: { autoCompactWindow: "500000" } },
      },
    });

    expect(deriveProviderInstanceConfigMap(settings)[workId]?.config).toEqual({
      autoCompactWindow: "500000",
      compactModel: "claude-sonnet-5-5",
    });
  });

  it("never shares a pool's binaryPath, homePath, customModels or enabled", () => {
    const settings = settingsWith({
      providerInstances: {
        [poolId]: {
          driver: claude,
          pool: [workId],
          config: {
            binaryPath: "/opt/claude",
            homePath: "/tmp/pool-home",
            customModels: [{ slug: "pool-model", name: "Pool model" }],
            enabled: false,
            idleCompaction: "beforeCacheExpires",
          },
        },
        [workId]: { driver: claude },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[workId]?.config).toEqual({ idleCompaction: "beforeCacheExpires" });
  });

  it("leaves members untouched when the pool carries no config", () => {
    const settings = settingsWith({
      providerInstances: {
        [poolId]: { driver: claude, pool: [workId, personalId] },
        [workId]: {
          driver: claude,
          config: {
            autoCompactWindow: "300000",
            idleCompaction: "beforeCacheExpires",
            compactModel: "claude-sonnet-5-5",
          },
        },
        [personalId]: {
          driver: claude,
          config: {
            autoCompactWindow: "300000",
            idleCompaction: "beforeCacheExpires",
            compactModel: "claude-sonnet-5-5",
          },
        },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[workId]).toBe(settings.providerInstances[workId]);
    expect(merged[personalId]).toBe(settings.providerInstances[personalId]);
  });

  it("resolves a default instance that a pool lists but settings never stored", () => {
    const settings = settingsWith({
      providerInstances: {
        [poolId]: {
          driver: claude,
          pool: [ProviderInstanceId.make("claudeAgent")],
          config: { compactModel: "claude-sonnet-5-5" },
        },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[ProviderInstanceId.make("claudeAgent")]).toEqual({
      driver: claude,
      config: { compactModel: "claude-sonnet-5-5" },
    });
  });

  it("leaves the pool's own entry as stored", () => {
    const pool = {
      driver: claude,
      pool: [workId],
      config: { autoCompactWindow: "300000" },
    };
    const settings = settingsWith({
      providerInstances: {
        [poolId]: pool,
        [workId]: { driver: claude },
      },
    });

    expect(deriveProviderInstanceConfigMap(settings)[poolId]).toBe(pool);
  });
});
