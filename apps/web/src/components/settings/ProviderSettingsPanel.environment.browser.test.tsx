import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  const keybindings = Atom.make({}).pipe(Atom.keepAlive);
  return {
    ...actual,
    // The model picker's popover reads keybindings; the live atom would dial this test's
    // fake remote environment.
    primaryServerKeybindingsAtom: keybindings as never,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");
const codexPoolId = ProviderInstanceId.make("codex_pool");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

const claudeDriver = ProviderDriverKind.make("claudeAgent");
const poolId = ProviderInstanceId.make("claude_pool");
const poolMemberId = ProviderInstanceId.make("claude_work");
const otherPoolMemberId = ProviderInstanceId.make("claude_home");

function claudeModel(slug: string, contextWindowTokens?: number): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
}

function claudeProvider(
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider {
  return { ...provider(), instanceId, driver: claudeDriver, models };
}

/** Every setting a pool shares, set away from its default so omitting one is visible. */
const poolConfig = {
  launchArgs: "--chrome",
  autoCompactWindow: "300000",
  idleCompaction: "beforeCacheExpires",
  compactModel: "claude-sonnet",
  compactOnlyWhenCold: false,
};

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

// The section header and the end of the provider list both offer Add provider.

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});

describe("pooled provider settings", () => {
  it("edits only a pool's shared settings", async () => {
    await setup();
    const pool = {
      driver: claudeDriver,
      displayName: "Claude (pooled)",
      pool: [poolMemberId, otherPoolMemberId],
      config: { ...poolConfig, compactModel: "" },
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [poolId]: pool,
        [poolMemberId]: { driver: claudeDriver, displayName: "Work" },
        [otherPoolMemberId]: { driver: claudeDriver, displayName: "Home" },
      },
    };
    await setProviders([
      claudeProvider(poolMemberId, [
        claudeModel("claude-sonnet", 200_000),
        claudeModel("claude-opus", 200_000),
        claudeModel("claude-small"),
      ]),
      claudeProvider(otherPoolMemberId, [
        claudeModel("claude-sonnet", 200_000),
        claudeModel("claude-haiku", 200_000),
      ]),
    ]);
    await using _screen = await render(panel({ targetInstanceId: poolId }));

    await expect.element(page.getByText("How the pool picks")).toBeVisible();
    for (const label of [
      "Launch arguments",
      "Auto-compact after",
      "Compact idle threads",
      "Compact with",
      "Only when the prompt cache has expired",
    ]) {
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
    }
    // An account's own paths, models and environment are never shared.
    expect(page.getByText("Binary path").query()).toBeNull();
    expect(page.getByText("CLAUDE_CONFIG_DIR path").query()).toBeNull();
    expect(page.getByText("Variables").query()).toBeNull();

    // The shared choice is the composer's picker, which reaches every account's models.
    await expect
      .element(page.getByRole("button", { name: "Compact with" }))
      .toHaveTextContent("Same as the conversation");
    await userEvent.click(
      page.getByRole("switch", { name: "Only when the prompt cache has expired" }),
    );

    expect(state.mutateProviderInstance.mock.calls.map(([input]) => input)).toEqual([
      {
        operation: "upsert",
        instanceId: poolId,
        // The pool card keeps today's omit behaviour: switching to the default drops the key.
        instance: {
          ...pool,
          config: {
            launchArgs: "--chrome",
            autoCompactWindow: "300000",
            idleCompaction: "beforeCacheExpires",
            compactModel: "",
          },
        },
      },
    ]);
  });

  it("shows a member what it runs with, and returns one field to the pool", async () => {
    await setup();
    const pool = {
      driver: claudeDriver,
      displayName: "Claude (pooled)",
      pool: [poolMemberId],
      // Idle compaction is left out, so neither side holds a value for it.
      config: {
        launchArgs: poolConfig.launchArgs,
        autoCompactWindow: poolConfig.autoCompactWindow,
        compactModel: poolConfig.compactModel,
        compactOnlyWhenCold: poolConfig.compactOnlyWhenCold,
      },
    };
    const member = {
      driver: claudeDriver,
      displayName: "Work",
      config: { autoCompactWindow: "400000", binaryPath: "/opt/claude" },
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [poolId]: pool, [poolMemberId]: member },
    };
    await setProviders([claudeProvider(poolMemberId, [claudeModel("claude-sonnet", 200_000)])]);
    await using _screen = await render(panel({ targetInstanceId: poolMemberId }));

    // Its own value, and its own paths, beside the pool's values for the rest.
    await expect
      .element(page.getByRole("textbox", { name: "Auto-compact after" }))
      .toHaveValue("400000");
    await expect
      .element(page.getByRole("textbox", { name: "Launch arguments" }))
      .toHaveValue("--chrome");
    await expect
      .element(page.getByRole("textbox", { name: "Binary path" }))
      .toHaveValue("/opt/claude");
    await expect
      .element(page.getByRole("button", { name: "Compact with" }))
      .toHaveTextContent("claude-sonnet");
    // Neither side sets idle compaction: it shows the driver default, still governed by the pool.
    await expect
      .element(page.getByRole("combobox", { name: "Compact idle threads" }))
      .toHaveTextContent("Use default");
    // compactOnlyWhenCold is off for the pool, so the switch is off too.
    await expect
      .element(page.getByRole("switch", { name: "Only when the prompt cache has expired" }))
      .not.toBeChecked();

    expect(page.getByText("Overridden").query()).not.toBeNull();
    expect(page.getByText("From Claude (pooled)").elements()).toHaveLength(4);

    await userEvent.click(page.getByRole("button", { name: "Use pool's value" }));

    expect(state.mutateProviderInstance.mock.calls.map(([input]) => input)).toEqual([
      {
        operation: "upsert",
        instanceId: poolMemberId,
        // Only the key it stored, leaving its own paths and the other shared fields alone.
        instance: { ...member, config: { binaryPath: "/opt/claude" } },
      },
    ]);
  });

  it("stores a member's choice even when it matches the driver's default", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [poolId]: {
          driver: claudeDriver,
          displayName: "Claude (pooled)",
          pool: [poolMemberId],
          config: poolConfig,
        },
        [poolMemberId]: { driver: claudeDriver, displayName: "Work" },
      },
    };
    await setProviders([claudeProvider(poolMemberId, [claudeModel("claude-sonnet", 200_000)])]);
    await using _screen = await render(panel({ targetInstanceId: poolMemberId }));

    await userEvent.click(
      page.getByRole("switch", { name: "Only when the prompt cache has expired" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Reset Compact with to default" }));
    await userEvent.click(page.getByRole("combobox", { name: "Compact idle threads" }));
    await userEvent.click(page.getByRole("option", { name: "Use default" }));
    const launchArgs = page.getByRole("textbox", { name: "Launch arguments" });
    await userEvent.clear(launchArgs);
    await userEvent.keyboard("{Enter}");
    const autoCompactWindow = page.getByRole("textbox", { name: "Auto-compact after" });
    await userEvent.clear(autoCompactWindow);
    await userEvent.keyboard("{Enter}");

    expect(
      state.mutateProviderInstance.mock.calls.map(
        ([input]) => (input as { instance: { config: unknown } }).instance.config,
      ),
    ).toEqual([
      { compactOnlyWhenCold: true },
      { compactModel: "" },
      { idleCompaction: "default" },
      { launchArgs: "" },
      { autoCompactWindow: "" },
    ]);
  });

  it("leaves a pool of a driver with nothing to share, and an unpooled account, as they were", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), displayName: "Work" },
        [codexPoolId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex (pooled)",
          pool: [customId],
        },
      },
    };
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: codexPoolId }));

    await expect.element(page.getByText("How the pool picks")).toBeVisible();
    expect(page.getByText("Launch arguments").query()).toBeNull();
    expect(page.getByText("Binary path").query()).toBeNull();
  });

  it("leaves a Claude account in no pool without pool labels", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [poolMemberId]: { driver: claudeDriver, displayName: "Work" },
      },
    };
    await setProviders([claudeProvider(poolMemberId, [claudeModel("claude-sonnet", 200_000)])]);
    await using _screen = await render(panel({ targetInstanceId: poolMemberId }));

    await expect.element(page.getByRole("textbox", { name: "Binary path" })).toBeVisible();
    expect(page.getByText("Overridden").query()).toBeNull();
    expect(page.getByText("Use pool's value").query()).toBeNull();
    expect(page.getByText(/^From /).query()).toBeNull();
  });
});
