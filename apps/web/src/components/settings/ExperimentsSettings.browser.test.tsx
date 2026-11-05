import "../../index.css";

import { type ReactNode } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ExperimentError,
  ProjectId,
  ProviderInstanceId,
  type AgentPolicyManifest,
  type Experiment,
  type ExperimentAssignmentReport,
  type ExperimentResults,
  type ExperimentVariantResults,
} from "@t3tools/contracts";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  trials: [] as unknown[],
  results: null as unknown,
  report: null as unknown,
  manifest: null as unknown,
  environments: [] as unknown[],
  projects: [] as unknown[],
  create: vi.fn(),
  transition: vi.fn(),
  adopt: vi.fn(),
  record: vi.fn(),
}));
const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    experimentsList: () => ({ kind: "list" }),
    experimentsResults: () => ({ kind: "results" }),
    experimentsReport: () => ({ kind: "report" }),
    experimentsCreate: { permissionAtom: () => ({}), tag: "create" },
    experimentsTransition: { permissionAtom: () => ({}), tag: "transition" },
    experimentsAdopt: { permissionAtom: () => ({}), tag: "adopt" },
    experimentsRecordOutcome: { permissionAtom: () => ({}), tag: "record" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "list"
        ? state.trials
        : atom?.kind === "results"
          ? state.results
          : atom?.kind === "report"
            ? state.report
            : null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { tag: "create" | "transition" | "adopt" | "record" }) =>
    state[command.tag],
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environments: state.environments }),
}));
vi.mock("./useAgentPolicies", () => ({
  useAgentPolicies: () => ({
    policies: [
      {
        environmentId: "env",
        canEdit: true,
        data: { snapshot: { manifest: state.manifest } },
        error: null,
        isPending: false,
      },
    ],
    reload: () => undefined,
  }),
}));
vi.mock("./useInstanceEntries", () => ({
  useInstanceEntries: () => ({
    settings: {},
    providers: [
      {
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        auth: { status: "authenticated" },
        models: [
          {
            slug: "gpt-sol",
            name: "GPT-6.1 Sol",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  type: "select",
                  label: "Effort",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
    entries: [
      {
        instanceId: "codex",
        driverKind: "codex",
        isDefault: true,
        models: [{ slug: "gpt-sol", name: "GPT-6.1 Sol" }],
      },
    ],
  }),
}));
vi.mock("./ExperimentTrialModelPicker", () => ({
  TrialModelPicker: ({ selection }: { selection: { model: string } | null }) => (
    <button type="button">{selection?.model ?? "Choose model"}</button>
  ),
}));
vi.mock("../ModelLabel", () => ({ ModelLabel: ({ model }: { model: string }) => model }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: () => undefined },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: passthrough,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));

import { ExperimentsSettings } from "./ExperimentsSettings";

const environmentId = EnvironmentId.make("env");
const project = ProjectId.make("project-1");
const codex = ProviderInstanceId.make("codex");
const solAt = (value: string) => ({
  instanceId: codex,
  model: "gpt-sol",
  options: [{ id: "reasoningEffort", value }],
});

const manifest = {
  version: 2,
  revision: "fixture",
  models: {
    sol: { driverKind: "codex", model: "gpt-sol", effortOption: "reasoningEffort" },
  },
  lists: { review: [{ model: "sol", effort: "medium" }] },
  roles: { reviewer: { list: "review", specList: "review" } },
} as unknown as AgentPolicyManifest;

const trial = (overrides: Partial<Experiment> = {}): Experiment => ({
  id: "trial-1",
  title: "Reviewer: Sol medium or Sol high",
  question: "Which finds more?",
  lever: "reviewer",
  primaryOutcome: "Confirmed blockers",
  variants: [
    { id: "a", label: "GPT-6.1 Sol medium", modelSelection: solAt("medium") },
    { id: "b", label: "GPT-6.1 Sol high", modelSelection: solAt("high") },
  ],
  eligibility: {
    projectIds: [project],
    models: [],
    taskCategories: [],
    reviewScopes: ["change"],
    agentRoles: ["reviewer"],
  },
  maxAssignments: 40,
  endsAt: "2027-02-01T00:00:00.000Z",
  stopConditions: [],
  codeRevision: null,
  briefRevision: null,
  revision: 1,
  status: "running",
  createdAt: "2026-10-01T00:00:00.000Z",
  startedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const variantResults = (
  overrides: Partial<ExperimentVariantResults> = {},
): ExperimentVariantResults => ({
  variantId: "a",
  label: "GPT-6.1 Sol medium",
  enrolled: 12,
  tokens: { value: 24_000, covered: 8 },
  confirmedBlockers: { value: null, covered: 0 },
  falsePositives: { value: 0, covered: 7 },
  sentBack: { value: 3, covered: 12 },
  problemsAfterLanding: { value: null, covered: 0 },
  landingWindowsComplete: 2,
  delegatedHelpers: { value: null, covered: 0 },
  enteredByHand: 0,
  tooFewResults: true,
  ...overrides,
});

const results = (overrides: Partial<ExperimentResults> = {}): ExperimentResults => ({
  experimentId: "trial-1",
  variants: [
    variantResults(),
    variantResults({ variantId: "b", label: "GPT-6.1 Sol high", enrolled: 11 }),
  ],
  samples: [],
  totalSamples: 23,
  offset: 0,
  hasMore: false,
  enoughPerVariant: 20,
  forgeReadable: true,
  readAt: "2026-11-05T00:00:00.000Z",
  ...overrides,
});

function setup(trials: ReadonlyArray<Experiment>, shown: ExperimentResults | null = results()) {
  state.trials = [...trials];
  state.results = shown;
  state.report = null;
  state.manifest = manifest;
  state.environments = [{ environmentId, label: "Test Mac", connection: { phase: "connected" } }];
  state.projects = [{ id: project, environmentId, title: "T3 Peach" }];
  state.create.mockReset();
  state.transition.mockReset();
  state.adopt.mockReset();
  state.record.mockReset();
  state.create.mockImplementation(async ({ input }: { input: unknown }) =>
    AsyncResult.success(input),
  );
  state.transition.mockImplementation(async () => AsyncResult.success(trials[0]));
}

const refused = (detail?: string) =>
  AsyncResult.failure(
    Cause.fail(
      new ExperimentError({
        operation: "transition",
        reason: "conflict",
        entityId: "trial-1",
        ...(detail === undefined ? {} : { detail }),
      }),
    ),
  );

async function click(name: string) {
  await userEvent.click(document.querySelector(`[data-testid="${name}"]`) ?? byText(name));
}

function byText(name: string): HTMLElement {
  const candidates = [...document.querySelectorAll<HTMLElement>("button, label, a")];
  const match = candidates.find((element) => element.textContent?.trim() === name);
  if (!match) throw new Error(`Nothing named ${name}`);
  return match;
}

const hasButton = (name: string) =>
  [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === name);

const pageText = () => document.body.textContent ?? "";

const rowCells = (row: string) =>
  [...document.querySelectorAll(`[data-row="${row}"] td`)].map((cell) => cell.textContent ?? "");

it("groups trials and shows real figures in the list", async () => {
  setup([trial(), trial({ id: "draft", status: "draft", startedAt: null, title: "A draft" })]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(pageText()).toContain("Reviewer: Sol medium or Sol high"));
  expect(pageText()).toContain("23 of 40 tasks");
  expect(pageText()).toContain("12 enrolled · blockers unknown · 3k tokens per task");
  expect(pageText()).toContain("Too few results to conclude");
  expect(pageText()).toContain("A draft");
  expect(pageText()).toContain("Nothing has finished yet.");
});

it("clamps a long question to two lines in the list and shows all of it on the trial's page", async () => {
  const question = Array.from(
    { length: 8 },
    (_, index) => `Paragraph ${index} of a very long question about what this trial should answer.`,
  ).join("\n\n");
  setup([trial({ question })]);
  await using _screen = await render(
    <div className="w-96">
      <ExperimentsSettings />
    </div>,
  );
  const shownQuestion = () =>
    [...document.querySelectorAll("p")].find((element) =>
      element.textContent?.startsWith("Paragraph 0"),
    )!;
  await vi.waitFor(() => expect(shownQuestion()).toBeDefined());
  const card = shownQuestion();
  expect(card.scrollHeight).toBeGreaterThan(card.clientHeight);
  expect(card.clientHeight).toBeLessThanOrEqual(parseFloat(getComputedStyle(card).lineHeight) * 2);
  await click("Results");
  await vi.waitFor(() => expect(pageText()).toContain("Whole trial, by variant"));
  const full = shownQuestion();
  expect(full.scrollHeight).toBe(full.clientHeight);
  expect(full.textContent).toBe(question);
  expect(full.getBoundingClientRect().height).toBeGreaterThan(
    parseFloat(getComputedStyle(full).lineHeight) * 8,
  );
});

it("shows a variant's letter once when an old label already begins with it", async () => {
  const labels = ["A — Late policy", "B — Early policy"] as const;
  setup(
    [
      trial({
        variants: [
          { id: "a", label: labels[0], modelSelection: solAt("medium") },
          { id: "b", label: labels[1], modelSelection: solAt("high") },
        ],
      }),
    ],
    results({
      variants: [
        variantResults({ label: labels[0] }),
        variantResults({ variantId: "b", label: labels[1] }),
      ],
    }),
  );
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(pageText()).toContain("A Late policy"));
  expect(pageText()).toContain("B Early policy");
  expect(pageText()).not.toContain("A A —");
  await click("Results");
  await vi.waitFor(() => expect(document.querySelector("thead")).not.toBeNull());
  expect(document.querySelector("thead")?.textContent).toContain("A Late policy");
  expect(document.querySelector("thead")?.textContent).not.toContain("—");
  await click("Make B the default");
  await vi.waitFor(() => expect(pageText()).toContain("Make B the default: Early policy"));
});

it("hides a draft that was deleted, which the server records as stopped before starting", async () => {
  setup([trial({ id: "gone", status: "stopped", startedAt: null, title: "Deleted draft" })]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(pageText()).toContain("Nothing is running."));
  expect(pageText()).not.toContain("Deleted draft");
});

it("shows a failed Start on the page, with what the server says to change", async () => {
  setup([trial({ status: "draft", startedAt: null })]);
  state.transition.mockResolvedValueOnce(refused("End the other trial first."));
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Start")).toBe(true));
  await click("Start");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "Couldn't start this trial. End the other trial first. It is still a draft.",
    ),
  );
  state.transition.mockResolvedValueOnce(AsyncResult.success(trial()));
  await click("Try again");
  await vi.waitFor(() => expect(pageText()).not.toContain("Couldn't start this trial."));
  expect(state.transition).toHaveBeenCalledTimes(2);
});

it("shows a failed Pause and a failed Stop on the page", async () => {
  setup([trial()]);
  state.transition.mockResolvedValue(refused());
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Pause")).toBe(true));
  await click("Pause");
  await vi.waitFor(() =>
    expect(pageText()).toContain("Couldn't pause this trial. Another running trial"),
  );
  await click("Stop");
  await click("Stop trial");
  await vi.waitFor(() => expect(pageText()).toContain("Couldn't stop this trial."));
});

it("shows unknown rather than zero, and how much each figure covers", async () => {
  setup([trial()]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(rowCells("blockers").length).toBe(2));
  expect(rowCells("blockers")[0]).toBe("unknown0 of 12 enrolled");
  expect(rowCells("false-positives")[0]).toBe("07 of 12 enrolled");
  expect(rowCells("after-landing")[0]).toBe("unknown0 of 12 enrolled · 2 past 14 days");
  expect(rowCells("sent-back")[1]).toBe("312 of 11 enrolled");
  expect(rowCells("tokens")[0]).toBe("3k8 of 12 enrolled");
  expect(pageText()).toContain("A gap shows as unknown, never as zero.");
});

it("warns when there are too few results, using the server's number", async () => {
  setup([trial()]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() =>
    expect(pageText()).toContain("Too few results to conclude. GPT-6.1 Sol medium has 12 enrolled"),
  );
  expect(pageText()).toContain("about 20 results each");
});

it("says when Forge results are unavailable", async () => {
  setup([trial()], results({ forgeReadable: false }));
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(pageText()).toContain("Forge results are unavailable right now"));
});

it("opens a rollover trial read-only, with its results and nothing to act on", async () => {
  const rollover = trial({
    lever: "rollover",
    status: "draft",
    startedAt: null,
    title: "Context rollover",
    variants: [
      { id: "a", label: "Roll over at 70%", rollover: { softLimit: 70, hardLimit: 80 } },
      { id: "b", label: "Roll over at 85%", rollover: { softLimit: 85, hardLimit: 95 } },
    ],
  });
  setup([rollover]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(pageText()).toContain("Context rollover"));
  expect(hasButton("Start")).toBe(false);
  await click("Context rollover");
  await vi.waitFor(() => expect(pageText()).toContain("This kind of trial can't run any more."));
  expect(rowCells("sent-back").length).toBe(2);
  for (const name of ["Start", "Edit", "Stop", "Make B the default", "Record an outcome"]) {
    expect(hasButton(name)).toBe(false);
  }
  expect(pageText()).not.toContain("Save draft");
});

it("does not offer rollover for a new trial", async () => {
  setup([]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("New trial")).toBe(true));
  await click("New trial");
  await vi.waitFor(() => expect(pageText()).toContain("What do you want to compare?"));
  expect(pageText()).not.toMatch(/rollover/i);
  expect(pageText()).not.toContain("council");
});

