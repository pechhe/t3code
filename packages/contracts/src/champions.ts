import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  RunId,
  MessageId,
  TrimmedNonEmptyString,
  EnvironmentId,
  ChampionId,
} from "./baseSchemas.ts";
import { StoredAgentRole, AgentTaskClass, AgentTaskBinding } from "./agentPolicy.ts";
import { CommandId, NodeId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export const ChampionText = Schema.String.check(Schema.isMaxLength(8000));
export const ChampionLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const DEFAULT_CHAMPION_INSTRUCTIONS =
  "Observe and score; never repair. Read and measure in the project's main checkout without editing it. Raise what needs work as a finding with evidence a stranger can act on: the server opens a case for it in Henry's Inbox, where an agent diagnoses, fixes, files a Spec or asks Henry. Record unavailable tools and failures honestly.";
/** Earlier defaults; stored instructions equal to one of them read as the current default. */
export const PAST_DEFAULT_CHAMPION_INSTRUCTIONS: ReadonlyArray<string> = [
  "Inspect and measure without editing the shared root. Delegate bounded repairs into isolated workspaces, independently review their pinned handoff with the appropriate reviewer (and UI verifier when needed), apply fixes, then adopt and land once through normal SlipJay. A returned worker commit is a handoff, not delivery. Record the confirmed landing operation before verification; verify a fresh observation on the running revision. Use an advisor on the configured stronger selection for larger work, then shape a Forge Spec and delegate its lead; the lead allocates its own Spec workspace. Record unavailable tools and failures honestly.",
  "Inspect and measure without editing the shared root. Delegate bounded repairs into isolated workspaces, independently review their pinned handoff with the appropriate reviewer (and a browser task when needed), apply fixes, then adopt and land once through normal SlipJay. A returned worker commit is a handoff, not delivery. Record the confirmed landing operation before verification; verify a fresh observation on the running revision. Use an advisor on the configured stronger selection for larger work, then shape a Forge Spec and delegate its lead; the lead allocates its own Spec workspace. Record unavailable tools and failures honestly.",
];
/** The reserved series a goal review's score is stored under, beside the Champion's readings; never a metric id. */
export const GOAL_SCORE_SERIES = "goal-score";
export const DEFAULT_GOAL_SCORE_TARGET = 7;

export const ChampionLifecycle = Schema.Literals(["active", "paused", "retired"]);
export type ChampionLifecycle = typeof ChampionLifecycle.Type;
export const ChampionMetricCommand = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
).check(Schema.isMinLength(1), Schema.isMaxLength(32));
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
  /** Argument list the server runs, without a shell, to read this metric; absent means an agent measures it. */
  collect: Schema.optional(ChampionMetricCommand),
  /** A value beyond the target that starts a case at once; only for direction higher or lower. Changing it keeps the version. */
  alarm: Schema.optional(Schema.Finite),
});
export type ChampionMetricInput = typeof ChampionMetricInput.Type;
export const ChampionMetric = Schema.Struct({
  ...ChampionMetricInput.fields,
  version: Schema.Int,
  seriesId: ChampionLabel,
  reason: ChampionLabel,
  /** When this version took effect; absent on a version stored before it was recorded. */
  definedAt: Schema.optional(IsoDateTime),
});
export type ChampionMetric = typeof ChampionMetric.Type;
export const ChampionCharter = Schema.Struct({
  instructions: ChampionText.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAMPION_INSTRUCTIONS)),
  ),
});
export const ChampionSelectionClass = Schema.Struct({
  role: StoredAgentRole,
  taskClass: AgentTaskClass,
});
export type ChampionSelectionClass = typeof ChampionSelectionClass.Type;
/** A model for one kind of Champion run, with an optional backup for when it is at its usage limit. */
export const ChampionModelSlot = Schema.Struct({
  model: ModelSelection,
  backup: Schema.optional(ModelSelection),
});
export type ChampionModelSlot = typeof ChampionModelSlot.Type;
/** The models a machine's Champions run on: `checks` for readings, `advice` for goal reviews, metric setup and the case fallback. A slot not chosen yet is absent. */
export const ChampionModelDefaults = Schema.Struct({
  checks: Schema.optional(ChampionModelSlot),
  advice: Schema.optional(ChampionModelSlot),
});
export type ChampionModelDefaults = typeof ChampionModelDefaults.Type;
/** One Champion's own main models; the default's backup still applies. */
export const ChampionModelOverrides = Schema.Struct({
  checks: Schema.optional(ModelSelection),
  advice: Schema.optional(ModelSelection),
});
export type ChampionModelOverrides = typeof ChampionModelOverrides.Type;
/** What a Champion's next run of one kind will use, and whether that is its own choice or the machine default. */
export const ChampionNextModel = Schema.Struct({
  model: ModelSelection,
  backup: Schema.optional(ModelSelection),
  source: Schema.Literals(["default", "champion"]),
});
export type ChampionNextModel = typeof ChampionNextModel.Type;
export const ChampionNextModels = Schema.Struct({
  checks: Schema.optional(ChampionNextModel),
  advice: Schema.optional(ChampionNextModel),
});
export type ChampionNextModels = typeof ChampionNextModels.Type;
/**
 * A Champion that hunts bugs through browser journeys (T3-465). The target is configuration: commands that start and
 * end it print its manifest, and the server decides whether it is eligible before any browser starts.
 */
