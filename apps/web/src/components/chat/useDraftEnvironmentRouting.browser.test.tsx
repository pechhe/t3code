import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ServerProvider } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

import { ThreadId } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { useUiStateStore } from "../../uiStateStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { isAutomaticDraftEnvironment } from "./useDraftEnvironmentRouting";
import { DeviceEnvironmentSwitch } from "./device/DeviceEnvironmentSwitch";

const resources = vi.hoisted(() => ({
  refreshSelection: vi.fn<(ids: readonly EnvironmentId[]) => Promise<EnvironmentId | null>>(),
}));
const fixture = vi.hoisted(() => ({
  recommendation: "remote" as string | null,
  pending: false,
  failed: false,
}));
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    environmentId: fixture.recommendation,
    pending: fixture.pending,
    failed: fixture.failed,
    refresh: () => {},
    refreshSelection: resources.refreshSelection,
  }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: async () => null }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "local", id: "local-project" },
    { environmentId: "remote", id: "remote-project" },
  ],
}));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const draftId = DraftId.make("routing-test");
const candidates = [local, remote].map((environmentId) => ({
  environmentId,
  projectId: ProjectId.make(`${environmentId}-project`),
  label: environmentId,
  isPrimary: environmentId === local,
  machine: "server" as const,
}));

function setup(selection?: "manual") {
  fixture.recommendation = "remote";
  fixture.pending = false;
  fixture.failed = false;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useUiStateStore.getState().setNewThreadEnvironmentId(local);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(local, ProjectId.make("local-project")), draftId, {
      threadId: ThreadId.make("routing-thread"),
      ...(selection ? { environmentSelection: selection } : {}),
    });
}

