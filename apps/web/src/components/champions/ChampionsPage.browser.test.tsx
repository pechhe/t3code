import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ChampionError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionActivity,
  type ChampionClassChoicesResult,
  type ChampionFinding,
  type ChampionRuntimeState,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

// One file because Vitest's browser mocks race when two running files mock the same modules.
const fixtures = vi.hoisted(() => ({
  machines: null as unknown as Atom.Writable<ReadonlyArray<MachineFixture>>,
  lists: new Map<string, Atom.Writable<unknown>>(),
  upsert: vi.fn(),
  commands: new Map<string, ReturnType<typeof vi.fn>>(),
  granted: null as unknown as Atom.Writable<boolean>,
  learning: vi.fn(),
  recommendation: vi.fn(),
  classChoices: vi.fn(),
  projects: [] as ReadonlyArray<unknown>,
}));

interface MachineFixture {
  readonly environmentId: string;
  readonly label: string;
  readonly phase: string;
}

vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const machines = Atom.make<ReadonlyArray<MachineFixture>>([
    { environmentId: "machine-a", label: "Studio", phase: "connected" },
  ]).pipe(Atom.keepAlive);
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
    useEnvironmentProviders: () => new Map(),
  } as never;
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  fixtures.granted = Atom.make(true).pipe(Atom.keepAlive);
  const noValue = Atom.make(null);
  const command = { permissionAtom: () => fixtures.granted };
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      championsLive: ({ environmentId }: { readonly environmentId: string }) =>
        fixtures.lists.get(environmentId),
      providersValueAtom: () => noValue,
      championFindingAction: command,
      cancelChampionInvestigation: command,
      upsertChampion: command,
      setupChampion: command,
      refreshProviders: command,
      championLearning: (target: unknown) => fixtures.learning(target),
      championRecommendation: (target: unknown) => fixtures.recommendation(target),
      championClassChoices: (target: unknown) => fixtures.classChoices(target),
    },
  } as never;
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: unknown, options: { readonly label: string }) => {
    const existing = fixtures.commands.get(options.label);
    if (existing) return existing;
    const created = vi.fn().mockResolvedValue({ _tag: "Success", value: {} });
    fixtures.commands.set(options.label, created);
    return created;
  }) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => fixtures.projects) as never,
}));
vi.mock(import("../settings/useInstanceEntries"), async (original) => ({
  ...(await original()),
  useInstanceEntries: (() => ({ entries: [], providers: [], settings: {} })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));

import { ChampionActivityList, ChampionDecisionList } from "./ChampionActivityList";
import { ChampionForm } from "./ChampionForm";
import { ChampionsPage } from "./ChampionsPage";

const PROJECT_A = { environmentId: "machine-a", id: "project-a", title: "Peach", isScratch: false };
const PROJECT_B = { environmentId: "machine-b", id: "project-b", title: "Plum", isScratch: false };

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
  fixtures.projects = [PROJECT_A];
  fixtures.commands.clear();
  fixtures.upsert.mockReset();
  fixtures.upsert.mockResolvedValue({ _tag: "Success", value: {} });
  fixtures.commands.set("champion save", fixtures.upsert);
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

    const purpose = page.getByLabelText("Goal");
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
    await expect.element(page.getByLabelText("Goal")).toBeVisible();

    await setPhaseOfA(null);

    await expect.element(page.getByLabelText("Goal")).not.toBeInTheDocument();
    await expect.element(page.getByText("Its machine isn't connected")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Bravo/ })).toBeVisible();
  });
});

const ENV = A;
const THREAD = ThreadId.make("owner");
const model = (name: string) => ({ instanceId: ProviderInstanceId.make("claude"), model: name });

const finding = (decision: ChampionFinding["decision"]): ChampionFinding => ({
  id: "f1",
  attemptId: "attempt",
  workId: "work",
  metricId: null,
  seriesId: null,
  title: "Private packages stay unpatched",
  evidence: "3 advisories are past their deadline.",
  status: "open",
  decision,
  repairAttention: null,
  childThreadId: null,
  specUrl: null,
  revision: null,
  delivery: null,
  updatedAt: "2026-11-05T10:00:00.000Z",
});

const decision = (id: string, recommendationId: string) => ({
  id,
  recommendationId,
  findingAttemptId: "attempt",
  proposedScope: "Only @acme.",
  question: "Should the owner extend the script?",
  status: "requested" as const,
  answer: null,
  requestedAt: "2026-11-05T10:00:00.000Z",
  resolvedAt: null,
});

