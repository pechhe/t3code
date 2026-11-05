import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  RunId,
  MessageId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AgentRole, AgentTaskClass, AgentTaskBinding } from "./agentPolicy.ts";
import { CommandId, NodeId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

const ChampionText = Schema.String.check(Schema.isMaxLength(8000));
const ChampionLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const DEFAULT_CHAMPION_INSTRUCTIONS =
  "Inspect and measure without editing the shared root. Delegate bounded repairs into isolated workspaces, independently review their pinned handoff with the appropriate reviewer (and UI verifier when needed), apply fixes, then adopt and land once through normal SlipJay. A returned worker commit is a handoff, not delivery. Record the confirmed landing operation before verification; verify a fresh observation on the running revision. Use an advisor on the configured stronger selection for larger work, then shape a Forge Spec and delegate its lead; the lead allocates its own Spec workspace. Record unavailable tools and failures honestly.";

export const ChampionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ChampionId = typeof ChampionId.Type;
export const ChampionLifecycle = Schema.Literals(["active", "paused", "retired"]);
export type ChampionLifecycle = typeof ChampionLifecycle.Type;
export const ChampionMetricInput = Schema.Struct({
  id: ChampionLabel,
  name: ChampionLabel,
  description: ChampionText,
  required: Schema.optional(Schema.Boolean),
  baseline: Schema.optional(Schema.NullOr(Schema.Finite)),
  staleAfterMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  unit: ChampionLabel,
  source: ChampionLabel,
  context: ChampionText,
  direction: Schema.Literals(["higher", "lower", "range", "observe"]),
  minimum: Schema.NullOr(Schema.Finite),
  maximum: Schema.NullOr(Schema.Finite),
});
export type ChampionMetricInput = typeof ChampionMetricInput.Type;
export const ChampionMetric = Schema.Struct({
  ...ChampionMetricInput.fields,
  version: Schema.Int,
  seriesId: ChampionLabel,
  reason: ChampionLabel,
});
export type ChampionMetric = typeof ChampionMetric.Type;
export const ChampionCharter = Schema.Struct({
  maxConcurrentRepairs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  maxRepairsPerDay: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
  instructions: ChampionText.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAMPION_INSTRUCTIONS)),
  ),
});
export const ChampionSelectionClass = Schema.Struct({ role: AgentRole, taskClass: AgentTaskClass });
export type ChampionSelectionClass = typeof ChampionSelectionClass.Type;
export const ChampionClasses = Schema.Struct({
  setup: ChampionSelectionClass.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ role: "advisor" as const, taskClass: "non-ui" as const }),
    ),
  ),
  routine: ChampionSelectionClass.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ role: "chore-worker" as const, taskClass: "non-ui" as const }),
    ),
  ),
});
export const ChampionClassChoicesInput = Schema.Struct({
  projectId: ProjectId,
  championId: Schema.optional(ChampionId),
  taskClass: Schema.optional(AgentTaskClass),
  phase: Schema.optional(Schema.Literals(["setup", "routine"])),
});
export type ChampionClassChoicesInput = typeof ChampionClassChoicesInput.Type;
export const ChampionClassChoicesResult = Schema.Struct({
  policyHash: Schema.NullOr(ChampionText),
  policyRevision: Schema.NullOr(ChampionText),
  refusal: Schema.NullOr(ChampionLabel),
  roles: Schema.Array(
    Schema.Struct({
      role: AgentRole,
      selection: Schema.NullOr(ModelSelection),
      refusal: Schema.NullOr(ChampionLabel),
    }),
  ).check(Schema.isMaxLength(12)),
});
export type ChampionClassChoicesResult = typeof ChampionClassChoicesResult.Type;
export const ChampionConfig = Schema.Struct({
  id: ChampionId,
  projectId: ProjectId,
  name: ChampionLabel,
  purpose: ChampionLabel,
  schedule: Schema.Union([
    ScheduledTaskUpsertSchedule.members[0],
    ScheduledTaskUpsertSchedule.members[1],
  ]),
  classes: Schema.optional(ChampionClasses),
  setupModelSelection: ModelSelection,
  routineModelSelection: ModelSelection,
  charter: ChampionCharter,
});
export type ChampionConfig = typeof ChampionConfig.Type;
const ChampionSampleStatus = Schema.Literals(["measured", "unknown", "insufficient", "error"]);
export const ChampionLatestSample = Schema.Struct({
  metricId: ChampionLabel,
  name: ChampionLabel,
  version: Schema.Int,
  seriesId: ChampionLabel,
  unit: ChampionLabel,
  required: Schema.Boolean,
  value: Schema.NullOr(Schema.Finite),
  status: ChampionSampleStatus,
  health: Schema.Literals(["healthy", "breached", "unknown", "stale", "insufficient", "error"]),
  observedAt: Schema.NullOr(IsoDateTime),
  collectedAt: Schema.NullOr(IsoDateTime),
  revision: Schema.NullOr(ChampionText),
  staleAt: Schema.NullOr(IsoDateTime),
});
export type ChampionLatestSample = typeof ChampionLatestSample.Type;
export const ChampionSummary = Schema.Struct({
  ...ChampionConfig.fields,
  latestSamples: Schema.optional(Schema.Array(ChampionLatestSample).check(Schema.isMaxLength(32))),
  lifecycle: ChampionLifecycle,
  ownerThreadId: ThreadId,
  setupThreadId: Schema.NullOr(ThreadId),
  nextCheckAt: Schema.NullOr(IsoDateTime),
  lastCheckAt: Schema.NullOr(IsoDateTime),
  outstandingCheckId: Schema.NullOr(TrimmedNonEmptyString),
  outstandingSetupId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  attention: Schema.Array(Schema.String),
  openFindingCount: Schema.Int,
  pendingProposal: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ChampionSummary = typeof ChampionSummary.Type;
export const ChampionFinding = Schema.Struct({
  id: ChampionLabel,
  metricId: Schema.NullOr(Schema.String),
  seriesId: Schema.NullOr(Schema.String),
  title: ChampionLabel,
  evidence: ChampionText,
  status: Schema.Literals([
    "open",
    "working",
    "handed_back",
    "delivered",
    "verified",
    "inconclusive",
    "dismissed",
  ]),
  decision: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: ChampionLabel,
        recommendationId: Schema.optional(ChampionLabel),
        findingAttemptId: Schema.optional(ChampionText),
        proposedScope: Schema.optional(ChampionText),
        question: ChampionText,
        status: Schema.Literals(["requested", "resolved"]),
        answer: Schema.NullOr(ChampionText),
        requestedAt: IsoDateTime,
        resolvedAt: Schema.NullOr(IsoDateTime),
      }),
    ),
  ),
  delivery: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        operationId: ChampionLabel,
        revision: ChampionLabel,
        confirmedAt: IsoDateTime,
        provenance: Schema.Literal("slipjay-runner"),
      }),
    ),
  ),
  repairAttention: Schema.optional(Schema.NullOr(ChampionText)),
  baselineValue: Schema.optional(Schema.NullOr(Schema.Finite)),
  baselineMetric: Schema.optional(Schema.NullOr(ChampionMetric)),
  deliveredAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  childThreadId: Schema.NullOr(ThreadId),
  workId: ChampionText,
  attemptId: ChampionText,
  revision: Schema.NullOr(Schema.String),
  specUrl: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ChampionFinding = typeof ChampionFinding.Type;
