import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  poolForMember,
  requiredScopesForProjectMutation,
  resolveClaudeCompactionSetting,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceConfig,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  sharedProviderSettingKeys,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ServerSettings response streaming", () => {
  it("defaults to paragraph streaming", () => {
    expect(decodeServerSettings({}).responseStreamingMode).toBe("paragraph");
  });

  it.each(["turn", "paragraph", "live"])(
    "round-trips %s as an environment setting and project override",
    (responseStreamingMode) => {
      const input = {
        responseStreamingMode,
        projectSettingsOverrides: { project: { responseStreamingMode } },
      };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );
});

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("CodexSettings auto-compaction", () => {
  const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

  it("uses Codex's default threshold when no override is configured", () => {
    expect(decodeCodexSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "1000000"])("accepts a supported threshold: %s", (value) => {
    expect(decodeCodexSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
  });

  it.each(["99999", "1000001", "300k"])("rejects an unsupported threshold: %s", (value) => {
    expect(() => decodeCodexSettings({ autoCompactWindow: value })).toThrow();
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings window capture", () => {
  it("keeps a Space shortcut's key", () => {
    const optionSpace = {
      key: " ",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: false,
    };
    expect(decodeClientSettingsPatch({ snapShotShortcut: optionSpace })).toEqual({
      snapShotShortcut: optionSpace,
    });
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("pool shared settings", () => {
  const instanceId = ProviderInstanceId.make;
  const decodeInstances = (providerInstances: Record<string, unknown>) =>
    decodeServerSettings({ providerInstances }).providerInstances;
  const effectiveConfig = (instances: ReturnType<typeof decodeInstances>, id: string) =>
    decodeClaudeSettings(resolveProviderInstanceConfig(instances, instanceId(id))?.config ?? {});

  const poolConfig = {
    launchArgs: "--chrome",
    autoCompactWindow: "300000",
    idleCompaction: "beforeCacheExpires",
    compactModel: "claude-sonnet-5-5",
    compactOnlyWhenCold: false,
  } as const;

  it("shares exactly the fields the driver's schema marks, and none for other drivers", () => {
    expect(sharedProviderSettingKeys(ProviderDriverKind.make("claudeAgent"))).toEqual([
      "launchArgs",
      "autoCompactWindow",
      "idleCompaction",
      "compactModel",
      "compactModelInstanceId",
      "compactOnlyWhenCold",
    ]);
    expect(sharedProviderSettingKeys(ProviderDriverKind.make("codex"))).toEqual([]);
  });

  it("gives a member every shared field its pool sets", () => {
    const instances = decodeInstances({
      claude_pool: { driver: "claudeAgent", pool: ["claude_a"], config: poolConfig },
      claude_a: { driver: "claudeAgent" },
    });
    const config = effectiveConfig(instances, "claude_a");
    expect(config.launchArgs).toBe("--chrome");
    expect(config.autoCompactWindow).toBe("300000");
    expect(config.idleCompaction).toBe("beforeCacheExpires");
    expect(config.compactModel).toBe("claude-sonnet-5-5");
    expect(config.compactOnlyWhenCold).toBe(false);
  });

  it("keeps a member's own value, including empty and default ones", () => {
    const instances = decodeInstances({
      claude_pool: { driver: "claudeAgent", pool: ["claude_a"], config: poolConfig },
      claude_a: {
        driver: "claudeAgent",
        config: {
          launchArgs: "",
          autoCompactWindow: "",
          idleCompaction: "default",
          compactModel: "claude-opus-4-6",
          compactOnlyWhenCold: true,
        },
      },
    });
    const config = effectiveConfig(instances, "claude_a");
    expect(config.launchArgs).toBe("");
    expect(config.autoCompactWindow).toBe("");
    expect(config.idleCompaction).toBe("default");
    expect(config.compactModel).toBe("claude-opus-4-6");
    expect(config.compactOnlyWhenCold).toBe(true);
  });

  it("takes the pool's value again once a member stops storing its own", () => {
    const withOwn = decodeInstances({
      claude_pool: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: { compactModel: "claude-sonnet-5-5" },
      },
      claude_a: { driver: "claudeAgent", config: { compactModel: "claude-opus-4-6" } },
    });
    expect(effectiveConfig(withOwn, "claude_a").compactModel).toBe("claude-opus-4-6");

    const withoutOwn = decodeInstances({
      claude_pool: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: { compactModel: "claude-sonnet-5-5" },
      },
      claude_a: { driver: "claudeAgent", config: { launchArgs: "" } },
    });
    expect(effectiveConfig(withoutOwn, "claude_a").compactModel).toBe("claude-sonnet-5-5");
  });

  it("never shares an account's paths, models or enabled flag", () => {
    const instances = decodeInstances({
      claude_pool: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: {
          binaryPath: "/pool/claude",
          homePath: "/pool/home",
          customModels: ["pool-model"],
          enabled: false,
          autoCompactWindow: "300000",
        },
      },
      claude_a: { driver: "claudeAgent", config: { launchArgs: "--member" } },
    });
    expect(resolveProviderInstanceConfig(instances, instanceId("claude_a"))?.config).toEqual({
      autoCompactWindow: "300000",
      launchArgs: "--member",
    });
  });

  it("leaves an instance no pool owns alone, by reference", () => {
    const instances = decodeInstances({
      claude_alone: { driver: "claudeAgent", config: { launchArgs: "--mine" } },
      codex_pool: { driver: "codex", pool: ["claude_alone"], config: { launchArgs: "--codex" } },
    });
    const id = instanceId("claude_alone");
    expect(poolForMember(instances, id)).toBeUndefined();
    expect(resolveProviderInstanceConfig(instances, id)).toBe(instances[id]);
  });

  it("keeps a pool's own entry unchanged and never makes it a member", () => {
    const instances = decodeInstances({
      claude_pool: { driver: "claudeAgent", pool: ["claude_a"], config: poolConfig },
      claude_a: { driver: "claudeAgent" },
    });
    const id = instanceId("claude_pool");
    expect(poolForMember(instances, id)).toBeUndefined();
    expect(resolveProviderInstanceConfig(instances, id)).toBe(instances[id]);
  });

  it("returns nothing for an instance id that is not stored", () => {
    expect(
      resolveProviderInstanceConfig(decodeInstances({}), instanceId("claude_a")),
    ).toBeUndefined();
  });

  it("uses the first matching pool in settings order and skips other drivers", () => {
    const instances = decodeInstances({
      codex_pool: { driver: "codex", pool: ["claude_a"], config: { launchArgs: "--codex" } },
      claude_first: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: { launchArgs: "--first" },
      },
      claude_second: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: { launchArgs: "--second" },
      },
      claude_a: { driver: "claudeAgent" },
    });
    expect(poolForMember(instances, instanceId("claude_a"))?.poolId).toBe(
      instanceId("claude_first"),
    );
    expect(effectiveConfig(instances, "claude_a").launchArgs).toBe("--first");
  });

  it("drops a pool value its own field rejects and keeps the rest", () => {
    const instances = decodeInstances({
      claude_pool: {
        driver: "claudeAgent",
        pool: ["claude_a"],
        config: { autoCompactWindow: "5000", compactModel: "claude-sonnet-5-5" },
      },
      claude_a: { driver: "claudeAgent" },
    });
    expect(resolveProviderInstanceConfig(instances, instanceId("claude_a"))?.config).toEqual({
      compactModel: "claude-sonnet-5-5",
    });
    expect(effectiveConfig(instances, "claude_a").autoCompactWindow).toBe("");
  });

  it("ignores a pool config that is not an object", () => {
    const instances = decodeInstances({
      claude_pool: { driver: "claudeAgent", pool: ["claude_a"], config: "not-a-config" },
      claude_a: { driver: "claudeAgent", config: { launchArgs: "--mine" } },
    });
    const id = instanceId("claude_a");
    expect(resolveProviderInstanceConfig(instances, id)).toBe(instances[id]);
  });

  it("leaves a pool with no config leaving each member's stored settings as they are", () => {
    const stored = {
      autoCompactWindow: "300000",
      idleCompaction: "beforeCacheExpires",
      compactModel: "claude-sonnet-5-5",
    };
    const instances = decodeInstances({
      claude_pool: { driver: "claudeAgent", pool: ["claude_a", "claude_b", "claude_c"] },
      claude_a: { driver: "claudeAgent", config: stored },
      claude_b: { driver: "claudeAgent", config: stored },
      claude_c: { driver: "claudeAgent", config: stored },
    });
    for (const member of ["claude_a", "claude_b", "claude_c"]) {
      const id = instanceId(member);
      expect(resolveProviderInstanceConfig(instances, id)).toBe(instances[id]);
      const config = effectiveConfig(instances, member);
      expect(config.autoCompactWindow).toBe("300000");
      expect(config.idleCompaction).toBe("beforeCacheExpires");
      expect(config.compactModel).toBe("claude-sonnet-5-5");
    }
  });

  it("resolves idle compaction and the compaction model through the pool", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_pool: {
          driver: "claudeAgent",
          pool: ["claude_new", "claude_own"],
          config: {
            idleCompaction: "beforeCacheExpires",
            compactModel: "claude-sonnet-5-5",
            compactModelInstanceId: "claude_own",
            compactOnlyWhenCold: false,
          },
        },
        claude_new: { driver: "claudeAgent" },
        claude_own: {
          driver: "claudeAgent",
          config: {
            idleCompaction: "onReturn",
            compactModel: "claude-opus-4-6",
            compactOnlyWhenCold: true,
          },
        },
      },
    });
    expect(resolveIdleCompaction(settings, instanceId("claude_new"))).toBe("beforeCacheExpires");
    expect(resolveClaudeCompactionSetting(settings, instanceId("claude_new"))).toEqual({
      model: "claude-sonnet-5-5",
      instanceId: instanceId("claude_own"),
      onlyWhenCold: false,
    });
    expect(resolveIdleCompaction(settings, instanceId("claude_own"))).toBe("onReturn");
    expect(resolveClaudeCompactionSetting(settings, instanceId("claude_own"))).toEqual({
      model: "claude-opus-4-6",
      instanceId: instanceId("claude_own"),
      onlyWhenCold: true,
    });
  });
});