it("never shows stored orchestration controls as a difference", async () => {
  setup([
    trial({
      lever: "orchestration-policy",
      title: "Old approach trial",
      variants: [
        { id: "inline-first", label: "Inline first", allocationPolicy: "inline-first" },
        { id: "delegate-earlier", label: "Delegate earlier", allocationPolicy: "delegate-earlier" },
      ],
      orchestrationControls: {
        orchestratorSelection: solAt("high"),
        policyHash: "f".repeat(64),
        reviewerPolicyRevision: "reviewer-policy-7",
        verificationRevision: "verification-9",
        concurrency: 3,
      },
    }),
  ]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(rowCells("helpers").length).toBeGreaterThan(0));
  for (const hidden of ["reviewer-policy-7", "verification-9", "ffffffffffff", "Held fixed"]) {
    expect(pageText()).not.toContain(hidden);
  }
});

it("starts variant A from Delegation and refuses a variant identical to it", async () => {
  setup([]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("New trial")).toBe(true));
  await click("New trial");
  await click("Model and effort for a jobTry a different model or effort on one kind of work.");
  await vi.waitFor(() => expect(pageText()).toContain("Current setup"));
  expect(hasButton("Start trial")).toBe(true);
  const start = byText("Start trial") as HTMLButtonElement;
  // No project ticked yet.
  expect(start.disabled).toBe(true);
  await click("T3 Peach");
  await vi.waitFor(() => expect((byText("Start trial") as HTMLButtonElement).disabled).toBe(false));
  await click("Save draft");
  await vi.waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  const { input } = state.create.mock.calls[0]![0] as { input: Experiment };
  expect(input.lever).toBe("reviewer");
  expect(input.eligibility.reviewScopes).toEqual(["spec"]);
  expect(input.eligibility.agentRoles).toEqual(["reviewer"]);
  expect(input.variants[0]?.modelSelection).toEqual(solAt("medium"));
  expect(input.variants[1]?.modelSelection).toEqual(solAt("high"));
  expect(input.stopConditions).toEqual([]);
});