function RoutingHarness({
  locked = false,
  attachments = false,
  offlineEnvironment = null,
  unavailableProviderEnvironment = null,
  unauthenticatedEnvironment = null,
  referenceEnvironment = null,
}: {
  locked?: boolean;
  attachments?: boolean;
  offlineEnvironment?: EnvironmentId | null;
  unavailableProviderEnvironment?: EnvironmentId | null;
  unauthenticatedEnvironment?: EnvironmentId | null;
  referenceEnvironment?: EnvironmentId | null;
}) {
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const routing = useDraftEnvironmentRouting({
    draftId,
    draftThread: draft,
    envLocked: locked,
    automaticEnvironment: isAutomaticDraftEnvironment({
      clientSettingsHydrated: true,
      draftId,
      draftThread: draft,
      envLocked: locked,
      canAutoBalanceEnvironments: true,
      loadBalancingEnabled: true,
      composerHasAttachments: attachments,
    }),
    logicalProjectEnvironments: candidates,
    environmentById: new Map(
      candidates.map(({ environmentId }) => [
        environmentId,
        {
          environmentId,
          connection: {
            phase:
              offlineEnvironment === environmentId
                ? ("reconnecting" as const)
                : ("connected" as const),
            error: null,
            traceId: null,
          },
          serverConfig: null,
        },
      ]),
    ),
    providersByEnvironment: new Map(
      candidates.map(({ environmentId }) => [
        environmentId,
        [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready" as const,
            auth: {
              status:
                unauthenticatedEnvironment === environmentId
                  ? ("unauthenticated" as const)
                  : ("authenticated" as const),
            },
            availability:
              unavailableProviderEnvironment === environmentId
                ? ("unavailable" as const)
                : ("available" as const),
            checkedAt: "2026-10-23T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      ]),
    ),
    loadBalancingSettings: { loadBalancingEnabled: true, loadBalancingWeights: {} },
    referencedThreadContexts: referenceEnvironment
      ? [
          threadContextRecord(
            scopeThreadRef(referenceEnvironment, ThreadId.make("referenced-thread")),
            "Referenced thread",
          ),
        ]
      : [],
    activeProviderInstanceId: null,
    selectedProvider: ProviderDriverKind.make("codex"),
    composerHasAttachments: attachments,
    activeProjectKey: "project",
    activeProjectIsScratch: false,
    projectGroupingSettings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
    sendInFlightRef: { current: false },
  });
  return (
    <>
      <output aria-label="Selected machine">{draft?.environmentId}</output>
      <output aria-label="Automatic pick">{draft?.loadBalancedEnvironmentId ?? "unknown"}</output>
      <output aria-label="Routing mode">{draft?.environmentSelection ?? "auto"}</output>
      <output aria-label="Routing readiness">
        {routing.needsLoadBalancing ? "blocked" : "ready"}
      </output>
      <DeviceEnvironmentSwitch
        environments={[candidates[0]!, candidates[1]!]}
        environmentId={draft?.environmentId ?? local}
        locked={locked}
        balanceState={routing.balanceState}
        onChange={routing.onEnvironmentChangeStable}
      />
    </>
  );
}

it.each(["local", "remote"])(
  "opens on %s as the automatic pick and restores auto after an override",
  async (recommended) => {
    setup();
    fixture.recommendation = recommended;
    const other = recommended === "local" ? "remote" : "local";
    await using screen = await render(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent(recommended);
    await expect
      .element(screen.getByRole("switch"))
      .toHaveAttribute("data-device-switch-balance", "auto");
    await userEvent.click(screen.getByRole("switch"));
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent(other);
    await expect
      .element(screen.getByRole("status", { name: "Automatic pick" }))
      .toHaveTextContent(recommended);
    await expect
      .element(screen.getByRole("status", { name: "Routing mode" }))
      .toHaveTextContent("manual");
    await expect
      .element(screen.getByRole("switch"))
      .toHaveAttribute("data-device-switch-balance", "override");
    await userEvent.click(screen.getByRole("switch"));
    await expect
      .element(screen.getByRole("status", { name: "Routing mode" }))
      .toHaveTextContent("auto");
    await expect
      .element(screen.getByRole("switch"))
      .toHaveAttribute("data-device-switch-balance", "auto");
    expect(useUiStateStore.getState().newThreadEnvironmentId).toBeNull();
  },
);

it("recovers the automatic pick for an older manually selected draft without moving it", async () => {
  setup("manual");
  await using screen = await render(<RoutingHarness />);
  await expect
    .element(screen.getByRole("status", { name: "Automatic pick" }))
    .toHaveTextContent("remote");
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await userEvent.click(screen.getByRole("switch"));
  await expect
    .element(screen.getByRole("status", { name: "Routing mode" }))
    .toHaveTextContent("auto");
  await expect
    .element(screen.getByRole("switch"))
    .toHaveAttribute("data-device-switch-balance", "auto");
});

it.each([
  { fault: "connection", manual: false },
  { fault: "connection", manual: true },
  { fault: "provider", manual: false },
  { fault: "provider", manual: true },
])(
  "keeps the draft and its automatic pick stable through a transient change (%o)",
  async ({ fault, manual }) => {
    setup();
    await using screen = await render(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent("remote");
    if (manual) await userEvent.click(screen.getByRole("switch"));
    fixture.recommendation = "local";
    await screen.rerender(
      <RoutingHarness
        offlineEnvironment={fault === "connection" ? remote : null}
        unavailableProviderEnvironment={fault === "provider" ? remote : null}
      />,
    );
    await expect
      .element(screen.getByRole("status", { name: "Automatic pick" }))
      .toHaveTextContent("remote");
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent(manual ? "local" : "remote");
    await expect
      .element(screen.getByRole("switch"))
      .toHaveAttribute("data-device-switch-balance", manual ? "override" : "auto");
    await screen.rerender(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Automatic pick" }))
      .toHaveTextContent("remote");
  },
);

it("does not turn a pinned attachment into a false override when resources resolve", async () => {
  setup();
  fixture.pending = true;
  await using screen = await render(<RoutingHarness />);
  await screen.rerender(<RoutingHarness attachments />);
  fixture.pending = false;
  await screen.rerender(<RoutingHarness attachments />);
  await expect
    .element(screen.getByRole("status", { name: "Automatic pick" }))
    .toHaveTextContent("unknown");
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await expect
    .element(screen.getByRole("switch"))
    .not.toHaveAttribute("data-device-switch-balance", "override");
  await screen.rerender(<RoutingHarness />);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("remote");
  await expect
    .element(screen.getByRole("switch"))
    .toHaveAttribute("data-device-switch-balance", "auto");
});

it("replaces a recommendation for a removed project machine and can return to Auto", async () => {
  setup("manual");
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    loadBalancedEnvironmentId: EnvironmentId.make("removed-machine"),
  });
  await using screen = await render(<RoutingHarness />);
  await expect
    .element(screen.getByRole("status", { name: "Automatic pick" }))
    .toHaveTextContent("remote");
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await userEvent.click(screen.getByRole("switch"));
  await expect
    .element(screen.getByRole("switch"))
    .toHaveAttribute("data-device-switch-balance", "auto");
  await expect
    .element(screen.getByRole("status", { name: "Routing mode" }))
    .toHaveTextContent("auto");
});

it("applies a previously cached pick only after attachments are removed, without chasing a new score", async () => {
  setup();
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: remote,
  });
  fixture.recommendation = "local";
  await using screen = await render(<RoutingHarness attachments />);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await expect
    .element(screen.getByRole("switch"))
    .not.toHaveAttribute("data-device-switch-balance", "override");
  await screen.rerender(<RoutingHarness />);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("remote");
  await expect
    .element(screen.getByRole("switch"))
    .toHaveAttribute("data-device-switch-balance", "auto");
});

it("reports unavailable balancing without claiming the current machine was selected", async () => {
  setup();
  fixture.recommendation = null;
  fixture.failed = true;
  await using screen = await render(<RoutingHarness />);
  await expect.element(screen.getByRole("switch")).toHaveAccessibleDescription(/unavailable/i);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
});

it("waits for the cached machine to reconnect before applying an unapplied pick", async () => {
  setup();
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: remote,
  });
  fixture.recommendation = "local";
  await using screen = await render(<RoutingHarness offlineEnvironment={remote} />);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await expect
    .element(screen.getByRole("status", { name: "Automatic pick" }))
    .toHaveTextContent("remote");
  await expect.element(screen.getByRole("switch")).toHaveAccessibleDescription(/unavailable/i);
  await screen.rerender(<RoutingHarness />);
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("remote");
  await expect
    .element(screen.getByRole("switch"))
    .toHaveAttribute("data-device-switch-balance", "auto");
});

