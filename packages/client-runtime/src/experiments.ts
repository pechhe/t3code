import { DateTime } from "effect";
import type {
  AgentPolicyManifest,
  AgentRole,
  Experiment,
  ExperimentAllocationPolicy,
  ExperimentAssignment,
  ExperimentAssignmentReport,
  ExperimentDefinition,
  ExperimentMeasure,
  ExperimentOrchestrationControls,
  ExperimentOutcome,
  ExperimentOutcomeInput,
  ExperimentResults,
  ExperimentResultSource,
  ExperimentSampleResult,
  ExperimentVariant,
  ExperimentVariantResults,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

const dateAt = (epochMillis: number) => DateTime.toDate(DateTime.makeUnsafe(epochMillis));

/**
 * Presentation rules shared by the web/desktop and mobile experiment screens.
 * The server owns assignment, eligibility and reporting; these helpers only
 * describe what it recorded without inferring winners, charges or zero usage.
 */

export const ALLOCATION_POLICY_LABELS: Readonly<Record<ExperimentAllocationPolicy, string>> = {
  "inline-first": "Inline first",
  "delegate-earlier": "Delegate earlier",
};

export function describeModelSelection(selection: ModelSelection): string {
  const options = (selection.options ?? []).map((option) => `${option.id} ${String(option.value)}`);
  return [selection.model, ...options].join(" · ");
}

export function describeExperimentTreatment(variant: ExperimentVariant): string {
  if (variant.allocationPolicy) return ALLOCATION_POLICY_LABELS[variant.allocationPolicy];
  if (variant.rollover)
    return `${variant.rollover.softLimit.toLocaleString()} soft / ${variant.rollover.hardLimit.toLocaleString()} hard`;
  if (variant.modelSelection) return describeModelSelection(variant.modelSelection);
  if (variant.instructions)
    return `${variant.instructions.sourcePath} at ${variant.instructions.revision} (${variant.instructions.sha256.slice(0, 12)})`;
  return "Unspecified treatment";
}

export function describeOrchestrationControls(controls: ExperimentOrchestrationControls): string {
  return [
    `parent ${describeModelSelection(controls.orchestratorSelection)}`,
    `agent policy ${controls.policyHash.slice(0, 12)}`,
    `reviewer policy ${controls.reviewerPolicyRevision}`,
    `verification ${controls.verificationRevision}`,
    `up to ${controls.concurrency} concurrent managed task${controls.concurrency === 1 ? "" : "s"}`,
  ].join(" · ");
}

export interface AssignmentUnitDescription {
  readonly title: string;
  readonly owner: string;
  /** Label for `assignedModelSelection`, which is the parent's model for work units. */
  readonly modelLabel: string;
}

export function describeAssignmentUnit(
  assignment: ExperimentAssignment,
): AssignmentUnitDescription {
  if (assignment.unitKind === "work" && assignment.work) {
    const work = assignment.work;
    return {
      title: `Work ${work.workId}: ${work.description}`,
      owner:
        work.owner.parentThreadId !== null
          ? `T3 parent thread ${work.owner.parentThreadId}`
          : "External parent session",
      modelLabel: "Parent model (held fixed)",
    };
  }
  return {
    title: `${assignment.unitKind}: ${assignment.unitId}`,
    owner: assignment.threadId === null ? "No thread recorded" : `Thread ${assignment.threadId}`,
    modelLabel: "Model",
  };
}

export const VARIANT_LETTERS = "ABCD";
export const MAX_TRIAL_VARIANTS = 4;

/** A variant's name beside its letter: old labels may already begin with that letter. */
export function variantNameBesideLetter(label: string, index: number): string {
  const letter = VARIANT_LETTERS[index];
  if (letter === undefined || !label.startsWith(letter)) return label;
  const rest = label.slice(letter.length).match(/^\s*[—–:.-]\s*(.+)$/su)?.[1];
  return rest ?? label;
}
const MAX_ASSIGNMENTS = 1000;
const MAX_INSTRUCTION_LENGTH = 16_000;
/** The guide a draft quotes before any results exist; a running trial's comes from the server. */
const ENOUGH_PER_VARIANT_GUIDE = 20;
const DEFAULT_INSTRUCTION_SOURCE = "added-text";
const INSTRUCTION_REVISION = "added-text";
const TODAYS_INSTRUCTIONS = "Today's instructions";

export type TrialKind = "model" | "text" | "approach";
export type TrialJob =
  | "reviewer-change"
  | "reviewer-spec"
  | "implementation-worker"
  | "ui-worker"
  | "scout"
  | "researcher"
  | "chore-worker";

export const TRIAL_KINDS: Readonly<Record<TrialKind, { name: string; description: string }>> = {
  model: {
    name: "Model and effort for a job",
    description: "Try a different model or effort on one kind of work.",
  },
  text: {
    name: "Added instructions",
    description: "Today's instructions, or the same with text you add.",
  },
  approach: {
    name: "Delegation approach",
    description: "Do it inline first, or delegate earlier.",
  },
};

export interface TrialJobInfo {
  readonly name: string;
  readonly role: AgentRole;
  readonly reviewScope?: "change" | "spec";
  readonly unit: "task" | "Spec";
  readonly subject: string;
  readonly note?: string;
}

export const TRIAL_JOBS: Readonly<Record<TrialJob, TrialJobInfo>> = {
  "reviewer-change": {
    name: "Reviewer (change reviews)",
    role: "reviewer",
    reviewScope: "change",
    unit: "task",
    subject: "change reviews",
  },
  "reviewer-spec": {
    name: "Reviewer (Spec reviews)",
    role: "reviewer",
    reviewScope: "spec",
    unit: "Spec",
    subject: "Spec reviews",
  },
  "implementation-worker": {
    name: "Implementer",
    role: "implementation-worker",
    unit: "task",
    subject: "Implementer tasks",
  },
  "ui-worker": { name: "UI worker", role: "ui-worker", unit: "task", subject: "UI worker tasks" },
  scout: {
    name: "Scout",
    role: "scout",
    unit: "task",
    subject: "Scout tasks",
    note: "Scout shares its setting with Browser and UI verifier. Only Scout's work is in this trial.",
  },
  researcher: {
    name: "Researcher",
    role: "researcher",
    unit: "task",
    subject: "Researcher tasks",
  },
  "chore-worker": {
    name: "Chore worker",
    role: "chore-worker",
    unit: "task",
    subject: "Chore worker tasks",
  },
};

export const APPROACH_DESCRIPTIONS: Readonly<Record<ExperimentAllocationPolicy, string>> = {
  "inline-first": "The lead does the work itself, and delegates only when it has to.",
  "delegate-earlier": "The lead hands bounded work to a worker as soon as it can.",
};

export type DraftVariant =
  | { readonly type: "model"; readonly selection: ModelSelection | null }
  | { readonly type: "text"; readonly text: string | null; readonly sourcePath: string }
  | { readonly type: "approach"; readonly policy: ExperimentAllocationPolicy };

export interface TrialDraft {
  readonly kind: TrialKind | null;
  readonly job: TrialJob;
  /** The one job added text is limited to; null reaches every job the lever reaches. */
  readonly textRole: AgentRole | null;
  readonly variants: ReadonlyArray<DraftVariant>;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly limit: string;
  readonly endDate: string;
  readonly question: string;
  readonly questionEdited: boolean;
}

/** What a draft is judged against: the environment's setup, as the page last read it. */
export interface TrialContext {
  readonly now: Date;
  readonly manifest: AgentPolicyManifest | null;
  readonly modelName: (selection: ModelSelection) => string;
  readonly unavailable: (selection: ModelSelection) => string | null;
  readonly projectName: (projectId: ProjectId) => string;
  readonly otherTrials: ReadonlyArray<Experiment>;
}

export interface TrialIssue {
  readonly block: boolean;
  readonly text: string;
  readonly rivalId?: string;
}

export interface TrialIssues {
  readonly variants: ReadonlyArray<ReadonlyArray<TrialIssue>>;
  readonly work: ReadonlyArray<TrialIssue>;
  readonly stop: ReadonlyArray<TrialIssue>;
  readonly blocked: boolean;
}

function andList(names: ReadonlyArray<string>): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function localDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function emptyTrialDraft(now: Date): TrialDraft {
  return {
    kind: null,
    job: "reviewer-spec",
    textRole: null,
    variants: [],
    projectIds: [],
    limit: "40",
    endDate: localDateString(dateAt(now.getTime() + 28 * 86_400_000)),
    question: "",
    questionEdited: false,
  };
}

/** The option ids that carry a model's reasoning effort, under the names adapters use. */
const EFFORT_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
  "thinking",
  "variant",
]);