it("refuses two identical approach variants with the design's message", async () => {
  setup([]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("New trial")).toBe(true));
  await click("New trial");
  await click("Delegation approachDo it inline first, or delegate earlier.");
  await vi.waitFor(() => expect(pageText()).toContain("fresh threads linked to a Forge item"));
  expect(pageText()).toContain("the report shows what leads actually delegated");
  const column = document.querySelector('[data-variant="B"]');
  const inline = [...(column?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Inline first",
  );
  await userEvent.click(inline!);
  await vi.waitFor(() =>
    expect(pageText()).toContain("Same as A, so there is nothing to compare. Change one of them."),
  );
  await click("T3 Peach");
  expect((byText("Start trial") as HTMLButtonElement).disabled).toBe(true);
});

it("says where added text reaches, hashes it in the browser and saves it", async () => {
  setup([]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("New trial")).toBe(true));
  await click("New trial");
  await click("Added instructionsToday's instructions, or the same with text you add.");
  await vi.waitFor(() =>
    expect(pageText()).toContain("added to the agent's ordinary instructions on Claude and Codex"),
  );
  expect(pageText()).toContain("can't reach other providers");
  await userEvent.fill(document.querySelector('[data-variant="B"] textarea')!, "abc");
  await click("T3 Peach");
  await click("Save draft");
  await vi.waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  const { input } = state.create.mock.calls[0]![0] as { input: Experiment };
  expect(input.lever).toBe("instruction");
  expect(input.variants[0]?.label).toBe("Today's instructions");
  expect(input.variants[0]?.instructions).toBeUndefined();
  expect(input.variants[1]?.instructions).toEqual({
    sourcePath: "added-text",
    revision: "added-text",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    text: "abc",
  });
});