const recommendation = (recommendationId: string, text: string, recordedAt: string) =>
  ({
    id: "c1",
    investigationId: "inv",
    recommendationId,
    expectedCurrentId: null,
    proposedScope: "Only @acme.",
    summary: "Summary text.",
    alternatives: "",
    benefits: "",
    tradeoffs: "",
    uncertainty: "",
    recommendation: text,
    findingId: "f1",
    findingAttemptId: "attempt",
    recordedAt,
  }) as ChampionRuntimeState["recommendations"][number];

const runtime = (patch: Partial<ChampionRuntimeState> = {}): ChampionRuntimeState => ({
  attempts: [],
  investigations: [],
  recommendations: [],
  ...patch,
});

function reset() {
  fixtures.projects = [PROJECT_A];
  fixtures.commands.clear();
  fixtures.learning.mockReset();
  fixtures.recommendation.mockReset();
  fixtures.recommendation.mockReturnValue(
    Atom.make(AsyncResult.failure(Cause.fail(new ChampionError({ reason: "not-found" })))),
  );
  fixtures.classChoices.mockReset();
}

function List(props: {
  readonly finding: ChampionFinding | null;
  readonly events?: ReadonlyArray<ChampionActivity>;
  readonly state: ChampionRuntimeState;
}) {
  const listProps = {
    environmentId: ENV,
    championId: "c1",
    view: {
      entries: [
        ...(props.finding
          ? [{ kind: "finding" as const, finding: props.finding, events: [], archived: false }]
          : []),
        ...(props.events ?? []).map((event) => ({ kind: "event" as const, event })),
      ],
      quiet: [],
    },
    loading: false,
    runtimeState: props.state,
    runtimeFailed: false,
    paused: false,
    onChanged: () => {},
  };
  return (
    <>
      <ChampionDecisionList {...listProps} />
      <ChampionActivityList {...listProps} />
    </>
  );
}

