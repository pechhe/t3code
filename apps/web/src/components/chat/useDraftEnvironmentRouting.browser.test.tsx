import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useUiStateStore } from "../../uiStateStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import {
  isAutomaticDraftEnvironment,
  useDraftEnvironmentRouting,
} from "./useDraftEnvironmentRouting";
import { DeviceEnvironmentSwitch } from "./device/DeviceEnvironmentSwitch";

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