it("does not create a draft twice when only starting it failed", async () => {
  setup([]);
  state.transition.mockResolvedValueOnce(refused("Not now."));
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("New trial")).toBe(true));
  await click("New trial");
  await click("Delegation approachDo it inline first, or delegate earlier.");
  await click("T3 Peach");
  await vi.waitFor(() => expect((byText("Start trial") as HTMLButtonElement).disabled).toBe(false));
  await click("Start trial");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "Couldn't start this trial. Not now. Your choices are still here, saved as a draft.",
    ),
  );
  state.transition.mockResolvedValueOnce(AsyncResult.success(trial()));
  await click("Try again");
  await vi.waitFor(() => expect(state.transition).toHaveBeenCalledTimes(2));
  expect(state.create).toHaveBeenCalledOnce();
});

it("confirms before making a default, warns about few results and shows the next step", async () => {
  const added = trial({
    lever: "instruction",
    title: "Added instructions",
    eligibility: { projectIds: [project], models: [], taskCategories: [] },
    variants: [
      { id: "a", label: "Today's instructions" },
      {
        id: "b",
        label: "Added text B",
        instructions: {
          sourcePath: "skills/lead/SKILL.md",
          revision: "added-text",
          sha256: "a".repeat(64),
          text: "Ask for a fix with each finding.",
        },
      },
    ],
  });
  setup([added]);
  state.adopt.mockImplementation(async () => {
    state.trials = [{ ...added, status: "stopped", adoptedVariantId: "b" }];
    return AsyncResult.success({
      experiment: state.trials[0],
      applied: "recorded",
      nextStep: "Add this text to skills/lead/SKILL.md in agent-config and land it.",
    });
  });
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(hasButton("Make B the default")).toBe(true));
  expect(hasButton("Make A the default")).toBe(true);
  await click("Make B the default");
  await vi.waitFor(() =>
    expect(pageText()).toContain("this would be your judgement rather than what the trial showed"),
  );
  expect(pageText()).toContain("This also stops the trial.");
  expect(state.adopt).not.toHaveBeenCalled();
  await click("Apply");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "B is now the default. Add this text to skills/lead/SKILL.md in agent-config and land it.",
    ),
  );
});

