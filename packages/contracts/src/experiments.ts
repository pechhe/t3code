import { AgentReviewScope, AgentTaskBinding, Sha256 } from "./agentPolicy.ts";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  EnvironmentId,
  ProviderTurnId,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { TurnTokenUsage } from "./providerRuntime.ts";

export const ExperimentStatus = Schema.Literals(["draft", "running", "paused", "stopped"]);
export type ExperimentStatus = typeof ExperimentStatus.Type;
export const ExperimentLever = Schema.Literals([
  "rollover",
  "reviewer",
  "delegation",
  "orchestration-policy",
  "instruction",
]);
export type ExperimentLever = typeof ExperimentLever.Type;
export const ExperimentRolloverPolicy = Schema.Struct({
  softLimit: PositiveInt,
  hardLimit: PositiveInt,
});
export type ExperimentRolloverPolicy = typeof ExperimentRolloverPolicy.Type;
export const ExperimentAllocationPolicy = Schema.Literals(["inline-first", "delegate-earlier"]);
export type ExperimentAllocationPolicy = typeof ExperimentAllocationPolicy.Type;
export const ExperimentOrchestrationControls = Schema.Struct({
  orchestratorSelection: ModelSelection,
  policyHash: Sha256,
  reviewerPolicyRevision: TrimmedNonEmptyString,
  verificationRevision: TrimmedNonEmptyString,
  concurrency: PositiveInt,
});
export type ExperimentOrchestrationControls = typeof ExperimentOrchestrationControls.Type;
/**
 * One version of a workflow skill or instruction section, delivered to an assigned thread
 * as an overlay on top of its usual instructions. `sha256` is the hash of `text`.
 */
export const ExperimentInstructionVariant = Schema.Struct({
  /** Where the text comes from, such as `skills/lead/SKILL.md` in agent-config. */
  sourcePath: TrimmedNonEmptyString,
  /** The agent-config revision the text was taken from. */
  revision: TrimmedNonEmptyString,
  sha256: Sha256,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type ExperimentInstructionVariant = typeof ExperimentInstructionVariant.Type;
export const ExperimentVariant = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  rollover: Schema.optional(ExperimentRolloverPolicy),
  instructions: Schema.optional(ExperimentInstructionVariant),
  modelSelection: Schema.optional(ModelSelection),
  allocationPolicy: Schema.optional(ExperimentAllocationPolicy),
});
export type ExperimentVariant = typeof ExperimentVariant.Type;
export const ExperimentDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  lever: ExperimentLever,
  orchestrationControls: Schema.optional(ExperimentOrchestrationControls),
  primaryOutcome: TrimmedNonEmptyString,
  variants: Schema.Array(ExperimentVariant),
  eligibility: Schema.Struct({
    projectIds: Schema.Array(ProjectId),
    models: Schema.Array(TrimmedNonEmptyString),
    taskCategories: Schema.Array(TrimmedNonEmptyString),
    /**
     * Review units each reviewer experiment admits; required for new reviewer
     * experiments. A definition without it predates typed scope and admits only reviews
     * that declare none, so change and Spec reviews are never silently pooled with it.
     */
    reviewScopes: Schema.optional(Schema.Array(AgentReviewScope).check(Schema.isMinLength(1))),
  }),
  maxAssignments: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  endsAt: Schema.String,
  /** Human review criteria; maxAssignments and endsAt are enforced automatically. */
  stopConditions: Schema.Array(TrimmedNonEmptyString),
  codeRevision: Schema.NullOr(TrimmedNonEmptyString),
  briefRevision: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentDefinition = typeof ExperimentDefinition.Type;