describe("answering a recommendation", () => {
  it("doesn't send a draft against a recommendation that changed, and keeps it", async () => {
    reset();
    const first = runtime({
      recommendations: [recommendation("r1", "Extend the script.", "2026-11-05T09:00:00.000Z")],
    });
    await using screen = await render(
      <List finding={finding(decision("d1", "r1"))} state={first} />,
    );
    await expect.element(page.getByText("Extend the script.")).toBeVisible();
    await expect.element(page.getByText("Why", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Answer", exact: true }));
    const box = page.getByLabelText("Your answer");
    await userEvent.fill(box, "Yes, go ahead");

    await screen.rerender(
      <List
        finding={finding(decision("d2", "r2"))}
        state={runtime({
          recommendations: [
            recommendation("r2", "Rotate the token first.", "2026-11-05T11:00:00.000Z"),
            recommendation("r1", "Extend the script.", "2026-11-05T09:00:00.000Z"),
          ],
        })}
      />,
    );

    await expect.element(page.getByText("Rotate the token first.")).toBeVisible();
    await expect.element(box).toHaveValue("Yes, go ahead");
    await expect.element(page.getByText(/so your answer wasn't sent/)).toBeVisible();
    const send = page.getByRole("button", { name: "Send my answer" });
    await expect.element(send).toBeDisabled();
    expect(fixtures.commands.get("champion decision answer")).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Keep my answer for this version" }));
    await userEvent.click(send);
    await vi.waitFor(() =>
      expect(fixtures.commands.get("champion decision answer")).toHaveBeenCalledTimes(1),
    );
    expect(fixtures.commands.get("champion decision answer")?.mock.calls[0]?.[0]).toMatchObject({
      environmentId: ENV,
      input: {
        action: "resolve_decision",
        decisionId: "d2",
        recommendationId: "r2",
        reason: "Yes, go ahead",
      },
    });
  });

  it("shows the whole of a long question and recommendation before you answer", async () => {
    reset();
    const question = `${"Phi refused for browser, ui-verifier and ui-worker. ".repeat(6)}Recommend B.`;
    const advice = `${"Keep the trial reversible and the methods unchanged. ".repeat(8)}Report back.`;
    await using _screen = await render(
      <List
        finding={finding({ ...decision("d1", "r1"), question })}
        state={runtime({
          recommendations: [recommendation("r1", advice, "2026-11-05T09:00:00.000Z")],
        })}
      />,
    );
    await page.viewport(620, 700);
    for (const text of [question, advice]) {
      const shown = page.getByText(text, { exact: true });
      await expect.element(shown).toBeVisible();
      const element = shown.element();
      expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight);
    }
  });

  it("approves a proposal in one click and opens a box only to answer differently", async () => {
    reset();
    const proposed = {
      ...decision("d1", "r1"),
      proposal: {
        action: "Measure over 7 days.",
        why: "A day has too few reads.",
        otherOptions: "Lower the bar (noisy)",
      },
    };
    await using _screen = await render(
      <List
        finding={finding(proposed)}
        state={runtime({
          recommendations: [recommendation("r1", "Extend the script.", "2026-11-05T09:00:00.000Z")],
        })}
      />,
    );
    await expect.element(page.getByText("Measure over 7 days.")).toBeVisible();
    await expect.element(page.getByText(/Lower the bar/)).not.toBeInTheDocument();
    await expect.element(page.getByLabelText("Your answer")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Answer differently" }));
    await expect.element(page.getByLabelText("Your answer")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await userEvent.click(page.getByRole("button", { name: "Approve proposed" }));
    await vi.waitFor(() =>
      expect(fixtures.commands.get("champion decision answer")).toHaveBeenCalledTimes(1),
    );
    expect(fixtures.commands.get("champion decision answer")?.mock.calls[0]?.[0]).toMatchObject({
      input: {
        action: "resolve_decision",
        decisionId: "d1",
        reason: "Approved: Measure over 7 days.",
      },
    });
  });

  it("shows an approval an agent relayed as the person's, with its thread, time and words", async () => {
    reset();
    const approval = {
      quote: "can you do all of that for me?",
      threadId: ThreadId.make("performance-pass"),
      threadTitle: "Performance pass",
      model: "claude-opus-5-5",
      approvedAt: "2026-11-07T16:00:00.000Z",
    };
    await using _screen = await render(
      <List
        finding={finding({
          ...decision("d1", "r1"),
          status: "resolved",
          answer: "Approved: Measure over 7 days.",
          resolvedAt: "2026-11-07T16:00:00.000Z",
          approval,
        })}
        events={[
          {
            id: "e-accepted",
            championId: "c1",
            at: "2026-11-07T16:00:00.000Z",
            kind: "metrics-accepted",
            text: "Read speed now over 7 days.",
            findingId: null,
            threadId: approval.threadId,
            revision: null,
            specUrl: null,
            approval,
          },
        ]}
        state={runtime({
          recommendations: [recommendation("r1", "Extend the script.", "2026-11-05T09:00:00.000Z")],
        })}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: /Private packages stay unpatched/ }));
    await userEvent.click(page.getByRole("button", { name: /Metrics accepted/ }));
    const lines = page.getByText("Approved by you");
    await expect.element(lines.nth(0)).toBeVisible();
    await expect.element(lines.nth(1)).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Performance pass" }).nth(1)).toBeVisible();
    await expect.element(page.getByText(approval.quote).nth(1)).toBeVisible();
  });

  it("keeps the draft when the server says it arrived too late", async () => {
    reset();
    const onChanged = vi.fn();
    const answer = vi.fn().mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new ChampionError({ reason: "conflict" })),
    });
    fixtures.commands.set("champion decision answer", answer);
    await using _screen = await render(
      <ChampionDecisionList
        environmentId={ENV}
        championId="c1"
        view={{
          entries: [
            {
              kind: "finding",
              finding: finding(decision("d1", "r1")),
              events: [],
              archived: false,
            },
          ],
          quiet: [],
        }}
        loading={false}
        runtimeState={runtime({
          recommendations: [recommendation("r1", "Extend it.", "2026-11-05T09:00:00.000Z")],
        })}
        runtimeFailed={false}
        paused={false}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Answer", exact: true }));
    await userEvent.fill(page.getByLabelText("Your answer"), "Go");
    await userEvent.click(page.getByRole("button", { name: "Send my answer" }));
    await expect.element(page.getByText(/before your answer arrived/)).toBeVisible();
    await expect.element(page.getByLabelText("Your answer")).toHaveValue("Go");
    expect(onChanged).toHaveBeenCalled();
    expect(fixtures.recommendation).not.toHaveBeenCalled();
  });

  it("recovers an older decision's exact recommendation outside the recent window", async () => {
    reset();
    fixtures.recommendation.mockReturnValue(
      Atom.make(
        AsyncResult.success(recommendation("r1", "Extend the script.", "2026-11-05T09:00:00.000Z")),
      ),
    );
    await using _screen = await render(
      <List finding={finding(decision("d1", "r1"))} state={runtime()} />,
    );
    await expect.element(page.getByText("Extend the script.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Answer", exact: true }));
    await userEvent.fill(page.getByLabelText("Your answer"), "Go");
    await expect.element(page.getByRole("button", { name: "Send my answer" })).toBeEnabled();
    expect(fixtures.recommendation).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { id: "c1", findingId: "f1", findingAttemptId: "attempt", recommendationId: "r1" },
    });
  });

  it("won't take an answer to a recommendation it can't show", async () => {
    reset();
    await using _screen = await render(
      <List finding={finding(decision("d1", "gone"))} state={runtime()} />,
    );
    await expect.element(page.getByRole("button", { name: "Answer", exact: true })).toBeDisabled();
  });

  it("turns answering off while the device lacks permission or the machine is away", async () => {
    reset();
    const state = runtime({
      recommendations: [recommendation("r1", "Extend it.", "2026-11-05T09:00:00.000Z")],
    });
    const registry = AtomRegistry.make();
    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <List finding={finding(decision("d1", "r1"))} state={state} />
      </RegistryContext.Provider>,
    );
    await userEvent.click(page.getByRole("button", { name: "Answer", exact: true }));
    await userEvent.fill(page.getByLabelText("Your answer"), "Go");
    const send = page.getByRole("button", { name: "Send my answer" });
    await expect.element(send).toBeEnabled();
    await act(() => registry.set(fixtures.machines, machines("reconnecting")));
    await expect.element(send).toBeDisabled();
    await expect.element(page.getByLabelText("Your answer")).toHaveValue("Go");
    await act(() => registry.set(fixtures.machines, machines("connected")));
    await act(() => registry.set(fixtures.granted, false));
    await expect.element(send).toBeDisabled();
  });
});

