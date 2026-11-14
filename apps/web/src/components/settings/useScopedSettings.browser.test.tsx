import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: new Map<string, Atom.Atom<ServerSettings | null>>(),
  persist: vi.fn(),
  scopeContext: null as unknown,
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) => state.settings.get(id)) as never,
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readEnvironmentScope: () => true,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useOptionalSettingsScope: (() => state.scopeContext) as never,
  };
});

import {
  useToggleScopedModelFavorite,
  useUpdateScopedModelPreferences,
} from "./useScopedSettings";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const provider = ProviderInstanceId.make("pi");

function setup() {
  state.persist.mockReset();
  state.persist.mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
  const registry = AtomRegistry.make();
  state.settings.set(primaryId, Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS));
  state.settings.set(remoteId, Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS));
  state.scopeContext = {
    scope: { kind: "all", environmentIds: [primaryId, remoteId] },
    connectedEnvironments: [
      { environmentId: primaryId, label: "Mac" },
      { environmentId: remoteId, label: "Peach Box" },
    ],
  };
  return { registry };
}

function Harness({
  onReady,
}: {
  onReady: (api: {
    update: ReturnType<typeof useUpdateScopedModelPreferences>;
    toggleFavorite: ReturnType<typeof useToggleScopedModelFavorite>;
  }) => void;
}) {
  const update = useUpdateScopedModelPreferences(primaryId);
  const toggleFavorite = useToggleScopedModelFavorite(primaryId);
  onReady({ update, toggleFavorite });
  return null;
}

describe("useScopedSettings model preferences", () => {
  it("fans out model preferences and favorite toggles to every connected environment in scope", async () => {
    const { registry } = setup();
    let api!: {
      update: ReturnType<typeof useUpdateScopedModelPreferences>;
      toggleFavorite: ReturnType<typeof useToggleScopedModelFavorite>;
    };
    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <Harness
          onReady={(next) => {
            api = next;
          }}
        />
      </RegistryContext.Provider>,
      { router: false }, // Hook harness does not use router navigation.
    );

    await api.update({
      setModelsHidden: [{ provider, model: "antigravity/gemini-4-hydrogen", hidden: false }],
    });
    await api.toggleFavorite(provider, "antigravity/gemini-4-hydrogen");

    expect(state.persist).toHaveBeenCalledTimes(4);
    expect(state.persist).toHaveBeenNthCalledWith(1, {
      environmentId: primaryId,
      input: {
        patch: {
          setModelsHidden: [{ provider, model: "antigravity/gemini-4-hydrogen", hidden: false }],
        },
      },
    });
    expect(state.persist).toHaveBeenNthCalledWith(2, {
      environmentId: remoteId,
      input: {
        patch: {
          setModelsHidden: [{ provider, model: "antigravity/gemini-4-hydrogen", hidden: false }],
        },
      },
    });
    expect(state.persist).toHaveBeenNthCalledWith(3, {
      environmentId: primaryId,
      input: {
        patch: {
          setModelFavorites: [{ provider, model: "antigravity/gemini-4-hydrogen", favorite: true }],
        },
      },
    });
    expect(state.persist).toHaveBeenNthCalledWith(4, {
      environmentId: remoteId,
      input: {
        patch: {
          setModelFavorites: [{ provider, model: "antigravity/gemini-4-hydrogen", favorite: true }],
        },
      },
    });
  });
});