export const ChampionJourneyConfig = Schema.Struct({
  /** Prints the manifest. `{shards}` is replaced by the number of shards; a replay appends `--build <key>`. */
  provision: Schema.Array(ChampionLabel).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  /** `{id}` is the manifest's id. */
  teardown: Schema.Array(ChampionLabel).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  /** Prints what the target's network carried, as `{packets, peers, subnet, outside}`. `{id}` is the manifest's id. */
  capture: Schema.Array(ChampionLabel).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  shards: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  journeysPerShard: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  /** Decisions one journey may spend; a check's limit is its journeys times this. */
  decisionCap: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  /** A check does not start while the machine's 5-minute load is above this. */
  loadLimit: Schema.Finite,
  /** The target is known to carry no bugs, so every bug a check confirms counts as a false positive. */
  control: Schema.optional(Schema.Boolean),
});
export type ChampionJourneyConfig = typeof ChampionJourneyConfig.Type;
export const ChampionSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule.members[0],
  ScheduledTaskUpsertSchedule.members[1],
]);
export type ChampionSchedule = typeof ChampionSchedule.Type;
export const ChampionGoalScoreValue = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 10 }),
);
/** A Champion's goal review: its own schedule (UTC; default weekly on Mondays at a spread time) and its score target (default 7). */
export const ChampionGoalReviewConfig = Schema.Struct({
  schedule: Schema.optional(ChampionSchedule),
  target: Schema.optional(ChampionGoalScoreValue),
});
export type ChampionGoalReviewConfig = typeof ChampionGoalReviewConfig.Type;
export const ChampionConfig = Schema.Struct({
  id: ChampionId,
  projectId: ProjectId,
  name: ChampionLabel,
  purpose: ChampionLabel,
  /** When readings are taken. */
  schedule: ChampionSchedule,
  models: Schema.optional(ChampionModelOverrides),
  charter: ChampionCharter,
  journeys: Schema.optional(ChampionJourneyConfig),
  goalReview: Schema.optional(ChampionGoalReviewConfig),
});
export type ChampionConfig = typeof ChampionConfig.Type;
/** The agent-config folder a Champion lives in, and the one machine that runs it (T3-839). */
export const ChampionFolderState = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(500)),
  repository: Schema.String.check(Schema.isMaxLength(500)),
  runner: Schema.Struct({
    environmentId: EnvironmentId,
    label: Schema.String.check(Schema.isMaxLength(200)),
  }),
  savedAt: Schema.NullOr(IsoDateTime),
  /** Where `repository` holds the definition and learnings, for a repository-hosted Champion; `path` then holds only its readings and findings. */
  definedIn: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ChampionFolderState = typeof ChampionFolderState.Type;
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
  /** `untargeted`: measured, but its metric sets no target. `outdated`: read under an earlier definition. */
  health: Schema.Literals([
    "healthy",
    "breached",
    "unknown",
    "stale",
    "insufficient",
    "error",
    "untargeted",
    "outdated",
  ]),
  observedAt: Schema.NullOr(IsoDateTime),
  collectedAt: Schema.NullOr(IsoDateTime),
  revision: Schema.NullOr(ChampionText),
  staleAt: Schema.NullOr(IsoDateTime),
});
export type ChampionLatestSample = typeof ChampionLatestSample.Type;
/** One goal review's score: how well the area meets the Champion's whole goal. */
export const ChampionGoalScore = Schema.Struct({
  score: ChampionGoalScoreValue,
  target: ChampionGoalScoreValue,
  /** The main reasons the score is not higher. */
  reasons: ChampionText,
  /** What changed since the previous score, citing readings. */
  change: ChampionText,
  at: IsoDateTime,
});
export type ChampionGoalScore = typeof ChampionGoalScore.Type;
export const ChampionSummary = Schema.Struct({
  ...ChampionConfig.fields,
  /** Filled in when read: the models the next check and advice will use. */
  nextModels: Schema.optional(ChampionNextModels),
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
  updatedAt: IsoDateTime,
  folder: Schema.optional(ChampionFolderState),
  /** Readings runs in a row that ended without a clean report; three make the Champion stuck. */
  consecutiveCheckFailures: Schema.optional(Schema.Int),
  stuckEscalationThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  nextReviewAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastReviewAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  outstandingReviewId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Goal reviews in a row that ended without a clean report; three make the Champion stuck. */
  consecutiveReviewFailures: Schema.optional(Schema.Int),
  /** The UTC Monday time this Champion's default review runs at, spread apart from the others'. */
  reviewTime: Schema.optional(Schema.String.check(Schema.isMaxLength(5))),
  goalScore: Schema.optional(ChampionGoalScore),
});
export type ChampionSummary = typeof ChampionSummary.Type;
/** Henry's own words, typed in the agent thread that completed an approval for him. */
export const ChampionRelayedApproval = Schema.Struct({
  quote: ChampionText,
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(500)),
  /** The model the relaying thread ran on. */
  model: Schema.String.check(Schema.isMaxLength(500)),
  approvedAt: IsoDateTime,
  sourceEnvironment: Schema.optional(Schema.Struct({ id: EnvironmentId, label: Schema.String })),
});
export type ChampionRelayedApproval = typeof ChampionRelayedApproval.Type;
/** The path a champion asked the user to approve, kept short enough to decide from at a glance. */
export const ChampionDecisionProposal = Schema.Struct({
  action: ChampionLabel,
  why: ChampionLabel,
  otherOptions: Schema.optional(ChampionLabel),
});
export type ChampionDecisionProposal = typeof ChampionDecisionProposal.Type;
/**
 * A finding is open until it is verified fixed or dismissed. Repair statuses stored before cases
 * replaced the repair pipeline read as open.
 */
