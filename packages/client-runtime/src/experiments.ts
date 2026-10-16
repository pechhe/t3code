import { Sha256 } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Schema } from "effect";
import type {
  ExperimentAllocationPolicy,
  ExperimentAssignment,
  ExperimentAssignmentReport,
  ExperimentOrchestrationControls,
  ExperimentVariant,
  ExperimentWorkReport,
  ModelSelection,
} from "@t3tools/contracts";

/**
 * Presentation rules shared by the web/desktop and mobile experiment screens.
 * The server owns assignment, eligibility and reporting; these helpers only
 * describe what it recorded without inferring winners, charges or zero usage.
 */

export const ALLOCATION_POLICY_LABELS: Readonly<Record<ExperimentAllocationPolicy, string>> = {
  "inline-first": "Inline-first",
  "delegate-earlier": "Delegate-earlier",
};

/** Both arms of an orchestration-policy trial; the server requires exactly these two. */
export const ORCHESTRATION_POLICY_VARIANTS: readonly ExperimentVariant[] = (
  ["inline-first", "delegate-earlier"] as const
).map((policy) => ({
  id: policy,
  label: ALLOCATION_POLICY_LABELS[policy],
  allocationPolicy: policy,
}));

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

const isPolicyHash = Schema.is(Sha256);

/** Client-side form check mirroring the server's definition rules; the server still decides. */
export function orchestrationControlsError(input: {
  orchestratorSelection: ModelSelection | null;
  policyHash: string;
  reviewerPolicyRevision: string;
  verificationRevision: string;
  concurrency: number;
}): string | null {
  if (!input.orchestratorSelection) return "Choose the parent model and effort held in both arms.";
  if (!isPolicyHash(input.policyHash.trim()))
    return "Enter the 64-character agent policy hash that both arms must use.";
  if (!input.reviewerPolicyRevision.trim() || !input.verificationRevision.trim())
    return "Enter the reviewer policy and verification revisions held in both arms.";
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1)
    return "Concurrency must be a whole number of at least 1.";
  return null;
}

const WORK_EXCLUSION_REASONS: Readonly<Record<string, string>> = {
  "work-already-started": "Work had already started before enrollment",
  "controls-mismatch": "Parent model, effort or agent policy differed from the fixed controls",
  "assignment-cap": "The trial had reached its assignment limit",
};

export function describeWorkExclusion(reason: string): string {
  return WORK_EXCLUSION_REASONS[reason] ?? reason;
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

export type WorkTreatmentStatus = "matches" | "differs" | "undecided" | "not-assigned";

export interface WorkTreatmentComparison {
  readonly assignedPolicy: ExperimentAllocationPolicy | null;
  readonly actualAllocation: "inline" | "delegated" | null;
  readonly status: WorkTreatmentStatus;
}

/** Assignment versus actual allocation for one experiment's arm of an enrolled unit. */
export function compareWorkTreatment(
  work: ExperimentWorkReport,
  experimentId: string,
): WorkTreatmentComparison {
  const assignedPolicy =
    work.unit.assignedPolicies.find((policy) => policy.experimentId === experimentId)
      ?.allocationPolicy ?? null;
  const actualAllocation = work.actualAllocation;
  const status: WorkTreatmentStatus =
    assignedPolicy === null
      ? "not-assigned"
      : actualAllocation === null
        ? "undecided"
        : (assignedPolicy === "inline-first" ? "inline" : "delegated") === actualAllocation
          ? "matches"
          : "differs";
  return { assignedPolicy, actualAllocation, status };
}

export const WORK_TREATMENT_STATUS_LABELS: Readonly<Record<WorkTreatmentStatus, string>> = {
  matches: "matches the assigned policy's default",
  differs: "differs from the assigned policy's default",
  undecided: "allocation not yet recorded",
  "not-assigned": "not assigned by this trial",
};

const OBSERVED_DEVIATIONS: Readonly<Record<string, string>> = {
  "observed-parent-selection-changed": "Observed parent model or options differed from enrollment",
  "observed-child-selection-changed": "A child ran with a different selection than requested",
};

/** Observed treatment changes are labelled; anything else is the parent's own stated reason. */
export function describeWorkDeviation(deviation: string): string {
  return OBSERVED_DEVIATIONS[deviation] ?? `Parent-stated: ${deviation}`;
}

export interface WorkTaskLaunch {
  readonly label: string;
  /** A refused launch is an explicit block, never a silent fallback. */
  readonly blockedReason: string | null;
}

export function describeWorkTaskLaunch(
  task: ExperimentWorkReport["tasks"][number],
): WorkTaskLaunch {
  const { binding } = task;
  switch (task.launchState) {
    case "refused":
      return {
        label: "refused before launch",
        blockedReason: `Dispatch of the ${binding.role} route (${binding.taskClass}, ${binding.sourceAccess}, ${binding.toolProfile}) for ${describeModelSelection(binding.effective)} was refused before launch; the reason is not exposed to clients. No other model or wider permission was substituted.`,
      };
    case "launch-unknown":
      return { label: "launch outcome unknown; inspect before retrying", blockedReason: null };
    case null:
      return { label: "launch state unavailable", blockedReason: null };
    default:
      return { label: task.launchState, blockedReason: null };
  }
}

type Usage = ExperimentAssignmentReport["usage"];

function tokens(value: number | null): string {
  return value === null ? "unavailable" : value.toLocaleString();
}

/** Token counts only; missing counters read as unavailable, never zero, and nothing is priced. */
export function describeUsage(usage: Usage): string {
  return [
    `${usage.status} usage`,
    `input ${tokens(usage.inputTokens)}`,
    `output ${tokens(usage.outputTokens)}`,
    `cached input ${tokens(usage.cachedInputTokens)}`,
    `cache creation ${tokens(usage.cacheCreationTokens)}`,
    `reasoning ${tokens(usage.reasoningTokens)}`,
    ...(usage.missingTurns > 0 ? [`${usage.missingTurns} missing turns`] : []),
    ...(usage.partialTurns > 0 ? [`${usage.partialTurns} partial turns`] : []),
    ...(usage.hasUnattributedSubagentUsage ? ["unattributed subagent usage"] : []),
  ].join(" · ");
}

export function formatDurationMs(value: number | null): string {
  return value === null ? "unavailable" : formatDuration(value);
}