it.each([{ branch: "feature/pinned" }, { worktreePath: "/local/worktree" }])(
  "keeps a manual workspace pinned while holding a recommendation (%o)",
  async (workspace) => {
    setup();
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      ...workspace,
      loadBalancedEnvironmentId: remote,
    });
    await using screen = await render(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent("local");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject(workspace);
  },
);

it.each(["provider auth", "thread context"])(
  "blocks automatic sending when the stored pick is excluded by %s",
  async (reason) => {
    setup();
    await using screen = await render(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Routing readiness" }))
      .toHaveTextContent("ready");
    await screen.rerender(
      <RoutingHarness
        unauthenticatedEnvironment={reason === "provider auth" ? remote : null}
        referenceEnvironment={reason === "thread context" ? local : null}
      />,
    );
    await expect
      .element(screen.getByRole("status", { name: "Routing readiness" }))
      .toHaveTextContent("blocked");
    await expect
      .element(screen.getByRole("status", { name: "Selected machine" }))
      .toHaveTextContent("remote");
    await expect
      .element(screen.getByRole("status", { name: "Automatic pick" }))
      .toHaveTextContent("remote");
    await screen.rerender(<RoutingHarness />);
    await expect
      .element(screen.getByRole("status", { name: "Routing readiness" }))
      .toHaveTextContent("ready");
  },
);

it("keeps a started thread on its machine", async () => {
  setup();
  await using screen = await render(<RoutingHarness locked />);
  await expect.element(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  await expect
    .element(screen.getByRole("switch"))
    .not.toHaveAttribute("data-device-switch-balance");
  await expect
    .element(screen.getByRole("status", { name: "Selected machine" }))
    .toHaveTextContent("local");
  await expect
    .element(screen.getByRole("status", { name: "Automatic pick" }))
    .toHaveTextContent("unknown");
});

function setupRefresh() {
  resources.refreshSelection.mockReset();
  const a = EnvironmentId.make("machine-a");
  const b = EnvironmentId.make("machine-b");
  const draftId = DraftId.make("fresh-routing-draft");
  const projectId = ProjectId.make("project");
  const store = useComposerDraftStore.getState();
  store.clearDraftThread(draftId);
  store.setProjectDraftThreadId(scopeProjectRef(a, projectId), draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  store.setPrompt(draftId, "Keep this prompt");
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    availability: "available",
    version: null,
    checkedAt: "2026-11-10T01:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const input: Parameters<typeof useDraftEnvironmentRouting>[0] = {
    draftId,
    draftThread: store.getDraftSession(draftId),
    envLocked: false,
    automaticEnvironment: true,
    logicalProjectEnvironments: [a, b].map((environmentId) => ({
      environmentId,
      projectId,
      label: environmentId,
      isPrimary: environmentId === a,
      machine: "desktop",
    })),
    environmentById: new Map(
      [a, b].map((id): [EnvironmentId, EnvironmentPresentation] => [
        id,
        {
          environmentId: id,
          label: id,
          displayUrl: null,
          relayManaged: false,
          entry: {
            target: new PrimaryConnectionTarget({
              environmentId: id,
              label: id,
              httpBaseUrl: "http://localhost:3000",
              wsBaseUrl: "ws://localhost:3000",
            }),
            profile: Option.none(),
            enabled: true,
          },
          connection: { phase: "connected", error: null, traceId: null },
          serverConfig: null,
        },
      ]),
    ),
    providersByEnvironment: new Map([a, b].map((id) => [id, [provider]])),
    loadBalancingSettings: { loadBalancingEnabled: true, loadBalancingWeights: {} },
    referencedThreadContexts: [],
    activeProviderInstanceId: provider.instanceId,
    selectedProvider: provider.driver,
    composerHasAttachments: false,
    activeProjectKey: "project",
    activeProjectIsScratch: false,
    projectGroupingSettings: DEFAULT_UNIFIED_SETTINGS,
    sendInFlightRef: { current: false },
  };
  resources.refreshSelection.mockImplementation(async (ids) => (ids.includes(b) ? b : null));
  return { a, b, draftId, input, store };
}

function RefreshHarness({
  input,
  onPrepared,
}: {
  input: Parameters<typeof useDraftEnvironmentRouting>[0];
  onPrepared?: (ready: boolean | null) => void;
}) {
  const routing = useDraftEnvironmentRouting(input);
  const draft = useComposerDraftStore((state) => state.getDraftSession(input.draftId!));
  return (
    <>
      <span>{draft?.environmentId}</span>
      <button
        onClick={async () => {
          const ready = await routing.refreshBeforeSend();
          onPrepared?.(ready);
        }}
      >
        Send
      </button>
    </>
  );
}

it("refreshes a stored automatic choice before sending an unsent draft", async () => {
  const { a, b, draftId, input, store } = setupRefresh();
  const selections = ["model-a", "model-b"].map((model) =>
    createModelSelection(ProviderInstanceId.make("codex"), model),
  );
  const threadId = input.draftThread!.threadId;
  const destinationSelections = draftFanoutSelectionsAtom(
    scopedThreadKey(scopeThreadRef(b, threadId)),
  );
  appAtomRegistry.set(destinationSelections, null);
  appAtomRegistry.set(
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(a, threadId))),
    selections,
  );
  store.setDraftThreadContext(draftId, {
    branch: "main",
    envMode: "worktree",
    environmentSelection: "auto",
  });
  await using screen = await render(
    <RefreshHarness input={{ ...input, draftThread: store.getDraftSession(draftId) }} />,
  );
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Send" }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  expect(resources.refreshSelection).toHaveBeenCalledWith([a, b]);
  expect(store.getDraftSession(draftId)).toMatchObject({
    loadBalancedEnvironmentId: b,
    branch: "main",
    envMode: "worktree",
  });
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this prompt");
  expect(appAtomRegistry.get(destinationSelections)).toEqual(selections);
});