describe("research on a finding", () => {
  const investigation = (status: "open" | "cancel_requested") =>
    ({
      id: "c1",
      findingId: "f1",
      investigationId: "inv",
      question: "How?",
      topic: "Updates",
      status,
      attention: null,
      branches: [
        { id: "a", role: "researcher", hypothesis: "Extend the script", evidenceNeeds: "" },
        { id: "b", role: "scout", hypothesis: "Use the feed", evidenceNeeds: "" },
      ],
      attempts: [
        {
          id: "1",
          branchId: "a",
          state: "accepted",
          role: "researcher",
          admittedAt: "2026-11-05T09:00:00.000Z",
          resolvedSelection: model("resolved"),
          actualSelection: null,
          childThreadId: THREAD,
        },
      ],
    }) as unknown as ChampionRuntimeState["investigations"][number];

  it("asks why, sends a stable request and stays requested until the server confirms", async () => {
    reset();
    const cancel = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new ChampionError({ reason: "unavailable" })),
      })
      .mockResolvedValue({ _tag: "Success", value: {} });
    fixtures.commands.set("champion cancel investigation", cancel);
    await using screen = await render(
      <List finding={finding(null)} state={runtime({ investigations: [investigation("open")] })} />,
    );
    await userEvent.click(page.getByRole("button", { name: /Private packages/ }));
    await expect
      .element(page.getByText("Researching 2 options · 1 task running"))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Cancel research" }));
    await userEvent.fill(page.getByLabelText("Why cancel this?"), "Waiting for the upgrade");
    await userEvent.click(page.getByRole("button", { name: "Request cancel" }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Request cancel" }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    const [firstCall, secondCall] = cancel.mock.calls;
    expect(firstCall?.[0].input.requestId).toBe(secondCall?.[0].input.requestId);
    expect(secondCall?.[0]).toMatchObject({
      environmentId: ENV,
      input: { id: "c1", investigationId: "inv", reason: "Waiting for the upgrade" },
    });

    await expect.element(page.getByText(/Cancel requested\. It stays/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Cancel research" }))
      .not.toBeInTheDocument();

    await screen.rerender(
      <List
        finding={finding(null)}
        state={runtime({ investigations: [investigation("cancel_requested")] })}
      />,
    );
    await expect
      .element(page.getByText("Cancel requested · 1 task not yet stopped"))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });
});

describe("a learning note in Activity", () => {
  const event = (patch: Partial<ChampionActivity>): ChampionActivity => ({
    id: "e1",
    championId: "c1",
    at: "2026-09-12T10:00:00.000Z",
    kind: "learning-recorded",
    text: "Tool X lacked required auth support in version 1.",
    findingId: null,
    threadId: THREAD,
    revision: null,
    specUrl: null,
    ...patch,
  });
  const learningRef = { learningId: "l1", revisionId: "old", topic: "Tool X auth" };
  const revision = {
    id: "old",
    learningId: "l1",
    evidence: [
      { source: "Trial", evidence: "Refused at login.", observedAt: "2026-09-11T00:00:00.000Z" },
    ],
    attempts: [],
    applicability: "",
    tradeoffs: "",
    reviewAt: null,
    reviewConditions: ["Tool X adds scoped tokens"],
    versionConditions: [],
    isCurrent: false,
    applicabilityState: "uncertain",
  };
  const answered = (revisions: ReadonlyArray<unknown>) =>
    Atom.make(
      AsyncResult.success({ revisions, nextCursor: null, receiptId: "x", retrievedAt: "" }),
    );

  it("fetches only when opened, asks for that exact revision and shows it as history", async () => {
    reset();
    fixtures.learning.mockReturnValue(answered([revision]));
    await using _screen = await render(
      <List finding={null} events={[event({ learningRef })]} state={runtime()} />,
    );
    expect(fixtures.learning).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: /Learned/ }));
    await expect
      .element(page.getByText("We'll reconsider if Tool X adds scoped tokens."))
      .toBeVisible();
    await expect.element(page.getByText(/newer note has replaced this one/)).toBeVisible();
    expect(fixtures.learning.mock.calls[0]?.[0]).toEqual({
      environmentId: ENV,
      input: { id: "c1", topic: "Tool X auth", revisionId: "old", observations: [] },
    });
    await expect.element(page.getByPlaceholder(/topic/i)).not.toBeInTheDocument();
  });

  it("won't pass off the current head as the note it was asked about", async () => {
    reset();
    fixtures.learning.mockReturnValue(
      answered([{ ...revision, id: "head", isCurrent: true, applicabilityState: "current" }]),
    );
    await using _screen = await render(
      <List finding={null} events={[event({ learningRef })]} state={runtime()} />,
    );
    await userEvent.click(page.getByRole("button", { name: /Learned/ }));
    await expect
      .element(page.getByText("Its source isn't available on this machine."))
      .toBeVisible();
    await expect
      .element(page.getByText("Refused at login.", { exact: false }))
      .not.toBeInTheDocument();
  });

  it("shows an older event without a reference as it is, fetching nothing", async () => {
    reset();
    await using _screen = await render(
      <List
        finding={null}
        events={[event({ text: "Recorded learning 123." })]}
        state={runtime()}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: /Learned/ }));
    expect(fixtures.learning).not.toHaveBeenCalled();
  });
});