export const Experiment = Schema.Struct({
  ...ExperimentDefinition.fields,
  revision: PositiveInt,
  status: ExperimentStatus,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type Experiment = typeof Experiment.Type;
export const ExperimentTransitionInput = Schema.Struct({
  experimentId: TrimmedNonEmptyString,
  status: ExperimentStatus,
});
export type ExperimentTransitionInput = typeof ExperimentTransitionInput.Type;
export const ExperimentListInput = Schema.Struct({});
export const ExperimentAssignmentsInput = Schema.Struct({
  experimentId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type ExperimentAssignmentsInput = typeof ExperimentAssignmentsInput.Type;
export const ExperimentWorkOwner = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspacePath: TrimmedNonEmptyString,
  parentThreadId: Schema.NullOr(ThreadId),
  externalSessionKey: Schema.NullOr(TrimmedNonEmptyString),
  clientSessionId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentWorkOwner = typeof ExperimentWorkOwner.Type;
export const ExperimentWorkEnrollInput = Schema.Struct({
  workId: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  taskCategory: TrimmedNonEmptyString,
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  /** Explicitly exclude work whose execution already began; a parent declaration. */
  alreadyStarted: Schema.optional(Schema.Boolean),
  externalSessionKey: Schema.optional(TrimmedNonEmptyString),
  reportedOrchestratorSelection: Schema.optional(ModelSelection),
});
export type ExperimentWorkEnrollInput = typeof ExperimentWorkEnrollInput.Type;
export const ExperimentWorkUnit = Schema.Struct({
  id: TrimmedNonEmptyString,
  workId: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  taskCategory: TrimmedNonEmptyString,
  taskClass: Schema.Literal("non-ui"),
  sourceRevision: Schema.NullOr(TrimmedNonEmptyString),
  owner: ExperimentWorkOwner,
  orchestratorSelection: ModelSelection,
  modelSource: Schema.Literals(["run-selection", "self-report"]),
  policyHash: Sha256,
  policyRevision: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.String,
  assignmentIds: Schema.Array(TrimmedNonEmptyString),
  assignedPolicies: Schema.Array(
    Schema.Struct({
      experimentId: TrimmedNonEmptyString,
      allocationPolicy: ExperimentAllocationPolicy,
      controls: ExperimentOrchestrationControls,
    }),
  ),
  exclusions: Schema.Array(
    Schema.Struct({ experimentId: TrimmedNonEmptyString, reason: TrimmedNonEmptyString }),
  ),
});
export type ExperimentWorkUnit = typeof ExperimentWorkUnit.Type;
export const ExperimentWorkAllocationInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  workUnitId: TrimmedNonEmptyString,
  allocation: Schema.Literals(["inline", "delegated"]),
  reason: TrimmedNonEmptyString,
  deviationReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentWorkAllocationInput = typeof ExperimentWorkAllocationInput.Type;
export const ExperimentWorkAllocation = Schema.Struct({
  ...ExperimentWorkAllocationInput.fields,
  recordedAt: Schema.String,
  source: Schema.Literal("self-report"),
});
export type ExperimentWorkAllocation = typeof ExperimentWorkAllocation.Type;
export const ExperimentWorkEvidenceInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  workUnitId: TrimmedNonEmptyString,
  actor: Schema.Literals(["parent", "child"]),
  phase: Schema.Literals([
    "briefing",
    "startup",
    "wait",
    "execution",
    "inspection",
    "rework",
    "verification",
    "advice",
  ]),
  attribution: Schema.Literals(["whole-turn", "explicit-segment", "partial", "unavailable"]),
  threadId: Schema.NullOr(ThreadId),
  providerTurnId: Schema.NullOr(ProviderTurnId),
  /** Stable identity in the external parent's own telemetry; never T3-attested. */
  externalSegmentId: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(TurnTokenUsage),
  evidence: Schema.Array(TrimmedNonEmptyString),
});
export type ExperimentWorkEvidenceInput = typeof ExperimentWorkEvidenceInput.Type;
export const ExperimentWorkEvidence = Schema.Struct({
  ...ExperimentWorkEvidenceInput.fields,
  recordedAt: Schema.String,
  source: Schema.Literals(["provider-telemetry", "self-report"]),
  attributionSource: Schema.Literal("self-report"),
});
export type ExperimentWorkEvidence = typeof ExperimentWorkEvidence.Type;
export const ExperimentWorkReadInput = Schema.Struct({ workUnitId: TrimmedNonEmptyString });
export const ExperimentAssignInput = Schema.Struct({
  agentTask: Schema.optional(AgentTaskBinding),
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  unitKind: Schema.Literals(["thread", "task"]),
  unitId: TrimmedNonEmptyString,
  taskCategory: Schema.optional(TrimmedNonEmptyString),
  taskLever: Schema.optional(Schema.Literals(["reviewer", "delegation"])),
  /** For a thread, the one lever to enroll it in; each caller assigns only its own. */
  threadLever: Schema.optional(Schema.Literals(["rollover", "instruction"])),
  enrollment: Schema.Literals(["new", "existing-boundary"]),
  unitCreatedAt: Schema.optional(Schema.String),
  boundaryRunId: Schema.optional(RunId),
});
export type ExperimentAssignInput = typeof ExperimentAssignInput.Type;
export const ExperimentAssignment = Schema.Struct({
  work: Schema.optional(ExperimentWorkUnit),
  agentTask: Schema.optional(AgentTaskBinding),
  id: TrimmedNonEmptyString,
  experimentId: TrimmedNonEmptyString,
  revision: PositiveInt,
  lever: ExperimentLever,
  unitKind: Schema.Literals(["thread", "task", "work"]),
  unitId: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  projectId: ProjectId,
  taskCategory: Schema.NullOr(TrimmedNonEmptyString),
  boundaryRunId: Schema.NullOr(RunId),
  variant: ExperimentVariant,
  assignedModelSelection: ModelSelection,
  enrollment: Schema.Literals(["new", "existing-boundary", "historical"]),
  assignmentMethod: Schema.Literals(["randomized", "observational"]),
  assignedAt: Schema.String,
  codeRevision: Schema.NullOr(TrimmedNonEmptyString),
  briefRevision: Schema.NullOr(TrimmedNonEmptyString),
  provenance: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentAssignment = typeof ExperimentAssignment.Type;
export const ExperimentOutcomeInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  assignmentId: TrimmedNonEmptyString,
  runId: Schema.NullOr(RunId),
  kind: Schema.Literals([
    "verified-completion",
    "failure",
    "cancellation",
    "constraint-missed",
    "user-correction",
    "rework",
    "validated-finding",
    "false-positive",
    "incomplete-review",
    "fallback",
    "manual-override",
  ]),
  source: Schema.Literals([
    "independent-evidence",
    "human-review",
    "automated-judgement",
    "self-report",
  ]),
  evidence: Schema.Array(TrimmedNonEmptyString),
  note: Schema.String,
  actualModelSelection: Schema.NullOr(ModelSelection),
  fallbackReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentOutcomeInput = typeof ExperimentOutcomeInput.Type;
export const ExperimentOutcome = Schema.Struct({
  ...ExperimentOutcomeInput.fields,
  recordedAt: Schema.String,
});
export type ExperimentOutcome = typeof ExperimentOutcome.Type;
/** Immutable evidence facts; evaluation is recorded separately against exact captures. */
export const ExperimentEvidenceArtifact = Schema.Struct({
  kind: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32_000))),
});
export const ExperimentEvidenceInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  assignmentId: TrimmedNonEmptyString,
  episodeId: TrimmedNonEmptyString,
  recipeRevision: TrimmedNonEmptyString,
  runId: RunId,
  phase: Schema.Literals(["before", "action", "after", "failure"]),
  source: Schema.Literals(["runtime", "human", "agent"]),
  artifacts: Schema.Array(ExperimentEvidenceArtifact).check(Schema.isMaxLength(32)),
  missing: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(32)),
});
export type ExperimentEvidenceInput = typeof ExperimentEvidenceInput.Type;
export const ExperimentEvidence = Schema.Struct({
  ...ExperimentEvidenceInput.fields,
  capturedAt: Schema.String,
});
export type ExperimentEvidence = typeof ExperimentEvidence.Type;
export const ExperimentEvaluationInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  assignmentId: TrimmedNonEmptyString,
  episodeId: TrimmedNonEmptyString,
  rubricRevision: TrimmedNonEmptyString,
  evaluator: TrimmedNonEmptyString,
  source: Schema.Literals(["human-review", "automated-judgement", "self-report"]),
  evidenceIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  findings: Schema.Array(
    Schema.Struct({
      criterion: TrimmedNonEmptyString,
      result: Schema.Literals(["pass", "fail", "unknown"]),
      evidenceIds: Schema.Array(TrimmedNonEmptyString),
      note: Schema.String.check(Schema.isMaxLength(8_000)),
    }),
  ).check(Schema.isMaxLength(32)),
  usage: Schema.NullOr(TurnTokenUsage),
  supersedesId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ExperimentEvaluationInput = typeof ExperimentEvaluationInput.Type;