const ChampionFindingStatus = Schema.String.check(
  Schema.makeFilter(
    (status) =>
      [
        "open",
        "working",
        "handed_back",
        "delivered",
        "verified",
        "inconclusive",
        "dismissed",
      ].includes(status),
    {
      expected: "open, verified or dismissed",
      toJsonSchema: () => ({ enum: ["open", "verified", "dismissed"] }),
    },
  ),
).pipe(
  Schema.decodeTo(Schema.Literals(["open", "verified", "dismissed"]), {
    decode: SchemaGetter.transform((status) =>
      status === "verified" || status === "dismissed" ? status : "open",
    ),
    encode: SchemaGetter.transform((status) => status),
  }),
);
/** The kinds of home a learning belongs in, as `~/.agents/references/learnings.md` maps them. */
export const ChampionLearningHome = Schema.Literals([
  "decision",
  "doc",
  "glossary",
  "research",
  "agents",
  "champion",
  "check",
]);
export type ChampionLearningHome = typeof ChampionLearningHome.Type;
/** What a goal review reports it learned; the case agent verifies it and records it in its home. */
export const ChampionReportedLearning = Schema.Struct({
  statement: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  home: ChampionLearningHome,
});
export type ChampionReportedLearning = typeof ChampionReportedLearning.Type;
/** A learning that belongs to no finding; waiting candidates batch into one tidy-up case. */
export const ChampionLearningCandidateInput = Schema.Struct({
  ...ChampionReportedLearning.fields,
  urgent: Schema.optional(Schema.Boolean),
});
export type ChampionLearningCandidateInput = typeof ChampionLearningCandidateInput.Type;

