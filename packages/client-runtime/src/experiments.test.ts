import {
  type AgentPolicyManifest,
  type Experiment,
  type ExperimentResults,
  type ExperimentVariantResults,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ExperimentAssignment,
  type ModelSelection,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  adoptionChange,
  currentJobSelection,
  describeAssignmentUnit,
  describeResultSource,
  describeTrialFailure,
  emptyTrialDraft,
  isDiscardedDraft,
  measureCell,
  needsAnOutcome,
  resultRows,
  resultsVerdict,
  trialDraftDefinition,
  trialDraftFromExperiment,
  trialDraftIssues,
  trialGroupOf,
  trialsClash,
  variantNameBesideLetter,
  type TrialContext,
  type TrialDraft,
} from "./experiments.ts";

const instance = ProviderInstanceId.make("codex");
const project = ProjectId.make("project-1");
const sol = (effort: string): ModelSelection => ({
  instanceId: instance,
  model: "gpt-sol",
  options: [{ id: "reasoningEffort", value: effort }],
});

const manifest = {
  version: 2,
  revision: "fixture",
  models: {
    sol: { driverKind: "codex", model: "gpt-sol", effortOption: "reasoningEffort" },
    opus: { driverKind: "claudeAgent", model: "claude-opus", effortOption: "effort" },
  },
  lists: {
    fast: [{ model: "sol", effort: "low" }],
    reviewChange: [
      { model: "sol", effort: "medium" },
      { model: "opus", effort: "high" },
    ],
    reviewSpec: [{ model: "opus", effort: "high" }],
  },
  roles: {
    reviewer: { list: "reviewChange", specList: "reviewSpec" },
    scout: { list: "fast" },
    browser: { list: "fast" },
    "ui-verifier": { list: "fast" },
  },
} as unknown as AgentPolicyManifest;

const now = DateTime.toDate(DateTime.makeUnsafe(Date.parse("2026-11-05T12:00:00")));
const context = (overrides: Partial<TrialContext> = {}): TrialContext => ({
  now,
  manifest,
  modelName: (selection) => selection.model,
  unavailable: () => null,
  projectName: () => "T3 Peach",
  otherTrials: [],
  ...overrides,
});

const draft = (overrides: Partial<TrialDraft> = {}): TrialDraft => ({
  ...emptyTrialDraft(now),
  kind: "model",
  job: "reviewer-change",
  variants: [
    { type: "model", selection: sol("medium") },
    { type: "model", selection: sol("high") },
  ],
  projectIds: [project],
  question: "Which is better?",
  questionEdited: true,
  ...overrides,
});

const hashed = (text: string) => `hash of ${text}`;
const definitionOf = (value: TrialDraft) =>
  trialDraftDefinition(value, {
    id: "trial",
    modelName: (selection) => selection.model,
    hashText: hashed,
  });

