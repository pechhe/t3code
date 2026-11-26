import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  type ProjectFile = { readonly defaultThreadEnvMode?: "local" | "worktree" } | null;
  let completeProjectFileRead: (value: ProjectFile) => void = () => undefined;
  let projectFileRead = Promise.resolve<ProjectFile>(null);
  let draftSession = {
    envMode: "local",
    worktreePath: null,
    branch: null as string | null,
    environmentSelection: undefined as "manual" | undefined,
  };
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null as { instanceId: string; model: string } | null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let slotOneSelection: { instanceId: string; model: string } | null = null;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
    buildLocation: (request: { readonly params: { readonly draftId: string } }) => ({
      href: `/draft/${request.params.draftId}`,
    }),
  };

  const defaultDraftSession = () =>
    openDraftRoute === null
      ? { ...draftSession, promotedTo: null, startFromOrigin: false }
      : {
          logicalProjectKey: "remote-project",
          promotedTo: null,
          threadId: "thread-open",
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
        };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => ({ draftId })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(defaultDraftSession),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: ProjectFile) => completeProjectFileRead(value),
    discoverBranch(branch: string) {
      draftSession = { ...draftSession, branch };
    },
    keepEarlierManualChoice() {
      draftSession = { ...draftSession, environmentSelection: "manual" };
    },
    pickBranch(branch: string) {
      draftSession = { ...draftSession, branch, environmentSelection: "manual" };
    },
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    openEmptyDraft(draftId: string) {
      openDraftRoute = { kind: "draft", draftId };
    },
    get targetSettings() {
      return targetSettings;
    },
    get slotOneSelection() {
      return slotOneSelection;
    },
    setSlotOne(selection: { instanceId: string; model: string } | null) {
      slotOneSelection = selection;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      openDraftRoute = null;
      draftStore.getDraftSession.mockImplementation(defaultDraftSession);
      draftSession = {
        envMode: "local",
        worktreePath: null,
        branch: null,
        environmentSelection: undefined,
      };
      slotOneSelection = null;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<ProjectFile>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: (ref: { environmentId: string; projectId: string }) =>
    `${ref.environmentId}:${ref.projectId}`,
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react-dom", () => ({ flushSync: (update: () => void) => update() }));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
}));
vi.mock("../providerInstances", () => ({ resolveDefaultProviderModelSelection: () => null }));
vi.mock("../modelSelection", () => ({
  resolveAutomaticDefaultModelSelection: () => testState.slotOneSelection,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
  peekT3ProjectFile: () => undefined,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProjects: () => [project],
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/projects", () => ({ defaultProjectFallbackReadyAtom: () => true }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({
  getClientSettings: () => ({ loadBalancingEnabled: true }),
  mergeEnvironmentSettings: (serverSettings: unknown) => serverSettings,
}));

import {
  readPendingWorkspaceDefault,
  resolveDefaultProjectRef,
  useNewThreadHandler,
} from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("opens the draft before the project file is read, then applies its workspace default", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ envMode: "local" }),
    );
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.discoverBranch("main");
    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("applies the project file's default to a draft chosen manually before it opened", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    testState.keepEarlierManualChoice();
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("keeps a branch the user picked while the project file loaded", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.pickBranch("feature");
    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await testState.projectFileRead;

    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("useNewThreadHandler's model default", () => {
  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
  const slotOne = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

  it("sets the composer's first slot after the remembered model, so it wins", async () => {
    testState.reset(null);
    testState.setSlotOne(slotOne);

    const pendingOpen = useNewThreadHandler()(projectRef);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.applyStickyState).toHaveBeenCalledWith(
      opened?.draftId,
      expect.any(Function),
    );
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      opened?.draftId,
      expect.objectContaining(slotOne),
      { replaceOptions: true },
    );
    expect(testState.draftStore.applyStickyState.mock.invocationCallOrder[0]).toBeLessThan(
      testState.draftStore.setModelSelection.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps an explicitly configured default model over the first slot", async () => {
    testState.reset(null);
    testState.setSlotOne(slotOne);
    testState.targetSettings.defaultModelSelection = { instanceId: "codex", model: "gpt-6-astra" };

    const pendingOpen = useNewThreadHandler()(projectRef);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      opened?.draftId,
      expect.objectContaining({ instanceId: "codex", model: "gpt-6-astra" }),
      { replaceOptions: true },
    );
  });
});