export const ChampionFinding = Schema.Struct({
  id: ChampionLabel,
  metricId: Schema.NullOr(Schema.String),
  seriesId: Schema.NullOr(Schema.String),
  title: ChampionLabel,
  evidence: ChampionText,
  status: ChampionFindingStatus,
  /** A decision requested before cases replaced decision requests; it still resolves through the card. */
  decision: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: ChampionLabel,
        question: ChampionText,
        proposal: Schema.optional(ChampionDecisionProposal),
        status: Schema.Literals(["requested", "resolved"]),
        answer: Schema.NullOr(ChampionText),
        approval: Schema.optional(ChampionRelayedApproval),
        requestedAt: IsoDateTime,
        resolvedAt: Schema.NullOr(IsoDateTime),
      }),
    ),
  ),
  /** Set once a reading reached the metric's alarm value; its case starts at once. */
  alarm: Schema.optional(Schema.Boolean),
  /** When this occurrence opened, and when a check last confirmed it. */
  firstSeenAt: Schema.optional(IsoDateTime),
  lastConfirmedAt: Schema.optional(IsoDateTime),
  /** Learnings the review reported with this finding; its case brief lists them. */
  learnings: Schema.optional(Schema.Array(ChampionReportedLearning).check(Schema.isMaxLength(3))),
  /** The Inbox thread working this finding: its case. */
  escalationThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  revision: Schema.NullOr(Schema.String),
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
  /** Null on a reading the server collected: no run or model produced it. */
  runId: Schema.NullOr(RunId),
  modelSelection: Schema.NullOr(ModelSelection),
  provenance: Schema.Literals(["agent-reported", "server-collected"]),
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
  approval: Schema.optional(ChampionRelayedApproval),
});
export type ChampionActivity = typeof ChampionActivity.Type;
export const CHAMPION_METRIC_LIMIT = 32;
/** A change to a champion's metrics, applied at once; metrics it neither lists nor retires stay unchanged. */
export const ChampionMetricChange = Schema.Struct({
  metrics: Schema.Array(ChampionMetricInput).check(Schema.isMaxLength(CHAMPION_METRIC_LIMIT)),
  /** Ids of tracked metrics to stop tracking. */
  retires: Schema.optional(
    Schema.Array(ChampionLabel).check(Schema.isMaxLength(CHAMPION_METRIC_LIMIT)),
  ),
  reason: ChampionLabel,
});
export type ChampionMetricChange = typeof ChampionMetricChange.Type;
/** The metrics `change` leaves tracked: current ones in place (replaced when listed, dropped when retired), then new ones. */
export function championMetricChangeResult<
  A extends { readonly id: string },
  P extends { readonly id: string },
