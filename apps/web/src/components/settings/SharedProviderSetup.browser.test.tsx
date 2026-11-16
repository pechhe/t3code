import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  settings: new Map<EnvironmentId, Atom.Writable<ServerSettings | null>>(),
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
    serverConfig: {
      environment: {
        platform: { os: "darwin" | "linux"; machine?: "vps" };
        capabilities: { sharedModelPreferences?: boolean };
      };
    };
  }>,
  applyInstancesToken: Symbol("applySharedProviderSetup"),
  applyModelPreferencesToken: Symbol("applySharedModelPreferences"),
  setSharingToken: Symbol("setProviderSetupSharing"),
  applyInstances: vi.fn(),
  applyModelPreferences: vi.fn(),
  setSharing: vi.fn(),
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) => state.settings.get(id)) as never,
      applySharedProviderSetup: state.applyInstancesToken as never,
      applySharedModelPreferences: state.applyModelPreferencesToken as never,
      setProviderSetupSharing: state.setSharingToken as never,
    },
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironments: (() => ({ environments: state.environments })) as never,
    usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
    useEnvironmentProviders: (() => new Map()) as never,
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readEnvironmentScope: () => true,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown) => {
      if (command === state.applyInstancesToken) return state.applyInstances;
      if (command === state.applyModelPreferencesToken) return state.applyModelPreferences;
      if (command === state.setSharingToken) return state.setSharing;
      return vi.fn();
    }) as never,
  };
});

import { SharedProviderSetupSync, SharedSetupBanners } from "./SharedProviderSetup";

const macId = EnvironmentId.make("mac");
const vpsId = EnvironmentId.make("peach-box");
const provider = ProviderInstanceId.make("codex");

function setup() {
  // The sync publishes failures to the app registry, so the banners must read the same one.
  const registry = appAtomRegistry;
  state.settings.clear();
  state.applyInstances.mockReset();
  state.applyModelPreferences.mockReset();
  state.setSharing.mockReset();
  state.environments = [
    {
      environmentId: macId,
      label: "Mac",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          platform: { os: "darwin" },
          capabilities: { sharedModelPreferences: true },
        },
      },
    },
    {
      environmentId: vpsId,
      label: "Peach Box",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          platform: { os: "linux", machine: "vps" },
          capabilities: { sharedModelPreferences: true },
        },
      },
    },
  ];
  const macSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    favorites: [{ provider, model: "gpt-6-luna" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["old"], modelOrder: [] } },
    sharedProviderSetup: {
      shared: true,
      version: 1,
      baseVersion: 1,
      changedAt: "2026-11-16T10:00:00.000Z",
      digest: "inst",
      modelPreferencesVersion: 2,
      modelPreferencesBaseVersion: 1,
      modelPreferencesChangedAt: "2026-11-16T10:05:00.000Z",
      modelPreferencesDigest: "mac-prefs",
    },
  } satisfies ServerSettings;
  const vpsSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    favorites: [],
    providerModelPreferences: {},
    sharedProviderSetup: {
      shared: true,
      version: 1,
      baseVersion: 1,
      changedAt: "2026-11-16T10:00:00.000Z",
      digest: "inst",
      modelPreferencesVersion: 1,
      modelPreferencesBaseVersion: 1,
      modelPreferencesChangedAt: "2026-11-16T10:00:00.000Z",
      modelPreferencesDigest: "vps-prefs",
    },
  } satisfies ServerSettings;
  state.settings.set(macId, Atom.make<ServerSettings | null>(macSettings));
  state.settings.set(vpsId, Atom.make<ServerSettings | null>(vpsSettings));

  return { registry, macSettings, vpsSettings };
}

describe("SharedProviderSetupSync model preferences", () => {
  it("pushes newer favorites to peers before restamping the source", async () => {
    const fixture = setup();
    // Each apply lands the source's preferences on the target, as the server would.
    state.applyModelPreferences.mockImplementation(
      async ({ environmentId }: { environmentId: EnvironmentId }) => {
        const atom = state.settings.get(environmentId)!;
        const current = fixture.registry.get(atom)!;
        const next = {
          ...current,
          favorites: fixture.macSettings.favorites,
          providerModelPreferences: fixture.macSettings.providerModelPreferences,
          sharedProviderSetup: {
            ...current.sharedProviderSetup!,
            modelPreferencesVersion: 2,
            modelPreferencesBaseVersion: 2,
            modelPreferencesChangedAt: "2026-11-16T10:05:00.000Z",
            modelPreferencesDigest: "mac-prefs",
          },
        };
        fixture.registry.set(atom, next);
        return AsyncResult.success(next);
      },
    );
    await using _screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <SharedProviderSetupSync />
      </RegistryContext.Provider>,
      // Router context is unrelated to background settings sync.
      { router: false },
    );

    await vi.waitFor(() => {
      expect(state.applyModelPreferences).toHaveBeenCalledTimes(2);
    });
    expect(state.applyModelPreferences.mock.calls).toEqual([
      [
        {
          environmentId: vpsId,
          input: {
            favorites: fixture.macSettings.favorites,
            providerModelPreferences: fixture.macSettings.providerModelPreferences,
            version: 2,
            changedAt: "2026-11-16T10:05:00.000Z",
            expectedDigest: "vps-prefs",
          },
        },
      ],
      [
        {
          environmentId: macId,
          input: {
            favorites: fixture.macSettings.favorites,
            providerModelPreferences: fixture.macSettings.providerModelPreferences,
            version: 2,
            changedAt: "2026-11-16T10:05:00.000Z",
            expectedDigest: "mac-prefs",
          },
        },
      ],
    ]);
  });

  it("surfaces model preference sync failures in SharedSetupBanners", async () => {
    const fixture = setup();
    state.applyModelPreferences.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Preferences sync refused"))),
    );
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <SharedProviderSetupSync />
        <SharedSetupBanners />
      </RegistryContext.Provider>,
      // Router context is unrelated to shared setup sync banners.
      { router: false },
    );

    await expect
      .element(screen.getByText("Peach Box didn't take your last change"))
      .toBeInTheDocument();
  });
});