export const ExperimentEvaluation = Schema.Struct({
  ...ExperimentEvaluationInput.fields,
  recordedAt: Schema.String,
});
export type ExperimentEvaluation = typeof ExperimentEvaluation.Type;
export const ExperimentEpisodeReport = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The recipe of the episode's earliest capture; each capture records its own. */
  recipeRevision: TrimmedNonEmptyString,
  /**
   * The setup segment of this entry's captures (see the runs' `setupSegment`). An episode
   * spanning a cut appears once per segment, each entry holding only that side's captures.
   */
  setupSegment: Schema.optional(NonNegativeInt),
  captureIds: Schema.Array(TrimmedNonEmptyString),
  evaluationIds: Schema.Array(TrimmedNonEmptyString),
});
export type ExperimentEpisodeReport = typeof ExperimentEpisodeReport.Type;

export const ExperimentEvidenceReadInput = Schema.Struct({
  assignmentId: TrimmedNonEmptyString,
  episodeId: TrimmedNonEmptyString,
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(5))),
});
export type ExperimentEvidenceReadInput = typeof ExperimentEvidenceReadInput.Type;
export const ExperimentEvidenceBundle = Schema.Struct({
  rubric: Schema.NullOr(
    Schema.Struct({
      revision: TrimmedNonEmptyString,
      criteria: Schema.Array(TrimmedNonEmptyString),
      instructions: Schema.String,
    }),
  ),
  captures: Schema.Array(ExperimentEvidence),
  evaluations: Schema.Array(ExperimentEvaluation),
  hasMoreCaptures: Schema.Boolean,
  evaluationsTruncated: Schema.Boolean,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type ExperimentEvidenceBundle = typeof ExperimentEvidenceBundle.Type;

export const ExperimentObservationInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  assignmentId: TrimmedNonEmptyString,
  runId: RunId,
  episodeId: Schema.optional(TrimmedNonEmptyString),
  configuredPolicy: Schema.optional(ExperimentRolloverPolicy),
  effectivePolicy: Schema.optional(ExperimentRolloverPolicy),
  kind: Schema.Literals([
    "soft",
    "hard",
    "rollover",
    "fresh-context",
    "context-drop",
    "context-growth",
    "native-compaction",
    "restart-failure",
    "continuation-ended",
    "setup-change",
  ]),
  usedTokens: Schema.NullOr(NonNegativeInt),
  maxTokens: Schema.NullOr(PositiveInt),
  growthTokens: Schema.optional(NonNegativeInt),
  recoveredTokens: Schema.optional(NonNegativeInt),
  delayMs: Schema.optional(NonNegativeInt),
  lowYield: Schema.optional(Schema.Boolean),
  /**
   * A `setup-change` cut point: what differs from the thread's previous run. `subject`
   * is `agent-config` for the revision, or an instruction file's path for its hash.
   */
  setupChanges: Schema.optional(
    Schema.Array(
      Schema.Struct({
        subject: TrimmedNonEmptyString,
        from: Schema.NullOr(TrimmedNonEmptyString),
        to: Schema.NullOr(TrimmedNonEmptyString),
      }),
    ),
  ),
  evidence: Schema.Array(TrimmedNonEmptyString),
});
export type ExperimentObservationInput = typeof ExperimentObservationInput.Type;
export const ExperimentObservation = Schema.Struct({
  ...ExperimentObservationInput.fields,
  recordedAt: Schema.String,
});
export type ExperimentObservation = typeof ExperimentObservation.Type;
export const ExperimentHistoricalInput = Schema.Struct({
  experimentId: TrimmedNonEmptyString,
  variantId: TrimmedNonEmptyString,
  unitId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  taskCategory: Schema.NullOr(TrimmedNonEmptyString),
  assignedModelSelection: ModelSelection,
  assignedAt: Schema.String,
  codeRevision: Schema.NullOr(TrimmedNonEmptyString),
  briefRevision: Schema.NullOr(TrimmedNonEmptyString),
  /** Original method and source, without reclassifying it as T3 randomization. */
  provenance: TrimmedNonEmptyString,
});
export type ExperimentHistoricalInput = typeof ExperimentHistoricalInput.Type;
export const ExperimentReportInput = Schema.Struct({
  experimentId: TrimmedNonEmptyString,
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type ExperimentReportInput = typeof ExperimentReportInput.Type;
export const ExperimentTurnEvidence = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  providerTurnId: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  modelSelection: Schema.NullOr(ModelSelection),
  modelSource: Schema.Literals([
    "provider-reported",
    "recorded-treatment",
    "run-selection",
    "unknown",
  ]),
  status: Schema.String,
  usage: Schema.NullOr(TurnTokenUsage),
  activeMs: Schema.NullOr(NonNegativeInt),
});
export type ExperimentTurnEvidence = typeof ExperimentTurnEvidence.Type;
export const ExperimentAssignmentReport = Schema.Struct({
  assignment: ExperimentAssignment,
  coExposureIds: Schema.Array(TrimmedNonEmptyString),
  turns: Schema.Array(ExperimentTurnEvidence),
  runs: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      runId: RunId,
      status: Schema.String,
      modelSelection: ModelSelection,
      requestedAt: Schema.String,
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
      /**
       * How many `setup-change` cut points on this run's thread precede or start it, so
       * runs on either side of a cut can be compared separately.
       */
      setupSegment: Schema.optional(NonNegativeInt),
    }),
  ),
  descendantCoverage: Schema.Literals(["complete", "partial"]),
  telemetryTruncated: Schema.Boolean,
  missingThreadIds: Schema.Array(ThreadId),
  outcomes: Schema.Array(ExperimentOutcome),
  observations: Schema.Array(ExperimentObservation),
  episodes: Schema.optional(Schema.Array(ExperimentEpisodeReport)),
  episodeSummariesTruncated: Schema.optional(Schema.Boolean),
  projectionAvailable: Schema.Boolean,
  wallClockMs: Schema.NullOr(NonNegativeInt),
  activeMs: Schema.NullOr(NonNegativeInt),
  waitMs: Schema.NullOr(NonNegativeInt),
  usage: Schema.Struct({
    status: Schema.Literals(["complete", "partial", "unavailable"]),
    inputTokens: Schema.NullOr(NonNegativeInt),
    outputTokens: Schema.NullOr(NonNegativeInt),
    cachedInputTokens: Schema.NullOr(NonNegativeInt),
    cacheCreationTokens: Schema.NullOr(NonNegativeInt),
    reasoningTokens: Schema.NullOr(NonNegativeInt),
    missingTurns: NonNegativeInt,
    partialTurns: NonNegativeInt,
    hasUnattributedSubagentUsage: Schema.Boolean,
  }),
});
export type ExperimentAssignmentReport = typeof ExperimentAssignmentReport.Type;
export const ExperimentWorkReport = Schema.Struct({
  /** Observed simultaneous parent/child activity; does not claim useful parallelism. */
  overlapMs: Schema.NullOr(NonNegativeInt),
  tasks: Schema.Array(
    Schema.Struct({
      taskId: TrimmedNonEmptyString,
      threadId: ThreadId,
      binding: AgentTaskBinding,
      launchState: Schema.NullOr(Schema.String),
    }),
  ),
  turns: Schema.Array(ExperimentTurnEvidence),
  runs: ExperimentAssignmentReport.fields.runs,
  wallClockMs: Schema.NullOr(NonNegativeInt),
  activeMs: Schema.NullOr(NonNegativeInt),
  unit: ExperimentWorkUnit,
  allocations: Schema.Array(ExperimentWorkAllocation),
  evidence: Schema.Array(ExperimentWorkEvidence),
  assignmentIds: Schema.Array(TrimmedNonEmptyString),
  actualAllocation: Schema.NullOr(Schema.Literals(["inline", "delegated"])),
  deviations: Schema.Array(TrimmedNonEmptyString),
  parentCoverage: Schema.Literals(["complete", "partial", "unavailable"]),
  childCoverage: Schema.Literals(["complete", "partial", "unavailable", "not-applicable"]),
  parentUsage: ExperimentAssignmentReport.fields.usage,
  childUsage: ExperimentAssignmentReport.fields.usage,
  usage: ExperimentAssignmentReport.fields.usage,
  observedUsage: ExperimentAssignmentReport.fields.usage,
  elapsedToAcceptedMs: Schema.NullOr(NonNegativeInt),
  phaseMs: Schema.Struct({
    briefing: Schema.NullOr(NonNegativeInt),
    startup: Schema.NullOr(NonNegativeInt),
    wait: Schema.NullOr(NonNegativeInt),
    execution: Schema.NullOr(NonNegativeInt),
    inspection: Schema.NullOr(NonNegativeInt),
    rework: Schema.NullOr(NonNegativeInt),
    verification: Schema.NullOr(NonNegativeInt),
    advice: Schema.NullOr(NonNegativeInt),
  }),
  independentlySupportedAcceptance: Schema.Boolean,
  outcomes: Schema.Array(ExperimentOutcome),
  coExposureIds: Schema.Array(TrimmedNonEmptyString),
});
export type ExperimentWorkReport = typeof ExperimentWorkReport.Type;
export const ExperimentPolicySummary = Schema.Struct({
  assignedPolicy: ExperimentAllocationPolicy,
  assignedCount: NonNegativeInt,
  actualInlineCount: NonNegativeInt,
  actualDelegatedCount: NonNegativeInt,
  allocationUnknownCount: NonNegativeInt,
  deviationCount: NonNegativeInt,
  independentlyAcceptedCount: NonNegativeInt,
  failureCount: NonNegativeInt,
  cancellationCount: NonNegativeInt,
  incompleteCount: NonNegativeInt,
  missingParentCount: NonNegativeInt,
  incompleteChildCount: NonNegativeInt,
  acceptedElapsed: Schema.Struct({
    n: NonNegativeInt,
    meanMs: Schema.NullOr(Schema.Number),
    minMs: Schema.NullOr(NonNegativeInt),
    maxMs: Schema.NullOr(NonNegativeInt),
  }),
  usage: ExperimentAssignmentReport.fields.usage,
});
export type ExperimentPolicySummary = typeof ExperimentPolicySummary.Type;
export const ExperimentReport = Schema.Struct({
  work: Schema.optional(Schema.Array(ExperimentWorkReport)),
  /** Reviewer assignments by declared scope; `unscoped` covers records from before it. */
  reviewScopes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        scope: Schema.Literals(["change", "spec", "unscoped"]),
        variantId: TrimmedNonEmptyString,
        count: NonNegativeInt,
      }),
    ),
  ),
  policySummary: Schema.optional(Schema.Array(ExperimentPolicySummary)),
  exclusions: Schema.optional(
    Schema.Array(Schema.Struct({ unit: ExperimentWorkUnit, reason: TrimmedNonEmptyString })),
  ),
  uncertainty: Schema.optional(Schema.String),
  experiment: Experiment,
  assignments: Schema.Array(ExperimentAssignmentReport),
  totalAssignments: NonNegativeInt,
  offset: NonNegativeInt,
  hasMore: Schema.Boolean,
  randomizedCount: NonNegativeInt,
  observationalCount: NonNegativeInt,
  readAt: Schema.String,
});
export type ExperimentReport = typeof ExperimentReport.Type;
export class ExperimentError extends Schema.TaggedError<ExperimentError>()("ExperimentError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "not-found",
    "invalid-definition",
    "invalid-transition",
    "conflict",
    "persistence",
    "invalid-evidence",
  ]),
  entityId: Schema.String,
  /** What the caller can change to succeed; absent when nothing it supplied was at fault. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Experiment ${this.operation} failed (${this.reason})${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}
