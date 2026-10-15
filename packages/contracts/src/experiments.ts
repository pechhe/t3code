import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
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
export const ExperimentLever = Schema.Literals(["rollover", "reviewer", "delegation"]);
export type ExperimentLever = typeof ExperimentLever.Type;
export const ExperimentRolloverPolicy = Schema.Struct({
  softLimit: PositiveInt,
  hardLimit: PositiveInt,
});
export type ExperimentRolloverPolicy = typeof ExperimentRolloverPolicy.Type;
export const ExperimentVariant = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  rollover: Schema.optional(ExperimentRolloverPolicy),
  modelSelection: Schema.optional(ModelSelection),
});
export type ExperimentVariant = typeof ExperimentVariant.Type;
export const ExperimentDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  lever: ExperimentLever,
  primaryOutcome: TrimmedNonEmptyString,
  variants: Schema.Array(ExperimentVariant),
  eligibility: Schema.Struct({
    projectIds: Schema.Array(ProjectId),
    models: Schema.Array(TrimmedNonEmptyString),
    taskCategories: Schema.Array(TrimmedNonEmptyString),
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
export const ExperimentAssignInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  unitKind: Schema.Literals(["thread", "task"]),
  unitId: TrimmedNonEmptyString,
  taskCategory: Schema.optional(TrimmedNonEmptyString),
  taskLever: Schema.optional(Schema.Literals(["reviewer", "delegation"])),
  enrollment: Schema.Literals(["new", "existing-boundary"]),
  unitCreatedAt: Schema.optional(Schema.String),
  boundaryRunId: Schema.optional(RunId),
});
export type ExperimentAssignInput = typeof ExperimentAssignInput.Type;
export const ExperimentAssignment = Schema.Struct({
  id: TrimmedNonEmptyString,
  experimentId: TrimmedNonEmptyString,
  revision: PositiveInt,
  lever: ExperimentLever,
  unitKind: Schema.Literals(["thread", "task"]),
  unitId: TrimmedNonEmptyString,
  threadId: ThreadId,
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
  recipeRevision: TrimmedNonEmptyString,
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
  ]),
  usedTokens: Schema.NullOr(NonNegativeInt),
  maxTokens: Schema.NullOr(PositiveInt),
  growthTokens: Schema.optional(NonNegativeInt),
  recoveredTokens: Schema.optional(NonNegativeInt),
  delayMs: Schema.optional(NonNegativeInt),
  lowYield: Schema.optional(Schema.Boolean),
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
export const ExperimentReport = Schema.Struct({
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
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Experiment ${this.operation} failed (${this.reason}).`;
  }
}
