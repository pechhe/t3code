import { cloneElement, type ReactElement, type ReactNode } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

const state = vi.hoisted(() => ({
  stopWorkflowLabel: "environment-data:orchestration:stop-workflow",
  projection: null as unknown,
  projections: null as Map<string, unknown> | null,
  navigate: vi.fn(),
  shells: [] as unknown[],
  shell: null as unknown,
  watchers: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
  workflowCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
  toast: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: ((ref: ScopedThreadRef | null) =>
    ref === null
      ? undefined
      : {
          projection: state.projections
            ? state.projections.get(scopedThreadKey(ref))
            : state.projection,
        }) as never,
  useThreadRelationshipShells: ((ref: { readonly environmentId: string }) =>
    (state.shells as ReadonlyArray<{ readonly environmentId: string; readonly source: unknown }>)
      .filter((shell) => shell.environmentId === ref.environmentId)
      .map((shell) => shell.source)) as never,
  useProjects: (() => state.projects) as never,
  useThreadShell: (() => state.shell) as never,
  useThreadWatchers: (() => state.watchers) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() =>
    new Map(
      [...state.configs].map(([id, config]) => [id, (config as { providers: unknown }).providers]),
    )) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    command.label === state.stopWorkflowLabel ? state.workflowCommand : state.command) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } as never };
});
vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  const stopWorkflow = actual.orchestrationEnvironment.stopWorkflow;
  return {
    ...actual,
    orchestrationEnvironment: Object.assign(Object.create(actual.orchestrationEnvironment), {
      stopWorkflow: Object.assign(Object.create(stopWorkflow), {
        label: state.stopWorkflowLabel,
        permissionAtom: () => granted,
      }),
    }),
  };
});
// Tooltip and hover card content renders inline so the suite can read every row's agent
// details across many states without hovering each row.
vi.mock(import("../ui/tooltip"), async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: (({ children }: { children: ReactNode }) => children) as never,
    TooltipTrigger: (({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children)) as never,
    TooltipPopup: (({ children }: { children: ReactNode }) =>
      state.showTooltips ? <div role="tooltip">{children}</div> : null) as never,
  };
});

import { act, render as renderUi } from "../../../test/render";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

