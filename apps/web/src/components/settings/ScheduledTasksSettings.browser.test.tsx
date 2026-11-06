import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const state = vi.hoisted(() => ({ connected: true, tasksLoaded: true, taskDeleted: false }));
const permissions = new Map<string, Atom.Writable<boolean>>();
const commands: Array<Record<string, unknown>> = [];
/** Inputs the editor asked to save; deletes and run-now calls carry no prompt. */
const savedTaskInputs = () =>
  commands.filter((input): input is ScheduledTaskUpsertInput => "prompt" in input);

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.taskDeleted = false;
  commands.length = 0;
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? { environment: { platform: "linux", capabilities: { oneTimeSchedules: true } } }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: [entry],
      connectedEnvironments: state.connected ? [entry] : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      agentPolicyRead: ((input: unknown) => ({ policy: input })) as never,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : typeof request === "object" && "policy" in request
          ? { snapshot: { manifest: { roles: {}, lists: {}, models: {} } } }
          : { tasks: state.tasksLoaded ? [task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/scheduledTasks"), async (original) => ({
  ...(await original()),
  useAllScheduledTasks: (() =>
    state.connected
      ? [
          {
            environmentId,
            tasks: state.taskDeleted ? [] : state.tasksLoaded ? [task] : null,
            error: null,
          },
        ]
      : []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => environment()) as never,
  useEnvironments: (() => ({
    isReady: true,
    networkStatus: "online",
    environments: state.connected ? [environment()] : [],
    presentationById: new Map(),
  })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: projectId, environmentId, title: "Project", workspaceRoot: "/repo" },
  ]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
// Records what the editor asks the server to save, which the real command needs a connection for.
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: unknown) => async (args: { input: Record<string, unknown> }) => {
    commands.push(args.input);
    return { _tag: "Success", value: undefined };
  }) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("lists the tasks on connected machines and opens the linked one", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByText("1 task")).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Task name" }))
      .toHaveValue("Review issues");
  });

  it("follows the permission to change tasks on the machine it runs on", async () => {
    setup();
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings taskId={task.id} />
      </RegistryContext.Provider>,
    );
    const save = page.getByRole("button", { name: "Save" });
    await expect.element(save).toBeEnabled();
    await act(() => registry.set(permissions.get(environmentId)!, false));
    await expect.element(save).toBeDisabled();
    await act(() => registry.set(permissions.get(environmentId)!, true));
    await expect.element(save).toBeEnabled();
  });

  it("opens an empty task from New task", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveValue("");
    await expect.element(page.getByRole("button", { name: "Create task" })).toBeVisible();
  });

  it("asks for a machine when none is connected", async () => {
    setup();
    state.connected = false;
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByText("No machines connected")).toBeVisible();
  });

  it("allows New task only with a connected machine permitted to create one", async () => {
    setup();
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = page.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(environmentId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(environmentId)!, true));
    await expect.element(create).toBeEnabled();

    state.connected = false;
    await screen.rerender(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    await expect.element(create).toBeDisabled();
  });

  it("still edits the same task after a disconnect, while its list reloads", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const name = page.getByRole("textbox", { name: "Task name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
    await expect.element(page.getByRole("button", { name: "Create task" })).not.toBeInTheDocument();

    state.connected = true;
    state.tasksLoaded = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
    await expect.element(page.getByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  it("does not keep a task's draft to recreate it once the task is deleted", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const name = page.getByRole("textbox", { name: "Task name" });
    await userEvent.fill(name, "Review stale issues");

    state.taskDeleted = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("");
  });

  it("keeps a task the user started when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const name = page.getByRole("textbox", { name: "Task name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("My draft");
    await expect.element(page.getByRole("button", { name: "Create task" })).toBeVisible();
  });

  it("saves the thread a bound task already runs in, carrying on", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(savedTaskInputs()).toHaveLength(1));
    expect(savedTaskInputs()[0]).toMatchObject({
      threadId: task.threadId,
      threadMode: "continue",
    });
  });

  it("saves a fresh session in the task's thread when the editor chooses it", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("combobox", { name: "Where each run posts" }));
    await userEvent.click(
      page.getByRole("option", { name: "one thread, a fresh session each run" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(savedTaskInputs()).toHaveLength(1));
    expect(savedTaskInputs()[0]).toMatchObject({
      threadId: task.threadId,
      threadMode: "fresh_session",
    });
  });

  it("starts a new thread each run when the editor chooses it", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("combobox", { name: "Where each run posts" }));
    await userEvent.click(page.getByRole("option", { name: "a new thread each run" }));
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(savedTaskInputs()).toHaveLength(1));
    expect(savedTaskInputs()[0]).toMatchObject({ threadId: null, threadMode: "new_thread" });
  });
});