const experiment = (overrides: Partial<Experiment> = {}): Experiment => ({
  ...definitionOf(draft()),
  revision: 1,
  status: "running",
  createdAt: "2026-10-01T00:00:00.000Z",
  startedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const allMessages = (value: TrialDraft, overrides: Partial<TrialContext> = {}) => {
  const issues = trialDraftIssues(value, context(overrides));
  return [...issues.variants.flat(), ...issues.work, ...issues.stop].map((issue) => issue.text);
};

describe("trial draft validity", () => {
  it("lets a complete draft start", () => {
    expect(trialDraftIssues(draft(), context()).blocked).toBe(false);
  });

  it("refuses a variant identical to an earlier one, with the design's message", () => {
    const value = draft({
      variants: [
        { type: "model", selection: sol("medium") },
        { type: "model", selection: sol("medium") },
      ],
    });
    expect(trialDraftIssues(value, context()).blocked).toBe(true);
    expect(allMessages(value)).toContain(
      "Same as A, so there is nothing to compare. Change one of them.",
    );
  });

  it("refuses no projects, a past date and a limit the server would refuse", () => {
    expect(allMessages(draft({ projectIds: [] }))).toContain(
      "Tick at least one project, or nothing can enrol.",
    );
    expect(allMessages(draft({ endDate: "2026-11-05" }))).toContain(
      "That date has passed, so nothing would enrol.",
    );
    expect(trialDraftIssues(draft({ limit: "1001" }), context()).blocked).toBe(true);
    expect(trialDraftIssues(draft({ limit: "0" }), context()).blocked).toBe(true);
  });

  it("refuses a model outside Delegation's lists, which the server would also refuse", () => {
    const value = draft({
      variants: [
        { type: "model", selection: sol("medium") },
        { type: "model", selection: { instanceId: instance, model: "gpt-other" } },
      ],
    });
    expect(trialDraftIssues(value, context()).blocked).toBe(true);
  });

  it("warns about a rate limit but refuses a signed-out model", () => {
    const limited = trialDraftIssues(draft(), context({ unavailable: () => "rate limited" }));
    expect(limited.blocked).toBe(false);
    expect(limited.variants.flat().length).toBeGreaterThan(0);
    expect(trialDraftIssues(draft(), context({ unavailable: () => "signed out" })).blocked).toBe(
      true,
    );
  });

  it("names a running trial that would take this work first", () => {
    const rival = experiment({ id: "rival", title: "Rival" });
    const issues = trialDraftIssues(draft(), context({ otherTrials: [rival] }));
    expect(issues.blocked).toBe(true);
    expect(issues.work[0]?.rivalId).toBe("rival");
    expect(issues.work[0]?.text).toContain("“Rival” is already running in T3 Peach");
  });

  it("requires text on an added-text variant, and refuses identical text", () => {
    const today = { type: "text", text: null, sourcePath: "added-text" } as const;
    const empty = draft({
      kind: "text",
      variants: [today, { type: "text", text: "  ", sourcePath: "added-text" }],
    });
    expect(trialDraftIssues(empty, context()).blocked).toBe(true);
    const twin = draft({
      kind: "text",
      variants: [
        today,
        { type: "text", text: "Add a test.", sourcePath: "added-text" },
        { type: "text", text: " Add a test. ", sourcePath: "added-text" },
      ],
    });
    expect(allMessages(twin)).toContain(
      "Same as B, so there is nothing to compare. Change one of them.",
    );
  });
});

describe("what a draft sends", () => {
  it("sends a Reviewer job as the reviewer lever, with its scope and one role", () => {
    const definition = definitionOf(draft({ job: "reviewer-spec" }));
    expect(definition.lever).toBe("reviewer");
    expect(definition.eligibility).toEqual({
      projectIds: [project],
      models: [],
      taskCategories: [],
      agentRoles: ["reviewer"],
      reviewScopes: ["spec"],
    });
    expect(definition.stopConditions).toEqual([]);
    expect(definition.codeRevision).toBeNull();
    expect(definition.briefRevision).toBeNull();
  });

  it("sends other jobs as the delegation lever, with no review scope", () => {
    const definition = definitionOf(draft({ job: "scout" }));
    expect(definition.lever).toBe("delegation");
    expect(definition.eligibility.agentRoles).toEqual(["scout"]);
    expect(definition.eligibility.reviewScopes).toBeUndefined();
    expect(definition.variants[1]?.modelSelection).toEqual(sol("high"));
  });

  it("sends added text with the hash of exactly the text it carries", () => {
    const definition = definitionOf(
      draft({
        kind: "text",
        textRole: "ui-worker",
        variants: [
          { type: "text", text: null, sourcePath: "added-text" },
          { type: "text", text: "  Check phone width.\n", sourcePath: "roles/ui-worker.md" },
        ],
      }),
    );
    expect(definition.lever).toBe("instruction");
    expect(definition.eligibility.agentRoles).toEqual(["ui-worker"]);
    expect(definition.variants[0]?.instructions).toBeUndefined();
    expect(definition.variants[1]?.instructions).toEqual({
      sourcePath: "roles/ui-worker.md",
      revision: "added-text",
      sha256: hashed("Check phone width."),
      text: "Check phone width.",
    });
  });

  it("sends a delegation approach with no controls and both policies", () => {
    const definition = definitionOf(
      draft({
        kind: "approach",
        variants: [
          { type: "approach", policy: "inline-first" },
          { type: "approach", policy: "delegate-earlier" },
        ],
      }),
    );
    expect(definition.lever).toBe("orchestration-policy");
    expect(definition.orchestrationControls).toBeUndefined();
    expect(definition.variants.map((variant) => variant.allocationPolicy)).toEqual([
      "inline-first",
      "delegate-earlier",
    ]);
  });

  it("reads variant A from the job's Delegation list, using the Spec list for Spec reviews", () => {
    const instanceFor = () => instance;
    expect(currentJobSelection(manifest, "reviewer-change", instanceFor)).toEqual(sol("medium"));
    expect(currentJobSelection(manifest, "reviewer-spec", instanceFor)?.model).toBe("claude-opus");
    expect(currentJobSelection(null, "scout", instanceFor)).toBeNull();
  });

  it("reopens a saved draft with the choices it was saved with", () => {
    const reopened = trialDraftFromExperiment(experiment({ status: "draft", startedAt: null }));
    expect(reopened.kind).toBe("model");
    expect(reopened.job).toBe("reviewer-change");
    expect(reopened.variants[1]).toEqual({ type: "model", selection: sol("high") });
    expect(reopened.projectIds).toEqual([project]);
  });
});

describe("trial clashes mirror the server's start check", () => {
  const scope = (
    lever: Experiment["lever"],
    extra: Partial<Experiment["eligibility"]> = {},
  ) => ({
    lever,
    eligibility: { projectIds: [project], models: [], taskCategories: [], ...extra },
  });

  it("keeps change and Spec reviews apart", () => {
    expect(
      trialsClash(
        scope("reviewer", { reviewScopes: ["change"] }),
        scope("reviewer", { reviewScopes: ["spec"] }),
      ),
    ).toBe(false);
  });

  it("clashes two legacy reviews that declare no scope, as the server does", () => {
    expect(trialsClash(scope("reviewer"), scope("reviewer"))).toBe(true);
  });

  it("keeps a legacy review apart from one that declares a scope, as the server does", () => {
    expect(trialsClash(scope("reviewer", { reviewScopes: ["spec"] }), scope("reviewer"))).toBe(
      false,
    );
  });

  it("leaves a legacy rollover trial out of the added-text clash, as the server does", () => {
    // The server's thread-overlay rule excludes rollover on both sides, so a stored rollover
    // trial does not block a new text trial even though both are thread trials.
    expect(trialsClash(scope("rollover"), scope("instruction"))).toBe(false);
  });

  it("keeps different jobs on the delegation lever apart", () => {
    expect(
      trialsClash(
        scope("delegation", { agentRoles: ["scout"] }),
        scope("delegation", { agentRoles: ["researcher"] }),
      ),
    ).toBe(false);
  });

  it("clashes an approach with a delegation model, and added text with an approach", () => {
    expect(trialsClash(scope("orchestration-policy"), scope("delegation"))).toBe(true);
    expect(trialsClash(scope("instruction"), scope("orchestration-policy"))).toBe(true);
  });

  it("does not clash across projects", () => {
    expect(
      trialsClash(scope("instruction"), {
        ...scope("instruction"),
        eligibility: { ...scope("instruction").eligibility, projectIds: [ProjectId.make("p2")] },
      }),
    ).toBe(false);
  });
});

const variantResults = (
  overrides: Partial<ExperimentVariantResults> = {},
): ExperimentVariantResults => ({
  variantId: "a",
  label: "Sol medium",
  enrolled: 12,
  tokens: { value: null, covered: 0 },
  confirmedBlockers: { value: null, covered: 0 },
  falsePositives: { value: null, covered: 0 },
  sentBack: { value: null, covered: 0 },
  problemsAfterLanding: { value: null, covered: 0 },
  landingWindowsComplete: 0,
  delegatedHelpers: { value: null, covered: 0 },
  enteredByHand: 0,
  tooFewResults: true,
  ...overrides,
});

const results = (variants: ReadonlyArray<ExperimentVariantResults>): ExperimentResults => ({
  experimentId: "trial",
  variants,
  samples: [],
  totalSamples: 0,
  offset: 0,
  hasMore: false,
  enoughPerVariant: 20,
  forgeReadable: true,
  readAt: "2026-11-05T00:00:00.000Z",
});

describe("results", () => {
  it("shows a null measure as unknown, never zero, and a real zero as zero", () => {
    expect(measureCell({ value: null, covered: 0 }, 12)).toEqual({
      value: "unknown",
      coverage: "0 of 12 enrolled",
    });
    expect(measureCell({ value: 0, covered: 7 }, 12)).toEqual({
      value: "0",
      coverage: "7 of 12 enrolled",
    });
  });

  it("shows tokens per unit only over the samples that were measured", () => {
    const rows = resultRows(experiment(), [
      variantResults({ tokens: { value: 3000, covered: 2 } }),
      variantResults({ variantId: "b" }),
    ]);
    const tokens = rows.find((row) => row.key === "tokens");
    expect(tokens?.cells[0]).toEqual({ value: "1.5k", coverage: "2 of 12 enrolled" });
    expect(tokens?.cells[1]?.value).toBe("unknown");
  });

  it("shows helpers only for an approach trial and review rows only where they can fill", () => {
    const approach = resultRows(experiment({ lever: "orchestration-policy" }), [variantResults()]);
    expect(approach.map((row) => row.key)).toContain("helpers");
    const delegation = resultRows(experiment({ lever: "delegation" }), [variantResults()]);
    expect(delegation.map((row) => row.key)).toEqual(["enrolled", "sent-back", "tokens"]);
  });

  it("warns when any variant has too few results, quoting the server's number", () => {
    const verdict = resultsVerdict(
      results([variantResults(), variantResults({ tooFewResults: false, label: "Sol high" })]),
    );
    expect(verdict.tooFew).toBe(true);
    expect(verdict.tone).toBe("warning");
    expect(verdict.text).toContain("Too few results to conclude.");
    expect(verdict.text).toContain("about 20 results each");
  });

  it("never picks a winner when there are enough", () => {
    const verdict = resultsVerdict(results([variantResults({ tooFewResults: false })]));
    expect(verdict.tooFew).toBe(false);
    expect(verdict.text).toContain("That's your call.");
  });

  it("says plainly when nothing has enrolled", () => {
    expect(resultsVerdict(results([variantResults({ enrolled: 0 })])).text).toBe(
      "Nothing has enrolled yet, so there is nothing to compare.",
    );
  });

  it("labels a hand-entered result as entered by hand, with where it shows", () => {
    const described = describeResultSource(
      { measure: "confirmed-blocker", origin: "hand", reference: "outcome-1" },
      [
        {
          id: "outcome-1",
          assignmentId: "a",
          runId: null,
          kind: "validated-finding",
          source: "human-review",
          evidence: ["review 12"],
          note: "",
          actualModelSelection: null,
          fallbackReason: null,
          recordedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    );
    expect(described).toEqual({
      measure: "Confirmed blocker",
      origin: "Entered by hand · review 12",
    });
  });

  it("names the Forge finding a result came from", () => {
    expect(
      describeResultSource(
        {
          measure: "false-positive",
          origin: "forge-finding",
          reference: "run-1",
          findingRef: "F2",
        },
        [],
      ).origin,
    ).toBe("Forge finding F2 in review run-1");
  });

  it("asks for an outcome only on a landed review with nothing known", () => {
    const sample = {
      assignmentId: "a",
      variantId: "a",
      threadId: null,
      specId: null,
      tokens: null,
      confirmedBlockers: null,
      falsePositives: null,
      sentBack: null,
      problemsAfterLanding: null,
      landingWindowComplete: false,
      delegatedHelpers: null,
      sources: [],
    };
    expect(needsAnOutcome({ lever: "reviewer" }, sample)).toBe(true);
    expect(needsAnOutcome({ lever: "delegation" }, sample)).toBe(false);
    expect(needsAnOutcome({ lever: "reviewer" }, { ...sample, landingWindowComplete: null })).toBe(
      false,
    );
    expect(needsAnOutcome({ lever: "reviewer" }, { ...sample, confirmedBlockers: 0 })).toBe(false);
  });
});

describe("trial lifecycle on the page", () => {
  it("groups a rollover trial as finished whatever its stored status", () => {
    expect(trialGroupOf(experiment({ lever: "rollover", status: "running" }))).toBe("finished");
  });

  it("hides only a draft that was stopped before it ever started", () => {
    expect(isDiscardedDraft(experiment({ status: "stopped", startedAt: null }))).toBe(true);
    expect(isDiscardedDraft(experiment({ status: "stopped" }))).toBe(false);
    expect(isDiscardedDraft(experiment({ status: "draft", startedAt: null }))).toBe(false);
    expect(
      isDiscardedDraft(experiment({ lever: "rollover", status: "stopped", startedAt: null })),
    ).toBe(false);
  });
});

describe("making a variant the default", () => {
  const names = {
    manifest,
    modelName: (_driver: unknown, model: string) => model,
    roleLabel: (role: string) => role,
  };

  it("moves the variant to the top of the job's list, and shows both orders", () => {
    const trial = experiment();
    const change = adoptionChange(trial, trial.variants[1]!, names);
    expect(change?.inDelegation).toBe(true);
    expect(change?.before?.map((entry) => entry.effort)).toEqual(["medium", "high"]);
    expect(change?.after).toEqual([
      { label: "gpt-sol", effort: "high" },
      { label: "claude-opus", effort: "high" },
    ]);
  });

  it("still offers a model already first, saying nothing in Delegation changes", () => {
    const trial = experiment();
    const change = adoptionChange(trial, trial.variants[0]!, names);
    expect(change).toMatchObject({
      changesNothing: true,
      inDelegation: false,
      before: null,
      after: null,
      what: "Reviewer (change reviews): gpt-sol medium is already first.",
    });
  });

  it("offers every variant of a trial that can still be decided", () => {
    for (const lever of [
      "reviewer",
      "delegation",
      "instruction",
      "orchestration-policy",
    ] as const) {
      const trial = experiment({ lever });
      for (const variant of [...trial.variants, { id: "c", label: "Today's setup" }]) {
        expect(adoptionChange(trial, variant, names)).not.toBeNull();
      }
    }
  });

  it("says when the list is shared with other jobs", () => {
    const trial = experiment({
      lever: "delegation",
      eligibility: { ...experiment().eligibility, agentRoles: ["scout"], reviewScopes: undefined },
    } as Partial<Experiment>);
    const change = adoptionChange(
      trial,
      { id: "b", label: "Sol high", modelSelection: sol("high") },
      names,
    );
    expect(change?.note).toContain("share one list, so this changes all 3.");
  });

  it("treats added text and approaches as outside Delegation", () => {
    const trial = experiment({ lever: "instruction" });
    const change = adoptionChange(
      trial,
      {
        id: "b",
        label: "Added text B",
        instructions: {
          sourcePath: "skills/lead/SKILL.md",
          revision: "added-text",
          sha256: "a".repeat(64),
          text: "Do it.",
        },
      },
      names,
    );
    expect(change?.inDelegation).toBe(false);
    expect(change?.what).toContain("skills/lead/SKILL.md");
    expect(change?.changesNothing).toBe(false);
    expect(adoptionChange(trial, { id: "a", label: "Today's instructions" }, names)).toEqual({
      what: "Today's instructions stay as they are.",
      inDelegation: false,
      changesNothing: true,
      before: null,
      after: null,
      note: null,
    });
  });

  it("does not offer the variant already adopted, or anything on a rollover trial", () => {
    const trial = experiment({ adoptedVariantId: "b" });
    expect(adoptionChange(trial, trial.variants[1]!, names)).toBeNull();
    const rollover = experiment({ lever: "rollover" });
    expect(adoptionChange(rollover, rollover.variants[1]!, names)).toBeNull();
  });
});

describe("a variant's name beside its letter", () => {
  it("drops a leading copy of its own letter, however it was punctuated", () => {
    for (const label of [
      "A — Late policy",
      "A – Late policy",
      "A - Late policy",
      "A: Late policy",
    ]) {
      expect(variantNameBesideLetter(label, 0)).toBe("Late policy");
    }
    expect(variantNameBesideLetter("B — Early policy", 1)).toBe("Early policy");
  });

  it("keeps names that only look similar", () => {
    expect(variantNameBesideLetter("Added text B", 1)).toBe("Added text B");
    expect(variantNameBesideLetter("A better policy", 0)).toBe("A better policy");
    expect(variantNameBesideLetter("B — Early policy", 0)).toBe("B — Early policy");
    expect(variantNameBesideLetter("A —", 0)).toBe("A —");
    expect(variantNameBesideLetter("A — Late policy", 7)).toBe("A — Late policy");
  });
});

describe("failed actions", () => {
  it("says what to change when the server does", () => {
    expect(
      describeTrialFailure("adopt", {
        _tag: "ExperimentError",
        reason: "invalid-definition",
        detail: "Delegation has no scout job.",
      }),
    ).toBe(
      "Couldn't change the default. Delegation has no scout job. Nothing changed in Delegation.",
    );
  });

  it("explains a refusal without a detail", () => {
    expect(
      describeTrialFailure("start", { _tag: "ExperimentError", reason: "conflict" }),
    ).toContain("Another running trial takes this work first");
  });

  it("says the server didn't answer when it failed some other way", () => {
    expect(describeTrialFailure("pause", new Error("socket closed"))).toBe(
      "Couldn't pause this trial. The server didn't answer. It is still enrolling new work.",
    );
  });
});

describe("assignment description used by mobile", () => {
  it("keeps thread and task assignments readable", () => {
    const assignment = {
      id: "assignment:1",
      experimentId: "trial",
      revision: 1,
      lever: "delegation",
      unitKind: "task",
      unitId: "task-1",
      threadId: ThreadId.make("thread-1"),
      projectId: project,
      taskCategory: null,
      boundaryRunId: null,
      variant: { id: "a", label: "A" },
      assignedModelSelection: sol("medium"),
      enrollment: "new",
      assignmentMethod: "randomized",
      assignedAt: "2026-10-14T10:00:00.000Z",
      codeRevision: null,
      briefRevision: null,
      provenance: null,
    } satisfies ExperimentAssignment;
    expect(describeAssignmentUnit(assignment)).toEqual({
      title: "task: task-1",
      owner: "Thread thread-1",
      modelLabel: "Model",
    });
  });
});