export function selectionEffort(selection: ModelSelection): string | null {
  const option = selection.options?.find(
    (candidate) => EFFORT_OPTION_IDS.has(candidate.id) && typeof candidate.value === "string",
  );
  return typeof option?.value === "string" ? option.value : null;
}

function selectionKey(selection: ModelSelection): string {
  const options = [...(selection.options ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((option) => [option.id, option.value]);
  return JSON.stringify([selection.instanceId, selection.model, options]);
}

export function selectionsMatch(left: ModelSelection | null, right: ModelSelection | null) {
  return left !== null && right !== null && selectionKey(left) === selectionKey(right);
}

function jobList(manifest: AgentPolicyManifest, job: TrialJobInfo): string | null {
  const policy = manifest.roles[job.role];
  if (policy === undefined) return null;
  return job.reviewScope === "spec" ? (policy.specList ?? policy.list) : policy.list;
}

/** What a job runs today: the first model in its Delegation list, with its effort. */
export function currentJobSelection(
  manifest: AgentPolicyManifest | null,
  job: TrialJob,
  instanceFor: (driverKind: ProviderDriverKind) => ProviderInstanceId | null,
): ModelSelection | null {
  if (manifest === null) return null;
  const list = jobList(manifest, TRIAL_JOBS[job]);
  const entry = list === null ? undefined : manifest.lists[list]?.[0];
  const binding = entry === undefined ? undefined : manifest.models[entry.model];
  if (entry === undefined || binding === undefined) return null;
  const instanceId = instanceFor(binding.driverKind);
  if (instanceId === null) return null;
  const options = [
    ...(binding.effortOption !== undefined && entry.effort !== undefined
      ? [{ id: binding.effortOption, value: entry.effort }]
      : []),
    ...Object.entries(binding.options ?? {}).map(([id, value]) => ({ id, value })),
  ];
  return { instanceId, model: binding.model, ...(options.length > 0 ? { options } : {}) };
}

/** The server refuses a model outside every Delegation list, at both create and start. */
export function isModelInDelegation(manifest: AgentPolicyManifest, model: string): boolean {
  return Object.values(manifest.lists).some((list) =>
    list.some((entry) => manifest.models[entry.model]?.model === model),
  );
}

function withEffort(selection: ModelSelection, effort: string): ModelSelection {
  const options = selection.options ?? [];
  return {
    ...selection,
    options: options.map((option) =>
      EFFORT_OPTION_IDS.has(option.id) && typeof option.value === "string"
        ? { id: option.id, value: effort }
        : option,
    ),
  };
}

/** A starts as today's setup and B as the same model one effort up, so a trial differs at once. */
export function freshTrialVariants(
  kind: TrialKind,
  current: ModelSelection | null,
  effortsOfCurrent: ReadonlyArray<string>,
): ReadonlyArray<DraftVariant> {
  if (kind === "text") {
    return [
      { type: "text", text: null, sourcePath: DEFAULT_INSTRUCTION_SOURCE },
      { type: "text", text: "", sourcePath: DEFAULT_INSTRUCTION_SOURCE },
    ];
  }
  if (kind === "approach") {
    return [
      { type: "approach", policy: "inline-first" },
      { type: "approach", policy: "delegate-earlier" },
    ];
  }
  const effort = current === null ? null : selectionEffort(current);
  const at = effort === null ? -1 : effortsOfCurrent.indexOf(effort);
  const other = effortsOfCurrent[at + 1] ?? effortsOfCurrent[at - 1];
  return [
    { type: "model", selection: current },
    {
      type: "model",
      selection: current !== null && other !== undefined ? withEffort(current, other) : null,
    },
  ];
}

export function defaultTrialQuestion(kind: TrialKind, job: TrialJob): string {
  if (kind === "text")
    return "Does the added text land work with less sent back, for fewer tokens?";
  if (kind === "approach") {
    return "Does delegating earlier use fewer tokens without more work being sent back?";
  }
  return TRIAL_JOBS[job].reviewScope !== undefined
    ? "Which finds more confirmed blockers with fewer false positives?"
    : "Which lands work with less sent back, for fewer tokens?";
}

export function draftVariantName(
  variant: DraftVariant,
  index: number,
  modelName: (selection: ModelSelection) => string,
): string {
  if (variant.type === "approach") return ALLOCATION_POLICY_LABELS[variant.policy];
  if (variant.type === "text") {
    return variant.text === null ? TODAYS_INSTRUCTIONS : `Added text ${VARIANT_LETTERS[index]}`;
  }
  if (variant.selection === null) return "No model yet";
  const effort = selectionEffort(variant.selection);
  const name = modelName(variant.selection);
  return effort === null ? name : `${name} ${effort}`;
}

function trialDraftTitle(
  draft: TrialDraft,
  modelName: (selection: ModelSelection) => string,
): string {
  const names = draft.variants.map((variant, index) => draftVariantName(variant, index, modelName));
  if (draft.kind === "approach") return "Inline first or delegate earlier";
  if (draft.kind === "text") return `Added instructions: ${names.join(" or ")}`;
  return `${TRIAL_JOBS[draft.job].name}: ${names.join(" or ")}`;
}

export function trialUnit(draft: Pick<TrialDraft, "kind" | "job">): string {
  return draft.kind === "model" ? TRIAL_JOBS[draft.job].unit : "thread";
}

export function pluralize(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

function formatDay(value: Date | string, now: Date): string {
  const millis = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(millis)) return "no date";
  const date = dateAt(millis);
  const near = Math.abs(date.getTime() - now.getTime()) < 330 * 86_400_000;
  return date.toLocaleDateString(
    "en-GB",
    near ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" },
  );
}

function endOfLocalDay(day: string): Date {
  return dateAt(Date.parse(`${day}T23:59:59`));
}

export function trialDraftSentence(draft: TrialDraft, context: TrialContext): string {
  const subject =
    draft.kind === "approach"
      ? "Fresh threads linked to a Forge item"
      : draft.kind === "text"
        ? "New threads"
        : `New ${TRIAL_JOBS[draft.job].subject}`;
  const where =
    draft.projectIds.length > 0
      ? `in ${andList(draft.projectIds.map(context.projectName))}`
      : "in the projects you tick";
  const limit = Number(draft.limit) || 0;
  const end = draft.endDate ? formatDay(endOfLocalDay(draft.endDate), context.now) : "no date";
  return `${subject} ${where} get one of these at random, up to ${limit} or until ${end}.`;
}

type TrialScope = Pick<ExperimentDefinition, "lever" | "eligibility" | "orchestrationControls">;

function draftScope(draft: TrialDraft): TrialScope | null {
  if (draft.kind === null) return null;
  const base = {
    projectIds: draft.projectIds,
    models: [] as ReadonlyArray<string>,
    taskCategories: [] as ReadonlyArray<string>,
  };
  if (draft.kind === "approach") return { lever: "orchestration-policy", eligibility: base };
  if (draft.kind === "text") {
    return {
      lever: "instruction",
      eligibility: {
        ...base,
        ...(draft.textRole === null ? {} : { agentRoles: [draft.textRole] }),
      },
    };
  }
  const job = TRIAL_JOBS[draft.job];
  return {
    lever: job.reviewScope === undefined ? "delegation" : "reviewer",
    eligibility: {
      ...base,
      agentRoles: [job.role],
      ...(job.reviewScope === undefined ? {} : { reviewScopes: [job.reviewScope] }),
    },
  };
}

const overlaps = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === 0 || right.length === 0 || left.some((value) => right.includes(value));

const isThreadTrial = (trial: TrialScope) =>
  trial.lever === "instruction" ||
  (trial.lever === "orchestration-policy" && trial.orchestrationControls === undefined);

/** Mirrors the server's start check, so a clash shows before Start rather than after it. */
export function trialsClash(left: TrialScope, right: TrialScope): boolean {
  const projects = overlaps(left.eligibility.projectIds, right.eligibility.projectIds);
  if (!projects) return false;
  if (left.lever !== right.lever && isThreadTrial(left) && isThreadTrial(right)) return true;
  if (left.lever === right.lever) {
    if (
      left.lever === "reviewer" &&
      !(left.eligibility.reviewScopes ?? []).some((scope) =>
        (right.eligibility.reviewScopes ?? []).includes(scope),
      )
    ) {
      return false;
    }
    return (
      overlaps(left.eligibility.models, right.eligibility.models) &&
      overlaps(left.eligibility.taskCategories, right.eligibility.taskCategories) &&
      overlaps(left.eligibility.agentRoles ?? [], right.eligibility.agentRoles ?? [])
    );
  }
  const levers = [left.lever, right.lever];
  return levers.includes("orchestration-policy") && levers.includes("delegation");
}

function variantIdentity(variant: DraftVariant): string | null {
  if (variant.type === "approach") return variant.policy;
  if (variant.type === "text") return variant.text === null ? "today" : variant.text.trim();
  return variant.selection === null ? null : selectionKey(variant.selection);
}

function variantIssues(
  draft: TrialDraft,
  variant: DraftVariant,
  index: number,
  context: TrialContext,
): TrialIssue[] {
  const issues: TrialIssue[] = [];
  const identity = variantIdentity(variant);
  const twin =
    identity === null
      ? -1
      : draft.variants.findIndex(
          (other, otherIndex) => otherIndex < index && variantIdentity(other) === identity,
        );
  if (twin >= 0) {
    issues.push({
      block: true,
      text: `Same as ${VARIANT_LETTERS[twin]}, so there is nothing to compare. Change one of them.`,
    });
  }
  if (variant.type === "text" && variant.text !== null) {
    if (variant.text.trim() === "") {
      issues.push({ block: true, text: "Add the text this variant gives the agent." });
    } else if (variant.text.trim().length > MAX_INSTRUCTION_LENGTH) {
      issues.push({
        block: true,
        text: `Keep this text to ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters or fewer.`,
      });
    }
    if (variant.sourcePath.trim() === "") {
      issues.push({ block: true, text: "Say where this text would eventually live." });
    }
  }
  if (variant.type === "model") {
    if (variant.selection === null) {
      issues.push({ block: true, text: "Choose a model for this variant." });
      return issues;
    }
    const name = context.modelName(variant.selection);
    if (
      context.manifest !== null &&
      !isModelInDelegation(context.manifest, variant.selection.model)
    ) {
      issues.push({
        block: true,
        text: `${name} isn't in any list in Delegation, so this trial can't start. Add it there first.`,
      });
    }
    const reason = context.unavailable(variant.selection);
    if (reason === "rate limited") {
      issues.push({ block: false, text: `${name} is rate limited, so its work may wait.` });
    } else if (reason !== null) {
      issues.push({ block: true, text: `${name} is ${reason}, so this variant could not run.` });
    }
  }
  return issues;
}

function workIssues(draft: TrialDraft, context: TrialContext): TrialIssue[] {
  if (draft.projectIds.length === 0) {
    return [{ block: true, text: "Tick at least one project, or nothing can enrol." }];
  }
  const scope = draftScope(draft);
  if (scope === null) return [];
  const now = context.now.getTime();
  const rival = context.otherTrials.find(
    (other) =>
      other.status === "running" && Date.parse(other.endsAt) > now && trialsClash(scope, other),
  );
  if (rival === undefined) return [];
  const shared = draft.projectIds.filter(
    (id) => rival.eligibility.projectIds.length === 0 || rival.eligibility.projectIds.includes(id),
  );
  return [
    {
      block: true,
      rivalId: rival.id,
      text: `“${rival.title}” is already running in ${andList(shared.map(context.projectName))}, and this work goes to it first. This trial would enrol nothing there until that one ends.`,
    },
  ];
}

function stopIssues(draft: TrialDraft, context: TrialContext): TrialIssue[] {
  const issues: TrialIssue[] = [];
  const limit = Number(draft.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    issues.push({ block: true, text: "Set a limit of at least 1, or nothing can enrol." });
  } else if (limit > MAX_ASSIGNMENTS) {
    issues.push({ block: true, text: `Set a limit of ${MAX_ASSIGNMENTS} or fewer.` });
  }
  if (draft.endDate === "") {
    issues.push({ block: true, text: "Choose an end date." });
  } else if (draft.endDate <= localDateString(context.now)) {
    issues.push({ block: true, text: "That date has passed, so nothing would enrol." });
  }
  return issues;
}

/** Everything that would stop a trial enrolling work, or quietly weaken it. */
export function trialDraftIssues(draft: TrialDraft, context: TrialContext): TrialIssues {
  const variants = draft.variants.map((variant, index) =>
    variantIssues(draft, variant, index, context),
  );
  const work = workIssues(draft, context);
  const stop = stopIssues(draft, context);
  const blocked =
    draft.kind === null || [...variants.flat(), ...work, ...stop].some((issue) => issue.block);
  return { variants, work, stop, blocked };
}

export function trialDraftLimitHint(draft: TrialDraft): string | null {
  const limit = Number(draft.limit);
  if (!Number.isInteger(limit) || limit < 1 || draft.variants.length === 0) return null;
  const each = Math.floor(limit / draft.variants.length);
  return `That is about ${each} per variant.${
    each < ENOUGH_PER_VARIANT_GUIDE
      ? ` Fewer than about ${ENOUGH_PER_VARIANT_GUIDE} each is usually too few to conclude.`
      : ""
  }`;
}

const VARIANT_IDS = "abcd";

/** A draft the issues above have cleared, as the server stores it. */
export function trialDraftDefinition(
  draft: TrialDraft,
  input: {
    readonly id: string;
    readonly modelName: (selection: ModelSelection) => string;
    readonly hashText: (text: string) => string;
  },
): ExperimentDefinition {
  const scope = draftScope(draft);
  if (scope === null) throw new Error("A trial needs something to compare.");
  const variants = draft.variants.map((variant, index): ExperimentVariant => {
    const label = draftVariantName(variant, index, input.modelName);
    if (variant.type === "approach") {
      return { id: variant.policy, label, allocationPolicy: variant.policy };
    }
    const id = VARIANT_IDS[index] ?? String(index);
    if (variant.type === "model") {
      if (variant.selection === null) throw new Error("Every variant needs a model.");
      return { id, label, modelSelection: variant.selection };
    }
    if (variant.text === null) return { id, label };
    const text = variant.text.trim();
    return {
      id,
      label,
      instructions: {
        sourcePath: variant.sourcePath.trim(),
        revision: INSTRUCTION_REVISION,
        sha256: input.hashText(text),
        text,
      },
    };
  });
  return {
    id: input.id,
    title: trialDraftTitle(draft, input.modelName),
    question: draft.question.trim() || defaultTrialQuestion(draft.kind ?? "model", draft.job),
    lever: scope.lever,
    primaryOutcome:
      scope.lever === "reviewer"
        ? "Confirmed blockers and false positives"
        : scope.lever === "orchestration-policy"
          ? "Tokens and work sent back"
          : "Work sent back and tokens",
    variants,
    eligibility: scope.eligibility,
    maxAssignments: Number(draft.limit),
    endsAt: endOfLocalDay(draft.endDate).toISOString(),
    stopConditions: [],
    codeRevision: null,
    briefRevision: null,
  };
}

const jobOfExperiment = (experiment: Pick<Experiment, "eligibility">): TrialJob => {
  const { agentRoles, reviewScopes } = experiment.eligibility;
  const role = agentRoles?.[0];
  if (role === "reviewer" || reviewScopes !== undefined) {
    return reviewScopes?.[0] === "change" ? "reviewer-change" : "reviewer-spec";
  }
  return (
    (Object.entries(TRIAL_JOBS).find(([, job]) => job.role === role)?.[0] as
      | TrialJob
      | undefined) ?? "implementation-worker"
  );
};

export function trialDraftFromExperiment(experiment: Experiment): TrialDraft {
  const kind: TrialKind =
    experiment.lever === "instruction"
      ? "text"
      : experiment.lever === "orchestration-policy"
        ? "approach"
        : "model";
  return {
    kind,
    job: jobOfExperiment(experiment),
    textRole: kind === "text" ? (experiment.eligibility.agentRoles?.[0] ?? null) : null,
    variants: experiment.variants.map((variant): DraftVariant => {
      if (kind === "approach") {
        return { type: "approach", policy: variant.allocationPolicy ?? "inline-first" };
      }
      if (kind === "text") {
        return {
          type: "text",
          text: variant.instructions?.text ?? null,
          sourcePath: variant.instructions?.sourcePath ?? DEFAULT_INSTRUCTION_SOURCE,
        };
      }
      return { type: "model", selection: variant.modelSelection ?? null };
    }),
    projectIds: experiment.eligibility.projectIds,
    limit: String(experiment.maxAssignments),
    endDate: localDateString(dateAt(Date.parse(experiment.endsAt))),
    question: experiment.question,
    questionEdited: true,
  };
}

export type TrialGroup = "running" | "drafts" | "finished";

export const isRolloverTrial = (experiment: Pick<Experiment, "lever">) =>
  experiment.lever === "rollover";

/**
 * The server has no way to delete a draft, so Delete stops it: a trial stopped before it ever
 * started and never adopted is a discarded draft, which the page no longer lists.
 */
export function isDiscardedDraft(experiment: Experiment): boolean {
  return (
    experiment.status === "stopped" &&
    experiment.startedAt === null &&
    experiment.adoptedVariantId === undefined &&
    !isRolloverTrial(experiment)
  );
}

export function trialGroupOf(experiment: Experiment): TrialGroup {
  if (isRolloverTrial(experiment) || experiment.status === "stopped") return "finished";
  return experiment.status === "draft" ? "drafts" : "running";
}

export function trialStateWord(experiment: Experiment): string {
  if (isRolloverTrial(experiment)) return "Retired";
  if (experiment.status === "stopped") return "Finished";
  if (experiment.status === "paused") return "Paused";
  return experiment.status === "draft" ? "Draft" : "Running";
}

export function experimentUnit(experiment: Pick<Experiment, "lever" | "eligibility">): string {
  if (experiment.lever === "reviewer") {
    return experiment.eligibility.reviewScopes?.[0] === "spec" ? "Spec" : "task";
  }
  return experiment.lever === "delegation" ? "task" : "thread";
}

export function experimentKindWords(experiment: Experiment): string {
  switch (experiment.lever) {
    case "instruction":
      return "Added instructions";
    case "orchestration-policy":
      return "Delegation approach";
    case "rollover":
      return "Context rollover";
    default:
      return TRIAL_JOBS[jobOfExperiment(experiment)].name;
  }
}

export function trialProgressWords(experiment: Experiment, enrolled: number | null, now: Date) {
  const unit = experimentUnit(experiment);
  const limit = experiment.maxAssignments;
  const end = formatDay(experiment.endsAt, now);
  if (experiment.status === "draft") {
    return `up to ${limit} ${pluralize(unit, limit)} · until ${end}`;
  }
  const count =
    enrolled === null
      ? `${limit} ${pluralize(unit, limit)} at most`
      : `${enrolled} of ${limit} ${pluralize(unit, limit)}`;
  if (experiment.status === "stopped")
    return `${count} · ended ${formatDay(experiment.updatedAt, now)}`;
  return Date.parse(experiment.endsAt) <= now.getTime()
    ? `${count} · ended ${end}`
    : `${count} · until ${end}`;
}

export function trialStopWords(experiment: Experiment, now: Date): string {
  const limit = experiment.maxAssignments;
  return `${limit} ${pluralize(experimentUnit(experiment), limit)}, or ${formatDay(experiment.endsAt, now)}`;
}

/** What a variant changes, in words. Stored orchestration controls were never enforced, so they stay out. */
export function describeVariantSetup(variant: ExperimentVariant): string | null {
  if (variant.allocationPolicy) return APPROACH_DESCRIPTIONS[variant.allocationPolicy];
  if (variant.instructions) return variant.instructions.text;
  if (variant.modelSelection) return null;
  if (variant.rollover) return describeExperimentTreatment(variant);
  return null;
}

const compactTokens = (value: number) =>
  new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 })
    .format(value)
    .toLowerCase();