export const ChampionSampleInput = Schema.Struct({
  metricId: ChampionLabel,
  version: Schema.Int,
  unit: ChampionLabel,
  status: ChampionSampleStatus,
  value: Schema.NullOr(Schema.Finite),
  observedAt: IsoDateTime,
  source: ChampionLabel,
  evidence: ChampionText,
  revision: Schema.NullOr(Schema.String),
});
export type ChampionSampleInput = typeof ChampionSampleInput.Type;
export const ChampionSample = Schema.Struct({
  ...ChampionSampleInput.fields,
  championId: ChampionId,
  checkId: ChampionText,
  seriesId: ChampionText,
  collectedAt: IsoDateTime,
  threadId: ThreadId,
  runId: RunId,
  modelSelection: ModelSelection,
  provenance: Schema.Literal("agent-reported"),
});
export type ChampionSample = typeof ChampionSample.Type;
export const ChampionActivity = Schema.Struct({
  id: ChampionText,
  championId: ChampionId,
  at: IsoDateTime,
  kind: ChampionText,
  text: ChampionText,
  learningRef: Schema.optional(
    Schema.Struct({ learningId: ChampionLabel, revisionId: ChampionLabel, topic: ChampionLabel }),
  ),
  findingId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  revision: Schema.NullOr(Schema.String),
  specUrl: Schema.NullOr(Schema.String),
});
export type ChampionActivity = typeof ChampionActivity.Type;
export const ChampionProposal = Schema.Struct({
  metrics: Schema.Array(ChampionMetricInput).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  reason: ChampionLabel,
});
export type ChampionProposal = typeof ChampionProposal.Type;
export const ChampionDetail = Schema.Struct({
  champion: ChampionSummary,
  latestSamples: Schema.optional(Schema.Array(ChampionLatestSample).check(Schema.isMaxLength(32))),
  metrics: Schema.Array(ChampionMetric),
  proposal: Schema.NullOr(ChampionProposal),
  findings: Schema.Array(ChampionFinding).check(Schema.isMaxLength(100)),
});
export type ChampionDetail = typeof ChampionDetail.Type;
export const ChampionListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const ChampionListResult = Schema.Struct({ champions: Schema.Array(ChampionSummary) });
export const ChampionGetInput = Schema.Struct({ id: ChampionId });
export const ChampionUpsertInput = ChampionConfig;
export type ChampionUpsertInput = typeof ChampionUpsertInput.Type;
export const ChampionLifecycleInput = Schema.Struct({
  id: ChampionId,
  lifecycle: ChampionLifecycle,
});
export const ChampionProposeInput = Schema.Struct({ id: ChampionId, ...ChampionProposal.fields });
export const ChampionAcceptInput = Schema.Struct({ id: ChampionId });
export const ChampionHistoryInput = Schema.Struct({
  id: ChampionId,
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const ChampionHistoryResult = Schema.Struct({
  findings: Schema.optional(Schema.Array(ChampionFinding)),
  definitions: Schema.Array(ChampionMetric),
  activity: Schema.Array(ChampionActivity),
  samples: Schema.Array(ChampionSample),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ChampionFindingActionInput = Schema.Struct({
  id: ChampionId,
  findingId: ChampionText,
  action: Schema.Literals(["dismiss", "reopen", "decision", "resolve_decision"]),
  decisionId: Schema.optional(ChampionLabel),
  recommendationId: Schema.optional(ChampionLabel),
  reason: ChampionLabel,
});
export const ChampionSetupCompleteInput = Schema.Struct({ summary: ChampionText });
export const ChampionCheckContext = Schema.Struct({
  champion: ChampionDetail,
  checkId: ChampionText,
  messageId: MessageId,
  metrics: Schema.Array(ChampionMetric),
  measureOnly: Schema.Boolean,
});
export const ChampionReportInput = Schema.Struct({
  samples: Schema.Array(ChampionSampleInput).check(Schema.isMaxLength(32)),
  findings: Schema.Array(
    Schema.Struct({
      existingFindingId: Schema.optional(Schema.String),
      title: ChampionLabel,
      evidence: ChampionText,
    }),
  ).check(Schema.isMaxLength(20)),
  summary: ChampionText,
});
export type ChampionReportInput = typeof ChampionReportInput.Type;
export const ChampionFindingDeliveryInput = Schema.Struct({
  findingId: ChampionText,
  action: Schema.Literals(["handed_back", "delivered", "verify", "inconclusive", "spec"]),
  operationId: Schema.optional(ChampionLabel),
  revision: Schema.optional(Schema.String),
  specUrl: Schema.optional(Schema.String),
  evidence: ChampionLabel,
});
export class ChampionError extends Schema.TaggedError<ChampionError>()("ChampionError", {
  reason: Schema.Literals(["not-found", "invalid", "conflict", "unauthorized", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
  validation: Schema.optional(
    Schema.Struct({
      sampleIndex: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 }))),
      field: Schema.Literals([
        "samples",
        "metricId",
        "version",
        "unit",
        "source",
        "value",
        "observedAt",
      ]),
    }),
  ),
}) {
  override get message() {
    if (this.reason === "invalid" && this.validation !== undefined) {
      const instruction = {
        samples:
          "Include each required frozen metric exactly once; do not duplicate metricId values.",
        metricId: "Copy metricId from a frozen metric in t3_champions_check_context.",
        version: "Copy version exactly from the frozen metric in t3_champions_check_context.",
        unit: "Copy unit exactly from the frozen metric in t3_champions_check_context.",
        source:
          "Copy source exactly, without paraphrasing, from the frozen metric in t3_champions_check_context. Put execution commands, paths and collection details in evidence.",
        value:
          "Use a finite numeric value only with status measured. Failed collection requires value null and status error; explain the failure in evidence.",
        observedAt: "Use a valid ISO date-time for observedAt.",
      }[this.validation.field];
      return `Champion report invalid: ${this.validation.sampleIndex === undefined ? "" : `sample ${this.validation.sampleIndex} `}${this.validation.field}. ${instruction}`;
    }
    return `Champion operation failed: ${this.reason}.`;
  }
}

export const ChampionExecutionAttempt = Schema.Struct({
  id: ChampionLabel,
  checkId: ChampionText,
  kind: Schema.Literals(["setup", "check"]),
  selectionClass: Schema.NullOr(ChampionSelectionClass),
  policyHash: Schema.NullOr(ChampionText),
  policyRevision: Schema.NullOr(ChampionText),
  resolvedSelection: ModelSelection,
  actualSelection: Schema.NullOr(ModelSelection),
  commandId: CommandId,
  messageId: MessageId,
  threadId: ThreadId,
  acceptedAt: IsoDateTime,
});
export type ChampionExecutionAttempt = typeof ChampionExecutionAttempt.Type;
export const ChampionLearningEvidence = Schema.Struct({
  source: ChampionLabel,
  evidence: ChampionText,
  observedAt: IsoDateTime,
});
export const ChampionComponentObservation = Schema.Struct({
  component: ChampionLabel,
  version: Schema.NullOr(ChampionLabel),
  observedAt: IsoDateTime,
});
export const ChampionLearningContent = Schema.Struct({
  topic: ChampionLabel,
  question: ChampionText,
  conclusion: ChampionText,
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: ChampionLabel,
      outcome: Schema.Literals(["improved", "failed", "inconclusive"]),
      evidence: ChampionText,
    }),
  ).check(Schema.isMaxLength(12)),
  evidence: Schema.Array(ChampionLearningEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
  ),
  components: Schema.Array(ChampionComponentObservation).check(Schema.isMaxLength(16)),
  environment: ChampionText,
  applicability: ChampionText,
  tradeoffs: ChampionText,
  reviewAt: Schema.NullOr(IsoDateTime),
  reviewConditions: Schema.Array(ChampionLabel).check(Schema.isMaxLength(12)),
  versionConditions: Schema.Array(
    Schema.Struct({
      component: ChampionLabel,
      comparison: Schema.Literal("changed"),
      version: ChampionLabel,
    }),
  ).check(Schema.isMaxLength(16)),
});
export const ChampionLearningRecordInput = Schema.Struct({
  id: ChampionId,
  learningId: ChampionLabel,
  expectedCurrentId: Schema.NullOr(ChampionLabel),
  reason: ChampionLabel,
  ...ChampionLearningContent.fields,
});
export type ChampionLearningRecordInput = typeof ChampionLearningRecordInput.Type;
export const ChampionLearningRevision = Schema.Struct({
  ...ChampionLearningContent.fields,
  id: ChampionLabel,
  learningId: ChampionLabel,
  championId: ChampionId,
  projectId: ProjectId,
  recordedAt: IsoDateTime,
  supersedes: Schema.NullOr(ChampionLabel),
  reason: ChampionLabel,
  applicabilityState: Schema.Literals(["current", "uncertain"]),
  isCurrent: Schema.Boolean,
});
export type ChampionLearningRevision = typeof ChampionLearningRevision.Type;
export const ChampionLearningQueryInput = Schema.Struct({
  id: ChampionId,
  topic: ChampionLabel,
  revisionId: Schema.optional(ChampionLabel),
  due: Schema.optional(Schema.Boolean),
  includeSuperseded: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(ChampionLabel),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  observations: Schema.Array(ChampionComponentObservation)
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ChampionLearningQueryInput = typeof ChampionLearningQueryInput.Type;
export const ChampionLearningQueryResult = Schema.Struct({
  revisions: Schema.Array(ChampionLearningRevision).check(Schema.isMaxLength(20)),
  nextCursor: Schema.NullOr(ChampionLabel),
  receiptId: ChampionLabel,
  retrievedAt: IsoDateTime,
  admissibleForInvestigation: Schema.optional(Schema.Boolean),
});
export type ChampionLearningQueryResult = typeof ChampionLearningQueryResult.Type;
export const ChampionInvestigationAlternative = Schema.Struct({
  id: ChampionLabel,
  hypothesis: ChampionText,
  evidenceNeeds: ChampionText,
  role: Schema.Literals(["advisor", "researcher", "scout"]),
});
export const ChampionInvestigationStartInput = Schema.Struct({
  id: ChampionId,
  findingId: ChampionLabel,
  investigationId: ChampionLabel,
  question: ChampionText,
  topic: ChampionLabel,
  retrievalReceiptId: ChampionLabel,
  alternatives: Schema.Array(ChampionInvestigationAlternative).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
});
export type ChampionInvestigationStartInput = typeof ChampionInvestigationStartInput.Type;
export const ChampionInvestigationBranchAttempt = Schema.Struct({
  id: ChampionLabel,
  branchId: ChampionLabel,
  clientRequestId: ChampionLabel,
  commandId: CommandId,
  taskId: NodeId,
  childThreadId: ThreadId,
  messageId: MessageId,
  role: Schema.Literals(["advisor", "researcher", "scout"]),
  workId: ChampionText,
  attemptId: ChampionText,
  workspacePath: ChampionText,
  policyHash: ChampionText,
  policyRevision: ChampionText,
  binding: AgentTaskBinding,
  resolvedSelection: ModelSelection,
  actualSelection: Schema.NullOr(ModelSelection),
  admittedAt: IsoDateTime,
  state: Schema.Literals(["admitted", "unknown", "accepted", "completed", "failed", "cancelled"]),
  followup: Schema.Boolean,
  result: Schema.NullOr(ChampionText),
});
export type ChampionInvestigationBranchAttempt = typeof ChampionInvestigationBranchAttempt.Type;
export const ChampionInvestigation = Schema.Struct({
  ...ChampionInvestigationStartInput.fields,
  findingAttemptId: ChampionText,
  consideredLearningIds: Schema.Array(ChampionLabel).check(Schema.isMaxLength(20)),
  createdAt: IsoDateTime,
  status: Schema.Literals(["open", "cancel_requested", "cancelled", "synthesized"]),
  branches: Schema.Array(
    Schema.Struct({
      ...ChampionInvestigationAlternative.fields,
      workId: ChampionText,
      attemptId: ChampionText,
    }),
  ).check(Schema.isMaxLength(3)),
  attempts: Schema.Array(ChampionInvestigationBranchAttempt).check(Schema.isMaxLength(6)),
  attention: Schema.NullOr(ChampionText),
});
export type ChampionInvestigation = typeof ChampionInvestigation.Type;
export const ChampionInvestigationCancelInput = Schema.Struct({
  id: ChampionId,
  investigationId: ChampionLabel,
  requestId: ChampionLabel,
  reason: ChampionLabel,
});
export type ChampionInvestigationCancelInput = typeof ChampionInvestigationCancelInput.Type;
export const ChampionSynthesisInput = Schema.Struct({
  id: ChampionId,
  investigationId: ChampionLabel,
  recommendationId: ChampionLabel,
  expectedCurrentId: Schema.NullOr(ChampionLabel),
  proposedScope: ChampionText,
  summary: ChampionText,
  alternatives: ChampionText,
  benefits: ChampionText,
  tradeoffs: ChampionText,
  uncertainty: ChampionText,
  recommendation: ChampionText,
});
export type ChampionSynthesisInput = typeof ChampionSynthesisInput.Type;
export const ChampionRecommendation = Schema.Struct({
  ...ChampionSynthesisInput.fields,
  findingId: ChampionLabel,
  findingAttemptId: ChampionText,
  recordedAt: IsoDateTime,
});
export type ChampionRecommendation = typeof ChampionRecommendation.Type;
export const ChampionRecommendationInput = Schema.Struct({
  id: ChampionId,
  findingId: ChampionLabel,
  findingAttemptId: ChampionText,
  recommendationId: ChampionLabel,
});
export type ChampionRecommendationInput = typeof ChampionRecommendationInput.Type;
export const ChampionRuntimeState = Schema.Struct({
  attempts: Schema.Array(ChampionExecutionAttempt).check(Schema.isMaxLength(50)),
  investigations: Schema.Array(ChampionInvestigation).check(Schema.isMaxLength(20)),
  recommendations: Schema.Array(ChampionRecommendation).check(Schema.isMaxLength(20)),
});
export type ChampionRuntimeState = typeof ChampionRuntimeState.Type;