>(
  current: ReadonlyArray<A>,
  change: {
    readonly metrics: ReadonlyArray<P>;
    readonly retires?: ReadonlyArray<string> | undefined;
  },
): Array<A | P> {
  const listed = new Map(change.metrics.map((metric) => [metric.id, metric]));
  const retired = new Set(change.retires);
  const known = new Set(current.map((metric) => metric.id));
  return [
    ...current.flatMap((metric) =>
      retired.has(metric.id) ? [] : [listed.get(metric.id) ?? metric],
    ),
    ...change.metrics.filter((metric) => !known.has(metric.id)),
  ];
}
export const ChampionDetail = Schema.Struct({
  champion: ChampionSummary,
  latestSamples: Schema.optional(Schema.Array(ChampionLatestSample).check(Schema.isMaxLength(32))),
  metrics: Schema.Array(ChampionMetric),
  findings: Schema.Array(ChampionFinding).check(Schema.isMaxLength(100)),
  /** The goal-score series, newest first. */
  goalScores: Schema.optional(Schema.Array(ChampionGoalScore).check(Schema.isMaxLength(20))),
});
export type ChampionDetail = typeof ChampionDetail.Type;
export const ChampionListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const ChampionListResult = Schema.Struct({
  champions: Schema.Array(ChampionSummary),
  /** The machine's Champion models; absent from a build that has none. */
  modelDefaults: Schema.optional(ChampionModelDefaults),
});
export const ChampionSetModelsInput = ChampionModelDefaults;
export type ChampionSetModelsInput = typeof ChampionSetModelsInput.Type;
export const ChampionGetInput = Schema.Struct({ id: ChampionId });
export const ChampionUpsertInput = ChampionConfig;
export type ChampionUpsertInput = typeof ChampionUpsertInput.Type;
export const ChampionLifecycleInput = Schema.Struct({
  id: ChampionId,
  lifecycle: ChampionLifecycle,
});
export const ChampionMetricChangeInput = Schema.Struct({
  id: ChampionId,
  ...ChampionMetricChange.fields,
});
const ApprovalQuote = Schema.optional(ChampionText).annotate({
  description:
    "The user's own words, copied exactly from a message they typed in this thread, that approve this. Without it the request waits for them on the Champion page.",
});
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
  /** `verify` closes a finding confirmed fixed; `resolve_decision` answers a decision requested before cases. */
  action: Schema.Literals(["dismiss", "reopen", "verify", "resolve_decision"]),
  decisionId: Schema.optional(ChampionLabel),
  reason: ChampionLabel,
});
export const ChampionAgentFindingActionInput = Schema.Struct({
  ...ChampionFindingActionInput.fields,
  approvalQuote: ApprovalQuote,
});
export const ChampionSetupCompleteInput = Schema.Struct({ summary: ChampionText });
export const ChampionCheckContext = Schema.Struct({
  champion: ChampionDetail,
  checkId: ChampionText,
  messageId: MessageId,
  /** The metrics the agent measures; ones the server reads by command are left out. */
  metrics: Schema.Array(ChampionMetric),
  /** What the server's commands read for this check, failures included. */
  collected: Schema.optional(Schema.Array(ChampionSample)),
  /** `readings` measures; `review` scores the goal and measures nothing. */
  rhythm: Schema.optional(Schema.Literals(["readings", "review"])),
  measureOnly: Schema.Boolean,
});
export const ChampionReportInput = Schema.Struct({
  samples: Schema.Array(ChampionSampleInput).check(Schema.isMaxLength(32)),
  findings: Schema.Array(
    Schema.Struct({
      existingFindingId: Schema.optional(Schema.String),
      title: ChampionLabel,
      evidence: ChampionText,
      learnings: Schema.optional(
        Schema.Array(ChampionReportedLearning).check(Schema.isMaxLength(3)),
      ),
    }),
  ).check(Schema.isMaxLength(20)),
  /** A goal review's learnings that belong to no finding; refused on a readings run. */
  learningCandidates: Schema.optional(
    Schema.Array(ChampionLearningCandidateInput).check(Schema.isMaxLength(5)),
  ),
  summary: ChampionText,
  /** A goal review's score, required on a review and refused on a readings run. */
  goalScore: Schema.optional(
    Schema.Struct({
      score: ChampionGoalScoreValue,
      reasons: ChampionText.check(Schema.isMinLength(1)),
      change: ChampionText.check(Schema.isMinLength(1)),
    }),
  ),
  /** A journey check's own account of its journeys; the server compares it with what it recorded. */
  journeys: Schema.optional(
    Schema.Struct({
      started: Schema.Int,
      passed: Schema.Int,
      failed: Schema.Int,
      stopped: Schema.Int,
    }),
  ),
});
export type ChampionReportInput = typeof ChampionReportInput.Type;

export const ChampionJourneyStep = Schema.Struct({
  /** The action's page-reach label or caller id. */
  id: Schema.String,
  kind: Schema.String,
  operation: Schema.String,
  /** The element as the page named it. */
  target: Schema.NullOr(Schema.Struct({ role: Schema.String, name: Schema.String })),
  /** A drag's source: the same element as `target`, named for the replay. */
  from: Schema.optional(Schema.NullOr(Schema.Struct({ role: Schema.String, name: Schema.String }))),
  /** A drag's destination. */
  to: Schema.optional(Schema.NullOr(Schema.Struct({ role: Schema.String, name: Schema.String }))),
  /** A key press's key. */
  key: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.NullOr(Schema.String),
  option: Schema.NullOr(Schema.String),
  /** The value typed, never a saved login's. */
  value: Schema.NullOr(Schema.String),
  /** The page this step acted on. */
  url: Schema.NullOr(Schema.String),
  state: Schema.String,
  at: IsoDateTime,
  ms: Schema.Finite,
});
export type ChampionJourneyStep = typeof ChampionJourneyStep.Type;