export const UNKNOWN_RESULT = "unknown";

export interface ResultCell {
  /** What the cell says; a measure with nothing behind it is unknown, never zero. */
  readonly value: string;
  readonly coverage: string | null;
}

export function measureCell(measure: ExperimentMeasure, enrolled: number): ResultCell {
  const coverage = enrolled === 0 ? null : `${measure.covered} of ${enrolled} enrolled`;
  return {
    value: measure.value === null ? UNKNOWN_RESULT : measure.value.toLocaleString("en-GB"),
    coverage,
  };
}

function tokensCell(results: ExperimentVariantResults): ResultCell {
  const { value, covered } = results.tokens;
  return {
    value: value === null || covered === 0 ? UNKNOWN_RESULT : compactTokens(value / covered),
    coverage: results.enrolled === 0 ? null : `${covered} of ${results.enrolled} enrolled`,
  };
}

export interface ResultRow {
  readonly key: string;
  readonly name: string;
  readonly source: "Automatic" | "From Forge";
  readonly cells: ReadonlyArray<ResultCell>;
}

/**
 * Rows for one trial's comparison. A lever that never measures reviews only ever has unknowns in
 * the review rows, so they appear only once a hand-entered result gives them something to say.
 */
export function resultRows(
  experiment: Pick<Experiment, "lever" | "eligibility">,
  variants: ReadonlyArray<ExperimentVariantResults>,
): ReadonlyArray<ResultRow> {
  const unit = experimentUnit(experiment);
  const reviews = experiment.lever === "reviewer" || experiment.lever === "orchestration-policy";
  const covered = (select: (results: ExperimentVariantResults) => ExperimentMeasure) =>
    reviews || variants.some((results) => select(results).covered > 0);
  const forgeRow = (
    key: string,
    name: string,
    select: (results: ExperimentVariantResults) => ExperimentMeasure,
  ): ResultRow => ({
    key,
    name,
    source: "From Forge",
    cells: variants.map((results) => measureCell(select(results), results.enrolled)),
  });
  return [
    {
      key: "enrolled",
      name: "Enrolled",
      source: "Automatic",
      cells: variants.map((results) => ({
        value: results.enrolled.toLocaleString("en-GB"),
        coverage: null,
      })),
    },
    ...(covered((results) => results.confirmedBlockers)
      ? [forgeRow("blockers", "Confirmed blockers found", (results) => results.confirmedBlockers)]
      : []),
    ...(covered((results) => results.falsePositives)
      ? [forgeRow("false-positives", "False positives", (results) => results.falsePositives)]
      : []),
    ...(covered((results) => results.problemsAfterLanding)
      ? [
          {
            ...forgeRow(
              "after-landing",
              "Problems found after landing",
              (results) => results.problemsAfterLanding,
            ),
            cells: variants.map((results) => ({
              value: measureCell(results.problemsAfterLanding, results.enrolled).value,
              coverage:
                results.enrolled === 0
                  ? null
                  : `${results.problemsAfterLanding.covered} of ${results.enrolled} enrolled · ${results.landingWindowsComplete} past 14 days`,
            })),
          },
        ]
      : []),
    forgeRow("sent-back", "Sent back", (results) => results.sentBack),
    ...(experiment.lever === "orchestration-policy"
      ? [
          {
            ...forgeRow("helpers", "Helpers leads started", (results) => results.delegatedHelpers),
            source: "Automatic" as const,
          },
        ]
      : []),
    {
      key: "tokens",
      name: `Tokens per ${unit}`,
      source: "Automatic",
      cells: variants.map(tokensCell),
    },
  ];
}