describe("useNewThreadHandler retargeting an open draft", () => {
  it("moves the open draft to the project with its defaults, without opening another", async () => {
    testState.reset(
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
      { envMode: "worktree", startFromOrigin: true },
    );
    testState.draftStore.getDraftSession.mockImplementation(
      () =>
        ({
          draftId: "draft-open",
          threadId: "thread-open",
          createdAt: "2026-10-16T00:00:00.000Z",
          promotedTo: null,
        }) as never,
    );
    const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;

    const pendingOpen = useNewThreadHandler()(projectRef, {
      retargetDraftId: "draft-open" as never,
    });
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;
    testState.draftStore.getDraftSession.mockImplementation(() => null as never);

    expect(opened).toEqual({ draftId: "draft-open", threadId: "thread-open" });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledTimes(1);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      "draft-open",
      expect.objectContaining({
        threadId: "thread-open",
        branch: null,
        worktreePath: null,
        envMode: "worktree",
        startFromOrigin: true,
        environmentSelection: "auto",
        loadBalancedEnvironmentId: null,
      }),
    );
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["promoted to a thread", { promotedTo: { threadId: "thread-server" } }],
    ["gone", null],
  ])("leaves a draft that was %s meanwhile untouched", async (_, session) => {
    testState.reset(null);
    testState.draftStore.getDraftSession.mockImplementation(() =>
      session === null
        ? (null as never)
        : ({
            draftId: "draft-open",
            threadId: "thread-open",
            createdAt: "2026-10-16T00:00:00.000Z",
            ...session,
          } as never),
    );
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { retargetDraftId: "draft-open" as never },
    );
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;
    testState.draftStore.getDraftSession.mockImplementation(() => null as never);

    expect(opened).toBeNull();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });
});

it("reopens an empty draft with a fresh automatic machine choice", async () => {
  testState.reset({
    draftId: "draft-existing",
    environmentId: "environment-ssh",
    promotedTo: null,
    threadId: "thread-existing",
  });
  const pendingOpen = useNewThreadHandler()({
    environmentId: "environment-ssh",
    projectId: "project-remote",
  } as never);
  testState.completeProjectFileRead(null);
  await pendingOpen;
  expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
    "draft-existing",
    expect.objectContaining({ environmentSelection: "auto", loadBalancedEnvironmentId: null }),
  );
  expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
    "remote-project",
    expect.anything(),
    "draft-existing",
    expect.objectContaining({ environmentSelection: "auto", loadBalancedEnvironmentId: null }),
  );
});

describe("useNewThreadHandler", () => {
  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("default project selection", () => {
  it("prefers the last used project in its environment and falls back when unavailable", () => {
    const projects = [
      { id: "project", environmentId: "first", workspaceRoot: "/first" },
      { id: "project", environmentId: "last-used", workspaceRoot: "/last-used" },
    ].map((project) => ({
      ...project,
      id: project.id as ProjectId,
      environmentId: project.environmentId as EnvironmentId,
      title: project.environmentId,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }));
    expect(resolveDefaultProjectRef(projects, [], "last-used:project")).toEqual({
      environmentId: "last-used",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project", false),
    ).toBeNull();
    expect(resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project")).toEqual({
      environmentId: "first",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(
        [projects[0]!, { ...projects[1]!, archivedAt: "2026-11-09T00:00:00.000Z" }],
        [],
        "last-used:project",
      ),
    ).toEqual({ environmentId: "first", projectId: "project" });
  });
});