export const ChampionJourney = Schema.Struct({
  id: Schema.String,
  checkId: Schema.String,
  tabId: Schema.String,
  shard: Schema.NullOr(Schema.String),
  goals: Schema.Array(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.Literals(["running", "passed", "failed", "stopped"]),
  reason: Schema.NullOr(Schema.String),
  stoppedByLimit: Schema.Boolean,
  decisions: Schema.Int,
  usd: Schema.Finite,
  unreportedCalls: Schema.Int,
  finalUrl: Schema.NullOr(Schema.String),
  /** The viewport this journey ran at, when the backend reported one. */
  viewport: Schema.optional(
    Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  ),
  screenshots: Schema.Array(Schema.String),
  steps: Schema.Array(ChampionJourneyStep),
});
export type ChampionJourney = typeof ChampionJourney.Type;

export const ChampionJourneyShard = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  signInPath: Schema.String,
  database: Schema.String,
  container: Schema.String,
  /** The language this shard's people use, for example pt-BR. */
  locale: Schema.optional(Schema.String),
  /** Pages a journey may change, with at most one running journey on each. */
  workPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type ChampionJourneyShard = typeof ChampionJourneyShard.Type;

export const ChampionJourneyManifest = Schema.Struct({
  schema: Schema.Literal(1),
  id: Schema.String,
  app: Schema.String,
  commit: Schema.String,
  build: Schema.String,
  patched: Schema.Boolean,
  synthetic: Schema.Boolean,
  network: Schema.String,
  capture: Schema.String,
  startedAt: Schema.String,
  expiresAt: Schema.String,
  startSeconds: Schema.Finite,
  shards: Schema.Array(ChampionJourneyShard).check(Schema.isMinLength(1)),
  /** Services this contained target lacks, and what cannot work without each. */
  missingServices: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, what: Schema.String })),
  ),
  /** What this kind of target was measured to carry, which sets a check's journeys per shard. */
  capacity: Schema.optional(
    Schema.Struct({
      measuredAt: Schema.String,
      browsersPerShard: Schema.Number,
      note: Schema.String,
    }),
  ),
});
export type ChampionJourneyManifest = typeof ChampionJourneyManifest.Type;

/** What the server recorded about one journey check; none of it comes from the owner's model. */
export const ChampionJourneyCheckRecord = Schema.Struct({
  checkId: Schema.String,
  championId: ChampionId,
  status: Schema.Literals(["running", "complete", "incomplete", "deferred", "refused"]),
  reason: Schema.NullOr(Schema.String),
  /** Set when the check ran smaller than configured, and why. */
  reduced: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  build: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(ChampionJourneyManifest),
  journeyLimit: Schema.Int,
  decisionCap: Schema.Int,
  spendLimitDecisions: Schema.Int,
  journeys: Schema.Struct({
    started: Schema.Int,
    passed: Schema.Int,
    failed: Schema.Int,
    stopped: Schema.Int,
    running: Schema.Int,
    stoppedByLimit: Schema.Int,
  }),
  ownerCounts: Schema.NullOr(
    Schema.Struct({
      started: Schema.Int,
      passed: Schema.Int,
      failed: Schema.Int,
      stopped: Schema.Int,
    }),
  ),
  concurrencyReached: Schema.Int,
  /** The most journeys at once this machine has been shown to carry with none stopped by a limit. */
  ceilingMeasured: Schema.Int,
  /** Confirmed bugs on a control target; null when the target is not one. */
  falsePositives: Schema.NullOr(Schema.Int),
  elapsedSeconds: Schema.NullOr(Schema.Finite),
  decisions: Schema.Int,
  usd: Schema.Finite,
  unpricedCalls: Schema.Int,
  candidates: Schema.Struct({
    filed: Schema.Int,
    confirmed: Schema.Int,
    rejected: Schema.Int,
    pending: Schema.Int,
    rejectionReasons: Schema.Array(Schema.String),
  }),
  perShard: Schema.Array(
    Schema.Struct({
      shard: Schema.String,
      journeys: Schema.Int,
      stepMsP50: Schema.NullOr(Schema.Finite),
      stepMsP95: Schema.NullOr(Schema.Finite),
      pageMsP50: Schema.NullOr(Schema.Finite),
      pageMsP95: Schema.NullOr(Schema.Finite),
      probeFailures: Schema.Int,
    }),
  ),
  machine: Schema.Struct({
    load5AtStart: Schema.Finite,
    peakCpuPercent: Schema.NullOr(Schema.Finite),
    peakMemoryGb: Schema.NullOr(Schema.Finite),
    /** Journey browser processes as the kernel reports them, at the sample with the most. */
    browserProcesses: Schema.Int,
    browserNice: Schema.NullOr(Schema.Int),
    browserPolicy: Schema.NullOr(Schema.String),
  }),
  network: Schema.Struct({
    allowed: Schema.Array(Schema.Struct({ destination: Schema.String, requests: Schema.Int })),
    blocked: Schema.Array(Schema.Struct({ destination: Schema.String, requests: Schema.Int })),
    capture: Schema.NullOr(
      Schema.Struct({
        packets: Schema.Int,
        peers: Schema.Int,
        subnet: Schema.String,
        outside: Schema.Array(Schema.String),
      }),
    ),
  }),
});
export type ChampionJourneyCheckRecord = typeof ChampionJourneyCheckRecord.Type;