export interface ResultsVerdict {
  readonly tone: "warning" | "info";
  readonly text: string;
  readonly tooFew: boolean;
}

export function resultsVerdict(results: ExperimentResults): ResultsVerdict {
  const names = results.variants.map(
    (variant) => `${variant.label} has ${variant.enrolled} enrolled`,
  );
  if (results.variants.every((variant) => variant.enrolled === 0)) {
    return {
      tone: "warning",
      tooFew: true,
      text: "Nothing has enrolled yet, so there is nothing to compare.",
    };
  }
  if (results.variants.some((variant) => variant.tooFewResults)) {
    return {
      tone: "warning",
      tooFew: true,
      text: `Too few results to conclude. ${andList(names)}, and about ${results.enoughPerVariant} results each is the least worth reading. Differences this small could be chance.`,
    };
  }
  return {
    tone: "info",
    tooFew: false,
    text: `Enough results to compare: ${andList(names)}. This page doesn't pick a winner. That's your call.`,
  };
}

export function miniResultWords(
  experiment: Pick<Experiment, "lever" | "eligibility">,
  results: ExperimentVariantResults,
): string {
  const unit = experimentUnit(experiment);
  const parts = [`${results.enrolled} enrolled`];
  if (experiment.lever === "reviewer") {
    const { value } = results.confirmedBlockers;
    parts.push(
      value === null
        ? `blockers ${UNKNOWN_RESULT}`
        : `${value.toLocaleString("en-GB")} ${pluralize("blocker", value)}`,
    );
  }
  if (experiment.lever === "orchestration-policy") {
    const { value } = results.delegatedHelpers;
    parts.push(
      value === null
        ? `helpers ${UNKNOWN_RESULT}`
        : `${value.toLocaleString("en-GB")} ${pluralize("helper", value)}`,
    );
  }
  const { value, covered } = results.tokens;
  parts.push(
    value === null || covered === 0
      ? `tokens ${UNKNOWN_RESULT}`
      : `${compactTokens(value / covered)} tokens per ${unit}`,
  );
  return parts.join(" · ");
}