async function setup() {
  state.shells = [];
  state.shell = null;
  state.watchers = [];
  state.projects = [];
  state.configs.clear();
  state.showTooltips = false;
  state.navigate.mockClear();
  state.command.mockClear();
  state.workflowCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockClear();
  state.projection = null;
  state.projections = null;

  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  const container = screen.container;
  let current: ReactElement;

  async function render(element: ReactElement) {
    current = element;
    await act(async () => screen.rerender(element));
  }
  // The mocked hooks read `state` while rendering, so a new element picks up changes.
  const update = async () => await act(async () => screen.rerender(cloneElement(current)));
  const click = async (element: HTMLElement) => await act(async () => element.click());
  const buttons = () => [...container.querySelectorAll("button")];
  const allByLabel = (label: string) =>
    buttons().filter((button) => button.getAttribute("aria-label") === label);
  function byLabel(label: string) {
    const matches = allByLabel(label);
    if (matches.length !== 1)
      throw new Error(`Expected one "${label}" button, got ${matches.length}`);
    return matches[0]!;
  }
  const sectionToggles = (expanded: boolean) =>
    buttons().filter(
      (button) =>
        button.getAttribute("aria-expanded") === String(expanded) &&
        !button.hasAttribute("aria-label"),
    );
  function sectionToggle(expanded: boolean) {
    const [toggle] = sectionToggles(expanded);
    if (!toggle) throw new Error(`No ${expanded ? "expanded" : "collapsed"} section toggle`);
    return toggle;
  }
  // A named lineage group ("Earlier", "Watching") is its own collapse control.
  function groupToggle(label: string) {
    const [toggle] = buttons().filter(
      (button) => button.getAttribute("aria-label") === null && button.textContent?.includes(label),
    );
    if (!toggle) throw new Error(`No "${label}" group toggle`);
    return toggle;
  }
  const heading = () => container.querySelector("h3")?.textContent;
  const buttonsWithLabel = (matches: (label: string) => boolean) =>
    buttons().filter((button) => matches(button.getAttribute("aria-label") ?? ""));
  // Joins rendered text nodes; `visibleOnly` drops screen-reader-only text.
  function textNodes(separator: string, visibleOnly = false) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (visibleOnly && node.parentElement?.closest(".sr-only")) continue;
      parts.push(node.textContent ?? "");
    }
    return parts.join(separator);
  }

  const environment = stack.move();
  return {
    container,
    render,
    update,
    click,
    buttons,
    allByLabel,
    byLabel,
    sectionToggles,
    sectionToggle,
    groupToggle,
    heading,
    buttonsWithLabel,
    textNodes,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

it("keeps managed advisor conversations in their own visible section through follow-ups and completion", async () => {
  await using fixture = await setup();
  const { render, update, click, byLabel, allByLabel, textNodes, groupToggle } = fixture;
  const child = {
    id: "advisor-chat",
    title: "Architecture advice",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    agentTask: { role: "advisor" },
    status: "running",
  };
  state.shells = [{ environmentId: "test", source: child }];
  const agent = {
    id: "advice-1",
    childThreadId: "advisor-chat",
    origin: "app_owned",
    driver: "codex",
    providerInstanceId: "codex",
    title: "Architecture advice",
    prompt: "Which boundary owns validation?",
    model: "gpt-6-astra",
    status: "running",
    progress: null,
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [agent],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      showLineage
      showSideChats
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await render(panel);
  const text = () => textNodes(" ");
  expect(text()).toContain("Advisors");
  expect(text()).toContain("Lineage · 1 running");
  for (const status of ["idle", "running", "completed", "cancelled"]) {
    state.projection = {
      ...projection,
      subagents: [
        { ...agent, status: "completed" },
        { ...agent, id: "advice-2", status },
      ],
    };
    state.shells = [{ environmentId: "test", source: { ...child, status } }];
    await update();
    expect(text()).toContain("Advisors");
    expect(text()).not.toContain("Earlier");
    expect(allByLabel("Open Architecture advice chat")).toHaveLength(1);
  }
  await click(byLabel("Open Architecture advice chat"));
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "advisor-chat" }) }),
  );
  state.shells = [
    {
      environmentId: "test",
      source: {
        ...child,
        status: "completed",
        advisorClosedAt: DateTime.makeUnsafe("2026-09-16T13:00:00Z"),
      },
    },
  ];
  await update();
  expect(text()).toContain("Earlier");
  expect(text()).not.toContain("Advisors");
  // The Earlier list is collapsed; a closed advisor stays listed in it.
  await click(groupToggle("Earlier"));
  expect(text()).toContain("Closed");
  expect(byLabel("Open Architecture advice chat")).toBeDefined();
});

it("lists a thread the current thread finished watching under Earlier with a Watched badge", async () => {
  await using fixture = await setup();
  const { render, click, byLabel, textNodes, groupToggle } = fixture;
  state.shells = [
    { environmentId: "test", source: { id: "parent", lineage: {} } },
    {
      environmentId: "test",
      source: { id: "done", title: "Fix the login", status: "completed", lineage: {} },
    },
  ];
  state.projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      endedThreadWatches: [{ threadId: "done", title: "Fix the login" }],
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  await render(
    <ThreadRelationshipsPanel
      showLineage
      showSideChats
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  const text = textNodes(" ");
  expect(text).toContain("Earlier");
  await click(groupToggle("Earlier"));
  expect(textNodes(" ")).toContain("Watched");
  await click(byLabel("Open Fix the login chat"));
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "done" }) }),
  );
});