/** An object with nothing required: MCP parameters must be an object, and the server knows which check this is. */
export const ChampionJourneysStartInput = Schema.Struct({ reason: Schema.optional(Schema.String) });
export const ChampionJourneyPlan = Schema.Struct({
  checkId: Schema.String,
  commit: Schema.String,
  shards: Schema.Array(ChampionJourneyShard),
  journeyLimit: Schema.Int,
  journeysPerShard: Schema.Int,
  decisionCap: Schema.Int,
  reduced: Schema.NullOr(Schema.String),
  /** Every path earlier checks walked, newest build first. */
  covered: Schema.Array(
    Schema.Struct({ commit: Schema.NullOr(Schema.String), urls: Schema.Array(Schema.String) }),
  ).check(Schema.isMaxLength(64)),
  /** Source files changed since the last check's build, when the project's checkout can say. */
  changedSinceLastCheck: Schema.Array(Schema.String).check(Schema.isMaxLength(200)),
  /** Confirmed bugs a later build may have fixed: replay each one. */
  retests: Schema.Array(Schema.Struct({ findingId: Schema.String, title: Schema.String })),
  /** Services the target lacks, and what cannot work without each. */
  missingServices: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, what: Schema.String })),
  ),
});
export type ChampionJourneyPlan = typeof ChampionJourneyPlan.Type;

export const ChampionJourneyCandidateInput = Schema.Struct({
  tabId: Schema.String,
  /** What this particular failure is, in one line; it does not decide whether two failures are the same bug. */
  title: ChampionLabel,
  expected: ChampionText,
  observed: ChampionText,
});
export type ChampionJourneyCandidateInput = typeof ChampionJourneyCandidateInput.Type;

export const ChampionCandidateReplayInput = Schema.Struct({
  /** Give one: a candidate to confirm, or a confirmed finding to re-test on this build. */
  candidateId: Schema.optional(Schema.String),
  findingId: Schema.optional(Schema.String),
});
export type ChampionCandidateReplayInput = typeof ChampionCandidateReplayInput.Type;

export const ChampionCandidateReplay = Schema.Struct({
  candidateId: Schema.String,
  /** Use these in delegate_task, with role browser, readOnly true and the integrated browser. */
  workId: Schema.String,
  attemptId: Schema.String,
  /** The whole task for the delegated browser agent; pass it unchanged. */
  brief: ChampionText,
});
export type ChampionCandidateReplay = typeof ChampionCandidateReplay.Type;

