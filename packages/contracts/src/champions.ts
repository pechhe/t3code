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
export const ChampionConfig = Schema.Struct({
  id: ChampionId,
  projectId: ProjectId,
  name: ChampionLabel,
  purpose: ChampionLabel,
  schedule: Schema.Union([
    ScheduledTaskUpsertSchedule.members[0],
    ScheduledTaskUpsertSchedule.members[1],
  ]),
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