it("lists the threads it watches and the threads watching it beside the graph", async () => {
  await using fixture = await setup();
  const { render, click, byLabel, textNodes, groupToggle } = fixture;
  state.shells = [
    { environmentId: "test", source: { id: "target", title: "Fix the login", lineage: {} } },
    { environmentId: "test", source: { id: "watcher", title: "Watching me", lineage: {} } },
  ];
  state.watchers = [{ id: "watcher", title: "Watching me" }];
  state.projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      threadWatches: [{ target: { kind: "thread", threadId: "target" }, title: "Fix the login" }],
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  await render(
    <ThreadRelationshipsPanel
      showLineage
      showSideChats
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  const text = textNodes(" ");
  expect(text).toContain("Watching");
  expect(text).toContain("Watched by");
  await click(byLabel("Open Fix the login chat"));
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "target" }) }),
  );
  expect(byLabel("Open Watching me chat")).toBeDefined();
  await click(groupToggle("Watching"));
  expect(textNodes(" ")).not.toContain("Fix the login");
});

it("leaves a subagent the composer panel already shows out of Lineage", async () => {
  await using fixture = await setup();
  const { render, textNodes } = fixture;
  const child = {
    id: "worker-chat",
    title: "Count the flaky tests",
    creationSource: "web",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "running",
  };
  state.shells = [{ environmentId: "test", source: child }];
  state.shell = {
    environmentId: "test",
    source: {
      id: "parent",
      lineage: { relationshipToParent: null },
      pendingBackgroundTasks: [{ kind: "subagent", childThreadId: child.id, status: "running" }],
    },
  };
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "worker-1",
        childThreadId: child.id,
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: "codex",
        title: "Count the flaky tests",
        prompt: "Count the flaky tests",
        model: "gpt-6-astra",
        status: "running",
        progress: null,
        result: null,
        startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    ],
  };
  await render(
    <ThreadRelationshipsPanel
      showLineage
      showSideChats
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  expect(textNodes(" ")).not.toContain("Count the flaky tests");
});

