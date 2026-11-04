import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const fixtures = vi.hoisted(() => ({
  machines: null as unknown as Atom.Writable<ReadonlyArray<MachineFixture>>,
  lists: new Map<string, Atom.Writable<unknown>>(),
  upsert: vi.fn(),
}));

interface MachineFixture {
  readonly environmentId: string;
  readonly label: string;
  readonly phase: string;
}

vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const machines = Atom.make<ReadonlyArray<MachineFixture>>([]).pipe(Atom.keepAlive);
  fixtures.machines = machines;
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      environmentsAtom: Atom.map(machines, (list) =>
        list.map((machine) => ({
          environmentId: machine.environmentId,
          isEnabled: true,
          connectionState: machine.phase,
        })),
      ),
    },
    useEnvironmentPresentation: (environmentId: string | null) => {
      const list = useAtomValue(machines);
      const machine = list.find((candidate) => candidate.environmentId === environmentId);
      return {
        isReady: true,
        presentation: machine ? { connection: { phase: machine.phase } } : null,
      };
    },
  } as never;
});

vi.mock(import("../../state/environments"), async (original) => {
  const actual = await original();
  const project = (machine: MachineFixture) => ({
    environmentId: machine.environmentId,
    label: machine.label,
    connection: { phase: machine.phase },
  });
  return {
    ...actual,
    useEnvironments: () => ({
      isReady: true,
      environments: useAtomValue(fixtures.machines).map(project),
    }),
    useEnvironment: (environmentId: string) => {
      const machine = useAtomValue(fixtures.machines).find(
        (candidate) => candidate.environmentId === environmentId,
      );
      return machine ? project(machine) : null;
    },
  } as never;
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  const noValue = Atom.make(null);
  // Grants stay true throughout: only the connection state may turn these commands off.
  const command = { permissionAtom: () => granted };
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      championsLive: ({ environmentId }: { readonly environmentId: string }) =>
        fixtures.lists.get(environmentId),
      providersValueAtom: () => noValue,
      upsertChampion: command,
      setupChampion: command,
      refreshProviders: command,
    },
  } as never;
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => fixtures.upsert) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("../settings/useInstanceEntries"), async (original) => ({
  ...(await original()),
  useInstanceEntries: (() => ({ entries: [], providers: [], settings: {} })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));

import { ChampionsPage } from "./ChampionsPage";

const A = EnvironmentId.make("machine-a");
const B = EnvironmentId.make("machine-b");

const champion = (id: string, name: string, projectId: string): ChampionSummary => ({
  id,
  projectId: ProjectId.make(projectId),
  name,
  purpose: "Stay fast",
  schedule: { type: "fixed_time", timeOfDay: "06:00" },
  setupModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  routineModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "paused",
  ownerThreadId: ThreadId.make("owner"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: null,
  outstandingCheckId: null,
  outstandingSetupId: null,
  attention: [],
  openFindingCount: 0,
  pendingProposal: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const listed = (...champions: ReadonlyArray<ChampionSummary>) => AsyncResult.success({ champions });

const machines = (phaseOfA: string | null): ReadonlyArray<MachineFixture> => [
  ...(phaseOfA === null ? [] : [{ environmentId: A, label: "Studio", phase: phaseOfA }]),
  { environmentId: B, label: "Laptop", phase: "connected" },
];

async function setup() {
  fixtures.upsert.mockReset();
  fixtures.upsert.mockResolvedValue({ _tag: "Success", value: {} });
  const listA = Atom.make<unknown>(listed(champion("a", "Alpha", "project-a"))).pipe(
    Atom.keepAlive,
  );
  const listB = Atom.make<unknown>(listed(champion("b", "Bravo", "project-b"))).pipe(
    Atom.keepAlive,
  );
  fixtures.lists.set(A, listA);
  fixtures.lists.set(B, listB);
  // Wide enough to show the list pane beside the form, as both machines' rows are under test.
  await page.viewport(1200, 800);
  const registry = AtomRegistry.make();
  registry.set(fixtures.machines, machines("connected"));
  const screen = await render(
    <RegistryContext.Provider value={registry}>
      <ChampionsPage environmentId={A} id="a" view="edit" />
    </RegistryContext.Provider>,
  );
  const setPhaseOfA = (phase: string | null) =>
    act(() => registry.set(fixtures.machines, machines(phase)));
  return { screen, registry, listA, setPhaseOfA };
}

describe("ChampionsPage across a machine reconnect", () => {
  it("keeps the edit draft on machine A while B stays live, and saves to A once it returns", async () => {
    const { screen, registry, listA, setPhaseOfA } = await setup();
    await using _screen = screen;

    const purpose = page.getByLabelText("What should stay true?");
    await userEvent.fill(purpose, "Draft typed before the drop");
    const field = purpose.element();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect.element(save).toBeEnabled();

    await setPhaseOfA("reconnecting");

    expect(purpose.element()).toBe(field);
    await expect.element(purpose).toHaveValue("Draft typed before the drop");
    await expect.element(save).toBeDisabled();
    await expect.element(page.getByText("Reconnecting to Studio", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Saving is off until it connects. Your draft stays here."))
      .toBeVisible();
    await expect
      .element(page.getByText("Showing its last known champions", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: /Alpha/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Bravo/ })).toBeVisible();
    expect(fixtures.upsert).not.toHaveBeenCalled();

    await setPhaseOfA("connected");
    await act(() => registry.set(listA, listed(champion("a", "Alpha renamed live", "project-a"))));

    expect(purpose.element()).toBe(field);
    await expect.element(purpose).toHaveValue("Draft typed before the drop");
    await expect.element(page.getByRole("button", { name: /Alpha renamed live/ })).toBeVisible();
    await expect
      .element(page.getByText("Reconnecting to Studio", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(save).toBeEnabled();

    await userEvent.click(save);
    await vi.waitFor(() => expect(fixtures.upsert).toHaveBeenCalledTimes(1));
    expect(fixtures.upsert.mock.calls[0]?.[0]).toMatchObject({
      environmentId: A,
      input: {
        id: "a",
        projectId: "project-a",
        purpose: "Draft typed before the drop",
      },
    });
  });

  it("doesn't keep the form as if accessible once machine A is unregistered", async () => {
    const { screen, setPhaseOfA } = await setup();
    await using _screen = screen;
    await expect.element(page.getByLabelText("What should stay true?")).toBeVisible();

    await setPhaseOfA(null);

    await expect.element(page.getByLabelText("What should stay true?")).not.toBeInTheDocument();
    await expect.element(page.getByText("Its machine isn't connected")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Bravo/ })).toBeVisible();
  });
});
