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
    heading,
    buttonsWithLabel,
    textNodes,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

it("keeps managed advisor conversations in their own visible section through follow-ups and completion", async () => {
  await using fixture = await setup();
  const { render, update, click, byLabel, allByLabel, textNodes } = fixture;
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
    expect(text()).not.toContain("Previous agents");
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
  expect(text()).toContain("Previous agents");
  expect(text()).not.toContain("Advisors");
  expect(text()).toContain("Closed");
  expect(byLabel("Open Architecture advice chat")).toBeDefined();
});