it("shows paused for a task and workflow members paused by parent Stop, and stopped/interrupted otherwise", async () => {
  await using fixture = await setup();
  const { render, update, click, byLabel, groupToggle } = fixture;
  state.showTooltips = true;
  const pausedTaskThread = {
    id: "paused-task",
    title: "Paused task",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "idle",
    latestRunId: "run-paused",
  };
  const stoppedTaskThread = {
    id: "stopped-task",
    title: "Stopped task",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "interrupted",
  };
  const pausedWorkflowThread = {
    id: "paused-workflow",
    title: "Paused workflow",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "interrupted",
  };
  const stoppedWorkflowThread = {
    id: "stopped-workflow",
    title: "Stopped workflow",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "interrupted",
  };
  state.shells = [
    { environmentId: "test", source: pausedTaskThread },
    { environmentId: "test", source: stoppedTaskThread },
    { environmentId: "test", source: pausedWorkflowThread },
    { environmentId: "test", source: stoppedWorkflowThread },
  ];
  const baseSubagent = {
    origin: "app_owned",
    driver: "claudeAgent",
    providerInstanceId: "claude",
    model: "claude-opus-4-6",
    prompt: "Check",
    progress: null,
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: DateTime.makeUnsafe("2026-09-16T12:01:00Z"),
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:01:00Z"),
  };
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        ...baseSubagent,
        id: "task-paused",
        childThreadId: "paused-task",
        title: "Paused task",
        status: "interrupted",
        pausedByParentStop: true,
      },
      {
        ...baseSubagent,
        id: "task-stopped",
        childThreadId: "stopped-task",
        title: "Stopped task",
        status: "interrupted",
      },
      {
        ...baseSubagent,
        id: "wf-paused",
        childThreadId: "paused-workflow",
        title: "Paused workflow",
        status: "interrupted",
        pausedByParentStop: true,
        workflow: {
          name: "Paused workflow",
          phases: [{ index: 0, title: "Inspect" }],
          agents: [
            {
              index: 0,
              label: "paused-member",
              state: "running",
              phaseIndex: 0,
              phaseTitle: "Inspect",
              childThreadId: "paused-member-thread",
            },
            {
              index: 1,
              label: "done-member",
              state: "completed",
              phaseIndex: 0,
              phaseTitle: "Inspect",
              childThreadId: "done-member-thread",
            },
          ],
        },
      },
      {
        ...baseSubagent,
        id: "wf-stopped",
        childThreadId: "stopped-workflow",
        title: "Stopped workflow",
        status: "interrupted",
        workflow: {
          name: "Stopped workflow",
          phases: [{ index: 0, title: "Verify" }],
          agents: [
            {
              index: 0,
              label: "stopped-member",
              state: "running",
              phaseIndex: 0,
              phaseTitle: "Verify",
              childThreadId: "stopped-member-thread",
            },
          ],
        },
      },
    ],
  };
  await render(
    <ThreadRelationshipsPanel
      showLineage
      showSideChats
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />,
  );
  await click(groupToggle("Earlier"));
  await click(byLabel("Expand Paused workflow"));
  await click(byLabel("Expand Stopped workflow"));
  await click(byLabel("Expand Inspect phase, paused"));
  await click(byLabel("Expand Verify phase, stopped"));

  const pausedTaskButton = byLabel("Open Paused task chat");
  const pausedTaskRow = pausedTaskButton.closest("li")!;
  expect(pausedTaskButton.lastElementChild?.textContent).toBe("Paused");
  expect(pausedTaskRow.querySelector('[role="tooltip"]')?.textContent).toContain("Paused");

  const stoppedTaskButton = byLabel("Open Stopped task chat");
  const stoppedTaskRow = stoppedTaskButton.closest("li")!;
  expect(stoppedTaskButton.textContent).not.toContain("Paused");
  expect(stoppedTaskRow.querySelector('[role="tooltip"]')?.textContent).toContain("interrupted");
  expect(stoppedTaskRow.querySelector('[role="tooltip"]')?.textContent).not.toContain("Paused");

  const pausedMemberButton = byLabel("Open paused-member chat");
  const pausedMemberRow = pausedMemberButton.closest("li")!;
  expect(pausedMemberButton.lastElementChild?.textContent).toBe("Paused");
  expect(pausedMemberButton.querySelector(".sr-only")?.textContent).toBe("Paused");
  expect(pausedMemberRow.querySelector('[role="tooltip"]')?.textContent).toContain("Paused");

  const doneMemberButton = byLabel("Open done-member chat");
  const doneMemberRow = doneMemberButton.closest("li")!;
  expect(doneMemberButton.textContent).not.toContain("Paused");
  expect(doneMemberRow.querySelector('[role="tooltip"]')?.textContent).toContain("completed");

  const stoppedMemberButton = byLabel("Open stopped-member chat");
  const stoppedMemberRow = stoppedMemberButton.closest("li")!;
  expect(stoppedMemberButton.textContent).not.toContain("Paused");
  expect(stoppedMemberButton.querySelector(".sr-only")?.textContent).toBe("interrupted");
  expect(stoppedMemberRow.querySelector('[role="tooltip"]')?.textContent).toContain("interrupted");

  state.shells = [
    { environmentId: "test", source: pausedTaskThread },
    { environmentId: "test", source: stoppedTaskThread },
    {
      environmentId: "test",
      source: {
        ...pausedWorkflowThread,
        status: "running",
        activityRunStatus: "running",
        activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:02:00Z"),
        latestRunRequestedAt: DateTime.makeUnsafe("2026-09-16T12:02:00Z"),
      },
    },
    { environmentId: "test", source: stoppedWorkflowThread },
  ];
  await update();

  const resumedWorkflowButton = byLabel("Open Paused workflow chat");
  const resumedWorkflowRow = resumedWorkflowButton.closest("li")!;
  expect(resumedWorkflowButton.querySelector(".sr-only")?.textContent).not.toBe("Paused");
  expect(resumedWorkflowRow.querySelector('[role="tooltip"] .capitalize')?.textContent).toBe(
    "running",
  );

  await click(byLabel("Expand Paused workflow"));
  expect(byLabel("Collapse Inspect phase, running")).toBeDefined();
  const resumedMemberButton = byLabel("Open paused-member chat");
  const resumedMemberRow = resumedMemberButton.closest("li")!;
  expect(resumedMemberButton.textContent).not.toContain("Paused");
  expect(resumedMemberButton.querySelector(".sr-only")?.textContent).toBe("running");
  expect(resumedMemberRow.querySelector('[role="tooltip"]')?.textContent).toContain("running");
});