it("lets the current setup win: today's instructions can be made the default", async () => {
  const added = trial({
    lever: "instruction",
    title: "Added instructions",
    eligibility: { projectIds: [project], models: [], taskCategories: [] },
    variants: [
      { id: "a", label: "Today's instructions" },
      {
        id: "b",
        label: "Added text B",
        instructions: {
          sourcePath: "skills/lead/SKILL.md",
          revision: "added-text",
          sha256: "a".repeat(64),
          text: "Ask for a fix with each finding.",
        },
      },
    ],
  });
  setup([added]);
  state.adopt.mockImplementation(async () =>
    AsyncResult.success({
      experiment: { ...added, status: "stopped", adoptedVariantId: "a" },
      applied: "recorded",
      nextStep: "Variant keeps today's setup, so nothing needs changing.",
    }),
  );
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(hasButton("Make A the default")).toBe(true));
  await click("Make A the default");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "Nothing changes in Delegation. This records A as the default and stops the trial.",
    ),
  );
  expect(pageText()).toContain("Today's instructions stay as they are.");
  expect(pageText()).toContain("this would be your judgement rather than what the trial showed");
  await click("Apply");
  await vi.waitFor(() => expect(state.adopt).toHaveBeenCalledOnce());
  expect(state.adopt.mock.calls[0]![0]).toEqual({
    environmentId,
    input: { experimentId: "trial-1", variantId: "a" },
  });
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "A is now the default. Variant keeps today's setup, so nothing needs changing.",
    ),
  );
});