export const ChampionCandidateSettleInput = Schema.Struct({ candidateId: Schema.String });
export const ChampionCandidateSettled = Schema.Struct({
  candidateId: Schema.String,
  status: Schema.Literals([
    "pending",
    "confirmed",
    "rejected",
    "inconclusive",
    "fixed",
    "still-failing",
  ]),
  reason: Schema.String,
  findingId: Schema.NullOr(Schema.String),
});
export type ChampionCandidateSettled = typeof ChampionCandidateSettled.Type;
export const ChampionJourneyRecordInput = Schema.Struct({
  checkId: Schema.String,
  includeJourneys: Schema.optional(Schema.Boolean),
});
export const ChampionJourneyRecordResult = Schema.Struct({
  record: ChampionJourneyCheckRecord,
  journeys: Schema.optional(Schema.Array(ChampionJourney)),
});
export type ChampionJourneyRecordResult = typeof ChampionJourneyRecordResult.Type;
export class ChampionError extends Schema.TaggedError<ChampionError>()("ChampionError", {
  reason: Schema.Literals(["not-found", "invalid", "conflict", "unauthorized", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
  /** What the caller can do about a refusal; agents read it in place of the bare reason. */
  detail: Schema.optional(Schema.String),
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
      return `Champion report invalid: ${this.validation.sampleIndex === undefined ? "" : `sample ${this.validation.sampleIndex} `}${this.validation.field}. ${this.detail ?? instruction}`;
    }
    return `Champion operation failed: ${this.reason}.${this.detail === undefined ? "" : ` ${this.detail}`}`;
  }
}

export const ChampionExecutionAttempt = Schema.Struct({
  id: ChampionLabel,
  checkId: ChampionText,
  kind: Schema.Literals(["setup", "check", "review"]),
  /** Written by builds that resolved a role class; no longer set. */
  selectionClass: Schema.optional(Schema.NullOr(ChampionSelectionClass)),
  policyHash: Schema.optional(Schema.NullOr(ChampionText)),
  policyRevision: Schema.optional(Schema.NullOr(ChampionText)),
  /** `backup` when the main model could not run. */
  slot: Schema.optional(Schema.Literals(["main", "backup"])),
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
  /** One sentence someone outside engineering understands; required on new revisions. */
  plainSummary: Schema.optional(ChampionLabel),
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
/**
 * Who contributed a learning. A linked environment vouches for the thread and role it forwards;
 * the link itself is named from this environment's own record of it.
 */
export const ChampionLearningContributor = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  environmentLabel: Schema.NullOr(ChampionLabel),
  linkSessionId: Schema.NullOr(ChampionLabel),
  threadId: ChampionLabel,
  threadTitle: Schema.NullOr(ChampionLabel),
  // A stored record: a role named before the writer roles merged still reads, as `implementer`.
  role: Schema.NullOr(StoredAgentRole),
});
export type ChampionLearningContributor = typeof ChampionLearningContributor.Type;
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
  /** Present when an agent other than the Champion recorded it. */
  contribution: Schema.optional(ChampionLearningContributor),
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
export const ChampionSourceRevision = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
export const ChampionMeasurementMetricRef = Schema.Struct({
  metricId: ChampionLabel,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export const ChampionMeasurementStartInput = Schema.Struct({
  id: ChampionId,
  checkId: ChampionLabel,
  measurementId: ChampionLabel,
  role: Schema.Literals(["browser", "reviewer"]),
  /** The full commit the audit is pinned to; a reviewer's equals the browser audit it confirms. */
  sourceRevision: ChampionSourceRevision,
  /** Frozen, agent-measured metrics of the check this audit gathers evidence for. */
  metrics: Schema.Array(ChampionMeasurementMetricRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  /** A reviewer's completed browser audit in the same check. */
  browserMeasurementId: Schema.optional(ChampionLabel),
  /** What the audited preview says it serves; never taken as proof of the source pin. */
  observedRuntime: Schema.optional(ChampionLabel),
});
export type ChampionMeasurementStartInput = typeof ChampionMeasurementStartInput.Type;
export const ChampionMeasurementAdmission = Schema.Struct({
  clientRequestId: ChampionLabel,
  commandId: CommandId,
  taskId: NodeId,
  childThreadId: ThreadId,
  messageId: MessageId,
  workspacePath: ChampionText,
  policyHash: ChampionText,
  policyRevision: ChampionText,
  binding: AgentTaskBinding,
  resolvedSelection: ModelSelection,
  actualSelection: Schema.NullOr(ModelSelection),
  admittedAt: IsoDateTime,
  result: Schema.NullOr(ChampionText),
});
export type ChampionMeasurementAdmission = typeof ChampionMeasurementAdmission.Type;
export const ChampionMeasurement = Schema.Struct({
  ...ChampionMeasurementStartInput.fields,
  workId: ChampionText,
  attemptId: ChampionText,
  createdAt: IsoDateTime,
  state: Schema.Literals([
    "planned",
    "admitted",
    "unknown",
    "accepted",
    "completed",
    "failed",
    "cancelled",
  ]),
  admission: Schema.NullOr(ChampionMeasurementAdmission),
});
export type ChampionMeasurement = typeof ChampionMeasurement.Type;
export const ChampionRuntimeState = Schema.Struct({
  attempts: Schema.Array(ChampionExecutionAttempt).check(Schema.isMaxLength(50)),
  measurements: Schema.optional(Schema.Array(ChampionMeasurement).check(Schema.isMaxLength(20))),
});
export type ChampionRuntimeState = typeof ChampionRuntimeState.Type;
export const ChampionMetricsLeadResult = Schema.Struct({ threadId: ThreadId });
export type ChampionMetricsLeadResult = typeof ChampionMetricsLeadResult.Type;