it.each(["manual", "attachments", "promoted"] as const)(
  "keeps the machine for %s drafts",
  async (kind) => {
    const { a, draftId, input, store } = setupRefresh();
    if (kind === "manual") store.setDraftThreadContext(draftId, { environmentSelection: "manual" });
    const guardedInput = {
      ...input,
      automaticEnvironment: kind !== "manual",
      composerHasAttachments: kind === "attachments",
      draftThread:
        kind === "promoted"
          ? {
              ...input.draftThread!,
              promotedTo: { environmentId: a, threadId: input.draftThread!.threadId },
            }
          : input.draftThread,
    };
    await using screen = await render(<RefreshHarness input={guardedInput} />);
    await screen.getByRole("button", { name: "Send" }).click();
    expect(resources.refreshSelection).not.toHaveBeenCalled();
    expect(store.getDraftSession(draftId)?.environmentId).toBe(a);
  },
);

it("does not reuse a stored choice when refreshed resources have no winner", async () => {
  const { a, input } = setupRefresh();
  resources.refreshSelection.mockResolvedValue(null);
  const onPrepared = vi.fn();
  await using screen = await render(<RefreshHarness input={input} onPrepared={onPrepared} />);
  await screen.getByRole("button", { name: "Send" }).click();
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(false));
});

it("abandons a refresh when the draft changes while resources are in flight", async () => {
  const { a, b, draftId, input, store } = setupRefresh();
  let resolve!: (environmentId: EnvironmentId) => void;
  resources.refreshSelection.mockReturnValue(
    new Promise<EnvironmentId>((done) => {
      resolve = done;
    }),
  );
  await using screen = await render(<RefreshHarness input={input} />);
  await screen.getByRole("button", { name: "Send" }).click();
  await act(async () => {
    store.setPrompt(draftId, "Edited while checking");
    resolve(b);
  });
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Edited while checking");
});