export function needsAnOutcome(
  experiment: Pick<Experiment, "lever">,
  sample: ExperimentSampleResult,
): boolean {
  return (
    experiment.lever === "reviewer" &&
    sample.landingWindowComplete !== null &&
    sample.confirmedBlockers === null &&
    sample.falsePositives === null
  );
}

export const FORGE_UNAVAILABLE_TEXT =
  "Forge results are unavailable right now, so anything that comes from Forge shows as unknown until it is back.";

const RESULT_MEASURE_WORDS: Readonly<Record<ExperimentResultSource["measure"], string>> = {
  "confirmed-blocker": "Confirmed blocker",
  "false-positive": "False positive",
  "sent-back": "Sent back",
  "problem-after-landing": "Problem after landing",
};

export function describeResultSource(
  source: ExperimentResultSource,
  outcomes: ReadonlyArray<ExperimentOutcome>,
): { readonly measure: string; readonly origin: string } {
  const measure = RESULT_MEASURE_WORDS[source.measure];
  switch (source.origin) {
    case "forge-finding":
      return {
        measure,
        origin: `Forge finding ${source.findingRef ?? ""} in review ${source.reference}`.replace(
          "  ",
          " ",
        ),
      };
    case "forge-landing":
      return { measure, origin: `Forge landing ${source.reference}` };
    case "forge-note":
      return { measure, origin: `Forge note ${source.reference}` };
    case "helper-round":
      return { measure, origin: `Helper run ${source.reference}` };
    case "hand": {
      const evidence = outcomes.find((outcome) => outcome.id === source.reference)?.evidence ?? [];
      return {
        measure,
        origin: ["Entered by hand", ...evidence].join(" · "),
      };
    }
  }
}