describe("the champion form's roles", () => {
  const choices = (
    roles: ChampionClassChoicesResult["roles"],
    refusal: string | null = null,
  ): ChampionClassChoicesResult => ({
    policyHash: refusal ? null : "h",
    policyRevision: refusal ? null : "r",
    refusal,
    roles,
  });
  const answering = (nonUi: ChampionClassChoicesResult) =>
    fixtures.classChoices.mockImplementation(
      (target: { readonly input: { readonly taskClass: string } }) =>
        Atom.make(AsyncResult.success(target.input.taskClass === "non-ui" ? nonUi : choices([]))),
    );
  const eligible = choices([
    { role: "advisor", selection: model("strong"), refusal: null },
    { role: "chore-worker", selection: model("light"), refusal: null },
  ]);

  it("saves a new champion's default roles with the server's selections, not a guess", async () => {
    reset();
    answering(eligible);
    await using _screen = await render(<ChampionForm existing={null} onDone={() => {}} />);
    await userEvent.fill(page.getByLabelText("Goal"), "Stay safe");
    await userEvent.click(page.getByRole("button", { name: "Add metrics myself" }));
    await vi.waitFor(() => expect(fixtures.commands.get("champion save")).toHaveBeenCalledTimes(1));
    expect(fixtures.commands.get("champion save")?.mock.calls[0]?.[0]).toMatchObject({
      environmentId: ENV,
      input: {
        projectId: "project-a",
        classes: {
          setup: { role: "advisor", taskClass: "non-ui" },
          routine: { role: "chore-worker", taskClass: "non-ui" },
        },
        setupModelSelection: model("strong"),
        routineModelSelection: model("light"),
      },
    });
    expect(fixtures.classChoices.mock.calls.map(([target]) => target.input.phase)).toEqual(
      expect.arrayContaining(["setup", "routine"]),
    );
  });

  it("shows the server's reason and blocks a new champion when a role can't run", async () => {
    reset();
    answering(
      choices([
        { role: "advisor", selection: null, refusal: "Nothing eligible for this role." },
        { role: "chore-worker", selection: model("light"), refusal: null },
      ]),
    );
    await using _screen = await render(<ChampionForm existing={null} onDone={() => {}} />);
    await expect
      .element(page.getByText(/Nothing eligible for this role\.\s+Nothing was switched/))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Propose metrics" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Add metrics myself" })).toBeDisabled();
    expect(fixtures.commands.get("champion save")).not.toHaveBeenCalled();
  });

  it("blocks a new champion when policy is unavailable, rather than choosing a model", async () => {
    reset();
    answering(choices([], "Agent class policy is unavailable on this machine."));
    await using _screen = await render(<ChampionForm existing={null} onDone={() => {}} />);
    await expect.element(page.getByRole("button", { name: "Propose metrics" })).toBeDisabled();
    await expect
      .element(page.getByText(/Agent class policy is unavailable on this machine\.\s+Nothing/))
      .toBeVisible();
  });

  it("never lets machine A's choices, even late ones, stand in for machine B's", async () => {
    reset();
    fixtures.projects = [PROJECT_A, PROJECT_B];
    const registry = AtomRegistry.make();
    registry.set(fixtures.machines, machines("connected"));
    const atoms = new Map<string, Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>>>();
    const atomOf = (environmentId: string, projectId: string, taskClass: string, phase: string) => {
      const key = `${environmentId}|${projectId}|${taskClass}|${phase}`;
      const existing = atoms.get(key);
      if (existing) return existing;
      const created = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
        AsyncResult.initial(true),
      ).pipe(Atom.keepAlive);
      atoms.set(key, created);
      return created;
    };
    fixtures.classChoices.mockImplementation(
      (target: {
        readonly environmentId: string;
        readonly input: {
          readonly projectId: string;
          readonly taskClass: string;
          readonly phase: string;
        };
      }) =>
        atomOf(
          target.environmentId,
          target.input.projectId,
          target.input.taskClass,
          target.input.phase,
        ),
    );
    const answer = (
      environmentId: string,
      projectId: string,
      roles: ChampionClassChoicesResult["roles"],
    ) =>
      act(() => {
        for (const phase of ["setup", "routine"]) {
          registry.set(
            atomOf(environmentId, projectId, "non-ui", phase),
            AsyncResult.success(choices(roles)),
          );
          registry.set(
            atomOf(environmentId, projectId, "ui", phase),
            AsyncResult.success(choices([])),
          );
        }
      });
    const eligibleOn = (machine: string) =>
      choices([
        { role: "advisor", selection: model(`${machine}-strong`), refusal: null },
        { role: "chore-worker", selection: model(`${machine}-light`), refusal: null },
        { role: "researcher", selection: model(`${machine}-research`), refusal: null },
      ]).roles;

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ChampionForm existing={null} onDone={() => {}} />
      </RegistryContext.Provider>,
    );
    await userEvent.fill(page.getByLabelText("Goal"), "Stay safe");
    const pickProject = async (name: string) => {
      await userEvent.click(page.getByRole("combobox", { name: "Project" }));
      await userEvent.click(page.getByRole("option", { name: new RegExp(name) }));
    };
    const save = page.getByRole("button", { name: "Add metrics myself" });

    await pickProject("Peach");
    await expect.element(save).toBeDisabled();
    await answer(A, "project-a", eligibleOn("a"));
    await expect.element(save).toBeEnabled();

    await userEvent.click(page.getByRole("button", { name: "Advanced settings" }));
    await userEvent.click(page.getByRole("combobox", { name: "Routine checks use" }));
    await userEvent.click(page.getByRole("option", { name: /Researcher/ }));

    await pickProject("Plum");
    await expect.element(save).toBeDisabled();

    await answer(A, "project-a", [
      { role: "advisor", selection: model("late-a"), refusal: null },
      { role: "researcher", selection: model("late-a"), refusal: null },
    ]);
    await expect.element(save).toBeDisabled();
    await expect.element(page.getByText("Checking your role policy…").first()).toBeVisible();

    await answer(B, "project-b", [
      { role: "advisor", selection: model("b-strong"), refusal: null },
      { role: "researcher", selection: null, refusal: "Researcher can't run on Laptop." },
    ]);
    await expect
      .element(page.getByText(/Researcher can't run on Laptop\.\s+Nothing/))
      .toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Routine checks use" }))
      .toHaveTextContent("Researcher");
    await expect.element(save).toBeDisabled();
    expect(fixtures.commands.get("champion save")).not.toHaveBeenCalled();

    await answer(B, "project-b", eligibleOn("b"));
    await expect.element(save).toBeEnabled();
    await userEvent.click(save);
    await vi.waitFor(() => expect(fixtures.commands.get("champion save")).toHaveBeenCalledTimes(1));
    const call = fixtures.commands.get("champion save")?.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      environmentId: B,
      input: {
        projectId: "project-b",
        classes: {
          setup: { role: "advisor", taskClass: "non-ui" },
          routine: { role: "researcher", taskClass: "non-ui" },
        },
        setupModelSelection: model("b-strong"),
        routineModelSelection: model("b-research"),
      },
    });
  });

  const saved = (classes: ChampionSummary["classes"]): ChampionSummary =>
    ({
      id: "c1",
      projectId: ProjectId.make("project-a"),
      name: "Keeper",
      purpose: "Stay safe",
      schedule: { type: "fixed_time", timeOfDay: "06:00" },
      ...(classes ? { classes } : {}),
      setupModelSelection: model("history-setup"),
      routineModelSelection: model("history-routine"),
      charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
    }) as unknown as ChampionSummary;

  it("keeps a saved role the policy now refuses, scoped to this champion, and saves it", async () => {
    reset();
    answering(
      choices([
        { role: "advisor", selection: null, refusal: "Nothing eligible for this role." },
        { role: "chore-worker", selection: model("light"), refusal: null },
      ]),
    );
    const classes = {
      setup: { role: "advisor", taskClass: "non-ui" },
      routine: { role: "chore-worker", taskClass: "non-ui" },
    } as const;
    await using _screen = await render(
      <ChampionForm
        existing={{ environmentId: ENV, champion: saved(classes) }}
        onDone={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Advanced settings" }));
    await expect.element(page.getByText(/Nothing eligible for this role/)).toBeVisible();
    await expect
      .element(page.getByText("Follows your role policy.", { exact: false }))
      .toBeVisible();
    expect(fixtures.classChoices.mock.calls[0]?.[0].input.championId).toBe("c1");
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await vi.waitFor(() => expect(fixtures.commands.get("champion save")).toHaveBeenCalledTimes(1));
    expect(fixtures.commands.get("champion save")?.mock.calls[0]?.[0].input).toMatchObject({
      classes,
      setupModelSelection: model("history-setup"),
    });
  });

  it("leaves a fixed-model champion alone until it's explicitly converted", async () => {
    reset();
    answering(eligible);
    await using _screen = await render(
      <ChampionForm
        existing={{ environmentId: ENV, champion: saved(undefined) }}
        onDone={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Advanced settings" }));
    await expect.element(page.getByText("This champion uses fixed models")).toBeVisible();
    expect(fixtures.classChoices).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Follow role policy instead" }));
    await expect.element(page.getByText(/Both fields now follow role policy/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await vi.waitFor(() => expect(fixtures.commands.get("champion save")).toHaveBeenCalledTimes(1));
    expect(fixtures.commands.get("champion save")?.mock.calls[0]?.[0].input).toMatchObject({
      classes: {
        setup: { role: "advisor", taskClass: "non-ui" },
        routine: { role: "chore-worker", taskClass: "non-ui" },
      },
      setupModelSelection: model("history-setup"),
      routineModelSelection: model("history-routine"),
    });
  });
});