it("offers a model that is already first in Delegation as the default", async () => {
  setup([trial()]);
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(hasButton("Make A the default")).toBe(true));
  await click("Make A the default");
  await vi.waitFor(() =>
    expect(pageText()).toContain("Reviewer (change reviews): GPT-6.1 Sol medium is already first."),
  );
  expect(pageText()).toContain("Nothing changes in Delegation.");
});

it("shows a refused default on the page with what to change", async () => {
  setup([trial()]);
  state.adopt.mockResolvedValue(refused("Delegation has no reviewer job."));
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(hasButton("Make B the default")).toBe(true));
  await click("Make B the default");
  await click("Apply");
  await vi.waitFor(() =>
    expect(pageText()).toContain(
      "Couldn't change the default. Delegation has no reviewer job. Nothing changed in Delegation.",
    ),
  );
});

it("lists an assignment's results with where each came from, and records by hand last", async () => {
  const row = {
    assignment: {
      id: "assignment-1",
      experimentId: "trial-1",
      revision: 1,
      lever: "reviewer",
      unitKind: "task",
      unitId: '["review","change",7,"w"]',
      threadId: null,
      projectId: project,
      taskCategory: null,
      boundaryRunId: null,
      variant: { id: "b", label: "GPT-6.1 Sol high" },
      assignedModelSelection: solAt("high"),
      enrollment: "new",
      assignmentMethod: "randomized",
      assignedAt: "2026-10-20T00:00:00.000Z",
      codeRevision: null,
      briefRevision: null,
      provenance: null,
    },
    outcomes: [
      {
        id: "outcome-1",
        assignmentId: "assignment-1",
        runId: null,
        kind: "validated-finding",
        source: "human-review",
        evidence: ["review note 4"],
        note: "Confirmed blocker",
        actualModelSelection: null,
        fallbackReason: null,
        recordedAt: "2026-10-22T00:00:00.000Z",
      },
    ],
  } as unknown as ExperimentAssignmentReport;
  const sample = {
    assignmentId: "assignment-1",
    variantId: "b",
    threadId: null,
    specId: "T3-418",
    tokens: 5000,
    confirmedBlockers: 1,
    falsePositives: 1,
    sentBack: null,
    problemsAfterLanding: null,
    landingWindowComplete: true,
    delegatedHelpers: null,
    sources: [
      { measure: "confirmed-blocker", origin: "hand", reference: "outcome-1" },
      {
        measure: "false-positive",
        origin: "forge-finding",
        reference: "run-9",
        findingRef: "F-2",
      },
    ],
  };
  setup([trial()], results({ samples: [sample as never] }));
  state.report = {
    assignments: [row],
    totalAssignments: 1,
    offset: 0,
    hasMore: false,
  };
  state.record.mockImplementation(async ({ input }: { input: unknown }) =>
    AsyncResult.success(input),
  );
  await using _screen = await render(<ExperimentsSettings />);
  await vi.waitFor(() => expect(hasButton("Results")).toBe(true));
  await click("Results");
  await vi.waitFor(() => expect(hasButton("Individual assignments23 in all")).toBe(true));
  await click("Individual assignments23 in all");
  await vi.waitFor(() => expect(pageText()).toContain("T3-418"));
  expect(pageText()).toContain("Confirmed blocker: Entered by hand · review note 4");
  expect(pageText()).toContain("False positive: Forge finding F-2 in review run-9");
  expect(pageText()).not.toContain('["review"');
  await click("Record an outcome");
  await click("Save outcome");
  await vi.waitFor(() =>
    expect(pageText()).toContain("Say where this shows, so the result can be checked later."),
  );
  expect(state.record).not.toHaveBeenCalled();
  await userEvent.fill(document.querySelector('input[placeholder^="A finding"]')!, "thread 12");
  await click("Save outcome");
  await vi.waitFor(() => expect(state.record).toHaveBeenCalledOnce());
  expect(state.record.mock.calls[0]![0].input).toMatchObject({
    kind: "validated-finding",
    source: "human-review",
    evidence: ["thread 12"],
  });
});