export type RecordedOutcomeChoice = "blocker" | "false-positive" | "after-landing" | "nothing";

export const RECORDED_OUTCOME_CHOICES: Readonly<
  Record<
    RecordedOutcomeChoice,
    {
      readonly label: string;
      readonly kind: ExperimentOutcomeInput["kind"];
      /** The server scores only hand-entered findings; anything else stays with the assignment. */
      readonly countsInTotals: boolean;
    }
  >
> = {
  blocker: { label: "Confirmed blocker", kind: "validated-finding", countsInTotals: true },
  "false-positive": { label: "False positive", kind: "false-positive", countsInTotals: true },
  "after-landing": { label: "Problem found after landing", kind: "rework", countsInTotals: false },
  nothing: { label: "Nothing found", kind: "verified-completion", countsInTotals: false },
};

/** What an outcome recorded outside the scored results says, for the assignment's own detail. */
export function describeRecordedOutcome(outcome: ExperimentOutcome): {
  readonly label: string;
  readonly origin: string;
} {
  const label = outcome.note.trim() || outcome.kind.replaceAll("-", " ");
  const who = outcome.source === "human-review" ? "Entered by hand" : "Recorded by an agent";
  return { label, origin: [who, ...outcome.evidence].join(" · ") };
}

export function outcomeNoteFor(choice: RecordedOutcomeChoice): string {
  return RECORDED_OUTCOME_CHOICES[choice].label;
}

/** An assignment's headline; encoded unit ids are never shown as they read as noise. */
export function assignmentTitle(row: ExperimentAssignmentReport): string {
  const { assignment } = row;
  if (assignment.work) return assignment.work.description;
  if (assignment.agentTask) return assignment.agentTask.workId;
  return assignment.threadId === null ? assignment.unitKind : "Thread";
}

export interface AdoptionEntry {
  readonly label: string;
  readonly effort: string | null;
}

export interface AdoptionChange {
  readonly what: string;
  readonly inDelegation: boolean;
  /** Adopting records the variant and stops the trial, but leaves every setting as it is. */
  readonly changesNothing: boolean;
  readonly before: ReadonlyArray<AdoptionEntry> | null;
  readonly after: ReadonlyArray<AdoptionEntry> | null;
  readonly note: string | null;
}

/**
 * What making a variant the default changes. Every variant of a trial that can still be decided
 * can be made the default, including one that keeps today's setup, so the current setup can win.
 */
export function adoptionChange(
  experiment: Experiment,
  variant: ExperimentVariant,
  input: {
    readonly manifest: AgentPolicyManifest | null;
    readonly modelName: (driverKind: ProviderDriverKind, model: string) => string;
    readonly roleLabel: (role: AgentRole) => string;
  },
): AdoptionChange | null {
  if (experiment.adoptedVariantId === variant.id || isRolloverTrial(experiment)) return null;
  const unchanged = (what: string): AdoptionChange => ({
    what,
    inDelegation: false,
    changesNothing: true,
    before: null,
    after: null,
    note: null,
  });
  if (variant.modelSelection === undefined) {
    if (variant.instructions !== undefined) {
      return {
        what: `Add this text to ${variant.instructions.sourcePath}`,
        inDelegation: false,
        changesNothing: false,
        before: null,
        after: null,
        note: null,
      };
    }
    if (variant.allocationPolicy === undefined) {
      return unchanged(
        experiment.lever === "instruction"
          ? "Today's instructions stay as they are."
          : "This variant keeps today's setup.",
      );
    }
    return {
      what: `The lead skill: ${ALLOCATION_POLICY_LABELS[variant.allocationPolicy].toLowerCase()}`,
      inDelegation: false,
      changesNothing: false,
      before: null,
      after: null,
      note: null,
    };
  }
  const job = TRIAL_JOBS[jobOfExperiment(experiment)];
  const generic: AdoptionChange = {
    what: `${job.name}: order to try`,
    inDelegation: true,
    changesNothing: false,
    before: null,
    after: null,
    note: null,
  };
  // A trial naming no single job can't change a list; the server says so when asked.
  if (experiment.eligibility.agentRoles?.length !== 1) return generic;
  const manifest = input.manifest;
  const list = manifest === null ? null : jobList(manifest, job);
  if (manifest === null || list === null) return generic;
  const toEntry = (entry: { model: string; effort?: string | undefined }): AdoptionEntry => {
    const binding = manifest.models[entry.model];
    return {
      label:
        binding === undefined ? entry.model : input.modelName(binding.driverKind, binding.model),
      effort: entry.effort ?? null,
    };
  };
  const current = manifest.lists[list] ?? [];
  const alias = Object.entries(manifest.models).find(
    ([, binding]) => binding.model === variant.modelSelection?.model,
  )?.[0];
  if (alias === undefined) return generic;
  const effort = selectionEffort(variant.modelSelection);
  const first = current[0];
  if (first?.model === alias && (first.effort ?? null) === effort) {
    const { label } = toEntry(first);
    return unchanged(
      `${job.name}: ${effort === null ? label : `${label} ${effort}`} is already first.`,
    );
  }
  const sharing = Object.entries(manifest.roles).flatMap(([role, policy]) =>
    policy !== undefined && (policy.list === list || policy.specList === list)
      ? [role as AgentRole]
      : [],
  );
  const labels = sharing.map(input.roleLabel);
  return {
    ...generic,
    before: current.map(toEntry),
    after: [
      toEntry({ model: alias, ...(effort === null ? {} : { effort }) }),
      ...current.filter((entry) => entry.model !== alias).map(toEntry),
    ],
    note:
      sharing.length > 1
        ? `${andList(labels)} share one list, so this changes ${sharing.length === 2 ? "both" : `all ${sharing.length}`}.`
        : null,
  };
}

export type TrialAction =
  | "start"
  | "start-saved"
  | "resume"
  | "pause"
  | "stop"
  | "delete"
  | "save"
  | "adopt"
  | "outcome";

const FAILURE_WORDS: Readonly<Record<TrialAction, { lead: string; keep: string }>> = {
  start: { lead: "Couldn't start this trial.", keep: "It is still a draft." },
  "start-saved": {
    lead: "Couldn't start this trial.",
    keep: "Your choices are still here, saved as a draft.",
  },
  resume: { lead: "Couldn't resume this trial.", keep: "It is still paused." },
  pause: { lead: "Couldn't pause this trial.", keep: "It is still enrolling new work." },
  stop: { lead: "Couldn't stop this trial.", keep: "Its status hasn't changed." },
  delete: { lead: "Couldn't delete this draft.", keep: "It is still here." },
  save: { lead: "Couldn't save this draft.", keep: "Your choices are still here." },
  adopt: { lead: "Couldn't change the default.", keep: "Nothing changed in Delegation." },
  outcome: { lead: "Couldn't save this outcome.", keep: "Nothing was recorded." },
};

const REASON_WORDS: Readonly<Record<string, string>> = {
  conflict: "Another running trial takes this work first, so stop that one before starting this.",
  "invalid-transition":
    "The server refused it: the end date or limit may have passed, or a model may have left Delegation's lists.",
  "invalid-definition": "The server refused this setup.",
  persistence: "The server couldn't save the change.",
  "not-found": "The server no longer has this trial.",
};

/** A failed action's message: `detail` says what to change, when the server knows. */
export function describeTrialFailure(action: TrialAction, error: unknown): string {
  const { lead, keep } = FAILURE_WORDS[action];
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    readonly _tag?: unknown;
    readonly detail?: unknown;
    readonly reason?: unknown;
  };
  if (failure._tag === "ExperimentError") {
    if (typeof failure.detail === "string" && failure.detail.trim() !== "") {
      return `${lead} ${failure.detail.trim()} ${keep}`;
    }
    const reason = typeof failure.reason === "string" ? REASON_WORDS[failure.reason] : undefined;
    if (reason !== undefined) return `${lead} ${reason} ${keep}`;
  }
  return `${lead} The server didn't answer. ${keep}`;
}
