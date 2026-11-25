import type { ForwardedChampionApproval } from "./ChampionApproval.ts";
import * as ChampionEvidence from "./ChampionEvidence.ts";
import { CHAMPION_MEASUREMENT_GUIDANCE } from "./measurementGuidance.ts";
import * as ChampionJourneys from "./ChampionJourneys.ts";
import {
  CANDIDATE_WORK_PREFIX,
  describeSteps,
  findingEvidence,
  isCandidateWorkId,
  parseVerdict,
  sameFailure,
  replayBrief,
  shardOfOrigin,
} from "./journeyRules.ts";
import { engines as decisionEngines } from "../decisions/adapters.ts";
import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import * as ChampionLearnings from "./ChampionLearnings.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProcessRunner from "../processRunner.ts";
import { agentPolicyRoot } from "../agents/agentPolicyRoot.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as AgentConfigGit from "./folders/AgentConfigGit.ts";
import * as ProjectChampionGit from "./folders/ProjectChampionGit.ts";
import * as ServerConfig from "../config.ts";
import {
  parseChampionFolder,
  renderChampionFolder,
  championFolderPath,
  type ChampionFolder,
  type ChampionFolderReading,
} from "./folders/championFolderCodec.ts";
import {
  CHAMPIONS_PREFIX,
  filesByFolder,
  folderChanges,
  folderGroup,
  foldersOnMain,
  hostedFolders,
  isManagedFile,
  isRecordFile,
  type FolderOnMain,
} from "./folders/championFolderFiles.ts";
import { collectReading, type CollectedReading } from "./metricCollection.ts";
import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";
import * as ChampionModels from "./ChampionModels.ts";
import * as Escalation from "./championEscalation.ts";
import { isUsageLimitFailure } from "../orchestration-v2/AccountFailover.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountAvailability from "../provider/AccountAvailability.ts";
import {
  isProviderOverloadedFailureCode,
  ChampionExecutionAttempt,
  type ChampionModelDefaults,
  ChampionModelDefaults as ChampionModelDefaultsSchema,
  type ChampionSetModelsInput,
  ChampionSummary,
  type ChampionLatestSample,
  ChampionDetail,
  ChampionMetric,
  ChampionMetricChange,
  type ChampionRelayedApproval,
  ChampionFinding,
  ChampionSample,
  ChampionActivity,
  ChampionError,
  CHAMPION_METRIC_LIMIT,
  championMetricChangeResult,
  DEFAULT_GOAL_SCORE_TARGET,
  GOAL_SCORE_SERIES,
  type ChampionGoalScore,
  ChampionGoalScore as ChampionGoalScoreSchema,
  type ChampionSchedule,
  CommandId,
  MessageId,
  ThreadId,
  type ChampionConfig,
  type ChampionMeasurement,
  type ChampionMeasurementStartInput,
  type ChampionMetricInput,
  type ChampionReportInput,
  type ChampionSampleInput,
  type ChampionLifecycle,
  type ChampionHistoryInput,
  type ChampionHistoryResult,
  type ChampionFindingActionInput,
  type ChampionCheckContext,
  type AgentTaskRequest,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ChampionLearningContributor,
  type ChampionLearningContributeInput,
  type ChampionLearningConfirmInput,
  type ChampionLearningNoteInput,
  type ChampionCandidateReplay,
  type ChampionCandidateReplayInput,
  type ChampionCandidateSettled,
  type ChampionJourneyCandidateInput,
  type ChampionJourneyPlan,
  type ChampionJourneyRecordResult,
  ChampionLearningContent,
  ChampionLearningRevision,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { nextScheduledRunAt, isSameSchedule } from "../scheduledTasks/Schedule.ts";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import { HARD_STOP_BOUNDARY } from "../orchestration-v2/arcRun.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Document = Schema.Struct({
  champion: ChampionSummary,
  metrics: Schema.Array(ChampionMetric),
  findings: Schema.Array(ChampionFinding),
  /** Blob ids of the folder's files as T3 last wrote or applied them, so its own writes are not re-imported. */
  folderFiles: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type Document = typeof Document.Type;
/** A metric change filed before changes applied at once; retire once no stored champion holds one. */
const decodeWaitingProposal = Schema.decodeEffect(Schema.fromJsonString(ChampionMetricChange));
const Check = Schema.Struct({
  id: Schema.String,
  championId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  executionAttempt: Schema.optional(ChampionExecutionAttempt),
  /** `check` is a readings run; `review` a goal review. */
  kind: Schema.Literals(["setup", "check", "review"]),
  startedAt: Schema.String,
  measureOnly: Schema.Boolean,
  metrics: Schema.Array(ChampionMetric),
  reported: Schema.Boolean,
  dispatched: Schema.Boolean,
  launchStarted: Schema.optional(Schema.Boolean),
  dispatchKind: Schema.Literals(["launch", "send"]),
  samples: Schema.optional(Schema.Array(ChampionSample)),
  cancelled: Schema.optional(Schema.Boolean),
  /** Why the run was skipped, when it ended on a usage limit with no model left to run. */
  skipped: Schema.optional(Schema.String),
  /** Retries the server started on its own for this claim; manual retries are not counted. */
  automaticRetries: Schema.optional(Schema.Number),
  /** The message of the one follow-up the server sent after a run ended without a report; it is sent once per check. */
  repromptMessageId: Schema.optional(MessageId),
  /** Set once this check's failure has counted towards the Champion being stuck. */
  failureCounted: Schema.optional(Schema.Boolean),
  /** A goal review's score, also kept as its goal-score sample. */
  goalScore: Schema.optional(ChampionGoalScoreSchema),
});
type Check = typeof Check.Type;
type Rhythm = Check["kind"];
/** The summary field holding a rhythm's outstanding claim. */
const outstandingField = (kind: Rhythm) =>
  kind === "setup"
    ? ("outstandingSetupId" as const)
    : kind === "review"
      ? ("outstandingReviewId" as const)
      : ("outstandingCheckId" as const);
const outstandingOf = (champion: ChampionSummary, kind: Rhythm) =>
  champion[outstandingField(kind)] ?? null;
/** How attention lines and messages name a rhythm's run. */
const runLabel = (kind: Rhythm) =>
  kind === "setup" ? "Setup" : kind === "review" ? "Review" : "Check";
const runWhat = (kind: Rhythm) =>
  kind === "setup" ? "setup" : kind === "review" ? "review" : "check";
/** Setup and goal reviews run on the advice model; readings on the checks model. */
const slotKind = (kind: Rhythm): ChampionModels.ChampionModelKind =>
  kind === "check" ? "checks" : "advice";
/** A goal review gets this long before it counts as overdue; a readings run an hour. */
const retryHint = (kind: Rhythm) =>
  kind === "setup" ? "Ask AI to try again" : kind === "review" ? "Review now" : "Check now";
const OVERDUE_MS = { setup: 60 * 60 * 1000, check: 60 * 60 * 1000, review: 3 * 60 * 60 * 1000 };
/** Opens the follow-up that tells an owner its readings run or review ended with no report on the server. */
const missingReportReminder = (check: Pick<Check, "id" | "kind">) =>
  `The server has no report for ${runWhat(check.kind)} claim ${check.id}. Saying it was reported does not record one. Call t3_champions_check_context and then t3_champions_report now, before anything else. End the turn only after the report call succeeds.`;
/** The one refusal every removed repair action gives a check, review or setup thread. */
export const CASE_FLOW_REFUSAL =
  "Champion readings and goal reviews only observe and score: they never delegate repairs or advice, record a diagnosis or route, file a Spec, start an investigation, request a decision or hand a finding on. Report it as a finding with t3_champions_report; the server opens a case for it in Henry's Inbox, where an agent diagnoses, fixes, files a Spec or asks Henry.";
const goalFindingId = (championId: string) => `${championId}${Escalation.GOAL_FINDING_SUFFIX}`;
/** The default review: weekly on Mondays at the Champion's spread time, in UTC like every schedule. */
const reviewScheduleOf = (
  champion: Pick<ChampionSummary, "goalReview" | "reviewTime">,
): ChampionSchedule =>
  champion.goalReview?.schedule ?? {
    type: "fixed_time",
    timeOfDay: champion.reviewTime ?? "06:00",
    weekdays: [1],
  };
const goalTargetOf = (champion: Pick<ChampionSummary, "goalReview">) =>
  champion.goalReview?.target ?? DEFAULT_GOAL_SCORE_TARGET;
const minutesOf = (time: string) => {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};
/** The first ten-minute Monday slot from 06:00 UTC at least ten minutes from every other Champion's review. */
const spreadReviewTime = (taken: ReadonlyArray<string>) => {
  const used = taken.map(minutesOf);
  for (let slot = 0; slot < 144; slot += 1) {
    const minute = (6 * 60 + slot * 10) % (24 * 60);
    if (
      used.every(
        (other) => Math.min(Math.abs(other - minute), 1440 - Math.abs(other - minute)) >= 10,
      )
    )
      return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }
  return "06:00";
};
/** Whether a reading reaches its metric's alarm value. */
const reachesAlarm = (metric: ChampionMetricInput, value: number) =>
  metric.alarm !== undefined &&
  (metric.direction === "lower"
    ? value >= metric.alarm
    : metric.direction === "higher"
      ? value <= metric.alarm
      : false);
/** A claim's own retries stop here, so a lasting outage cannot keep spending on it. */
const MAX_AUTOMATIC_CHECK_RETRIES = 3;
/** Opens the attention line and activity entry a skipped run leaves. */
const SKIPPED = "Skipped this ";
/** How long a check waits for the server's account failover to continue it before retrying it itself. */
const FAILOVER_GRACE_MS = 2 * 60 * 1000;
const CHAMPION_MODELS_GUIDANCE =
  "Models: readings run on the Champion models checks model, or this champion's own, with the backup taking over when that model is at its usage limit on every account; goal reviews and metric setup use the advice model the same way. When neither can run the server skips the run, records it as skipped (never as passing) and runs the next one on time, so do not ask for a different model for your own runs.";
// A claim crosses messages only through persisted server restart ancestry, or through the server's own account
// failover (its message id names the failed run), which moves the run to another account's provider session.
function checkRunMessages(run: OrchestrationV2Run, runs: ReadonlyMap<RunId, OrchestrationV2Run>) {
  const messages = [run.userMessageId];
  let current = run;
  const visited = new Set([run.id]);
  for (;;) {
    const failoverOf =
      current.manualContinuationOfRunId !== undefined &&
      current.userMessageId ===
        `limit-pool-switch:${current.threadId}:${current.manualContinuationOfRunId}`
        ? current.manualContinuationOfRunId
        : undefined;
    const sourceId = failoverOf ?? current.restartContinuationOfRunId;
    if (sourceId === undefined) break;
    const source = runs.get(sourceId);
    if (
      source === undefined ||
      visited.has(source.id) ||
      source.ordinal >= current.ordinal ||
      source.threadId !== current.threadId ||
      (failoverOf === undefined &&
        (source.providerInstanceId !== current.providerInstanceId ||
          source.providerThreadId !== current.providerThreadId))
    )
      break;
    visited.add(source.id);
    messages.push(source.userMessageId);
    current = source;
  }
  return messages;
}

const isChampionError = Schema.is(ChampionError);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const wordCharacter = /[\p{L}\p{N}]/u;
/** Whether `quote` appears in `text` word for word: whole words, any run of spaces alike. */
function quotedIn(quote: string, text: string) {
  const needle = collapse(quote);
  const haystack = collapse(text);
  if (needle === "") return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (
      (before === undefined || !wordCharacter.test(before) || !wordCharacter.test(needle[0]!)) &&
      (after === undefined || !wordCharacter.test(after) || !wordCharacter.test(needle.at(-1)!))
    )
      return true;
  }
  return false;
}
/**
 * Ids of the messages Champions write into threads: check prompts, decision deliveries, case
 * starts and the Fix-with-a-lead brief. Deliveries keep client provenance so they still resume a held queue,
 * so these ids, not provenance, keep them (and those stored before T3-448) from being quoted.
 */
const CHAMPION_MESSAGE_ID_PREFIXES = [
  "champion:",
  "champion-decision:",
  "champion-metrics-lead:",
  "champion-case:",
];
/** Words a person typed into the thread; the server's, agents', automations' and guests' never count. */
const typedByPerson = (message: OrchestrationV2ConversationMessage) =>
  !CHAMPION_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix)) &&
  message.role === "user" &&
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined &&
  message.context?.guest === undefined;
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));
const decodeCheck = Schema.decodeUnknownEffect(Schema.fromJsonString(Check));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(Document));
const encodeCheck = Schema.encodeEffect(Schema.fromJsonString(Check));
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(ChampionFinding));
const decodeFinding = Schema.decodeEffect(Schema.fromJsonString(ChampionFinding));
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(ChampionActivity));
const encodeMetric = Schema.encodeEffect(Schema.fromJsonString(ChampionMetric));
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(ChampionSummary));
const decodeActivity = Schema.decodeEffect(Schema.fromJsonString(ChampionActivity));
const decodeMetric = Schema.decodeEffect(Schema.fromJsonString(ChampionMetric));
const METRIC_RULE =
  "A metric change applies at once, with no acceptance, and keeps every metric it does not list: list only metrics to add or change, and to stop tracking one, name its id in retires. Prove each new metric works. Prefer a command to a method an agent re-derives: where a metric is a plain read, give it collect, the argument list of a read-only command the server runs itself at each check (see t3_champions_metrics); the server runs a new command once and refuses the change if it fails. Measure a metric without collect once yourself before adding it.";
const NEEDS_METRICS = "Add metrics before enabling checks.";
/** Attention that only waited for metrics, cleared once a change installs them. */
const WAITING_FOR_METRICS: ReadonlySet<string> = new Set([
  NEEDS_METRICS,
  "Accept metric definitions before enabling checks.",
  "Metric proposal awaits acceptance.",
]);
/** A metric's definition as versioned: its alarm value can change without a new version. */
const metricInputOf = (metric: ChampionMetricInput): ChampionMetricInput => ({
  id: metric.id,
  name: metric.name,
  description: metric.description,
  required: metric.required ?? true,
  baseline: metric.baseline ?? null,
  ...(metric.staleAfterMs === undefined ? {} : { staleAfterMs: metric.staleAfterMs }),
  unit: metric.unit,
  source: metric.source,
  context: metric.context,
  direction: metric.direction,
  minimum: metric.minimum,
  maximum: metric.maximum,
  ...(metric.collect === undefined ? {} : { collect: metric.collect }),
});
const withAlarm = <M extends ChampionMetricInput>(metric: M, alarm: number | undefined): M => {
  const { alarm: _previous, ...rest } = metric;
  return (alarm === undefined ? rest : { ...rest, alarm }) as M;
};
const targeted = (metric: ChampionMetricInput) =>
  metric.direction !== "observe" && (metric.minimum !== null || metric.maximum !== null);
const outside = (metric: ChampionMetricInput, value: number) =>
  (metric.minimum !== null && value < metric.minimum) ||
  (metric.maximum !== null && value > metric.maximum);
const settled = (finding: ChampionFinding) =>
  finding.status === "verified" || finding.status === "dismissed";
const MAX_OPEN_FINDINGS = 10;
const sameDefinition = (a: ChampionMetricInput, b: ChampionMetricInput) =>
  JSON.stringify(metricInputOf(a)) === JSON.stringify(metricInputOf(b));
const sameSeries = (a: ChampionMetricInput, b: ChampionMetricInput) =>
  a.unit === b.unit &&
  a.source === b.source &&
  a.context === b.context &&
  a.direction === b.direction;

type Caller = McpThreadCaller | undefined;
/** An agent completing an approval for the user: the thread it acts from and the user's words. */
export interface ChampionRelay {
  readonly threadId: ThreadId | undefined;
  readonly quote: string | undefined;
  readonly forwarded?: ForwardedChampionApproval & {
    readonly sourceEnvironment: NonNullable<ChampionRelayedApproval["sourceEnvironment"]>;
  };
}
const JOURNEY_OWNER_GONE_AFTER = Duration.minutes(5);
const JOURNEY_DEFER_MINUTES = 30;
const encodeClicks = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

type Evidence = Effect.Success<typeof ChampionEvidence.make>;
type Learnings = Effect.Success<typeof ChampionLearnings.make>;
type DetailOperation<I> = (input: I) => Effect.Effect<ChampionDetail, ChampionError>;

export class ChampionService extends Context.Service<
  ChampionService,
  {
    readonly hasThreadContext: (threadId: ThreadId) => Effect.Effect<boolean, ChampionError>;
    readonly verifyApproval: (
      relay: ChampionRelay,
    ) => Effect.Effect<ForwardedChampionApproval, ChampionError>;
    readonly setModels: (
      input: ChampionSetModelsInput,
    ) => Effect.Effect<ChampionModelDefaults, ChampionError>;
    readonly modelDefaults: Effect.Effect<ChampionModelDefaults, ChampionError>;
    readonly startMeasurementFromOwner: (
      caller: Caller,
      input: ChampionMeasurementStartInput,
    ) => Effect.Effect<ChampionMeasurement, ChampionError>;
    readonly runtimeState: Evidence["runtimeState"];
    readonly learningQuery: Evidence["learningQuery"];
    readonly learningSearch: Learnings["search"];
    readonly learningTopics: Learnings["topics"];
    readonly learningRead: Learnings["read"];
    /** A learning recorded by an agent other than the Champion; it counts at once. */
    readonly contributeLearning: (
      contributor: ChampionLearningContributor,
      input: ChampionLearningContributeInput,
    ) => ReturnType<Evidence["recordLearning"]>;
    readonly confirmLearning: (
      caller: Caller,
      input: ChampionLearningConfirmInput,
    ) => ReturnType<Learnings["confirm"]>;
    readonly noteLearning: (
      caller: Caller,
      input: ChampionLearningNoteInput,
    ) => ReturnType<Learnings["note"]>;
    readonly recordedDelegationBinding: Evidence["recordedBinding"];
    /** Admits an owner thread's measurement or journey replay; refuses any other delegation. */
    readonly admitDelegation: (
      proof: ChampionEvidence.Admission,
    ) => Effect.Effect<void, ChampionError>;
    readonly recordLearning: (
      caller: Caller,
      input: Parameters<Evidence["recordLearning"]>[0],
    ) => ReturnType<Evidence["recordLearning"]>;
    readonly list: (input: {
      readonly projectId?: ChampionConfig["projectId"] | undefined;
    }) => Effect.Effect<
      { champions: ReadonlyArray<ChampionSummary>; modelDefaults?: ChampionModelDefaults },
      ChampionError
    >;
    readonly subscribe: (input: {
      readonly projectId?: ChampionConfig["projectId"] | undefined;
    }) => Stream.Stream<{ champions: ReadonlyArray<ChampionSummary> }, ChampionError>;
    readonly get: DetailOperation<{ id: string }>;
    readonly history: (
      input: typeof ChampionHistoryInput.Type,
    ) => Effect.Effect<typeof ChampionHistoryResult.Type, ChampionError>;
    readonly upsert: DetailOperation<ChampionConfig>;
    readonly setLifecycle: DetailOperation<{ id: string; lifecycle: ChampionLifecycle }>;
    readonly setup: DetailOperation<{ id: string }>;
    readonly runCheck: DetailOperation<{ id: string }>;
    /** Starts a goal review now, whatever its schedule says. */
    readonly runReview: DetailOperation<{ id: string }>;
    /** Starts a thread on the lead role to shape and lead a fix for this champion's metrics. */
    readonly startMetricsLead: (input: {
      readonly id: string;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, ChampionError>;
    /** Applies at once; `by` is the thread that made the change, `prove: false` skips reading new commands. */
    readonly changeMetrics: (
      input: { id: string } & ChampionMetricChange,
      by?: ThreadId,
      options?: { readonly prove?: boolean },
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly cancelSetup: DetailOperation<{ id: string }>;
    readonly completeSetup: (
      caller: Caller,
      input: { summary: string },
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    /** `by` is the calling agent thread; a readings or review run it holds may not settle findings. */
    readonly findingAction: (
      input: typeof ChampionFindingActionInput.Type,
      actor?: "user" | ChampionRelay,
      by?: ThreadId,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly checkContext: (
      caller: Caller,
    ) => Effect.Effect<typeof ChampionCheckContext.Type, ChampionError>;
    readonly changeMetricsFromCheck: (
      caller: Caller,
      input: ChampionMetricChange,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly report: (
      caller: Caller,
      input: ChampionReportInput,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    /** The report tool's entry: a setup run's summary completes it; a check's samples and findings default to none. */
    readonly submitReport: (
      caller: Caller,
      input: {
        readonly summary: string;
        readonly samples?: ChampionReportInput["samples"];
        readonly findings?: ChampionReportInput["findings"];
        readonly journeys?: ChampionReportInput["journeys"];
      },
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly journeysStart: (caller: Caller) => Effect.Effect<ChampionJourneyPlan, ChampionError>;
    readonly journeyCandidate: (
      caller: Caller,
      input: ChampionJourneyCandidateInput,
    ) => Effect.Effect<{ readonly candidateId: string }, ChampionError>;
    readonly candidateReplay: (
      caller: Caller,
      input: ChampionCandidateReplayInput,
    ) => Effect.Effect<ChampionCandidateReplay, ChampionError>;
    readonly candidateSettle: (
      caller: Caller,
      input: { readonly candidateId: string },
    ) => Effect.Effect<ChampionCandidateSettled, ChampionError>;
    readonly journeyRecord: (input: {
      readonly checkId: string;
      readonly includeJourneys?: boolean | undefined;
    }) => Effect.Effect<ChampionJourneyRecordResult, ChampionError>;
    readonly guardDelegation: (input: {
      ownerThreadId: ThreadId;
      request: AgentTaskRequest | undefined;
      clientRequestId: string | undefined;
      followup?: boolean | undefined;
      task?: string | undefined;
      remote?: boolean | undefined;
    }) => Effect.Effect<ModelSelection | undefined, ChampionError>;
    readonly delegationOutcome: (input: {
      ownerThreadId: ThreadId;
      request: AgentTaskRequest | undefined;
      clientRequestId: string | undefined;
      state: "started" | "finished" | "failed";
      followup?: boolean | undefined;
      commandId?: CommandId | undefined;
    }) => Effect.Effect<void, ChampionError>;
    readonly runDue: Effect.Effect<void, ChampionError>;
    /** Applies agent-config folders naming this machine and saves its Champions back to them (T3-839). */
    readonly syncFolders: Effect.Effect<void, ChampionError>;
  }
>()("t3/champions/ChampionService") {}

function defaultStaleAfterMs(config: ChampionConfig, at: string): number {
  if (config.schedule.type === "interval") return Math.max(60_000, config.schedule.everyMs * 2);
  let previous = nextScheduledRunAt(config.schedule, DateTime.makeUnsafe(at));
  let longest = 60_000;
  for (let index = 0; index < 7 && previous !== null; index += 1) {
    const next = nextScheduledRunAt(config.schedule, previous);
    if (next === null) break;
    longest = Math.max(longest, DateTime.toEpochMillis(next) - DateTime.toEpochMillis(previous));
    previous = next;
  }
  return longest * 2;
}
function presentLatest(doc: Document, at: string): ChampionLatestSample[] {
  const cadence = defaultStaleAfterMs(doc.champion, at);
  return doc.metrics.map((metric) => {
    const sample = doc.champion.latestSamples?.find((s) => s.metricId === metric.id);
    const observed = sample?.observedAt == null ? Number.NaN : Date.parse(sample.observedAt);
    const expiration = Number.isFinite(observed)
      ? DateTime.make(observed + (metric.staleAfterMs ?? cadence))
      : Option.none();
    const staleAt = Option.isSome(expiration) ? DateTime.formatIso(expiration.value) : null;
    const value = sample?.value ?? null;
    let health: ChampionLatestSample["health"] = "unknown";
    if (sample?.seriesId === metric.seriesId && sample.version === metric.version) {
      if (sample.status === "error" || sample.status === "insufficient") health = sample.status;
      else if (Number.isFinite(observed) && staleAt !== null && at >= staleAt) health = "stale";
      else if (
        sample.status === "measured" &&
        staleAt !== null &&
        value !== null &&
        observed <= Date.parse(at) &&
        sample.collectedAt !== null &&
        observed <= Date.parse(sample.collectedAt)
      )
        health = !targeted(metric) ? "untargeted" : outside(metric, value) ? "breached" : "healthy";
    } else if (sample !== undefined && sample.collectedAt !== null) health = "outdated";
    return {
      metricId: metric.id,
      name: metric.name,
      version: sample?.version ?? metric.version,
      seriesId: sample?.seriesId ?? metric.seriesId,
      unit: sample?.unit ?? metric.unit,
      required: metric.required ?? true,
      value,
      status: sample?.status ?? "unknown",
      health,
      observedAt: sample?.observedAt ?? null,
      collectedAt: sample?.collectedAt ?? null,
      revision: sample?.revision ?? null,
      staleAt,
    };
  });
}

/** Escalation thread work a committed write implies; it runs after the commit, never inside it. */
type EscalationIntent = {
  readonly threadId: ThreadId;
  readonly championId: string;
  readonly target: Escalation.EscalationStep["target"];
  readonly action: Escalation.EscalationStep["action"];
  /** An alarm case starts at once. */
  readonly start: boolean;
};
class ChangeBatch extends Context.Reference<
  | {
      changed: boolean;
      owners: Set<ThreadId>;
      escalations: EscalationIntent[];
      /** Findings that need a case whatever changed: reopened by a person, or left without one by an upgrade. */
      forced: Set<string>;
    }
  | undefined
>("t3/champions/ChangeBatch", { defaultValue: () => undefined }) {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const managedAgents = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  const projects = yield* ProjectService.ProjectService;
  const processes = yield* ProcessRunner.ProcessRunner;
  const scheduler = yield* Scheduler.Scheduler;
  const random = yield* SecureRandom.SecureRandom;
  const evidence = yield* ChampionEvidence.make;
  const learnings = yield* ChampionLearnings.make;
  const journeys = yield* ChampionJourneys.make;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const shellChanges = yield* PubSub.unbounded<ThreadId>();
  const failure = (cause: unknown) => new ChampionError({ reason: "unavailable", cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = random.uuidV4().pipe(Effect.mapError(failure));
  // Set by any committed change, so the folder sync saves soon after instead of on its minute.
  let folderDirty = true;
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const repositoryIdentities = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );
  const here = Option.isSome(serverEnvironment)
    ? yield* serverEnvironment.value.getEnvironmentId
    : null;
  const DEFINED_TWICE = "Defined twice: ";
  const FOLDER_PROBLEM = "agent-config folder: ";
  const NOT_SAVED = Escalation.NOT_SAVED_PREFIX;
  /** True unless the Champion's folder names another machine as its runner, or it is defined in two places. */
  const runsHere = (champion: Pick<ChampionSummary, "folder" | "attention">) =>
    (champion.folder === undefined || champion.folder.runner.environmentId === here) &&
    !champion.attention.some((line) => line.startsWith(DEFINED_TWICE));
  const runsElsewhere = (champion: Pick<ChampionSummary, "folder" | "name" | "attention">) =>
    new ChampionError({
      reason: "conflict",
      detail:
        champion.attention.find((line) => line.startsWith(DEFINED_TWICE)) ??
        `${champion.name} runs on ${champion.folder?.runner.label ?? "another machine"}, as its folder ${champion.folder?.definedIn ?? champion.folder?.path ?? ""} says; this machine starts no work for it.`,
    });
  /** A repository-hosted Champion's definition, metrics and learnings change only by a landing there. */
  const hostedRefusal = (champion: Pick<ChampionSummary, "folder" | "name">, what: string) =>
    champion.folder?.definedIn === undefined
      ? null
      : new ChampionError({
          reason: "conflict",
          detail: `${champion.name}'s ${what} live in ${champion.folder.repository} at ${champion.folder.definedIn}/. Edit the file there and land it; T3 does not write project repositories.`,
        });
  const hostedGuidance = (champion: Pick<ChampionSummary, "folder">) =>
    champion.folder?.definedIn === undefined
      ? null
      : `This champion's definition, metrics and learnings live in ${champion.folder.repository} at ${champion.folder.definedIn}/, which T3 only reads: t3_champions_metrics submit and t3_champions_record_learning are refused for it. Write learnings and metric changes as files there (format: ~/.agents/champions/README.md), or in the area's knowledge home its AGENTS.md names, and land them through SlipJay with the repair that found them or as one landing per check.`;
  const mutate = <A, R>(effect: Effect.Effect<A, ChampionError, R>) =>
    Effect.suspend(() => {
      const batch = {
        changed: false,
        owners: new Set<ThreadId>(),
        escalations: [] as EscalationIntent[],
        forced: new Set<string>(),
      };
      return lock
        .withPermits(1)(
          sql.withTransaction(effect.pipe(Effect.provideService(ChangeBatch, batch))).pipe(
            Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
            Effect.tap(() =>
              Effect.gen(function* () {
                if (batch.changed) {
                  folderDirty = true;
                  yield* PubSub.publish(changes, undefined);
                }
              }),
            ),
          ),
        )
        .pipe(
          // After the commit and outside the lock: launching or settling a thread must not hold Champion writes.
          Effect.tap(() =>
            Effect.gen(function* () {
              for (const intent of batch.escalations)
                yield* runEscalation(intent).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("champions.escalation-failed", {
                      championId: intent.championId,
                      threadId: intent.threadId,
                      cause,
                    }),
                  ),
                );
              for (const owner of batch.owners) yield* PubSub.publish(shellChanges, owner);
            }),
          ),
        );
    });

  const read = Effect.fn("ChampionService.read")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champions WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (rows[0] === undefined)
      return yield* new ChampionError({
        reason: "not-found",
        detail: `No Champion has id "${id}" in this environment.`,
      });
    return yield* decodeDocument(rows[0].document_json).pipe(Effect.mapError(failure));
  });
  const write = Effect.fn("ChampionService.write")(function* (input: Document) {
    const at = yield* now;
    const retired = input.champion.lifecycle === "retired";
    const live = new Set(input.metrics.map((m) => m.seriesId));
    // Retired Champions and metrics that no longer exist (retired, or a new series) leave no open findings behind.
    const doc: Document = {
      ...input,
      findings: input.findings.map((f) =>
        f.status !== "verified" &&
        f.status !== "dismissed" &&
        (retired || (f.seriesId != null && !live.has(f.seriesId)))
          ? { ...f, status: "dismissed" as const, updatedAt: at }
          : f,
      ),
    };
    const latestSamples = presentLatest(doc, yield* now);
    const batch = yield* ChangeBatch;
    const priorRows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champions WHERE id = ${doc.champion.id}`.pipe(
      Effect.mapError(failure),
    );
    const prior =
      priorRows[0] === undefined
        ? undefined
        : yield* decodeDocument(priorRows[0].document_json).pipe(
            Effect.option,
            Effect.map(Option.getOrUndefined),
          );
    const reviewTime =
      doc.champion.reviewTime ??
      (doc.champion.goalReview?.schedule !== undefined
        ? undefined
        : spreadReviewTime(yield* reviewTimesBesides(doc.champion.id)));
    const reviewing = { ...doc.champion, reviewTime };
    const reviewMoved =
      prior === undefined ||
      !isSameSchedule(reviewScheduleOf(prior.champion), reviewScheduleOf(reviewing));
    // Only an active Champion reviews; a new or moved schedule, or one never set, takes its next slot.
    const nextReviewAt =
      doc.champion.lifecycle !== "active"
        ? null
        : doc.champion.nextReviewAt == null || reviewMoved
          ? yield* nextDueOf(reviewScheduleOf(reviewing))
          : doc.champion.nextReviewAt;
    const draft = {
      ...doc.champion,
      ...(reviewTime === undefined ? {} : { reviewTime }),
      nextReviewAt,
      latestSamples,
      attention: [
        ...new Set([
          ...doc.champion.attention.filter(
            (a) =>
              a !== "Findings need improvement or verification." &&
              a !== "A product decision needs attention; see activity." &&
              (a !== "Required measurements are stale." || doc.champion.lifecycle === "active") &&
              !a.startsWith("Decision:"),
          ),
          ...doc.findings
            .filter((f) => f.decision?.status === "requested")
            .map((f) => `Decision: ${f.title}`),
        ]),
      ],
      openFindingCount: doc.findings.filter((f) => !["verified", "dismissed"].includes(f.status))
        .length,
      updatedAt: yield* now,
    };
    // Escalation threads get their ids here, in the same commit as the state that needs them; the
    // threads themselves are made after it (runEscalation).
    let stuckThreadId = draft.stuckEscalationThreadId ?? null;
    const findingThreadIds = new Map<string, ThreadId>();
    const intents: EscalationIntent[] = [];
    if (batch !== undefined)
      for (const step of Escalation.planEscalation(
        prior,
        { champion: draft, findings: doc.findings },
        batch.forced,
      )) {
        const target = step.target;
        let threadId =
          target.kind === "stuck"
            ? stuckThreadId
            : (doc.findings.find((f) => f.id === target.findingId)?.escalationThreadId ?? null);
        if (threadId !== null && step.action === "ensure") {
          // A case the user archived or deleted stays gone while its finding stays open; a finding
          // that closed and reopened gets a fresh one.
          const existing = yield* threads.getThreadShell(threadId).pipe(Effect.option);
          if (
            Option.isSome(existing) &&
            existing.value !== null &&
            (existing.value.deletedAt !== null || existing.value.archivedAt !== null)
          ) {
            if (step.fresh !== true && target.kind !== "stuck") continue;
            threadId = null;
          }
        }
        if (threadId === null) {
          if (step.action === "settle") continue;
          threadId = ThreadId.make(yield* uuid);
          if (target.kind === "stuck") stuckThreadId = threadId;
          else findingThreadIds.set(target.findingId, threadId);
        }
        intents.push({
          threadId,
          championId: draft.id,
          target,
          action: step.action,
          start: step.start === true,
        });
      }
    const champion =
      stuckThreadId === null ? draft : { ...draft, stuckEscalationThreadId: stuckThreadId };
    const threadedFindings = doc.findings.map((f) =>
      findingThreadIds.has(f.id) ? { ...f, escalationThreadId: findingThreadIds.get(f.id)! } : f,
    );
    const active = threadedFindings.filter((f) => !["verified", "dismissed"].includes(f.status));
    const settled = threadedFindings
      .filter((f) => ["verified", "dismissed"].includes(f.status))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const finding of settled.slice(Math.max(0, 100 - active.length))) {
      const json = yield* encodeFinding(finding).pipe(Effect.mapError(failure));
      yield* sql`INSERT INTO champion_finding_archive (id,champion_id,at,document_json) VALUES (${finding.id},${champion.id},${finding.updatedAt},${json}) ON CONFLICT(id) DO UPDATE SET at=excluded.at, document_json=excluded.document_json`.pipe(
        Effect.mapError(failure),
      );
    }
    const next = {
      ...doc,
      findings: [...active, ...settled.slice(0, Math.max(0, 100 - active.length))],
      champion,
    };
    yield* sql`INSERT INTO champions (id, project_id, document_json) VALUES (${champion.id}, ${champion.projectId}, ${yield* encodeDocument(next).pipe(Effect.mapError(failure))})
      ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json`.pipe(
      Effect.mapError(failure),
    );
    if (batch !== undefined) {
      batch.changed = true;
      if (
        (prior !== undefined && prior.champion.attention.length > 0) !==
        champion.attention.length > 0
      ) {
        batch.owners.add(champion.ownerThreadId);
        if (champion.setupThreadId !== null) batch.owners.add(champion.setupThreadId);
      }
      batch.escalations.push(...intents);
      // An escalation thread's shell follows its finding or the Champion's stuck state.
      const before = prior === undefined ? new Map() : Escalation.escalationShells(prior);
      const after = Escalation.escalationShells({ champion, findings: threadedFindings });
      for (const id of new Set([...before.keys(), ...after.keys()]))
        if (!Escalation.sameShell(before.get(id), after.get(id)))
          batch.owners.add(ThreadId.make(id));
    }
    return { ...next, latestSamples };
  });
  const activity = Effect.fn("ChampionService.activity")(function* (
    id: string,
    kind: string,
    text: string,
    finding?: ChampionFinding,
    threadId?: ThreadId,
    approval?: ChampionRelayedApproval,
  ) {
    const at = yield* now;
    const batch = yield* ChangeBatch;
    if (batch !== undefined) batch.changed = true;
    const entry: ChampionActivity = {
      id: `${at}:${yield* uuid}`,
      championId: id,
      at,
      kind,
      text,
      findingId: finding?.id ?? null,
      threadId: threadId ?? finding?.escalationThreadId ?? null,
      revision: finding?.revision ?? null,
      specUrl: null,
      ...(approval === undefined ? {} : { approval }),
    };
    yield* sql`INSERT INTO champion_activity (id, champion_id, document_json) VALUES (${entry.id}, ${id}, ${yield* encodeActivity(entry).pipe(Effect.mapError(failure))})`.pipe(
      Effect.mapError(failure),
    );
  });
  const byThread = Effect.fn("ChampionService.byThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ document_json: string }>`SELECT document_json FROM champions
      WHERE json_extract(document_json, '$.champion.ownerThreadId') = ${threadId}
      OR json_extract(document_json, '$.champion.setupThreadId') = ${threadId}`;
    return rows[0] === undefined ? undefined : yield* decodeDocument(rows[0].document_json);
  }, Effect.mapError(failure));
  const hasThreadContext = Effect.fn("ChampionService.hasThreadContext")(function* (
    threadId: ThreadId,
  ) {
    if ((yield* byThread(threadId)) !== undefined) return true;
    // The Champion's current stuck escalation thread, or any open finding's, reads its own Champion's state (same match as the brief).
    const escalations = yield* sql`SELECT 1 FROM champions
      WHERE json_extract(document_json, '$.champion.stuckEscalationThreadId') = ${threadId}
        OR EXISTS (SELECT 1 FROM json_each(document_json, '$.findings') f
          WHERE json_extract(f.value, '$.escalationThreadId') = ${threadId})
      LIMIT 1`.pipe(Effect.mapError(failure));
    if (escalations.length > 0) return true;
    const checks =
      yield* sql`SELECT 1 FROM champion_checks WHERE thread_id = ${threadId} AND status = 'pending' LIMIT 1`.pipe(
        Effect.mapError(failure),
      );
    return checks.length > 0;
  });
  const verifyApproval = Effect.fn("ChampionService.verifyApproval")(function* (
    relay: ChampionRelay,
    waiting = "The request still waits for the user on the Champion page.",
    /** When the request was filed; an approval typed before it cannot be about it. */
    filedAt?: string,
  ) {
    const ask = (why: string) =>
      new ChampionError({ reason: "unauthorized", detail: `${why} ${waiting}` });
    const quote = relay.quote?.trim() ?? "";
    if (quote === "") return yield* ask("This needs the user's approval.");
    const shell =
      relay.threadId === undefined
        ? null
        : yield* threads.getThreadShell(relay.threadId).pipe(Effect.mapError(failure));
    if (shell === null)
      return yield* ask("An approval quote counts only from a thread the user typed in.");
    const { messages } = yield* threads
      .getThreadRecords(shell.id, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(failure));
    const filed = filedAt === undefined ? undefined : DateTime.make(filedAt);
    const typed = messages.filter(
      (message) => typedByPerson(message) && quotedIn(quote, message.text),
    );
    if (typed.length === 0)
      return yield* ask(
        "That approval quote is not word for word from a message the user typed in this thread; messages T3 Code or other agents sent there do not count.",
      );
    if (
      filed !== undefined &&
      Option.isSome(filed) &&
      !typed.some((message) => !DateTime.isLessThan(message.createdAt, filed.value))
    )
      return yield* ask(
        "The user typed that before this request was filed, so it cannot approve it.",
      );
    const message = typed.toSorted(
      (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
    )[0]!;
    return {
      quote,
      threadId: shell.id,
      threadTitle: shell.title.slice(0, 500),
      model: shell.modelSelection.model.slice(0, 500),
      messageId: message.id,
      createdAt: DateTime.formatIso(message.createdAt),
    } satisfies ForwardedChampionApproval;
  });
  const relayedApproval = Effect.fn("ChampionService.relayedApproval")(function* (
    relay: ChampionRelay,
    waiting: string,
    filedAt: string | undefined,
  ) {
    const verified = relay.forwarded ?? (yield* verifyApproval(relay, waiting, filedAt));
    if (filedAt !== undefined && Date.parse(verified.createdAt) < Date.parse(filedAt))
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: `The user typed that before this request was filed, so it cannot approve it. ${waiting}`,
      });
    return {
      quote: verified.quote,
      threadId: verified.threadId,
      threadTitle: verified.threadTitle,
      model: verified.model,
      approvedAt: yield* now,
      ...(relay.forwarded === undefined
        ? {}
        : { sourceEnvironment: relay.forwarded.sourceEnvironment }),
    } satisfies ChampionRelayedApproval;
  });
  const list: ChampionService["Service"]["list"] = Effect.fn("ChampionService.list")(
    function* (input) {
      const rows =
        input.projectId === undefined
          ? yield* sql<{
              summary_json: string;
            }>`SELECT json_extract(document_json, '$.champion') AS summary_json FROM champions`.pipe(
              Effect.mapError(failure),
            )
          : yield* sql<{
              summary_json: string;
            }>`SELECT json_extract(document_json, '$.champion') AS summary_json FROM champions WHERE project_id = ${input.projectId}`.pipe(
              Effect.mapError(failure),
            );
      const at = yield* now;
      const modelDefaults = yield* readDefaults;
      return {
        modelDefaults,
        champions: yield* Effect.forEach(rows, (row) =>
          decodeSummary(row.summary_json).pipe(
            Effect.mapError(failure),
            Effect.map((summary) => ({
              ...summary,
              nextModels: ChampionModels.nextModels(modelDefaults, summary.models),
              latestSamples: summary.latestSamples?.map((sample) =>
                sample.staleAt !== null &&
                at >= sample.staleAt &&
                (sample.health === "healthy" || sample.health === "breached")
                  ? { ...sample, health: "stale" as const }
                  : sample,
              ),
            })),
          ),
        ),
      };
    },
  );
  const validateModel = Effect.fn("ChampionService.validateModel")(function* (
    selection: ModelSelection,
  ) {
    const provider = (yield* providers.getProviders).find(
      (p) => p.instanceId === selection.instanceId,
    );
    if (
      provider === undefined ||
      provider.enabled === false ||
      provider.installed === false ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.availability === "unavailable" ||
      !provider.models.some((m) => m.slug === selection.model)
    )
      return yield* new ChampionError({ reason: "invalid" });
    // Usage is judged once, by ChampionModels through the shared evaluator.
    const descriptors = provider.models.find((m) => m.slug === selection.model)?.capabilities
      ?.optionDescriptors;
    if (invalidOptionSelections(selection.options ?? [], descriptors).length > 0)
      return yield* new ChampionError({ reason: "invalid" });
  });
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const decodeDefaults = Schema.decodeEffect(Schema.fromJsonString(ChampionModelDefaultsSchema));
  const readDefaults: Effect.Effect<ChampionModelDefaults, ChampionError> = Effect.gen(
    function* () {
      const rows = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM champion_model_defaults WHERE id = 1`;
      return rows[0] === undefined ? {} : yield* decodeDefaults(rows[0].document_json);
    },
  ).pipe(Effect.mapError(failure));
  const accountAvailability = yield* Effect.serviceOption(AccountAvailability.AccountAvailability);
  const modelSource = Effect.gen(function* () {
    const settings: ChampionModels.ModelSource["settings"] = Option.isSome(serverSettings)
      ? yield* serverSettings.value.getSettings.pipe(Effect.orElseSucceed(() => ({})))
      : {};
    return {
      providers: yield* providers.getProviders,
      settings,
      blocks: Option.isSome(accountAvailability)
        ? (yield* accountAvailability.value.state).blocks
        : [],
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    } satisfies ChampionModels.ModelSource;
  });
  const setModels: ChampionService["Service"]["setModels"] = Effect.fn("ChampionService.setModels")(
    function* (input) {
      const source = yield* modelSource;
      for (const slot of [input.checks, input.advice])
        for (const model of [slot?.model, slot?.backup])
          if (model !== undefined && ChampionModels.assess(model, source).status === "missing")
            return yield* new ChampionError({
              reason: "invalid",
              detail: "That model is not available on this machine.",
            });
      const defaults: ChampionModelDefaults = {
        ...(input.checks === undefined ? {} : { checks: input.checks }),
        ...(input.advice === undefined ? {} : { advice: input.advice }),
      };
      yield* mutate(
        sql`INSERT INTO champion_model_defaults (id, document_json) VALUES (1, ${json(defaults)}) ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json`.pipe(
          Effect.mapError(failure),
          Effect.tap(() =>
            Effect.gen(function* () {
              const batch = yield* ChangeBatch;
              if (batch !== undefined) batch.changed = true;
            }),
          ),
        ),
      );
      return defaults;
    },
  );
  /** The slot a run of this kind uses, or why there is none. */
  const slotOf = Effect.fn("ChampionService.slotOf")(function* (
    doc: Pick<Document, "champion">,
    kind: ChampionModels.ChampionModelKind,
  ) {
    return ChampionModels.slotFor(kind, yield* readDefaults, doc.champion.models);
  });
  const nextDueOf = Effect.fn("ChampionService.nextDueOf")(function* (schedule: ChampionSchedule) {
    const next = nextScheduledRunAt(schedule, yield* DateTime.now);
    return next === null ? null : DateTime.formatIso(next);
  });
  const nextDue = (config: ChampionConfig) => nextDueOf(config.schedule);
  /** The Monday times other Champions' reviews start at, so a new default lands apart from them. */
  const reviewTimesBesides = Effect.fn("ChampionService.reviewTimesBesides")(function* (
    id: string,
  ) {
    const rows = yield* sql<{
      summary_json: string;
    }>`SELECT json_extract(document_json, '$.champion') AS summary_json FROM champions WHERE id != ${id}`;
    const times: string[] = [];
    for (const row of rows) {
      const other = yield* decodeSummary(row.summary_json);
      const schedule = reviewScheduleOf(other);
      if (
        schedule.type === "fixed_time" &&
        (schedule.weekdays === undefined ||
          schedule.weekdays.length === 0 ||
          schedule.weekdays.includes(1))
      )
        times.push(schedule.timeOfDay);
    }
    return times;
  }, Effect.mapError(failure));
  /** The goal-score series, newest first. */
  const goalScoresOf = Effect.fn("ChampionService.goalScoresOf")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE champion_id = ${id} AND status = 'reported' AND json_extract(document_json, '$.goalScore') IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 20`;
    const scores: ChampionGoalScore[] = [];
    for (const row of rows) {
      const check = yield* decodeCheck(row.document_json);
      if (check.goalScore !== undefined) scores.push(check.goalScore);
    }
    return scores;
  }, Effect.mapError(failure));
  const get: ChampionService["Service"]["get"] = Effect.fn("ChampionService.get")(function* ({
    id,
  }) {
    const doc = yield* read(id);
    const latestSamples = presentLatest(doc, yield* now);
    const nextModels = ChampionModels.nextModels(yield* readDefaults, doc.champion.models);
    const { folderFiles: _files, ...detail } = doc;
    return {
      ...detail,
      champion: { ...doc.champion, latestSamples, nextModels },
      latestSamples,
      goalScores: yield* goalScoresOf(id),
    };
  });
  const resolveRankedClass = Effect.fn("ChampionService.resolveRankedClass")(function* (
    projectId: ChampionConfig["projectId"],
    taskClass: AgentTaskRequest["taskClass"],
    role: AgentTaskRequest["role"],
    threadId?: ThreadId | null,
  ) {
    if (Option.isNone(managedAgents)) return yield* new ChampionError({ reason: "unavailable" });
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({ projectId, instanceId: provider.instanceId }),
    );
    const owner =
      threadId == null
        ? null
        : yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
    const ceiling = owner?.runtimeMode ?? "full-access";
    const request = { taskClass, runtimeMode: ceiling };
    const [selection] = yield* managedAgents.value
      .ranked({ projectId, providers: enabled, ceiling, request, role })
      .pipe(Effect.mapError(failure));
    if (selection === undefined)
      return { selection: null, refusal: "No eligible model is available." };
    const result = yield* managedAgents.value
      .roles({ projectId, providers: enabled, ceiling, request, selection })
      .pipe(Effect.mapError(failure));
    const selected = result.roles.find((entry) => entry.role === role);
    if (selected?.selection == null || selected.refusal !== null)
      return { selection: null, refusal: selected?.refusal ?? "No eligible model is available." };
    yield* validateModel(selected.selection);
    return {
      selection: selected.selection,
      refusal: null,
      policyHash: result.policyHash,
      policyRevision: result.policyRevision,
    };
  });
  const upsert: ChampionService["Service"]["upsert"] = Effect.fn("ChampionService.upsert")(
    function* (input) {
      if (Option.isNone(yield* projects.getById(input.projectId).pipe(Effect.mapError(failure))))
        return yield* new ChampionError({ reason: "not-found" });
      const priorConfig = yield* read(input.id).pipe(Effect.option);
      const hosted = Option.isSome(priorConfig)
        ? hostedRefusal(priorConfig.value.champion, "definition")
        : null;
      if (hosted !== null) return yield* hosted;
      const source = yield* modelSource;
      for (const model of [input.models?.checks, input.models?.advice])
        if (model !== undefined && ChampionModels.assess(model, source).status === "missing")
          return yield* new ChampionError({
            reason: "invalid",
            detail: "That model is not available on this machine.",
          });
      return yield* mutate(
        Effect.gen(function* () {
          const existing = yield* sql<{
            document_json: string;
          }>`SELECT document_json FROM champions WHERE id = ${input.id}`.pipe(
            Effect.mapError(failure),
          );
          const prior =
            existing[0] === undefined
              ? undefined
              : yield* decodeDocument(existing[0].document_json).pipe(Effect.mapError(failure));
          if (prior !== undefined && prior.champion.projectId !== input.projectId)
            return yield* new ChampionError({ reason: "invalid" });
          const doc: Document =
            prior === undefined
              ? {
                  champion: {
                    ...input,
                    lifecycle: "paused",
                    ownerThreadId: ThreadId.make(yield* uuid),
                    setupThreadId: null,
                    nextCheckAt: null,
                    lastCheckAt: null,
                    outstandingCheckId: null,
                    outstandingSetupId: null,
                    attention: [NEEDS_METRICS],
                    openFindingCount: 0,
                    updatedAt: yield* now,
                  },
                  metrics: [],
                  findings: [],
                }
              : {
                  ...prior,
                  champion: {
                    ...prior.champion,
                    ...input,
                    // Omitting `models` keeps the override; an empty object clears it.
                    models:
                      input.models === undefined
                        ? prior.champion.models
                        : input.models.checks === undefined && input.models.advice === undefined
                          ? undefined
                          : input.models,
                    nextCheckAt:
                      prior.champion.lifecycle === "active"
                        ? isSameSchedule(prior.champion.schedule, input.schedule)
                          ? prior.champion.nextCheckAt
                          : yield* nextDue(input)
                        : null,
                  },
                };
          const saved = yield* write(doc);
          yield* activity(
            input.id,
            "configuration",
            prior === undefined ? "Champion draft created." : "Champion configuration updated.",
          );
          return saved;
        }),
      );
    },
  );
  const setLifecycle: ChampionService["Service"]["setLifecycle"] = Effect.fn(
    "ChampionService.setLifecycle",
  )(function* (input) {
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        if (input.lifecycle === "active" && doc.metrics.length === 0)
          return yield* new ChampionError({ reason: "invalid" });
        const saved = yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            lifecycle: input.lifecycle,
            nextCheckAt: input.lifecycle === "active" ? yield* nextDue(doc.champion) : null,
          },
        });
        yield* activity(
          input.id,
          "lifecycle",
          `Champion ${input.lifecycle}. In-flight work continues.`,
        );
        return saved;
      }),
    );
  });
  const saveCheck = Effect.fn("ChampionService.saveCheck")(function* (check: Check) {
    yield* sql`INSERT INTO champion_checks (id, champion_id, thread_id, message_id, started_at, status, document_json)
      VALUES (${check.id}, ${check.championId}, ${check.threadId}, ${check.messageId}, ${check.startedAt}, ${check.cancelled ? "cancelled" : check.reported ? "reported" : "pending"}, ${yield* encodeCheck(check)})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, message_id = excluded.message_id, document_json = excluded.document_json`;
  }, Effect.mapError(failure));
  const readCheck = Effect.fn("ChampionService.readCheck")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (!rows[0]) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure));
  });
  /** Every run's rules, ahead of the Champion's own instructions, which they override. */
  const OBSERVE_ONLY_RULES = `OBSERVE ONLY. These rules override every other instruction, this champion's own included. ${CASE_FLOW_REFUSAL} Never edit code or files in the project: read and measure in its main checkout without changing it. This owner thread carries only readings and goal reviews, and each run after the first starts from a clean context, so depend on nothing an earlier run said; read what you need with t3_champions_get and t3_champions_history.`;
  const ownInstructions = (doc: Document) =>
    `This champion's own instructions, which the observe-only rules above override: ${doc.champion.charter.instructions}`;
  const openFindingsLine = (doc: Document) =>
    `Open findings (supply existingFindingId to update one rather than paraphrasing it; each already has its case): ${JSON.stringify(doc.findings.filter((f) => !settled(f)).map(({ id, title, metricId }) => ({ id, title, metricId })))}`;
  const journeyPrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      CHAMPION_MODELS_GUIDANCE,
      ...(hostedGuidance(doc.champion) === null ? [] : [hostedGuidance(doc.champion)]),
      OBSERVE_ONLY_RULES,
      `Check claim: ${check.id}. YOU FIND AND REPORT BUGS. YOU DO NOT REPAIR. This overrides any other instruction: no repairs, no worktrees, no source edits and no reading the target's source, even if a bug looks easy to fix.  Each confirmed finding opens a case in Henry's Inbox, where an agent repairs it; your re-test still settles it.`,
      "1. Call t3_champions_check_context, then t3_champions_learning_search with this champion's id for what past checks covered. Then call t3_champions_journeys_start: it starts the target and returns its shards, the most journeys this check may run, the paths earlier checks already walked, the source files changed since, and bugs to re-test, which you replay first, by findingId, under step 5. If it says the check is deferred or refused, report that no journey ran; do not work around it.",
      "2. Survey before you choose: open your tabs, one per area in the sidebar first, and call browser_snapshot on each. Read the links and buttons inside each page's main content, not the sidebar, then open and snapshot the pages those links lead to as well, so you have seen two levels. Name in each goal the links it should follow, as the snapshot shows them, and spend no journey on a feature that needs a real model, voice or outbound service, since this contained copy has none. Then choose journeys a real person might take and break. At least half must start on, or pass through, a page or control you found only this way, and a page reached only from inside another page gets at least two journeys, since nobody else will go there. No two journeys may share a start and a goal, on any shard: a shard is capacity, not a reason to repeat a path. A shard may carry a locale and workPaths: give each journey that changes data its own workPath, and never run two journeys on the same workPath at once; give a journey on a shard with a locale, such as pt-BR, the goal of reading its screens for English left behind, judged from what the screen shows. Include journeys a real person takes that goal-driven clicking misses: dragging an element between lanes, a phone-width journey opened with a narrow viewport, and a keyboard-only journey of key presses with no clicks, checking which element holds focus. Prefer areas no earlier check covered and areas that recently changed; past coverage is a list to avoid, so never reuse a goal from a learning unless it is a re-test. Every goal is an attack of at least three steps, never a visit, and across the check cover each kind of break: searches and filters given unusual input such as ( [ % or a very long value; a draft started, then a link followed away and back, checking the draft survived; a multi-step flow taken to its very last button, checking that button can be used; empty submits and double submits. Never ask a goal to report: the task's model reads each page for you. Never name or assume a bug you have not seen.",
      "3. Run them all at once, spread evenly across the shards, never one shard at a time: the check is measured on how many overlap. In ONE message issue one browser_open per journey with url = the shard's origin + its signInPath (add next=<path> for where it starts). Then in ONE message issue one browser_task per tab, each with a goal, pageReach: {}, a limit of decisions from the plan, a binding for every value it must type, since a goal cannot type without one, and checks that can pass only at the journey's end, such as text the finished task must show. A task that takes no action counts as testing nothing, so give each goal something to do, never use a bare url check, and do not fall back to scripted steps. A journey that must run at one width opens with browser_open viewport { width, height } and stays at it; its replay will repeat that width. Put the plan's full journeyLimit, every shard's journeys together, in those two messages: a check that started fewer, or started them in smaller batches, has not done its job. One tab is one journey, and more tasks in the same tab continue it. The server records every journey, its clicks and its timing. Your browsers can reach only the shards. Close each tab when its journey ends.",
      "4. A journey that shows an error page, a dead end, lost work or anything a person would call broken is a candidate: call t3_champions_journey_candidate with its tabId, what should have happened and what did. A task that ends with reason page-broken always is: what should have happened comes from its goal, and what did from its detail. That tells nobody. Do not judge whether it is real; a stronger model decides. If a journey only stalled on a limit or a slow page, it is not a candidate.",
      "5. For every candidate, and for every re-test the plan names, call t3_champions_candidate_replay, and once more for one that settles inconclusive. It starts a fresh database and returns workId, attemptId and a brief. Call delegate_task with agentTask {role: browser, taskClass: non-ui, readOnly: true, browser: {backend: integrated}, workId, attemptId, workspacePath: your workspace} and mode wait, and task = the brief, unchanged; any other task is refused, and so is a follow-up. At most four replays run at once: when a call says so, settle one and go on. When each finishes call t3_champions_candidate_settle: the server reads that agent's verdict itself; what you say about it does not count. Only a confirmed candidate becomes a finding.",
      "6. Retain what you covered and under which build with t3_champions_record_learning, plainSummary first.",
      "7. Call t3_champions_report with samples for each frozen metric, findings: [] (the server raises findings from confirmed candidates; never file one yourself), journeys: {started, passed, failed, stopped} counted honestly from your results, and a summary. The server compares your counts with its own and marks the check incomplete if they differ or if a shard stopped. Report plainly a check that could not finish, or that found nothing, with the paths it covered.",
      `Open findings, whose steps t3_champions_journeys_start returns as re-tests: ${JSON.stringify(doc.findings.filter((f) => f.status !== "verified" && f.status !== "dismissed").map(({ id, title }) => ({ id, title })))}.`,
      ownInstructions(doc),
    ].join("\n\n");
  const setupPrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      CHAMPION_MODELS_GUIDANCE,
      hostedGuidance(doc.champion),
      OBSERVE_ONLY_RULES,
      `SETUP (claim ${check.id}): inspect the actual product and set measurable metrics that show progress towards the goal with t3_champions_metrics action submit, or call t3_champions_report with only a summary for a no-change summary. Name each metric in plain words someone outside engineering understands ("How long common screens take to become usable", not "Sentinel usable readiness"), and start its description with one plain sentence on what it tells the user about the goal; method detail follows. Renaming or rewording a metric keeps its series, so fix unclear names on any setup. A metric whose direction is higher or lower may carry alarm, a value beyond its target that starts a case at once. ${METRIC_RULE}`,
      ownInstructions(doc),
    ]
      .filter((line) => line !== null)
      .join("\n\n");
  const readingsPrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      CHAMPION_MODELS_GUIDANCE,
      hostedGuidance(doc.champion),
      OBSERVE_ONLY_RULES,
      `READINGS (claim ${check.id}): measure what no script can. Definitions were frozen when this run started. Call t3_champions_check_context: metrics lists what you measure; collected holds what the server already read by command. Then call t3_champions_report with a sample for each metric it lists, qualitative findings only for something new that needs work, and a summary of what you observed. Do not score the goal or review it: the goal review does that, and a readings report carrying goalScore is refused. ${check.measureOnly ? "This champion is paused: measure only." : ""}`,
      check.metrics.some((m) => m.collect !== undefined)
        ? "Never measure or report a collected metric, including one whose collection failed; say in your summary what a failed collection needs."
        : null,
      "Follow each frozen metric method. Copy metricId, version, unit and source verbatim from t3_champions_check_context; never paraphrase source. Put actual execution commands, paths and collection details in evidence. If collection fails, report value null with status error and explain why; never invent a numeric value, report stale readings as healthy or disguise a source change as improvement.",
      `Findings are a work queue (at most ${MAX_OPEN_FINDINGS} open), not a progress journal: the server raises metric breaches itself, and each finding opens a case an agent will work, so open one only for something that needs work. Start its evidence with one plain sentence naming the problem and its effect; raw numbers and commands follow.`,
      `When a metric cannot show progress (blank, insufficient, or measuring the wrong thing), say so and change it with t3_champions_metrics action submit. ${METRIC_RULE}`,
      "Work for genuine improvement, not metric gaming or rule compliance; you may challenge existing designs. Never fabricate baselines, report stale readings as healthy, or disguise a source change as improvement.",
      CHAMPION_MEASUREMENT_GUIDANCE,
      openFindingsLine(doc),
      ownInstructions(doc),
    ]
      .filter((line) => line !== null)
      .join("\n\n");
  const reviewPrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      CHAMPION_MODELS_GUIDANCE,
      hostedGuidance(doc.champion),
      OBSERVE_ONLY_RULES,
      `GOAL REVIEW (claim ${check.id}): attack the goal. You do not measure: readings are taken separately, so read them with t3_champions_get and their trends with t3_champions_history. Name the angles you considered (for example reliability, performance, security, tests, user experience, docs and operations, as they apply to this goal) and, for each, read the relevant code and docs in the project's main checkout and its recent changes, as well as the readings. Look for what is weak, untested, fragile or could be better, not just for breaches.`,
      `Then call t3_champions_report with goalScore: score, a whole number from 0 to 10 for how well the area meets the whole goal, covering both keeping things working and improving them; reasons, the main reasons the score is not higher; change, what changed since the previous score, citing readings. Add a finding for each weakness or opportunity that needs work (it opens a case), samples: [], and a summary that opens with the angles you considered. Previous score: ${doc.champion.goalScore === undefined ? "none yet" : `${doc.champion.goalScore.score}/10 at ${doc.champion.goalScore.at}: ${doc.champion.goalScore.reasons}`}. Target: ${goalTargetOf(doc.champion)}; a score below it opens the goal finding.`,
      `LEARNING REVIEW: call t3_champions_learning_search with championId ${doc.champion.id} and filter needs-review. For each learning another agent contributed, check it: confirm it with t3_champions_confirm_learning, or supersede it with t3_champions_record_learning (expectedCurrentId its revision) and a reason. Give each learning with no plain sentence one with t3_champions_confirm_learning action note. Keep this champion's learnings short and operational (at most about 15 notes on measurement quirks, false positives or run mechanics); durable product or engineering knowledge belongs in the repository's docs, Decisions, AGENTS.md or tests.`,
      "Work for genuine improvement, not metric gaming or rule compliance; you may challenge existing designs. Never fabricate baselines, report stale readings as healthy, or disguise a source change as improvement.",
      `When a metric cannot show progress, change it with t3_champions_metrics action submit. ${METRIC_RULE}`,
      openFindingsLine(doc),
      ownInstructions(doc),
    ]
      .filter((line) => line !== null)
      .join("\n\n");
  const prompt = (doc: Document, check: Check) => {
    const body =
      check.kind === "setup"
        ? setupPrompt(doc, check)
        : check.kind === "review"
          ? reviewPrompt(doc, check)
          : doc.champion.journeys !== undefined
            ? journeyPrompt(doc, check)
            : readingsPrompt(doc, check);
    return check.repromptMessageId === check.messageId
      ? `${missingReportReminder(check)}\n\n${body}`
      : body;
  };
  /**
   * The model an attempt runs on, resolved now: the main model, else the backup. With neither able to run it fails
   * with the skip message, which the caller records.
   */
  const resolveAttempt = Effect.fn("ChampionService.resolveAttempt")(function* (
    doc: Document,
    check: Pick<Check, "id" | "kind" | "threadId" | "messageId" | "commandId">,
    failed?: { readonly selection: ModelSelection; readonly until: string | null },
  ) {
    const slot = yield* slotOf(doc, slotKind(check.kind));
    if (slot === null)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: `${SKIPPED}${runWhat(check.kind)}: no Champion models are set. Choose them at the top of the Champions screen.`,
      });
    const source = yield* modelSource;
    const picked = ChampionModels.pickSlot(slot.slot, source, { failed });
    if (picked.use === null)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: ChampionModels.skipMessage({
          what: runWhat(check.kind),
          slot: slot.slot,
          assessed: picked,
          providers: source.providers,
          nextCheckAt:
            check.kind !== "check" || doc.champion.lifecycle !== "active"
              ? null
              : // A manual check leaves the scheduled time alone; a due one moves on from now.
                doc.champion.nextCheckAt !== null && doc.champion.nextCheckAt > (yield* now)
                ? doc.champion.nextCheckAt
                : yield* nextDue(doc.champion),
        }),
      });
    const attempt: ChampionExecutionAttempt = {
      id: yield* uuid,
      checkId: check.id,
      kind: check.kind,
      slot: picked.use.slot,
      resolvedSelection: picked.use.selection,
      actualSelection: null,
      commandId: check.commandId,
      messageId: check.messageId,
      threadId: check.threadId,
      acceptedAt: yield* now,
    };
    yield* sql`INSERT INTO champion_execution_attempts (id,champion_id,check_id,at,document_json) VALUES (${attempt.id},${doc.champion.id},${check.id},${attempt.acceptedAt},${json(attempt)})`.pipe(
      Effect.mapError(failure),
    );
    return attempt;
  });
  const dispatchCheck = Effect.fn("ChampionService.dispatchCheck")(function* (claimed: Check) {
    const doc = yield* read(claimed.championId);
    if ((yield* readCheck(claimed.id)).cancelled) return;
    let check = claimed;
    // A claim made while no model could run (only a check the server might finish itself is claimed so) gets its
    // model now, or ends as skipped, so it never retries a dispatch that cannot succeed.
    if (check.executionAttempt === undefined) {
      const resolved = yield* resolveAttempt(doc, check).pipe(Effect.result);
      if (resolved._tag === "Failure") {
        const detail = resolved.failure.detail;
        if (resolved.failure.reason === "unavailable" && detail?.startsWith(SKIPPED))
          return yield* recordSkip({
            id: check.championId,
            kind: check.kind,
            message: detail,
            advance: false,
            ended: check,
          });
        return yield* resolved.failure;
      }
      check = { ...check, executionAttempt: resolved.success };
      yield* mutate(
        saveCheck({ ...(yield* readCheck(check.id)), executionAttempt: resolved.success }),
      );
    }
    if (check.executionAttempt === undefined)
      return yield* new ChampionError({ reason: "unavailable" });
    const modelSelection = check.executionAttempt.resolvedSelection;
    yield* validateModel(modelSelection);
    const existing = yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure));
    const commandId = check.commandId;
    const allowed = yield* mutate(
      Effect.gen(function* () {
        const current = yield* readCheck(check.id);
        if (current.cancelled) return false;
        yield* saveCheck({ ...current, launchStarted: true });
        return true;
      }),
    );
    if (!allowed) return;
    if (check.dispatchKind === "launch") {
      yield* launch
        .launch({
          commandId,
          threadId: check.threadId,
          projectId: doc.champion.projectId,
          title: `${check.kind === "setup" ? "Set up" : "Champion:"} ${doc.champion.name}`,
          // Checks and cases launch in the project's main checkout; only work that changes code allocates a workspace.
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: check.messageId, text: prompt(doc, check), attachments: [] },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    } else {
      if (
        existing === null ||
        existing.deletedAt !== null ||
        existing.archivedAt !== null ||
        existing.projectId !== doc.champion.projectId
      )
        return yield* new ChampionError({ reason: "conflict" });
      yield* threads
        .sendToThread({
          commandId,
          threadId: check.threadId,
          projectId: doc.champion.projectId,
          messageId: check.messageId,
          text: prompt(doc, check),
          attachments: [],
          modelSelection,
          mode: "queue",
          // Every readings run and review after the first starts clean: stale history overrode later prompts.
          ...(check.kind === "setup" ? {} : { freshContext: true }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    }
    if (check.kind !== "setup" && check.dispatchKind === "launch") {
      yield* threads
        .dispatch({
          type: "thread.compact-at.set",
          commandId: CommandId.make(`champion:${check.id}:compaction`),
          threadId: check.threadId,
          compactAt: null,
        })
        .pipe(Effect.mapError(failure));
    }
    yield* mutate(
      Effect.gen(function* () {
        const current = yield* readCheck(check.id);
        yield* saveCheck({ ...current, dispatched: true });
      }),
    );
  });
  /** A run no model could take is a skipped check: said plainly, never a passing one, and the next one starts on time. */
  const recordSkip = Effect.fn("ChampionService.recordSkip")(function* (input: {
    readonly id: string;
    readonly kind: Check["kind"];
    readonly message: string;
    readonly advance: boolean;
    readonly ended?: Check | undefined;
  }) {
    yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        if (input.ended !== undefined) {
          const latest = yield* readCheck(input.ended.id);
          if (latest.reported || latest.cancelled || latest.messageId !== input.ended.messageId)
            return;
          yield* saveCheck({ ...latest, cancelled: true, skipped: input.message });
        }
        const ended = (line: string) =>
          line.startsWith(`${SKIPPED}${runWhat(input.kind)}`) ||
          line.startsWith(`${runLabel(input.kind)} dispatch unavailable.`) ||
          line.startsWith(`${runLabel(input.kind)} run ended without`);
        const advanced = input.advance && doc.champion.lifecycle === "active";
        yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            ...(input.ended === undefined ? {} : { [outstandingField(input.kind)]: null }),
            nextCheckAt:
              advanced && input.kind === "check"
                ? yield* nextDue(doc.champion)
                : doc.champion.nextCheckAt,
            nextReviewAt:
              advanced && input.kind === "review"
                ? yield* nextDueOf(reviewScheduleOf(doc.champion))
                : doc.champion.nextReviewAt,
            // A skip (no model could take the run) is not a failed check: it never makes a Champion stuck.
            attention: [...doc.champion.attention.filter((line) => !ended(line)), input.message],
          },
        });
        yield* activity(input.id, "check-skipped", input.message, undefined, input.ended?.threadId);
      }),
    ).pipe(Effect.ignore);
  });
  const start = Effect.fn("ChampionService.start")(function* (
    id: string,
    kind: Check["kind"],
    scheduled = false,
    automatic = false,
    afterLimit: { readonly until: string | null } | undefined = undefined,
    reprompt = false,
  ) {
    if (kind === "check") {
      const champion = (yield* read(id)).champion;
      if (champion.journeys !== undefined) {
        const reason = journeys.overLoadLimit(champion.journeys);
        if (reason !== null) {
          if (scheduled)
            yield* mutate(
              Effect.gen(function* () {
                const doc = yield* read(id);
                yield* write({
                  ...doc,
                  champion: {
                    ...doc.champion,
                    nextCheckAt: DateTime.formatIso(
                      DateTime.add(yield* DateTime.now, { minutes: JOURNEY_DEFER_MINUTES }),
                    ) as typeof doc.champion.nextCheckAt,
                  },
                });
              }),
            );
          return yield* new ChampionError({
            reason: "conflict",
            detail: `Check deferred: ${reason}`,
          });
        }
      }
    }
    const claim = yield* mutate(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const doc = yield* read(id);
            if (!runsHere(doc.champion)) return yield* runsElsewhere(doc.champion);
            if (
              doc.champion.lifecycle === "retired" ||
              (scheduled && doc.champion.lifecycle !== "active")
            )
              return yield* new ChampionError({ reason: "conflict" });
            const outstandingId = outstandingOf(doc.champion, kind);
            // A journey record is one run of one target; a second would blend into its counts.
            const spentJourneyCheck =
              kind === "check" && outstandingId !== null && doc.champion.journeys !== undefined
                ? yield* journeys.readRecord(outstandingId).pipe(
                    Effect.mapError(failure),
                    Effect.map(
                      (stored) => stored !== undefined && stored.record.status !== "running",
                    ),
                  )
                : false;
            if (spentJourneyCheck)
              yield* saveCheck({ ...(yield* readCheck(outstandingId!)), cancelled: true });
            let superseded = false;
            if (outstandingId !== null && !spentJourneyCheck) {
              const outstanding = yield* readCheck(outstandingId);
              if (outstanding.kind !== kind)
                return yield* new ChampionError({ reason: "conflict" });
              if (!scheduled && outstanding.dispatched) {
                const shell = yield* threads
                  .getThreadShell(outstanding.threadId)
                  .pipe(Effect.mapError(failure));
                const records =
                  shell === null
                    ? undefined
                    : yield* threads
                        .getThreadRecords(outstanding.threadId, ["runs"])
                        .pipe(Effect.mapError(failure));
                const runsById = new Map(records?.runs.map((run) => [run.id, run]));
                const acceptedPending =
                  records?.runs.some(
                    (run) =>
                      checkRunMessages(run, runsById).includes(outstanding.messageId) &&
                      !ThreadManagement.isTerminalRunStatus(run.status),
                  ) ?? false;
                const automaticRetries =
                  (outstanding.automaticRetries ?? 0) + (automatic && !reprompt ? 1 : 0);
                // A claim keeps the definitions it froze, so retrying one made before they changed
                // would measure what is no longer accepted, and never by command.
                superseded =
                  kind === "check" &&
                  !automatic &&
                  !acceptedPending &&
                  (shell === null || shell.activeRunId === null) &&
                  (outstanding.metrics.length !== doc.metrics.length ||
                    outstanding.metrics.some(
                      (frozen) =>
                        doc.metrics.find((metric) => metric.id === frozen.id)?.version !==
                        frozen.version,
                    ));
                if (superseded) {
                  yield* saveCheck({ ...outstanding, cancelled: true });
                  yield* activity(
                    id,
                    "check-superseded",
                    "The outstanding check was claimed before the accepted metrics changed and its run had ended, so a new check starts on the current definitions.",
                    undefined,
                    outstanding.threadId,
                  );
                } else if (
                  shell !== null &&
                  shell.activeRunId === null &&
                  !acceptedPending &&
                  shell.deletedAt === null &&
                  shell.archivedAt === null &&
                  automaticRetries <= MAX_AUTOMATIC_CHECK_RETRIES
                ) {
                  const retryId = yield* uuid;
                  let retry: Check = {
                    ...outstanding,
                    automaticRetries,
                    ...(reprompt
                      ? {
                          repromptMessageId: MessageId.make(
                            `champion:${outstanding.id}:retry:${retryId}`,
                          ),
                        }
                      : {}),
                    failureCounted: false,
                    dispatchKind: "send",
                    dispatched: false,
                    launchStarted: false,
                    commandId: CommandId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    messageId: MessageId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    measureOnly: outstanding.measureOnly || doc.champion.lifecycle !== "active",
                  };
                  retry = {
                    ...retry,
                    executionAttempt: yield* resolveAttempt(
                      doc,
                      retry,
                      afterLimit === undefined || outstanding.executionAttempt === undefined
                        ? undefined
                        : {
                            selection: outstanding.executionAttempt.resolvedSelection,
                            until: afterLimit.until,
                          },
                    ),
                  };
                  yield* saveCheck(retry);
                  yield* write({
                    ...doc,
                    champion: {
                      ...doc.champion,
                      attention: doc.champion.attention.filter(
                        (attention) =>
                          !attention.startsWith(
                            `${runLabel(kind)} run ended without an authenticated report.`,
                          ) && !attention.startsWith(`${runLabel(kind)} automatic retr`),
                      ),
                    },
                  });
                  yield* activity(
                    id,
                    "check-retry",
                    reprompt
                      ? `The ${runWhat(kind)} run ended without an authenticated report, so the server asked the owner once more to report it.`
                      : automatic
                        ? afterLimit === undefined
                          ? `The provider was overloaded, so the server retried the ${runWhat(kind)}. The retry retains its definitions and owner.`
                          : `The model reached its usage limit, so the server retried the ${runWhat(kind)} once on ${retry.executionAttempt?.slot === "backup" ? "the backup model" : "another account of the main model"}. The retry retains its definitions and owner.`
                        : `The previous ${runWhat(kind)} run ended without an authenticated report. A manual retry retains its definitions and owner.`,
                    undefined,
                    retry.threadId,
                  );
                  return retry;
                }
              }
              if (!superseded) return outstanding;
            }
            // A journey check's evidence is what the server records; a paused one only measures.
            const journeysWhilePaused =
              doc.champion.journeys !== undefined && doc.champion.lifecycle !== "active";
            if (kind === "check" && doc.metrics.length === 0 && !journeysWhilePaused)
              return yield* new ChampionError({ reason: "invalid" });
            const checkId = yield* uuid;
            const setupThreadId = doc.champion.setupThreadId ?? ThreadId.make(yield* uuid);
            const threadId = kind === "setup" ? setupThreadId : doc.champion.ownerThreadId;
            // A readings run and a review may be claimed together before the owner thread exists:
            // only one launches it, and the other queues on it.
            const otherLaunch =
              kind === "setup"
                ? false
                : yield* Effect.gen(function* () {
                    const otherId = outstandingOf(
                      doc.champion,
                      kind === "check" ? "review" : "check",
                    );
                    if (otherId === null) return false;
                    const other = yield* readCheck(otherId);
                    return !other.reported && !other.cancelled && other.dispatchKind === "launch";
                  });
            let check: Check = {
              id: checkId,
              championId: id,
              threadId,
              dispatchKind:
                !otherLaunch &&
                (yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure))) === null
                  ? "launch"
                  : "send",
              messageId: MessageId.make(`champion:${checkId}`),
              commandId: CommandId.make(`champion:${checkId}`),
              kind,
              startedAt: yield* now,
              measureOnly: kind === "setup" || doc.champion.lifecycle !== "active",
              metrics: doc.metrics,
              reported: false,
              dispatched: false,
            };
            // A check the server may finish by itself is not refused for want of a model.
            const attempt = yield* resolveAttempt(doc, check).pipe(
              Effect.catchIf(
                (error) => error.reason === "unavailable" && collectsEverything(doc, check),
                () => Effect.undefined,
              ),
            );
            if (attempt !== undefined) check = { ...check, executionAttempt: attempt };
            yield* saveCheck(check);
            yield* write({
              ...doc,
              champion: {
                ...doc.champion,
                setupThreadId: kind === "setup" ? setupThreadId : doc.champion.setupThreadId,
                attention: doc.champion.attention.filter(
                  (line) =>
                    !line.startsWith(`${SKIPPED}${runWhat(kind)}`) &&
                    !line.startsWith(`${runLabel(kind)} dispatch unavailable.`),
                ),
                [outstandingField(kind)]: checkId,
                nextCheckAt:
                  kind !== "check"
                    ? doc.champion.nextCheckAt
                    : doc.champion.lifecycle === "active"
                      ? yield* nextDue(doc.champion)
                      : null,
                nextReviewAt:
                  kind !== "review"
                    ? doc.champion.nextReviewAt
                    : doc.champion.lifecycle === "active"
                      ? yield* nextDueOf(reviewScheduleOf(doc.champion))
                      : null,
              },
            });
            yield* activity(
              id,
              "check-started",
              `${kind === "setup" ? "Setup" : kind === "review" ? "Goal review" : "Readings run"} claimed. Awaiting authenticated report.`,
              undefined,
              check.threadId,
            );
            return check;
          }),
        )
        .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
    ).pipe(
      Effect.tapError((error) =>
        error.reason !== "unavailable" || !error.detail?.startsWith(SKIPPED)
          ? Effect.void
          : recordSkip({ id, kind, message: error.detail, advance: scheduled }),
      ),
    );
    yield* advance(claim);
    return yield* read(id);
  });
  /** Takes an undispatched claim as far as it goes without an agent, then starts one if it still needs one. */
  const advance = Effect.fn("ChampionService.advance")(function* (claim: Check) {
    const check = yield* collectCheck(claim);
    if (check.reported || check.cancelled || check.dispatched) return;
    yield* dispatchCheck(check).pipe(
      Effect.catch((error) =>
        mutate(
          Effect.gen(function* () {
            const doc = yield* read(check.championId);
            yield* write({
              ...doc,
              champion: {
                ...doc.champion,
                attention: [
                  ...new Set([
                    ...doc.champion.attention,
                    `${runLabel(check.kind)} dispatch unavailable. Retry uses the same durable claim and resolves its model again.`,
                  ]),
                ],
              },
            });
            yield* activity(
              check.championId,
              "dispatch-unavailable",
              error.message,
              undefined,
              check.threadId,
            );
          }),
        ),
      ),
    );
  });
  /** The metrics `input` leaves tracked, or why it cannot apply to `doc`. */
  const metricChangeResult = Effect.fn("ChampionService.metricChangeResult")(function* (
    doc: Document,
    input: ChampionMetricChange,
  ) {
    const retires = input.retires ?? [];
    const invalid = (detail?: string) =>
      new ChampionError({ reason: "invalid", ...(detail === undefined ? {} : { detail }) });
    if (
      new Set(input.metrics.map((m) => m.id)).size !== input.metrics.length ||
      new Set(retires).size !== retires.length
    )
      return yield* invalid();
    if (input.metrics.length === 0 && retires.length === 0)
      return yield* invalid(
        "The change does nothing: list each metric to add or change, or name a tracked metric in retires to stop tracking it.",
      );
    for (const metric of input.metrics)
      if (metric.minimum !== null && metric.maximum !== null && metric.minimum > metric.maximum)
        return yield* invalid();
    for (const retired of retires) {
      if (input.metrics.some((m) => m.id === retired))
        return yield* invalid(
          `${retired} is both listed and named in retires. List a metric to change it, or name it in retires to stop tracking it, not both.`,
        );
      if (!doc.metrics.some((m) => m.id === retired))
        return yield* invalid(
          `${retired} is not a tracked metric, so there is nothing to retire. Read the champion for its metric ids.`,
        );
    }
    const metrics = championMetricChangeResult(doc.metrics, input);
    if (metrics.length > CHAMPION_METRIC_LIMIT)
      return yield* invalid(
        `This would track ${metrics.length} metrics; a champion tracks at most ${CHAMPION_METRIC_LIMIT}. Name metrics to stop tracking in retires, or add fewer.`,
      );
    if (metrics.length === 0)
      return yield* invalid(
        "This would retire every metric; a champion keeps at least one. Add a replacement alongside the retirement.",
      );
    return metrics;
  });
  /** Reads each new or changed command once, so no change installs a metric its command cannot read. */
  const proveCommands = Effect.fn("ChampionService.proveCommands")(function* (
    doc: Document,
    input: ChampionMetricChange,
  ) {
    const commands = input.metrics.filter(
      (metric) =>
        metric.collect !== undefined &&
        JSON.stringify(doc.metrics.find((m) => m.id === metric.id)?.collect) !==
          JSON.stringify(metric.collect),
    );
    if (commands.length === 0) return new Map<string, number>();
    const project = yield* projects.getById(doc.champion.projectId).pipe(Effect.mapError(failure));
    if (Option.isNone(project)) return yield* new ChampionError({ reason: "not-found" });
    const root = project.value.workspaceRoot;
    const readings = yield* Effect.forEach(
      commands,
      (metric) => collectReading(processes, metric.collect!, root),
      { concurrency: "unbounded" },
    );
    const failed = commands.flatMap((metric, index) =>
      readings[index]!.value === null ? [`${metric.name}: ${readings[index]!.evidence}`] : [],
    );
    if (failed.length > 0)
      return yield* new ChampionError({
        reason: "invalid",
        detail: `Nothing changed. Each new or changed command must print its metric's value before the change applies. ${failed.join(" ")}`,
      });
    return new Map(commands.map((metric, index) => [metric.id, readings[index]!.value!]));
  });
  const changeMetrics: ChampionService["Service"]["changeMetrics"] = Effect.fn(
    "ChampionService.changeMetrics",
  )(function* (input, by, options) {
    const refused = hostedRefusal((yield* read(input.id)).champion, "metrics");
    if (refused !== null) return yield* refused;
    return yield* applyMetricChange(input, by, options);
  });
  const applyMetricChange: ChampionService["Service"]["changeMetrics"] = Effect.fn(
    "ChampionService.applyMetricChange",
  )(function* (input, by, options) {
    const before = yield* read(input.id);
    yield* metricChangeResult(before, input);
    for (const metric of input.metrics) {
      if (metric.alarm === undefined) continue;
      const beyond =
        metric.direction === "lower"
          ? metric.maximum === null || metric.alarm > metric.maximum
          : metric.direction === "higher"
            ? metric.minimum === null || metric.alarm < metric.minimum
            : false;
      if (!beyond)
        return yield* new ChampionError({
          reason: "invalid",
          detail: `${metric.name}: an alarm is a value beyond the target of a higher or lower metric (above its maximum for lower, below its minimum for higher); a range metric carries none.`,
        });
    }
    const readings =
      options?.prove === false ? new Map<string, number>() : yield* proveCommands(before, input);
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const resulting = yield* metricChangeResult(doc, input);
        const added: string[] = [];
        const changed: string[] = [];
        const alarmed: string[] = [];
        const metrics = yield* Effect.forEach(
          resulting,
          Effect.fn("ChampionService.installMetric")(function* (metric) {
            const current = doc.metrics.find((m) => m.id === metric.id);
            // An alarm value is no definition change: the version and the series stay.
            if (current !== undefined && sameDefinition(current, metric)) {
              if (current.alarm === metric.alarm) return current;
              alarmed.push(
                metric.alarm === undefined
                  ? `${metric.name} (no alarm)`
                  : `${metric.name} (alarm at ${metric.alarm} ${metric.unit})`,
              );
              return withAlarm(current, metric.alarm);
            }
            const reading = readings.get(metric.id);
            (current === undefined ? added : changed).push(
              reading === undefined
                ? metric.name
                : `${metric.name} (read ${reading} ${metric.unit} when added)`,
            );
            const stored = yield* sql<{
              version: number;
              document_json: string;
            }>`SELECT version, document_json FROM champion_metric_definitions WHERE champion_id = ${input.id} AND metric_id = ${metric.id} ORDER BY version DESC LIMIT 1`.pipe(
              Effect.mapError(failure),
            );
            const previous =
              current ??
              (stored[0] === undefined
                ? undefined
                : yield* decodeMetric(stored[0].document_json).pipe(Effect.mapError(failure)));
            const at = yield* now;
            const definition = {
              ...withAlarm(metricInputOf(metric), metric.alarm),
              version: (stored[0]?.version ?? 0) + 1,
              seriesId:
                previous !== undefined && sameSeries(previous, metric)
                  ? previous.seriesId
                  : yield* uuid,
              reason: input.reason,
              definedAt: at as NonNullable<ChampionMetric["definedAt"]>,
            };
            const json = yield* encodeMetric(definition).pipe(Effect.mapError(failure));
            yield* sql`INSERT INTO champion_metric_definitions (champion_id, metric_id, version, created_at, document_json) VALUES (${input.id}, ${metric.id}, ${definition.version}, ${at}, ${json})`.pipe(
              Effect.mapError(failure),
            );
            return definition;
          }),
        );
        const stopped = doc.metrics
          .filter((metric) => !metrics.some((m) => m.id === metric.id))
          .map((metric) => metric.name);
        const waiting = doc.champion.attention.filter((a) => !WAITING_FOR_METRICS.has(a));
        if (added.length + changed.length + stopped.length + alarmed.length === 0) return doc;
        const saved = yield* write({
          ...doc,
          metrics,
          champion: { ...doc.champion, attention: waiting },
        });
        const list = (label: string, names: ReadonlyArray<string>) =>
          names.length === 0 ? [] : [`${label} ${names.join(", ")}.`];
        yield* activity(
          input.id,
          "metrics-changed",
          [
            ...list("Added", added),
            ...list("Changed", changed),
            ...list("Alarms:", alarmed),
            ...list("Stopped tracking", stopped),
            input.reason,
          ].join(" "),
          undefined,
          by,
        );
        return saved;
      }),
    );
  });
  const authenticateLive = Effect.fn("ChampionService.authenticateLive")(function* (
    caller: Caller,
  ) {
    if (caller === undefined) return yield* new ChampionError({ reason: "unauthorized" });
    const credential = yield* mcpSessions.read(caller.threadId);
    if (
      credential === undefined ||
      credential.providerSessionId !== caller.providerSessionId ||
      credential.providerInstanceId !== caller.providerInstanceId
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    const shell = yield* threads.getThreadShell(caller.threadId).pipe(Effect.mapError(failure));
    if (
      shell === null ||
      shell.activeRunId === null ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    const records = yield* threads
      .getThreadRecords(caller.threadId, ["runs", "providerThreads"])
      .pipe(Effect.mapError(failure));
    const run = records.runs.find(
      (r) => r.id === shell.activeRunId && r.providerInstanceId === caller.providerInstanceId,
    );
    const providerThread = records.providerThreads.find(
      (p) => p.id === shell.activeProviderThreadId,
    );
    if (
      run === undefined ||
      !ThreadManagement.isActiveRun(run) ||
      providerThread === undefined ||
      run.providerThreadId !== providerThread.id
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    return { shell, run, runs: records.runs };
  });
  const authenticate = Effect.fn("ChampionService.authenticateCheck")(function* (caller: Caller) {
    const { shell, run, runs } = yield* authenticateLive(caller);
    const runsById = new Map(runs.map((candidate) => [candidate.id, candidate]));
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE thread_id = ${shell.id} AND message_id IN ${sql.in(checkRunMessages(run, runsById))}`.pipe(
      Effect.mapError(failure),
    );
    // A journey check's owner waits for replays, and each wakes it in a run its check message did not start.
    const journeyCheckId =
      rows[0] === undefined
        ? yield* journeys.latestCheckOf(shell.id).pipe(Effect.mapError(failure))
        : undefined;
    if (!rows[0] && journeyCheckId === undefined)
      return yield* new ChampionError({ reason: "unauthorized" });
    const check = rows[0]
      ? yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure))
      : yield* readCheck(journeyCheckId!);
    if (!rows[0] && check.reported) return yield* new ChampionError({ reason: "unauthorized" });
    if (check.cancelled) return yield* new ChampionError({ reason: "conflict" });
    const doc = yield* read(check.championId);
    if (doc.champion.projectId !== shell.projectId)
      return yield* new ChampionError({ reason: "unauthorized" });
    if (check.executionAttempt !== undefined && !check.reported) {
      const attempt = { ...check.executionAttempt, actualSelection: run.modelSelection };
      yield* sql`UPDATE champion_execution_attempts SET document_json = ${json(attempt)} WHERE id = ${attempt.id}`.pipe(
        Effect.mapError(failure),
      );
    }
    return { check, doc, run };
  });
  const checkContext: ChampionService["Service"]["checkContext"] = Effect.fn(
    "ChampionService.checkContext",
  )(function* (caller) {
    const { check, doc } = yield* authenticate(caller);
    return {
      champion: doc,
      checkId: check.id,
      messageId: check.messageId,
      // A goal review measures nothing; it reads the readings instead.
      metrics:
        check.kind === "review"
          ? []
          : check.metrics.filter((metric) => metric.collect === undefined),
      ...(check.samples === undefined || check.kind === "review"
        ? {}
        : { collected: check.samples }),
      ...(check.kind === "setup"
        ? {}
        : { rhythm: check.kind === "review" ? "review" : "readings" }),
      measureOnly: check.measureOnly || doc.champion.lifecycle !== "active",
    };
  });
  const changeMetricsFromCheck: ChampionService["Service"]["changeMetricsFromCheck"] = Effect.fn(
    "ChampionService.changeMetricsFromCheck",
  )(function* (caller, input) {
    const { doc: before, check } = yield* authenticate(caller);
    const result = yield* changeMetrics({ id: check.championId, ...input }, check.threadId);
    // A readings run or review still owes its report; only setup ends with its change.
    if (check.kind !== "setup") return result;
    return yield* mutate(
      Effect.gen(function* () {
        const current = yield* readCheck(check.id);
        if (!current.reported) yield* saveCheck({ ...current, reported: true });
        const doc = yield* read(check.championId);
        // Setting up a new champion is asking for it to run, so its first metrics start it.
        const start =
          before.metrics.length === 0 &&
          doc.metrics.length > 0 &&
          doc.champion.lifecycle === "paused";
        const saved = yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            outstandingSetupId: null,
            attention: doc.champion.attention.filter((a) => !a.startsWith("Setup ")),
            ...(start
              ? { lifecycle: "active" as const, nextCheckAt: yield* nextDue(doc.champion) }
              : {}),
          },
        });
        if (start)
          yield* activity(
            check.championId,
            "lifecycle",
            "Champion active. Setup added its first metrics, so checks start on schedule.",
          );
        return saved;
      }),
    );
  });
  const completeSetup: ChampionService["Service"]["completeSetup"] = Effect.fn(
    "ChampionService.completeSetup",
  )(function* (caller, input) {
    return yield* mutate(
      Effect.gen(function* () {
        const { doc, check } = yield* authenticate(caller);
        if (check.kind !== "setup") return yield* new ChampionError({ reason: "unauthorized" });
        if (check.reported) return doc;
        yield* saveCheck({ ...check, reported: true });
        yield* activity(
          doc.champion.id,
          "setup-completed",
          input.summary,
          undefined,
          check.threadId,
        );
        return yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            outstandingSetupId: null,
            attention: doc.champion.attention.filter((a) => !a.startsWith("Setup ")),
          },
        });
      }),
    );
  });
  const submitReport: ChampionService["Service"]["submitReport"] = Effect.fn(
    "ChampionService.submitReport",
  )(function* (caller, input) {
    const { check } = yield* authenticate(caller);
    if (
      check.kind === "setup" &&
      input.samples === undefined &&
      input.findings === undefined &&
      input.journeys === undefined
    )
      return yield* completeSetup(caller, { summary: input.summary });
    return yield* report(caller, {
      samples: input.samples ?? [],
      findings: input.findings ?? [],
      summary: input.summary,
      ...(input.journeys === undefined ? {} : { journeys: input.journeys }),
    });
  });
  const cancelSetup: ChampionService["Service"]["cancelSetup"] = Effect.fn(
    "ChampionService.cancelSetup",
  )(function* ({ id }) {
    const doc = yield* read(id);
    const pending = doc.champion.outstandingSetupId;
    if (!pending) return doc;
    const check = yield* readCheck(pending);
    const shell = yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure));

    if (shell !== null)
      yield* threads
        .dispatch({
          type: "thread.stop",
          threadId: check.threadId,
          commandId: CommandId.make(`champion-cancel-setup:${check.id}`),
          stopDelegatedTasks: false,
        })
        .pipe(Effect.mapError(failure));
    return yield* mutate(
      Effect.gen(function* () {
        const current = yield* read(id);
        if (current.champion.outstandingSetupId !== check.id) return current;
        const latest = yield* readCheck(check.id);
        if (shell === null && latest.launchStarted) {
          const receipt = yield* threads
            .getReceipt(latest.commandId)
            .pipe(Effect.mapError(failure));
          if (Option.isNone(receipt) || receipt.value.status !== "rejected")
            return yield* new ChampionError({ reason: "conflict" });
        }
        yield* saveCheck({ ...latest, cancelled: true });
        yield* activity(
          id,
          "setup-cancelled",
          "The user cancelled setup through the normal thread stop command.",
          undefined,
          check.threadId,
        );
        return yield* write({
          ...current,
          champion: {
            ...current.champion,
            outstandingSetupId: null,
            attention: current.champion.attention.filter((a) => !a.startsWith("Setup ")),
          },
        });
      }),
    );
  });
  const makeFinding = Effect.fn("ChampionService.makeFinding")(function* (
    id: string,
    title: string,
    evidence: string,
    metric?: ChampionMetric,
    options: { readonly alarm?: boolean; readonly findingId?: string } = {},
  ) {
    const at = yield* now;
    const findingId =
      options.findingId ??
      (metric === undefined
        ? `${id}:qualitative:${yield* uuid}`
        : `${id}:metric:${metric.seriesId}`);
    return {
      id: findingId,
      title,
      evidence: evidence.slice(0, 8000),
      metricId: metric?.id ?? null,
      seriesId: metric?.seriesId ?? null,
      status: "open" as const,
      ...(options.alarm === true ? { alarm: true } : {}),
      firstSeenAt: at,
      lastConfirmedAt: at,
      revision: null,
      updatedAt: at,
    } satisfies ChampionFinding;
  });
  /** The finding reopened for a new occurrence: seen and confirmed now, an alarm only if this one is. */
  const reopened = (
    finding: ChampionFinding,
    at: string,
    evidence: string,
    alarm: boolean,
  ): ChampionFinding => {
    const { alarm: _alarm, decision: _decision, ...rest } = finding;
    return {
      ...rest,
      status: "open",
      evidence: evidence.slice(0, 8000),
      ...(alarm ? { alarm: true } : {}),
      firstSeenAt: at,
      lastConfirmedAt: at,
      revision: null,
      updatedAt: at,
    };
  };
  /**
   * Whether a case has had a run of any status; a worked case is closed by its agent, never by a
   * reading. A failed read counts as worked, so recovery never dismisses a case it can't see.
   */
  const caseHasRun = Effect.fn("ChampionService.caseHasRun")(function* (finding: ChampionFinding) {
    if (finding.escalationThreadId == null) return false;
    return yield* threads.getThreadShell(finding.escalationThreadId).pipe(
      Effect.map((shell) => shell !== null && shell.latestRunId != null),
      Effect.orElseSucceed(() => true),
    );
  });
  const similar = (a: string, b: string) => {
    const ignored = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "and",
      "to",
      "of",
      "in",
      "for",
      "on",
    ]);
    const words = (text: string) =>
      new Set((text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []).filter((w) => !ignored.has(w)));
    const left = words(a),
      right = words(b);
    return left.size > 0 && left.size === right.size && [...left].every((w) => right.has(w));
  };
  /**
   * Opens, reopens or confirms the finding of a reading outside its target or at its alarm (a value at
   * or past it, or a second errored reading in a row); false when the open-finding limit refused it.
   * An alarm is never refused, and it upgrades an open finding.
   */
  const raiseBreach = Effect.fn("ChampionService.raiseBreach")(function* (
    findings: ChampionFinding[],
    check: Check,
    metric: ChampionMetric,
    sample: ChampionSampleInput,
    at: string,
    previous: ChampionLatestSample | undefined,
    printed = "Its evidence",
  ) {
    const value = sample.value;
    const breached = value !== null && targeted(metric) && outside(metric, value);
    const alarm =
      value !== null
        ? reachesAlarm(metric, value)
        : metric.alarm !== undefined &&
          sample.status === "error" &&
          previous?.status === "error" &&
          previous.seriesId === metric.seriesId;
    if (!breached && !alarm) return true;
    for (const [i, f] of findings.entries())
      if (
        !settled(f) &&
        f.metricId === metric.id &&
        f.seriesId != null &&
        f.seriesId !== metric.seriesId
      )
        findings[i] = { ...f, status: "dismissed", updatedAt: at };
    const target = [
      metric.minimum === null ? null : `at least ${metric.minimum}`,
      metric.maximum === null ? null : `at most ${metric.maximum}`,
    ]
      .filter((bound) => bound !== null)
      .join(" and ");
    // A finding opens with a sentence a person can read; the sample keeps the raw output.
    const evidence =
      value === null
        ? `ALARM: ${metric.name} could not be read twice in a row, and it carries an alarm at ${metric.alarm} ${metric.unit}. ${printed}: ${sample.evidence}`
        : `${alarm ? "ALARM: " : ""}${metric.name} read ${value} ${metric.unit}, ${alarm ? `at or past its alarm of ${metric.alarm} ${metric.unit}` : `outside its target of ${target} ${metric.unit}`}. ${printed}: ${sample.evidence}`;
    const id = `${check.championId}:metric:${metric.seriesId}`;
    const index = findings.findIndex((f) => f.id === id);
    const existing = findings[index];
    if (existing === undefined) {
      if (!alarm && findings.filter((f) => !settled(f)).length >= MAX_OPEN_FINDINGS) return false;
      findings.push(
        yield* makeFinding(
          check.championId,
          `${metric.name} ${alarm ? "reached its alarm" : "is outside its target"}`,
          evidence,
          metric,
          { alarm },
        ),
      );
    } else if (settled(existing)) findings[index] = reopened(existing, at, evidence, alarm);
    else
      findings[index] = {
        ...existing,
        lastConfirmedAt: at,
        ...(alarm && existing.alarm !== true
          ? {
              alarm: true,
              title: `${metric.name} reached its alarm`,
              evidence: evidence.slice(0, 8000),
              updatedAt: at,
            }
          : {}),
      };
    return true;
  });
  /** Closes the metric's open finding when a reading is back in target and its case never ran. */
  const recoverMetric = Effect.fn("ChampionService.recoverMetric")(function* (
    findings: ChampionFinding[],
    championId: string,
    metric: ChampionMetric,
    value: number | null,
    at: string,
  ) {
    const index = findings.findIndex(
      (f) => f.id === `${championId}:metric:${metric.seriesId}` && !settled(f),
    );
    const finding = findings[index];
    if (
      finding === undefined ||
      value === null ||
      outside(metric, value) ||
      reachesAlarm(metric, value) ||
      (yield* caseHasRun(finding))
    )
      return undefined;
    findings[index] = { ...finding, status: "dismissed", updatedAt: at };
    return findings[index];
  });
  /** Attention a readings run, a review and setup each own; a run replaces only its own lines. */
  const ownedBy = (kind: Rhythm, line: string) => {
    const label = kind === "check" ? null : runLabel(kind);
    const others = (["setup", "review"] as const).filter((other) => other !== kind);
    if (label !== null)
      return line.startsWith(`${label} `) || line.startsWith(`${SKIPPED}${runWhat(kind)}`);
    return !(
      others.some(
        (other) =>
          line.startsWith(`${runLabel(other)} `) || line.startsWith(`${SKIPPED}${runWhat(other)}`),
      ) ||
      line.startsWith(FOLDER_PROBLEM) ||
      line.startsWith(NOT_SAVED) ||
      line.startsWith(DEFINED_TWICE) ||
      line.startsWith("Measurement:")
    );
  };
  const FINDING_LIMIT_NOTE =
    "Open finding limit reached. Reconcile existing findings before opening more.";
  const latestOf = (check: Check, samples: ReadonlyArray<ChampionSample>) =>
    samples.map((sample) => {
      const metric = check.metrics.find((m) => m.id === sample.metricId);
      return {
        metricId: sample.metricId,
        name: metric!.name,
        version: sample.version,
        seriesId: sample.seriesId,
        unit: sample.unit,
        required: metric?.required ?? true,
        value: sample.value,
        status: sample.status,
        health: "unknown" as const,
        observedAt: sample.observedAt,
        collectedAt: sample.collectedAt,
        revision: sample.revision,
        staleAt: null,
      };
    });
  /** A readings run with nothing an agent must measure, which the server finishes itself. */
  const collectsEverything = (doc: Document, check: Pick<Check, "kind">) =>
    check.kind === "check" &&
    doc.champion.journeys === undefined &&
    doc.metrics.length > 0 &&
    doc.metrics.every((metric) => metric.collect !== undefined);
  /** Runs a new readings run's commands once and stores their readings; finishes the run when no agent is needed. */
  const collectCheck = Effect.fn("ChampionService.collectCheck")(function* (claim: Check) {
    const commands = claim.metrics.filter((metric) => metric.collect !== undefined);
    if (
      claim.kind !== "check" ||
      claim.samples !== undefined ||
      claim.dispatched ||
      claim.launchStarted === true ||
      commands.length === 0
    )
      return claim;
    const project = yield* projects
      .getById((yield* read(claim.championId)).champion.projectId)
      .pipe(Effect.mapError(failure));
    const readings = yield* Effect.forEach(
      commands,
      (metric): Effect.Effect<CollectedReading> =>
        Option.isNone(project)
          ? Effect.succeed({
              value: null,
              revision: null,
              evidence: "Collection failed: the champion's project no longer exists.",
            })
          : collectReading(processes, metric.collect!, project.value.workspaceRoot),
      { concurrency: "unbounded" },
    );
    return yield* mutate(
      Effect.gen(function* () {
        const check = yield* readCheck(claim.id);
        if (check.reported || check.cancelled || check.samples !== undefined) return check;
        const doc = yield* read(check.championId);
        const at = yield* now;
        const findings = [...doc.findings];
        const limited: string[] = [];
        const recovered: ChampionFinding[] = [];
        const samples: ChampionSample[] = [];
        for (const [index, metric] of commands.entries()) {
          const reading = readings[index]!;
          const sample: ChampionSample = {
            metricId: metric.id,
            version: metric.version,
            unit: metric.unit,
            status: reading.value === null ? "error" : "measured",
            value: reading.value,
            observedAt: at as ChampionSample["observedAt"],
            source: metric.source,
            evidence: reading.evidence,
            revision: reading.revision,
            championId: check.championId as ChampionSample["championId"],
            checkId: check.id,
            seriesId: metric.seriesId,
            collectedAt: at as ChampionSample["collectedAt"],
            threadId: check.threadId,
            runId: null,
            modelSelection: null,
            provenance: "server-collected",
          };
          samples.push(sample);
          const previous = doc.champion.latestSamples?.find((s) => s.metricId === metric.id);
          if (
            !(yield* raiseBreach(
              findings,
              check,
              metric,
              sample,
              at,
              previous,
              "The server's command printed",
            ))
          )
            limited.push(metric.name);
          const closed = yield* recoverMetric(
            findings,
            check.championId,
            metric,
            reading.value,
            at,
          );
          if (closed !== undefined) recovered.push(closed);
        }
        // Every metric scripted: the server finishes the run whatever the readings say, so no model wakes.
        const finished = collectsEverything(doc, check) && commands.length === check.metrics.length;
        const saved = { ...check, samples, reported: finished };
        yield* saveCheck(saved);
        const notes = [
          ...(limited.length > 0 ? [FINDING_LIMIT_NOTE] : []),
          ...(finished && samples.some((sample) => sample.status !== "measured")
            ? ["Some measurements are unknown, insufficient, or failed."]
            : []),
        ];
        yield* write({
          ...doc,
          findings,
          champion: {
            ...doc.champion,
            latestSamples: [
              ...(doc.champion.latestSamples ?? []).filter(
                (old) => !samples.some((sample) => sample.metricId === old.metricId),
              ),
              ...latestOf(check, samples),
            ],
            ...(finished
              ? {
                  outstandingCheckId: null,
                  lastCheckAt: at as ChampionSample["collectedAt"],
                  attention: [
                    ...doc.champion.attention.filter((line) => !ownedBy("check", line)),
                    ...notes,
                  ],
                  consecutiveCheckFailures: 0,
                }
              : { attention: [...new Set([...doc.champion.attention, ...notes])] }),
          },
        });
        for (const name of limited)
          yield* activity(
            check.championId,
            "finding-limited",
            `${name} is outside its target, but ${MAX_OPEN_FINDINGS} findings are already open, so no finding was recorded for it.`,
          );
        if (finished)
          yield* activity(
            check.championId,
            "check-reported",
            `The server read ${samples.length === 1 ? "the one metric" : `all ${samples.length} metrics`} by command, so no agent ran.`,
          );
        yield* findingActivity(check.championId, doc.findings, findings, recovered, samples);
        return saved;
      }),
    );
  });
  /** The activity lines a run's finding changes leave. */
  const findingActivity = Effect.fn("ChampionService.findingActivity")(function* (
    championId: string,
    before: ReadonlyArray<ChampionFinding>,
    after: ReadonlyArray<ChampionFinding>,
    recovered: ReadonlyArray<ChampionFinding>,
    samples: ReadonlyArray<ChampionSample>,
  ) {
    for (const finding of after) {
      const prior = before.find((old) => old.id === finding.id);
      if (prior === undefined || (settled(prior) && !settled(finding)))
        yield* activity(championId, "finding-opened", finding.evidence, finding);
      else if (recovered.some((closed) => closed.id === finding.id))
        yield* activity(
          championId,
          "finding-recovered",
          `Back inside the target before its case ran, so the finding closed: ${samples.find((s) => s.seriesId === finding.seriesId)?.evidence ?? "the goal review scored at target."}`,
          finding,
        );
      else if (finding.alarm === true && prior.alarm !== true)
        yield* activity(championId, "finding-alarm", finding.evidence, finding);
    }
  });
  const report: ChampionService["Service"]["report"] = Effect.fn("ChampionService.report")(
    function* (caller, input) {
      const journeyCheck = yield* authenticate(caller).pipe(
        Effect.flatMap(({ check, doc }) => {
          if (check.kind === "check" && input.goalScore !== undefined)
            return Effect.fail(
              new ChampionError({
                reason: "invalid",
                detail:
                  "A readings run does not score the goal: send no goalScore. The goal review scores it.",
              }),
            );
          const config = doc.champion.journeys;
          if (config === undefined || check.kind !== "check" || check.reported)
            return Effect.undefined;
          if (input.findings.length > 0)
            return Effect.fail(
              new ChampionError({
                reason: "invalid",
                detail:
                  "A journey check raises findings only from confirmed candidates. Send findings: [] and file candidates instead.",
              }),
            );
          return journeys.finish({
            checkId: check.id,
            championId: doc.champion.id,
            threadId: check.threadId,
            config,
            owner: input.journeys,
          });
        }),
      );
      return yield* mutate(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const { check, doc, run } = yield* authenticate(caller);
              if (check.kind === "setup")
                return yield* new ChampionError({ reason: "unauthorized" });
              if (check.reported) return doc;
              const collectedAt = yield* now;
              const findings = [...doc.findings];
              let findingsLimited = false;
              const recovered: ChampionFinding[] = [];
              const samples: ChampionSample[] = [];
              let goalScore: ChampionGoalScore | undefined;
              if (check.kind === "review") {
                if (input.goalScore === undefined)
                  return yield* new ChampionError({
                    reason: "invalid",
                    detail:
                      "A goal review reports goalScore: score, a whole number from 0 to 10 for how well the area meets the whole goal; reasons, why it is not higher; change, what changed since the previous score, citing readings.",
                  });
                if (input.samples.length > 0)
                  return yield* new ChampionError({
                    reason: "invalid",
                    detail:
                      "A goal review measures nothing: send samples: []. Readings are taken by their own runs.",
                  });
                const target = goalTargetOf(doc.champion);
                goalScore = {
                  score: input.goalScore.score,
                  target,
                  reasons: input.goalScore.reasons,
                  change: input.goalScore.change,
                  at: collectedAt,
                };
                samples.push({
                  metricId: GOAL_SCORE_SERIES,
                  version: 1,
                  unit: "score out of 10",
                  status: "measured",
                  value: goalScore.score,
                  observedAt: collectedAt,
                  source: "goal review",
                  evidence:
                    `Why not higher: ${goalScore.reasons}\nChanged: ${goalScore.change}`.slice(
                      0,
                      8000,
                    ),
                  revision: null,
                  championId: check.championId,
                  checkId: check.id,
                  seriesId: GOAL_SCORE_SERIES,
                  collectedAt,
                  threadId: check.threadId,
                  runId: run.id,
                  modelSelection: run.modelSelection,
                  provenance: "agent-reported",
                });
                const id = goalFindingId(check.championId);
                const index = findings.findIndex((f) => f.id === id);
                const existing = findings[index];
                const evidence = `The goal review scored ${goalScore.score}/10, below its target of ${target}. Why not higher: ${goalScore.reasons} Changed: ${goalScore.change}`;
                if (goalScore.score < target) {
                  if (existing === undefined)
                    findings.push(
                      yield* makeFinding(
                        check.championId,
                        `${doc.champion.name} scores ${goalScore.score}/10 against its goal`,
                        evidence,
                        undefined,
                        { findingId: id },
                      ),
                    );
                  else if (settled(existing))
                    findings[index] = reopened(existing, collectedAt, evidence, false);
                  else
                    findings[index] = {
                      ...existing,
                      evidence: evidence.slice(0, 8000),
                      lastConfirmedAt: collectedAt,
                      updatedAt: collectedAt,
                    };
                } else if (
                  existing !== undefined &&
                  !settled(existing) &&
                  !(yield* caseHasRun(existing))
                ) {
                  findings[index] = { ...existing, status: "dismissed", updatedAt: collectedAt };
                  recovered.push(findings[index]!);
                }
              } else {
                if (new Set(input.samples.map((s) => s.metricId)).size !== input.samples.length)
                  return yield* new ChampionError({
                    reason: "invalid",
                    validation: { field: "samples" },
                  });
                for (const [sampleIndex, sample] of input.samples.entries()) {
                  const metric = check.metrics.find((m) => m.id === sample.metricId);
                  if (metric === undefined)
                    return yield* new ChampionError({
                      reason: "invalid",
                      validation: { sampleIndex, field: "metricId" },
                    });
                  if (metric.collect !== undefined)
                    return yield* new ChampionError({
                      reason: "invalid",
                      detail: `The server reads ${metric.id} by command and has recorded it for this check. Leave it out of samples.`,
                      validation: { sampleIndex, field: "metricId" },
                    });
                  const field =
                    metric.version !== sample.version
                      ? "version"
                      : metric.unit !== sample.unit
                        ? "unit"
                        : sample.status === "measured" && metric.source !== sample.source
                          ? "source"
                          : (sample.status === "measured") !== (sample.value !== null) ||
                              (sample.value !== null && !Number.isFinite(sample.value))
                            ? "value"
                            : !Number.isFinite(Date.parse(sample.observedAt))
                              ? "observedAt"
                              : undefined;
                  if (field !== undefined)
                    return yield* new ChampionError({
                      reason: "invalid",
                      validation: { sampleIndex, field },
                    });
                  samples.push({
                    ...sample,
                    championId: check.championId,
                    checkId: check.id,
                    seriesId: metric.seriesId,
                    collectedAt,
                    threadId: check.threadId,
                    runId: run.id,
                    modelSelection: run.modelSelection,
                    provenance: "agent-reported",
                  });
                  const previous = doc.champion.latestSamples?.find(
                    (s) => s.metricId === metric.id,
                  );
                  if (!(yield* raiseBreach(findings, check, metric, sample, collectedAt, previous)))
                    findingsLimited = true;
                  const closed = yield* recoverMetric(
                    findings,
                    check.championId,
                    metric,
                    sample.value,
                    collectedAt,
                  );
                  if (closed !== undefined) recovered.push(closed);
                }
                if (
                  check.metrics.some(
                    (metric) =>
                      metric.collect === undefined &&
                      (metric.required ?? true) &&
                      !samples.some((s) => s.metricId === metric.id),
                  )
                )
                  return yield* new ChampionError({
                    reason: "invalid",
                    validation: { field: "samples" },
                  });
              }
              for (const qualitative of input.findings) {
                const existing =
                  qualitative.existingFindingId === undefined
                    ? findings.find((f) => !settled(f) && similar(f.title, qualitative.title))
                    : findings.find((f) => f.id === qualitative.existingFindingId && !settled(f));
                if (qualitative.existingFindingId !== undefined && existing === undefined)
                  return yield* new ChampionError({ reason: "invalid" });
                if (existing !== undefined) {
                  findings[findings.indexOf(existing)] = {
                    ...existing,
                    evidence: qualitative.evidence,
                    lastConfirmedAt: collectedAt,
                    updatedAt: collectedAt,
                  };
                } else {
                  if (findings.filter((f) => !settled(f)).length >= MAX_OPEN_FINDINGS) {
                    findingsLimited = true;
                    continue;
                  }
                  findings.push(
                    yield* makeFinding(check.championId, qualitative.title, qualitative.evidence),
                  );
                }
              }
              const stored = [...(check.samples ?? []), ...samples];
              yield* saveCheck({
                ...check,
                reported: true,
                samples: stored,
                ...(goalScore === undefined ? {} : { goalScore }),
              });
              const notes = [
                ...(journeyCheck?.status === "incomplete"
                  ? [`The last journey check did not finish: ${journeyCheck.reason}`]
                  : []),
                ...(findingsLimited ? [FINDING_LIMIT_NOTE] : []),
                ...(check.kind === "check" &&
                stored.some(
                  (s) =>
                    s.status !== "measured" &&
                    (check.metrics.find((m) => m.id === s.metricId)?.required ?? true),
                )
                  ? ["Some measurements are unknown, insufficient, or failed."]
                  : []),
              ];
              const attention = [
                ...doc.champion.attention.filter((line) => !ownedBy(check.kind, line)),
                ...notes,
              ];
              const saved = yield* write({
                ...doc,
                findings,
                champion: {
                  ...doc.champion,
                  attention,
                  ...(check.kind === "review"
                    ? {
                        outstandingReviewId: null,
                        lastReviewAt: collectedAt,
                        consecutiveReviewFailures: 0,
                        ...(goalScore === undefined ? {} : { goalScore }),
                      }
                    : {
                        outstandingCheckId: null,
                        latestSamples: [
                          ...(doc.champion.latestSamples ?? []).filter(
                            (old) => !samples.some((sample) => sample.metricId === old.metricId),
                          ),
                          ...latestOf(check, samples),
                        ],
                        lastCheckAt: collectedAt,
                        consecutiveCheckFailures:
                          journeyCheck?.status === "incomplete"
                            ? (doc.champion.consecutiveCheckFailures ?? 0) + 1
                            : 0,
                      }),
                },
              });
              yield* activity(
                check.championId,
                check.kind === "review" ? "review-reported" : "check-reported",
                goalScore === undefined
                  ? input.summary
                  : `Goal score ${goalScore.score}/10. ${input.summary}`.slice(0, 8000),
                undefined,
                check.threadId,
              );
              yield* findingActivity(check.championId, doc.findings, findings, recovered, samples);
              return saved;
            }),
          )
          .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
      );
    },
  );
  /**
   * Delivers an answer to a decision requested before cases replaced decision requests: it goes to
   * the finding's case, unarchived if needed; a deleted case drops it with an activity line.
   */
  const deliverDecision = Effect.fn("ChampionService.deliverDecision")(function* (id: string) {
    const rows = yield* sql<{
      id: string;
      champion_id: string;
      finding_id: string;
      answer: string;
    }>`SELECT * FROM champion_decision_deliveries WHERE id = ${id} AND delivered = 0`.pipe(
      Effect.mapError(failure),
    );
    const row = rows[0];
    if (row === undefined) return;
    const doc = yield* read(row.champion_id);
    if (!runsHere(doc.champion)) return;
    const finding = doc.findings.find((candidate) => candidate.id === row.finding_id);
    const done = (line?: string) =>
      mutate(
        Effect.gen(function* () {
          yield* sql`UPDATE champion_decision_deliveries SET delivered = 1 WHERE id = ${id}`.pipe(
            Effect.mapError(failure),
          );
          const current = yield* read(row.champion_id);
          yield* write({
            ...current,
            champion: {
              ...current.champion,
              attention: current.champion.attention.filter(
                (a) => a !== `Decision answer delivery pending: ${id}`,
              ),
            },
          });
          if (line !== undefined)
            yield* activity(row.champion_id, "decision-answer-dropped", line, finding);
        }),
      );
    if (finding?.decision?.id !== row.id) return yield* done();
    const caseThreadId = finding.escalationThreadId ?? null;
    const shell =
      caseThreadId === null
        ? null
        : yield* threads.getThreadShell(caseThreadId).pipe(Effect.mapError(failure));
    // A case made in the same commit has no thread yet; the next pass delivers to it.
    if (caseThreadId !== null && shell === null) return;
    if (caseThreadId === null || shell === null || shell.deletedAt !== null)
      return yield* done(
        `The answer to decision ${row.id} was dropped: its finding's case was deleted. The answer: ${row.answer}`.slice(
          0,
          8000,
        ),
      );
    if (shell.archivedAt !== null)
      yield* threads
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`champion-decision:${row.id}:unarchive`),
          threadId: caseThreadId,
        })
        .pipe(Effect.mapError(failure));
    const decision = finding.decision;
    yield* threads
      .sendToThread({
        projectId: doc.champion.projectId,
        threadId: caseThreadId,
        commandId: CommandId.make(`champion-decision:${row.id}`),
        messageId: MessageId.make(`champion-decision:${row.id}`),
        text: `${
          decision.approval === undefined
            ? ""
            : `This answer was relayed by an agent in thread ${decision.approval.threadId} ("${decision.approval.threadTitle}"), not given on the card; the user's words there: "${decision.approval.quote}". `
        }The user answered decision ${row.id} on finding ${row.finding_id} ("${decision.question}"). Recheck the finding before acting on it.\n${row.answer}`,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failure));
    yield* done();
  });
  /** The strong interactive model a case runs on: the lead role, else the advice model, never the checks model. */
  const escalationModel = Effect.fn("ChampionService.escalationModel")(function* (doc: Document) {
    const lead = yield* resolveRankedClass(doc.champion.projectId, "non-ui", "lead").pipe(
      Effect.option,
    );
    if (Option.isSome(lead) && lead.value.selection != null && lead.value.refusal === null)
      return lead.value.selection;
    const advice = yield* slotOf(doc, "advice");
    return advice === null
      ? null
      : (ChampionModels.pickSlot(advice.slot, yield* modelSource).use?.selection ?? null);
  });
  const isAway = Option.isSome(serverSettings)
    ? serverSettings.value.getSettings.pipe(
        Effect.map((settings) => settings.away === true),
        Effect.orElseSucceed(() => true),
      )
    : Effect.succeed(false);
  /** The first message a case the server starts carries; the brief itself joins it at turn start. */
  const caseStartText = (alarm: boolean) =>
    alarm
      ? `This case started at once because its finding reached an alarm. Work it as unattended work, whether or not Henry is at his desk: decide reversible choices yourself from evidence and testing, and hold only hard-to-reverse actions (${HARD_STOP_BOUNDARY}) for Henry with watch {kind: "owner"}.`
      : "Henry is away, so this case started on its own. Work it from the brief.";
  /** Starts an idle case that has never had a run: its first message, with the brief, on the thread it has. */
  const startCase: (
    doc: Document,
    threadId: ThreadId,
    alarm: boolean,
  ) => Effect.Effect<void, ChampionError> = Effect.fn("ChampionService.startCase")(function* (
    doc: Document,
    threadId: ThreadId,
    alarm: boolean,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.latestRunId != null
    )
      return;
    // One id per case, so a repeated start replays rather than sending twice.
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        threadId,
        commandId: CommandId.make(`champion-case:${threadId}:start`),
        messageId: MessageId.make(`champion-case:${threadId}:start`),
        text: caseStartText(alarm),
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(failure));
    yield* activity(
      doc.champion.id,
      "case-started",
      alarm ? "An alarm case started at once." : "Henry is away, so the case started on its own.",
      undefined,
      threadId,
    ).pipe(mutate);
  });
  /**
   * Makes, unsettles, starts or settles one case (fork/differences.md `champions`). A new case stays
   * idle while Henry is attended, so no model turn is paid for until he starts it; an alarm, or any
   * case while he is away, is launched with its first message in the same command. Its brief joins
   * the first message at turn start (ProviderTurnStartService).
   */
  const runEscalation: (intent: EscalationIntent) => Effect.Effect<void, ChampionError> = Effect.fn(
    "ChampionService.runEscalation",
  )(function* (intent: EscalationIntent) {
    // Effects run after their commit and outside the lock, so a later write may already have changed
    // the state: act on the Champion as it is now, never undo what a newer intent asked for.
    const doc = yield* read(intent.championId);
    const current = Escalation.escalationShells(doc).get(intent.threadId);
    if (intent.action === "ensure" && current?.resolved === true) return;
    if (
      intent.action === "settle" &&
      current !== undefined &&
      !current.resolved &&
      (current.severity === "decision" || intent.target.kind === "stuck")
    )
      return;
    const shell = yield* threads.getThreadShell(intent.threadId).pipe(Effect.mapError(failure));
    const live = shell !== null && shell.deletedAt === null && shell.archivedAt === null;
    const dispatchId = `champion-escalation:${intent.action}:${intent.threadId}:${yield* uuid}`;
    if (intent.action === "settle") {
      if (live && shell.settledOverride !== "settled")
        yield* threads
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(dispatchId),
            threadId: intent.threadId,
            ...(shell.latestRunId == null ? {} : { expectedLatestRunId: shell.latestRunId }),
          })
          .pipe(Effect.mapError(failure));
      return;
    }
    const startNow = intent.start || (yield* isAway);
    if (live) {
      if (shell.settledOverride === "settled")
        yield* threads
          .dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make(dispatchId),
            threadId: intent.threadId,
            reason: "user",
          })
          .pipe(Effect.mapError(failure));
      if (startNow) yield* startCase(doc, intent.threadId, intent.start);
      return;
    }
    if (shell !== null) return;
    const target = intent.target;
    const finding =
      target.kind === "finding" ? doc.findings.find((f) => f.id === target.findingId) : undefined;
    if (target.kind === "finding" && finding === undefined) return;
    const modelSelection = yield* escalationModel(doc);
    if (modelSelection === null)
      return yield* Effect.logWarning("champions.escalation-no-model", {
        championId: intent.championId,
        threadId: intent.threadId,
      });
    const stuck = Escalation.stuckState(doc.champion);
    yield* launch
      .launch({
        commandId: CommandId.make(`champion-escalation:${intent.threadId}`),
        threadId: intent.threadId,
        projectId: doc.champion.projectId,
        title:
          finding !== undefined
            ? finding.title
            : `${doc.champion.name}: ${stuck.trigger.toLowerCase()}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        // Cases launch in the project's main checkout; only work that changes code allocates a workspace.
        workspaceStrategy: { type: "root" },
        ...(startNow
          ? {
              initialMessage: {
                messageId: MessageId.make(`champion-case:${intent.threadId}:start`),
                text: caseStartText(intent.start),
                attachments: [],
              },
            }
          : {}),
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(failure));
    if (startNow)
      yield* mutate(
        activity(
          doc.champion.id,
          "case-started",
          intent.start
            ? "An alarm case started at once."
            : "Henry is away, so the case started on its own.",
          finding,
          intent.threadId,
        ),
      );
  });
  /** While Henry is away, every open case that has never had a run starts. */
  const startIdleCases = Effect.fn("ChampionService.startIdleCases")(function* (doc: Document) {
    const open = [
      ...doc.findings
        .filter((finding) => !settled(finding) && finding.escalationThreadId != null)
        .map((finding) => ({
          threadId: finding.escalationThreadId!,
          alarm: finding.alarm === true,
        })),
      ...(doc.champion.stuckEscalationThreadId != null && Escalation.stuckState(doc.champion).stuck
        ? [{ threadId: doc.champion.stuckEscalationThreadId, alarm: false }]
        : []),
    ];
    for (const { threadId, alarm } of open)
      yield* startCase(doc, threadId, alarm).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("champions.case-start-failed", {
            championId: doc.champion.id,
            threadId,
            cause,
          }),
        ),
      );
  });
  const startMetricsLead: ChampionService["Service"]["startMetricsLead"] = Effect.fn(
    "ChampionService.startMetricsLead",
  )(function* (input) {
    const doc = yield* read(input.id);
    if (!runsHere(doc.champion)) return yield* runsElsewhere(doc.champion);
    if (doc.champion.lifecycle === "retired")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "This champion is retired. Restore it before starting a lead on its metrics.",
      });
    const lead = yield* resolveRankedClass(doc.champion.projectId, "non-ui", "lead");
    if (lead.selection == null || lead.refusal !== null)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: "No model is available for the lead role, so nothing was started.",
      });
    const key = yield* uuid;
    const threadId = ThreadId.make(key);
    const latest = presentLatest(doc, yield* now);
    const metricLines = doc.metrics.map((metric) => {
      const sample = latest.find((entry) => entry.metricId === metric.id);
      const reading =
        sample === undefined
          ? "never measured"
          : `${sample.status}, value ${sample.value ?? "none"}`;
      return `- ${metric.name} (${metric.id}): ${metric.description || "no description"} Latest: ${reading}.`;
    });
    const problems = [
      ...doc.champion.attention.filter((line) => !line.startsWith("Decision: ")),
      ...doc.findings
        .filter((finding) => !["verified", "dismissed"].includes(finding.status))
        .map((finding) => `Open finding: ${finding.title}`),
    ];
    yield* launch
      .launch({
        commandId: CommandId.make(`champion-metrics-lead:${key}`),
        threadId,
        projectId: doc.champion.projectId,
        title: `Fix metrics: ${doc.champion.name}`,
        modelSelection: lead.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`champion-metrics-lead:${key}`),
          text: [
            `The user asked you to fix the metrics of the ${doc.champion.name} champion (id ${doc.champion.id}). Its goal: ${doc.champion.purpose}`,
            `Its metrics now:\n${metricLines.join("\n") || "- none"}`,
            `What looks wrong:\n${problems.map((line) => `- ${line}`).join("\n") || "- nothing recorded; judge from the metrics above"}`,
            `Work out which metrics fail to show honest progress towards the goal: ones that cannot be collected here, that measure the wrong thing, or whose names a non-engineer would not understand. Shape the fix as a Spec with the shape skill and lead it with the lead skill. Read current state with t3_champions_get. Change the champion's definitions with t3_champions_metrics; renaming keeps a metric's history. ${METRIC_RULE} Do not change the champion's checks or findings directly.`,
          ].join("\n\n"),
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failure));
    yield* mutate(
      activity(
        doc.champion.id,
        "metrics-lead",
        "Started a lead to fix these metrics.",
        undefined,
        threadId,
      ),
    );
    return { threadId };
  });
  /** Whether a thread is running a Champion's readings or goal review right now. */
  const observingRun = Effect.fn("ChampionService.observingRun")(function* (threadId: ThreadId) {
    const doc = yield* byThread(threadId);
    if (doc === undefined) return false;
    for (const id of [doc.champion.outstandingCheckId, doc.champion.outstandingReviewId ?? null]) {
      if (id === null) continue;
      const check = yield* readCheck(id);
      if (check.threadId === threadId && !check.reported && !check.cancelled) return true;
    }
    return false;
  });
  const findingAction: ChampionService["Service"]["findingAction"] = Effect.fn(
    "ChampionService.findingAction",
  )(function* (input, actor = "user", by) {
    if (by !== undefined && (yield* observingRun(by)))
      return yield* new ChampionError({ reason: "unauthorized", detail: CASE_FLOW_REFUSAL });
    const answering =
      input.action === "resolve_decision" && actor !== "user"
        ? (yield* read(input.id)).findings.find((f) => f.id === input.findingId)?.decision
        : undefined;
    // An answer already on record needs no approval to repeat; the mutation below decides it.
    const approval =
      input.action !== "resolve_decision" ||
      actor === "user" ||
      (answering != null && answering.id === input.decisionId && answering.status === "resolved")
        ? undefined
        : yield* relayedApproval(
            actor,
            "The decision waits for them on its card: ask them to answer it there, or pass approvalQuote with their exact words from a message they typed in this thread.",
            answering?.requestedAt,
          );
    const result = yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const finding = doc.findings.find((f) => f.id === input.findingId);
        if (finding === undefined) return yield* new ChampionError({ reason: "not-found" });
        const at = yield* now;
        let updated: ChampionFinding = { ...finding, updatedAt: at };
        if (input.action === "resolve_decision") {
          if (!input.decisionId || finding.decision?.id !== input.decisionId)
            return yield* new ChampionError({
              reason: "conflict",
              detail:
                "That decision is not the finding's current one. Read the champion again and answer the decision it shows by its id.",
            });
          if (finding.decision.status === "resolved") {
            if (finding.decision.answer !== input.reason)
              return yield* new ChampionError({
                reason: "conflict",
                detail: "This decision was already answered differently.",
              });
            return doc;
          }
          updated = {
            ...updated,
            decision: {
              ...finding.decision,
              status: "resolved",
              answer: input.reason,
              ...(approval === undefined ? {} : { approval }),
              resolvedAt: at,
            },
          };
          yield* sql`INSERT INTO champion_decision_deliveries (id,champion_id,finding_id,answer) VALUES (${input.decisionId},${input.id},${finding.id},${input.reason})`.pipe(
            Effect.mapError(failure),
          );
        } else if (input.action === "reopen") {
          (yield* ChangeBatch)?.forced.add(finding.id);
          updated = reopened(finding, at, finding.evidence, false);
        } else
          updated = {
            ...updated,
            status: input.action === "dismiss" ? "dismissed" : "verified",
            decision: null,
          };
        yield* activity(
          input.id,
          input.action,
          input.reason,
          updated,
          approval?.threadId,
          approval,
        );
        return yield* write({
          ...doc,
          findings: doc.findings.map((f) => (f.id === updated.id ? updated : f)),
        });
      }),
    );
    if (input.action === "resolve_decision" && input.decisionId !== undefined) {
      yield* deliverDecision(input.decisionId).pipe(
        Effect.catch(() =>
          mutate(
            Effect.gen(function* () {
              const doc = yield* read(input.id);
              yield* write({
                ...doc,
                champion: {
                  ...doc.champion,
                  attention: [
                    ...new Set([
                      ...doc.champion.attention,
                      `Decision answer delivery pending: ${input.decisionId}`,
                    ]),
                  ],
                },
              });
            }),
          ),
        ),
      );
      return yield* read(input.id);
    }
    return result;
  });
  /** Admits a delegation the owner thread may make: a measurement of its live check, or a journey replay. */
  const admitDelegation: ChampionService["Service"]["admitDelegation"] = Effect.fn(
    "ChampionService.admitDelegation",
  )(function* (proof) {
    const doc = yield* byThread(proof.ownerThreadId);
    if (doc === undefined) return;
    if (!runsHere(doc.champion)) return yield* runsElsewhere(doc.champion);
    if (isCandidateWorkId(proof.binding.workId)) return;
    if (!ChampionEvidence.isMeasurementWorkId(proof.binding.workId))
      return yield* new ChampionError({ reason: "unauthorized", detail: CASE_FLOW_REFUSAL });
    const run = yield* ownerRun(proof.ownerThreadId);
    if (run === undefined || run.id !== proof.parentRunId)
      return yield* new ChampionError({ reason: "unauthorized" });
    yield* evidence.admitMeasurement({ ...proof, runMessageIds: run.messageIds });
    yield* PubSub.publish(changes, undefined);
  });
  /** Everyone a journey's confirmation must not be: the model that ran it, the one that drove it, and the configured decision model under any provider's name. */
  const journeyModels = Effect.fn("ChampionService.journeyModels")(function* (doc: Document) {
    const router = yield* Effect.serviceOption(DecisionRouter.DecisionRouter);
    const configured = Option.isSome(router)
      ? yield* router.value.status.pipe(
          Effect.map(({ model }) => [model, model.slice(model.lastIndexOf("/") + 1)]),
          Effect.orElseSucceed(() => []),
        )
      : [];
    return new Set([
      ...[yield* slotOf(doc, "checks"), yield* slotOf(doc, "advice")].flatMap((slot) =>
        slot === null ? [] : [slot.slot.main.model, slot.slot.backup?.model ?? ""],
      ),
      decisionEngines.jev.model,
      decisionEngines.luna.model,
      ...configured,
    ]);
  });
  /** The owner's active run and the messages its restart ancestry covers, which a check's own message must be among. */
  const ownerRun = Effect.fn("ChampionService.ownerRun")(function* (ownerThreadId: ThreadId) {
    const shell = yield* threads.getThreadShell(ownerThreadId);
    if (
      shell === null ||
      shell.activeRunId === null ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      return undefined;
    const records = yield* threads.getThreadRecords(ownerThreadId, ["runs"]);
    const run = records.runs.find((candidate) => candidate.id === shell.activeRunId);
    if (run === undefined || !ThreadManagement.isActiveRun(run)) return undefined;
    return {
      id: run.id,
      messageIds: checkRunMessages(run, new Map(records.runs.map((r) => [r.id, r]))),
    };
  }, Effect.mapError(failure));
  /** Role policy decides eligibility; a reviewer only skips the models its browser audit ran on. */
  const measurementSelection = Effect.fn("ChampionService.measurementSelection")(function* (
    doc: Document,
    request: AgentTaskRequest,
    avoid: ReadonlyArray<string>,
  ) {
    if (Option.isNone(managedAgents))
      return yield* new ChampionError({
        reason: "unavailable",
        detail: "Managed agent roles are unavailable.",
      });
    const roles = managedAgents.value;
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({
        projectId: doc.champion.projectId,
        instanceId: provider.instanceId,
      }),
    );
    const resolve = (selection?: ModelSelection) =>
      roles
        .roles({
          projectId: doc.champion.projectId,
          providers: enabled,
          ceiling: "full-access",
          request,
          ...(selection === undefined ? {} : { selection }),
        })
        .pipe(
          Effect.mapError(failure),
          Effect.map((result) => result.roles.find((entry) => entry.role === request.role)),
        );
    const [automatic] = yield* roles
      .ranked({
        role: request.role,
        projectId: doc.champion.projectId,
        providers: enabled,
        ceiling: "full-access",
        request,
      })
      .pipe(Effect.mapError(failure));
    const first = yield* resolve(automatic);
    if (
      first?.selection != null &&
      first.refusal === null &&
      !avoid.includes(ChampionEvidence.modelIdentity(first.selection.model))
    )
      return first.selection;
    if (avoid.length === 0)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: first?.refusal ?? `No model is eligible for the ${request.role} role.`,
      });
    for (const provider of enabled)
      for (const model of provider.models) {
        if (avoid.includes(ChampionEvidence.modelIdentity(model.slug))) continue;
        const alternative = yield* resolve({ instanceId: provider.instanceId, model: model.slug });
        if (alternative?.selection != null && alternative.refusal === null)
          return alternative.selection;
      }
    return yield* new ChampionError({
      reason: "unavailable",
      detail:
        "No eligible model other than the browser measurement's can confirm it, so it stays unconfirmed.",
    });
  });
  const guardConfirmation = Effect.fn("ChampionService.guardConfirmation")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest,
    task: string | undefined,
    followup: boolean,
  ) {
    const refuse = (detail: string) => new ChampionError({ reason: "unauthorized", detail });
    const doc = yield* byThread(ownerThreadId);
    if (doc === undefined || doc.champion.ownerThreadId !== ownerThreadId)
      return yield* refuse("Only the champion's owner thread starts a replay.");
    const candidate = yield* journeys
      .readCandidate(request.workId.slice(CANDIDATE_WORK_PREFIX.length))
      .pipe(Effect.mapError(failure));
    if (
      candidate === undefined ||
      candidate.championId !== doc.champion.id ||
      candidate.replay?.attemptId !== request.attemptId
    )
      return yield* refuse(
        "Start a replay with the workId and attemptId t3_champions_candidate_replay returned.",
      );
    if (followup)
      return yield* refuse("A replay judges alone, so it takes no follow-up. Start a new replay.");
    if (task?.trim() !== candidate.replay?.brief?.trim())
      return yield* refuse("A replay's task is its brief, unchanged.");
    if (
      request.role !== "browser" ||
      request.readOnly !== true ||
      (request.browser !== undefined && request.browser.backend !== "integrated")
    )
      return yield* refuse(
        "A replay runs as role browser with readOnly true and the integrated browser.",
      );
    if (Option.isNone(managedAgents)) return yield* new ChampionError({ reason: "unavailable" });
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({
        projectId: doc.champion.projectId,
        instanceId: provider.instanceId,
      }),
    );
    const excluded = yield* journeyModels(doc);
    const ranked = yield* managedAgents.value
      .ranked({
        projectId: doc.champion.projectId,
        providers: enabled,
        ceiling: "full-access",
        request,
        role: "browser",
      })
      .pipe(Effect.mapError(failure));
    // With only the check's own models able to run, the replay runs anyway and is recorded as
    // not independent when it settles.
    const selection = ranked.find((candidate) => !excluded.has(candidate.model)) ?? ranked[0];
    if (selection === undefined)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: "No model on the browser list can confirm this candidate now.",
      });
    return selection;
  });
  const journeysStart: ChampionService["Service"]["journeysStart"] = Effect.fn(
    "ChampionService.journeysStart",
  )(function* (caller) {
    const { check, doc } = yield* authenticate(caller);
    if (!runsHere(doc.champion)) return yield* runsElsewhere(doc.champion);
    const config = doc.champion.journeys;
    if (config === undefined || check.kind !== "check")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "This champion runs no journeys.",
      });
    const project = yield* projects.getById(doc.champion.projectId).pipe(Effect.mapError(failure));
    return yield* journeys.start({
      championId: doc.champion.id,
      threadId: check.threadId,
      checkId: check.id,
      config,
      openFindings: doc.findings
        .filter(
          (f) => f.id.includes(":qualitative:") && !["verified", "dismissed"].includes(f.status),
        )
        .map((f) => ({ id: f.id, title: f.title })),
      checkoutRoot: Option.isSome(project) ? project.value.workspaceRoot : null,
    });
  });
  const journeyCandidate: ChampionService["Service"]["journeyCandidate"] = Effect.fn(
    "ChampionService.journeyCandidate",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const running = yield* journeys.readRecord(check.id).pipe(Effect.mapError(failure));
    if (doc.champion.journeys === undefined || running?.record.status !== "running")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "No journey check is running.",
      });
    const journey = yield* journeys
      .markFailed(check.id, input.tabId)
      .pipe(Effect.mapError(failure));
    if (journey === undefined)
      return yield* new ChampionError({
        reason: "invalid",
        detail: `The server recorded no journey in tab ${input.tabId}.`,
      });
    const candidate: ChampionJourneys.JourneyCandidate = {
      id: yield* uuid,
      championId: doc.champion.id,
      checkId: check.id,
      kind: "candidate",
      status: "pending",
      reason: null,
      title: input.title,
      expected: input.expected,
      observed: input.observed,
      tabId: input.tabId,
      commit: running.record.commit,
      steps: journey.steps,
      finalUrl: journey.finalUrl,
      screenshots: journey.screenshots,
      findingId: null,
      viewport: journey.viewport ?? null,
      replay: null,
    };
    yield* journeys.saveCandidate(candidate).pipe(Effect.mapError(failure));
    return { candidateId: candidate.id };
  });
  const candidateReplay: ChampionService["Service"]["candidateReplay"] = Effect.fn(
    "ChampionService.candidateReplay",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const config = doc.champion.journeys;
    const running = yield* journeys.readRecord(check.id).pipe(Effect.mapError(failure));
    if (
      config === undefined ||
      running?.record.status !== "running" ||
      running.record.build === null
    )
      return yield* new ChampionError({
        reason: "conflict",
        detail: "No journey check is running.",
      });
    // A replay's brief is the only way to delegate it, so asking again must return it, not a new target.
    const started = (yield* journeys.candidatesOf(check.id).pipe(Effect.mapError(failure))).find(
      (open) =>
        open.status === "pending" &&
        (input.findingId !== undefined
          ? open.kind === "retest" && open.findingId === input.findingId
          : open.id === input.candidateId),
    );
    if (started?.replay?.brief !== undefined) {
      const { brief, workId, attemptId } = started.replay;
      return { candidateId: started.id, workId, attemptId, brief };
    }
    let candidate: ChampionJourneys.JourneyCandidate | undefined;
    if (input.findingId !== undefined) {
      const original = yield* journeys.confirmedFor(input.findingId).pipe(Effect.mapError(failure));
      if (original === undefined)
        return yield* new ChampionError({
          reason: "not-found",
          detail: "That finding has no recorded journey.",
        });
      candidate = {
        ...original,
        id: yield* uuid,
        checkId: check.id,
        kind: "retest",
        status: "pending",
        reason: null,
        replay: null,
      };
    } else if (input.candidateId !== undefined) {
      candidate = yield* journeys.readCandidate(input.candidateId).pipe(Effect.mapError(failure));
    }
    if (candidate === undefined || candidate.checkId !== check.id)
      return yield* new ChampionError({
        reason: "not-found",
        detail: "Name a candidate of this check, or a finding.",
      });
    if (candidate.status !== "pending" && candidate.status !== "inconclusive")
      return yield* new ChampionError({
        reason: "conflict",
        detail: `That candidate is already ${candidate.status}.`,
      });
    const workId = `${CANDIDATE_WORK_PREFIX}${candidate.id}`;
    // The candidate's shard, by the origin it ran on: its locale must be replayed in.
    const candidateShard =
      running.record.manifest === null
        ? undefined
        : (shardOfOrigin(running.record.manifest, candidate.finalUrl) ??
          candidate.steps
            .map((step) => shardOfOrigin(running.record!.manifest!, step.url))
            .find((entry) => entry !== undefined));
    const manifest = yield* journeys.provisionReplay({
      checkId: check.id,
      config,
      workId,
      build: running.record.build,
      ...(candidateShard?.locale === undefined ? {} : { locale: candidateShard.locale }),
    });
    const shard = manifest.shards[0]!;
    const attemptId = `${candidate.id}:${manifest.id}`;
    const brief = replayBrief({
      title: candidate.title,
      expected: candidate.expected,
      observed: candidate.observed,
      origin: shard.origin,
      signInPath: shard.signInPath,
      steps: candidate.steps,
      finalUrl: candidate.finalUrl,
      retest: candidate.kind === "retest",
      reproduction: candidate.reproduction ?? null,
      viewport: candidate.viewport ?? null,
      ...(candidateShard?.locale === undefined ? {} : { locale: candidateShard.locale }),
      ...(running.record.manifest?.missingServices === undefined
        ? {}
        : { missingServices: running.record.manifest.missingServices }),
      workPaths: shard.workPaths,
    });
    yield* journeys
      .saveCandidate({
        ...candidate,
        status: "pending",
        replay: { brief, targetId: manifest.id, workId, attemptId, commit: manifest.commit },
      })
      .pipe(Effect.mapError(failure));
    return { candidateId: candidate.id, workId, attemptId, brief };
  });
  const candidateSettle: ChampionService["Service"]["candidateSettle"] = Effect.fn(
    "ChampionService.candidateSettle",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const config = doc.champion.journeys;
    const candidate = yield* journeys
      .readCandidate(input.candidateId)
      .pipe(Effect.mapError(failure));
    if (config === undefined || candidate === undefined || candidate.checkId !== check.id)
      return yield* new ChampionError({ reason: "not-found" });
    const { replay } = candidate;
    if (replay === null)
      return yield* new ChampionError({ reason: "conflict", detail: "Start its replay first." });
    if (candidate.status !== "pending")
      return {
        candidateId: candidate.id,
        status: candidate.status,
        reason: candidate.reason ?? "",
        findingId: candidate.findingId,
      };
    const records = yield* threads
      .getThreadRecords(doc.champion.ownerThreadId, ["subagents"])
      .pipe(Effect.mapError(failure));
    let found: { task: (typeof records.subagents)[number]; model: string } | undefined;
    for (const task of records.subagents) {
      if (task.childThreadId === null) continue;
      const shell = yield* threads
        .getThreadShell(task.childThreadId)
        .pipe(Effect.mapError(failure));
      if (
        shell?.agentTask?.workId === replay.workId &&
        shell.agentTask.attemptId === replay.attemptId
      )
        found = { task, model: shell.modelSelection.model };
    }
    const unsettled = (reason: string) => ({
      candidateId: candidate.id,
      status: "pending" as const,
      reason,
      findingId: null,
    });
    if (found === undefined) return unsettled("Its replay has not started: delegate it first.");
    if (!["completed", "failed", "cancelled", "interrupted"].includes(found.task.status))
      return unsettled("Its replay is still running.");
    const finished = found;
    const independent = !(yield* journeyModels(doc)).has(finished.model);
    const close = Effect.fn("ChampionService.closeCandidate")(function* (
      status: ChampionJourneys.JourneyCandidate["status"],
      reason: string,
      findingId: string | null,
      reproduction: string | null = null,
    ) {
      yield* journeys
        .saveCandidate({
          ...candidate,
          status,
          reason,
          findingId: findingId ?? candidate.findingId,
          ...(reproduction === null ? {} : { reproduction }),
          ...(independent ? {} : { independent: false }),
        })
        .pipe(Effect.mapError(failure));
      yield* journeys.endReplay({
        checkId: check.id,
        config,
        workId: replay.workId,
        targetId: replay.targetId,
      });
      return {
        candidateId: candidate.id,
        status,
        reason,
        findingId: findingId ?? candidate.findingId,
      };
    });
    const verdict = parseVerdict(finished.task.result);
    if (verdict === null || verdict.verdict === "blocked")
      return yield* close(
        "inconclusive",
        verdict?.reason ?? "The replay ended without a verdict.",
        null,
      );
    // A failure a declared missing service causes reproduces every time, and is still not a bug.
    if (candidate.kind === "candidate" && verdict.missingService !== null) {
      const stored = yield* journeys.readRecord(check.id).pipe(Effect.mapError(failure));
      const named = verdict.missingService.toLowerCase();
      const service = stored?.record.manifest?.missingServices?.find(
        (declared) => declared.name.toLowerCase() === named,
      );
      if (service !== undefined)
        return yield* close(
          "rejected",
          `Missing service: ${service.name}. ${service.what} ${verdict.reason}`,
          null,
        );
    }
    if (candidate.kind === "retest") {
      if (verdict.verdict === "reproduced")
        return yield* close("still-failing", verdict.reason, candidate.findingId);
      if (replay.commit === candidate.commit)
        return yield* close(
          "inconclusive",
          "It passed, but on the same build it failed on, so this proves no fix.",
          candidate.findingId,
        );
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(doc.champion.id);
          const finding = current.findings.find((f) => f.id === candidate.findingId);
          if (finding === undefined) return;
          const closed: ChampionFinding = {
            ...finding,
            status: "verified",
            revision: replay.commit,
            updatedAt: yield* now,
          };
          yield* write({
            ...current,
            findings: current.findings.map((f) => (f.id === finding.id ? closed : f)),
          });
          yield* activity(
            doc.champion.id,
            "finding-verified",
            `Its replay passed on build ${replay.commit}: ${verdict.reason}`,
            closed,
          );
        }),
      );
      return yield* close("fixed", verdict.reason, candidate.findingId);
    }
    if (verdict.verdict === "not-reproduced") return yield* close("rejected", verdict.reason, null);
    const findingId = yield* mutate(
      Effect.gen(function* () {
        // Two settles of one replay raise one finding.
        const latest = yield* journeys.readCandidate(candidate.id).pipe(Effect.mapError(failure));
        if (latest?.findingId != null) return latest.findingId;
        const current = yield* read(doc.champion.id);
        // A check often walks into a bug still open from an earlier one; that is one bug, not two.
        for (const open of current.findings.filter(
          (f) => f.id.includes(":qualitative:") && f.status === "open",
        )) {
          const known = yield* journeys.confirmedFor(open.id).pipe(Effect.mapError(failure));
          if (known === undefined || !sameFailure(known, candidate)) continue;
          yield* journeys
            .saveCandidate({ ...candidate, findingId: open.id })
            .pipe(Effect.mapError(failure));
          return open.id;
        }
        const clicks = yield* encodeClicks(
          candidate.steps.map((step) => ({
            url: step.url,
            target: step.target,
            option: step.option,
          })),
        ).pipe(Effect.mapError(failure));
        const evidenceText = findingEvidence({
          observed: candidate.observed,
          expected: candidate.expected,
          commit: replay.commit,
          steps: describeSteps(candidate.steps),
          clicks,
          model: finished.model,
          independent,
          reason: verdict.reason,
          reproduction: verdict.steps,
          screenshot: verdict.screenshot ?? candidate.screenshots.at(-1) ?? "none recorded",
        });
        // One finding per replayed bug, never merged by title: two bugs can read alike.
        const finding = yield* makeFinding(doc.champion.id, candidate.title, evidenceText);
        yield* write({ ...current, findings: [...current.findings, finding] });
        yield* journeys
          .saveCandidate({ ...candidate, findingId: finding.id })
          .pipe(Effect.mapError(failure));
        yield* activity(doc.champion.id, "finding-opened", finding.evidence, finding);
        return finding.id;
      }),
    );
    return yield* close("confirmed", verdict.reason, findingId, verdict.steps);
  });
  const journeyRecord: ChampionService["Service"]["journeyRecord"] = (input) =>
    journeys.recordOf(input.checkId, input.includeJourneys === true);
  const guardDelegation: ChampionService["Service"]["guardDelegation"] = Effect.fn(
    "ChampionService.guardDelegation",
  )(function* ({ ownerThreadId, request, clientRequestId, followup, task, remote }) {
    const owner = yield* byThread(ownerThreadId);
    if (owner === undefined) return;
    if (!runsHere(owner.champion)) return yield* runsElsewhere(owner.champion);
    if (isCandidateWorkId(request?.workId))
      return yield* guardConfirmation(ownerThreadId, request!, task, followup === true);
    if (yield* journeys.ownerBusy(ownerThreadId).pipe(Effect.mapError(failure)))
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "During a journey check the only delegation is a replay.",
      });
    if (ChampionEvidence.isMeasurementWorkId(request?.workId)) {
      const run = yield* ownerRun(ownerThreadId);
      if (run === undefined)
        return yield* new ChampionError({
          reason: "unauthorized",
          detail: "A measurement is requested from the champion owner's active check run.",
        });
      const guarded = yield* evidence.guardMeasurement({
        ownerThreadId,
        request: request!,
        clientRequestId,
        followup: followup === true,
        remote,
        runMessageIds: run.messageIds,
      });
      const recorded = guarded.replay
        ? yield* evidence.recordedBinding(ownerThreadId, clientRequestId)
        : undefined;
      if (recorded !== undefined) return recorded.effective;
      const doc = yield* byThread(ownerThreadId);
      if (!doc) return yield* new ChampionError({ reason: "unavailable" });
      return yield* measurementSelection(doc, request!, guarded.avoid);
    }
    // A check, review or setup thread delegates nothing else: the case flow does that work.
    return yield* new ChampionError({ reason: "unauthorized", detail: CASE_FLOW_REFUSAL });
  });
  const delegationOutcome: ChampionService["Service"]["delegationOutcome"] = Effect.fn(
    "ChampionService.delegationOutcome",
  )(function* (input) {
    if (!input.request || !input.clientRequestId) return;
    if (
      yield* evidence.outcome(
        input.ownerThreadId,
        input.request,
        input.clientRequestId,
        input.state,
      )
    )
      yield* PubSub.publish(changes, undefined);
  });
  const history: ChampionService["Service"]["history"] = Effect.fn("ChampionService.history")(
    function* (input) {
      yield* read(input.id);
      const limit = input.limit ?? 50;
      const before = input.before ?? "9999";
      const rows = yield* sql<{ sort_key: string; kind: string; document_json: string }>`
      SELECT id AS sort_key, 'activity' AS kind, document_json FROM champion_activity
        WHERE champion_id = ${input.id} AND id < ${before}
      UNION ALL
      SELECT started_at || ':' || id AS sort_key, 'check' AS kind, document_json FROM champion_checks
        WHERE champion_id = ${input.id} AND started_at || ':' || id < ${before} AND status = 'reported'
      UNION ALL
      SELECT created_at || ':' || metric_id || ':' || version AS sort_key, 'definition' AS kind, document_json FROM champion_metric_definitions
        WHERE champion_id = ${input.id} AND created_at || ':' || metric_id || ':' || version < ${before}
      UNION ALL
      SELECT at || ':' || id AS sort_key, 'finding' AS kind, document_json FROM champion_finding_archive
        WHERE champion_id = ${input.id} AND at || ':' || id < ${before}
      ORDER BY sort_key DESC LIMIT ${limit + 1}
    `.pipe(Effect.mapError(failure));
      const page = rows.slice(0, limit);
      const activityItems = yield* Effect.forEach(
        page.filter((r) => r.kind === "activity"),
        (r) => decodeActivity(r.document_json).pipe(Effect.mapError(failure)),
      );
      const checks = yield* Effect.forEach(
        page.filter((r) => r.kind === "check"),
        (r) => decodeCheck(r.document_json).pipe(Effect.mapError(failure)),
      );
      const definitions = yield* Effect.forEach(
        page.filter((r) => r.kind === "definition"),
        (r) => decodeMetric(r.document_json).pipe(Effect.mapError(failure)),
      );
      const findings = yield* Effect.forEach(
        page.filter((r) => r.kind === "finding"),
        (r) => decodeFinding(r.document_json).pipe(Effect.mapError(failure)),
      );
      return {
        findings,
        definitions,
        activity: activityItems,
        samples: checks.flatMap((c) => c.samples ?? []),
        nextCursor: rows.length > limit ? (page.at(-1)?.sort_key ?? null) : null,
      };
    },
  );
  /** Opens, once, the cases of findings an upgrade left open without one (migration 158). */
  const backfillCases = Effect.gen(function* () {
    const rows = yield* sql<{
      champion_id: string;
      finding_id: string;
    }>`SELECT champion_id, finding_id FROM champion_case_backfill`.pipe(Effect.mapError(failure));
    for (const championId of new Set(rows.map((row) => row.champion_id))) {
      const findingIds = rows
        .filter((row) => row.champion_id === championId)
        .map((row) => row.finding_id);
      yield* mutate(
        Effect.gen(function* () {
          const doc = yield* read(championId).pipe(Effect.option);
          if (Option.isSome(doc) && runsHere(doc.value.champion)) {
            const batch = yield* ChangeBatch;
            for (const id of findingIds) batch?.forced.add(id);
            yield* write(doc.value);
          }
          yield* sql`DELETE FROM champion_case_backfill WHERE champion_id = ${championId}`.pipe(
            Effect.mapError(failure),
          );
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("champions.case-backfill-failed", { championId, cause }),
        ),
      );
    }
  });
  const runDue = Effect.gen(function* () {
    const timestamp = yield* now;
    const pendingDecisions = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_decision_deliveries WHERE delivered = 0 LIMIT 100`.pipe(
      Effect.mapError(failure),
    );
    for (const row of pendingDecisions) yield* deliverDecision(row.id).pipe(Effect.ignore);
    yield* backfillCases;
    const away = yield* isAway;
    const resumed: Array<Effect.Effect<void>> = [];
    for (const champion of (yield* list({})).champions) {
      if (!runsHere(champion)) continue;
      const doc = { champion };
      const stale = champion.latestSamples?.filter((sample) => sample.health === "stale") ?? [];
      const needsAttention =
        champion.lifecycle === "active" && stale.some((sample) => sample.required);
      if (
        (needsAttention && !champion.attention.includes("Required measurements are stale.")) ||
        stale.some((sample) => sample.staleAt !== null && champion.updatedAt < sample.staleAt)
      )
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(champion.id);
            yield* write({
              ...current,
              champion: {
                ...current.champion,
                attention: needsAttention
                  ? [
                      ...new Set([
                        ...current.champion.attention,
                        "Required measurements are stale.",
                      ]),
                    ]
                  : current.champion.attention,
              },
            });
          }),
        );
      const reconciled = yield* evidence.reconcile(champion.id);
      if (reconciled.changed) yield* PubSub.publish(changes, undefined);
      const existingAttention = champion.attention.filter((item) =>
        item.startsWith("Measurement:"),
      );
      if (existingAttention.join("\n") !== reconciled.attention.join("\n"))
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(champion.id);
            yield* write({
              ...current,
              champion: {
                ...current.champion,
                attention: [
                  ...current.champion.attention.filter((item) => !item.startsWith("Measurement:")),
                  ...reconciled.attention,
                ],
              },
            });
          }),
        );
      // A Champion from before goal reviews gets its first one scheduled, never run at once.
      if (champion.lifecycle === "active" && champion.nextReviewAt == null)
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(champion.id);
            if (current.champion.nextReviewAt == null) yield* write(current);
          }),
        );
      // Switching to Away, or a case opened while away, starts every open case that never ran.
      if (away && (champion.openFindingCount > 0 || champion.stuckEscalationThreadId != null))
        yield* startIdleCases(yield* read(champion.id));
      for (const pendingId of [
        doc.champion.outstandingCheckId,
        doc.champion.outstandingSetupId ?? null,
        doc.champion.outstandingReviewId ?? null,
      ]) {
        if (pendingId === null) continue;
        const check = yield* readCheck(pendingId);
        if (check.reported || check.cancelled) continue;
        if (!check.dispatched) {
          resumed.push(advance(check).pipe(Effect.ignore));
          continue;
        }
        const shell = check.dispatched
          ? yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure))
          : null;
        const records =
          shell !== null && check.dispatched
            ? yield* threads
                .getThreadRecords(check.threadId, ["runs"])
                .pipe(Effect.mapError(failure))
            : undefined;
        const runsById = new Map(records?.runs.map((run) => [run.id, run]));
        const matchingRuns =
          records?.runs.filter((run) =>
            checkRunMessages(run, runsById).includes(check.messageId),
          ) ?? [];
        const endedWithoutReport =
          matchingRuns.some((run) => ThreadManagement.isTerminalRunStatus(run.status)) &&
          !matchingRuns.some(ThreadManagement.isActiveRun);
        // An owner that stopped for good would otherwise keep its target's servers until they expire.
        if (doc.champion.journeys !== undefined && check.kind === "check" && shell !== null) {
          const subagents = yield* threads
            .getThreadRecords(check.threadId, ["subagents"])
            .pipe(Effect.mapError(failure));
          const quietFor = DateTime.distance(
            DateTime.makeUnsafe(shell.updatedAt),
            yield* DateTime.now,
          );
          if (
            shell.activeRunId === null &&
            endedWithoutReport &&
            !subagents.subagents.some((task) => task.status === "running") &&
            Duration.isGreaterThanOrEqualTo(quietFor, JOURNEY_OWNER_GONE_AFTER)
          ) {
            yield* journeys
              .finish({
                checkId: check.id,
                championId: doc.champion.id,
                threadId: doc.champion.ownerThreadId,
                config: doc.champion.journeys,
                owner: undefined,
                forcedReason: "The check's owner stopped without reporting.",
              })
              .pipe(Effect.ignore);
          }
        }
        const endedAttention = `${runLabel(check.kind)} run ended without an authenticated report.`;
        if (
          matchingRuns.some(ThreadManagement.isActiveRun) &&
          doc.champion.attention.some((item) => item.startsWith(endedAttention))
        ) {
          yield* mutate(
            Effect.gen(function* () {
              const current = yield* read(doc.champion.id);
              const latest = yield* readCheck(check.id);
              if (latest.reported || latest.cancelled || latest.messageId !== check.messageId)
                return;
              yield* write({
                ...current,
                champion: {
                  ...current.champion,
                  attention: current.champion.attention.filter(
                    (item) => !item.startsWith(endedAttention),
                  ),
                },
              });
            }),
          );
        }
        // Decided by the failure itself: an overloaded run can also leave the thread failed.
        const endedOnOverload =
          endedWithoutReport && isProviderOverloadedFailureCode(shell?.lastErrorCode);
        if (endedOnOverload && (check.automaticRetries ?? 0) < MAX_AUTOMATIC_CHECK_RETRIES) {
          yield* start(doc.champion.id, check.kind, false, true).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("champions.overload-retry-failed", {
                championId: doc.champion.id,
                checkId: check.id,
                cause,
              }).pipe(
                Effect.andThen(
                  mutate(
                    Effect.gen(function* () {
                      const current = yield* read(doc.champion.id);
                      const note = `${runLabel(check.kind)} automatic retry after a provider overload could not start. ${retryHint(check.kind)} to retry.`;
                      if (current.champion.attention.includes(note)) return;
                      yield* write({
                        ...current,
                        champion: {
                          ...current.champion,
                          attention: [...current.champion.attention, note],
                        },
                      });
                    }),
                  ).pipe(Effect.ignore),
                ),
              ),
            ),
          );
          continue;
        }
        // A limit ends the run: retry once on the backup, else skip it so the next check starts on time.
        // A pooled main model moves between accounts first, by AccountFailover, as for any thread.
        // One definition of a usage limit for threads and Champions: the failure's class or its words.
        if (
          endedWithoutReport &&
          shell !== null &&
          isUsageLimitFailure({
            class: shell.lastErrorClass ?? "provider_error",
            message: shell.lastError ?? "",
          })
        ) {
          const handled = yield* endedOnUsageLimit(
            doc,
            check,
            shell.usageLimitResetAt ?? null,
            shell.updatedAt,
          );
          if (handled) continue;
        }
        // A readings run or review that ends without its report gets one pointed follow-up per claim.
        if (
          endedWithoutReport &&
          check.kind !== "setup" &&
          check.repromptMessageId === undefined &&
          !endedOnOverload &&
          shell !== null &&
          shell.lastErrorCode !== "overloaded" &&
          shell.usageLimitResetAt == null
        ) {
          const reprompted = yield* start(
            doc.champion.id,
            check.kind,
            false,
            true,
            undefined,
            true,
          ).pipe(
            Effect.andThen(readCheck(check.id)),
            Effect.map((latest) => latest.repromptMessageId === latest.messageId),
            Effect.orElseSucceed(() => false),
          );
          if (reprompted) continue;
        }
        const ownershipLost =
          check.dispatched &&
          (shell === null ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            shell.status === "failed" ||
            shell.usageLimitResetAt != null);
        if (
          endedWithoutReport ||
          ownershipLost ||
          Date.parse(timestamp) - Date.parse(check.startedAt) > OVERDUE_MS[check.kind]
        ) {
          yield* mutate(
            Effect.gen(function* () {
              const current = yield* read(doc.champion.id);
              const latest = yield* readCheck(check.id);
              if (latest.reported || latest.cancelled || latest.messageId !== check.messageId)
                return;
              const attention = endedOnOverload
                ? `${runLabel(check.kind)} automatic retries exhausted after ${MAX_AUTOMATIC_CHECK_RETRIES} provider overloads. ${retryHint(check.kind)} to retry.`
                : endedWithoutReport
                  ? `${endedAttention} ${retryHint(check.kind)} to retry.`
                  : `${runLabel(check.kind)} report overdue or ownership lost. Inspect the ${check.kind === "setup" ? "setup" : "owner"} thread.`;
              // A run that ended with no retry left and whose next one is due is over: release the claim
              // in the same write, so it cannot hold the schedule forever. Before then, a manual run
              // still retries the claim in place.
              const nextAt =
                check.kind === "review"
                  ? (current.champion.nextReviewAt ?? null)
                  : current.champion.nextCheckAt;
              const release =
                endedWithoutReport &&
                check.kind !== "setup" &&
                current.champion.lifecycle === "active" &&
                nextAt !== null &&
                nextAt <= timestamp;
              // Each ended run counts once towards the Champion being stuck, in its own rhythm's streak.
              const counts = check.kind !== "setup" && latest.failureCounted !== true;
              if (release || counts)
                yield* saveCheck({
                  ...latest,
                  ...(release ? { cancelled: true } : {}),
                  ...(counts ? { failureCounted: true } : {}),
                });
              if (!current.champion.attention.includes(attention) || release || counts)
                yield* write({
                  ...current,
                  champion: {
                    ...current.champion,
                    ...(release ? { [outstandingField(check.kind)]: null } : {}),
                    ...(counts && check.kind === "check"
                      ? {
                          consecutiveCheckFailures:
                            (current.champion.consecutiveCheckFailures ?? 0) + 1,
                        }
                      : {}),
                    ...(counts && check.kind === "review"
                      ? {
                          consecutiveReviewFailures:
                            (current.champion.consecutiveReviewFailures ?? 0) + 1,
                        }
                      : {}),
                    attention: current.champion.attention.includes(attention)
                      ? current.champion.attention
                      : [...current.champion.attention, attention],
                  },
                });
            }),
          );
        }
      }
      if (doc.champion.journeys !== undefined)
        for (const checkId of yield* journeys
          .orphanedChecks(doc.champion.id)
          .pipe(Effect.orElseSucceed(() => [] as string[])))
          yield* journeys
            .finish({
              checkId,
              championId: doc.champion.id,
              threadId: doc.champion.ownerThreadId,
              config: doc.champion.journeys,
              owner: undefined,
              forcedReason:
                "The server restarted during the check, so nothing watched it to its end.",
            })
            .pipe(Effect.ignore);
      if (
        doc.champion.outstandingCheckId === null &&
        doc.champion.lifecycle === "active" &&
        doc.champion.nextCheckAt !== null &&
        doc.champion.nextCheckAt <= timestamp
      )
        resumed.push(start(doc.champion.id, "check", true).pipe(Effect.ignore));
      if (
        (doc.champion.outstandingReviewId ?? null) === null &&
        doc.champion.lifecycle === "active" &&
        doc.champion.nextReviewAt != null &&
        doc.champion.nextReviewAt <= timestamp
      )
        resumed.push(start(doc.champion.id, "review", true).pipe(Effect.ignore));
    }
    // Together, so one champion's slow command holds up no other champion's check.
    yield* Effect.forEach(resumed, (effect) => effect, { concurrency: "unbounded", discard: true });
  });
  /** Whether the limit is dealt with for now: retried, ended as skipped, or waiting for account failover. */
  const endedOnUsageLimit = Effect.fn("ChampionService.endedOnUsageLimit")(function* (
    doc: Pick<Document, "champion">,
    check: Check,
    until: string | null,
    endedAt: DateTime.Utc,
  ) {
    const slot = yield* slotOf(doc, slotKind(check.kind));
    const failedOn = check.executionAttempt?.resolvedSelection;
    // A run already on the backup, or with no model recorded, has nothing left to try.
    const retriable =
      slot !== null && failedOn !== undefined && check.executionAttempt?.slot !== "backup";
    if (retriable) {
      const source = yield* modelSource;
      const picked = ChampionModels.pickSlot(slot.slot, source, {
        failed: { selection: failedOn, until },
      });
      // Account failover moves a pooled model first; when it has not acted within its grace, retry here.
      const waitedMs =
        DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(endedAt);
      if (picked.use?.slot === "main" && !(waitedMs > FAILOVER_GRACE_MS)) return true;
      if (picked.use !== null) {
        const started = yield* start(doc.champion.id, check.kind, false, true, { until }).pipe(
          Effect.result,
        );
        // start() hands back the old claim when its retry guards refuse, so only a new message is a retry.
        const retried =
          started._tag === "Success" &&
          (yield* readCheck(check.id).pipe(
            Effect.map((latest) => latest.messageId !== check.messageId),
            Effect.orElseSucceed(() => true),
          ));
        if (retried) return true;
      }
    }
    const source = yield* modelSource;
    const message =
      slot === null
        ? `${SKIPPED}${runWhat(check.kind)}: no Champion models are set.`
        : ChampionModels.skipMessage({
            what: runWhat(check.kind),
            slot: slot.slot,
            assessed: ChampionModels.pickSlot(slot.slot, source, {
              failed: failedOn === undefined ? undefined : { selection: failedOn, until },
            }),
            providers: source.providers,
            nextCheckAt:
              check.kind === "check" && doc.champion.lifecycle === "active"
                ? doc.champion.nextCheckAt
                : null,
          });
    yield* recordSkip({
      id: doc.champion.id,
      kind: check.kind,
      message,
      advance: false,
      ended: check,
    });
    // Settled, the usage-limit auto-resume leaves the thread alone; the next check's message unsettles it.
    const shell = yield* threads.getThreadShell(check.threadId).pipe(Effect.option);
    if (Option.isSome(shell) && shell.value !== null && shell.value.latestRunId != null)
      yield* threads
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`champion:${check.id}:limit-settle`),
          threadId: check.threadId,
          expectedLatestRunId: shell.value.latestRunId,
        })
        .pipe(Effect.ignore);
    return true;
  });
  const shellSubscription = yield* PubSub.subscribe(shellChanges);
  yield* Stream.fromSubscription(shellSubscription).pipe(
    Stream.runForEach(
      Effect.fn("ChampionService.refreshOwnerShell")(
        function* (threadId) {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
          if (shell === null || shell.deletedAt !== null) return;
          // Shell metadata reads the champion ledger; its attention edge needs a normal durable shell event.
          yield* threads
            .dispatch({
              type: "thread.metadata.update",
              threadId,
              commandId: CommandId.make(`champion-attention:${yield* uuid}`),
            })
            .pipe(Effect.mapError(failure));
        },
        Effect.catch(() => Effect.logWarning("Champion owner shell refresh unavailable.")),
      ),
    ),
    Effect.forkScoped,
  );
  const applyWaitingProposals = Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      proposal_json: string;
    }>`SELECT id, json_extract(document_json, '$.proposal') AS proposal_json FROM champions WHERE json_type(document_json, '$.proposal') = 'object'`;
    for (const row of rows) {
      const outcome = yield* decodeWaitingProposal(row.proposal_json).pipe(
        Effect.mapError(failure),
        Effect.flatMap((proposal) =>
          changeMetrics(
            {
              id: row.id,
              ...proposal,
              reason: `Applied a change that was waiting for acceptance: ${proposal.reason}`,
            },
            undefined,
            { prove: false },
          ),
        ),
        Effect.result,
      );
      // Rewriting the document drops the stored proposal, applied or not.
      yield* mutate(
        Effect.gen(function* () {
          const doc = yield* read(row.id);
          yield* write({
            ...doc,
            champion: {
              ...doc.champion,
              attention: doc.champion.attention.filter(
                (a) => a !== "Metric proposal awaits acceptance.",
              ),
            },
          });
          if (outcome._tag === "Failure")
            yield* activity(
              row.id,
              "metrics-changed",
              `A metric change that was waiting for acceptance could not be applied: ${outcome.failure.detail ?? outcome.failure.reason}`,
            );
        }),
      );
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Champion waiting proposals could not be applied.", error),
    ),
  );
  yield* applyWaitingProposals;
  yield* scheduler.register("champions", runDue);
  const authenticateOwner = Effect.fn("ChampionService.authenticateOwner")(function* (
    caller: Caller,
    id: string,
  ) {
    const { shell } = yield* authenticateLive(caller);
    const doc = yield* read(id);
    if (
      doc.champion.ownerThreadId !== shell.id ||
      doc.champion.projectId !== shell.projectId ||
      shell.agentTask !== undefined
    )
      return yield* new ChampionError({ reason: "unauthorized" });
  });
  const recordLearning: ChampionService["Service"]["recordLearning"] = Effect.fn(
    "ChampionService.recordLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const refused = hostedRefusal((yield* read(input.id)).champion, "learnings");
    if (refused !== null) return yield* refused;
    const value = yield* evidence.recordLearning(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const contributeLearning: ChampionService["Service"]["contributeLearning"] = Effect.fn(
    "ChampionService.contributeLearning",
  )(function* (contributor, input) {
    const doc = yield* read(input.id);
    const refused = hostedRefusal(doc.champion, "learnings");
    if (refused !== null) return yield* refused;
    if (contributor.linkSessionId === null && contributor.threadId === doc.champion.ownerThreadId)
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "The Champion records its own learning with t3_champions_record_learning.",
      });
    if (doc.champion.lifecycle === "retired")
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "This Champion is retired and takes no new learnings.",
      });
    if (input.expectedCurrentId !== null) {
      // A contributor may revise a contribution; the Champion's own learning is its to supersede.
      const head = yield* learnings.read({ id: input.id, learningId: input.learningId }).pipe(
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      );
      if (
        head !== null &&
        head.current.revision.id === input.expectedCurrentId &&
        head.current.revision.contribution === undefined
      )
        return yield* new ChampionError({
          reason: "unauthorized",
          detail:
            "Only the Champion revises its own learning. Record what you found as a new learning with its own learningId.",
        });
    }
    const value = yield* evidence.recordLearning(input, contributor);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const confirmLearning: ChampionService["Service"]["confirmLearning"] = Effect.fn(
    "ChampionService.confirmLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* learnings.confirm(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const noteLearning: ChampionService["Service"]["noteLearning"] = Effect.fn(
    "ChampionService.noteLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* learnings.note(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const startMeasurementFromOwner: ChampionService["Service"]["startMeasurementFromOwner"] =
    Effect.fn("ChampionService.startMeasurementFromOwner")(function* (caller, input) {
      const { shell, run, runs } = yield* authenticateLive(caller);
      const doc = yield* read(input.id);
      if (
        doc.champion.ownerThreadId !== shell.id ||
        doc.champion.projectId !== shell.projectId ||
        shell.agentTask !== undefined
      )
        return yield* new ChampionError({ reason: "unauthorized" });
      const result = yield* evidence.startMeasurement({
        ownerThreadId: shell.id,
        runMessageIds: checkRunMessages(run, new Map(runs.map((r) => [r.id, r]))),
        measurement: input,
      });
      yield* PubSub.publish(changes, undefined);
      return result;
    });
  // Champion folders in agent-config (T3-839). The folder on main is the record and the
  // database the working copy: the runner applies edits it did not write, then saves its
  // own state back, reading and writing git objects only, never the checkout's working tree.
  const FOLDER_EVERY_MS = 300_000;
  const FOLDER_SOON_MS = 15_000;
  // Hosted repositories are read over the network; a save soon after a change reuses the last read.
  const HOSTED_POLL_MS = 300_000;
  const folderLock = yield* Semaphore.make(1);
  let folderSyncedAt = Number.NEGATIVE_INFINITY;
  const hereLabel = Option.isSome(serverEnvironment)
    ? yield* serverEnvironment.value.getDescriptor.pipe(
        Effect.map((descriptor): string => descriptor.label),
        Effect.catchCause(() => Effect.succeed("this machine")),
      )
    : "this machine";
  const decodeRevision = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ChampionLearningRevision),
  );
  const learningContentKeys = Object.keys(ChampionLearningContent.fields) as ReadonlyArray<
    keyof typeof ChampionLearningContent.Type
  >;
  const learningContentOf = (learning: typeof ChampionLearningContent.Type) =>
    Object.fromEntries(
      learningContentKeys.flatMap((key) =>
        learning[key] === undefined ? [] : [[key, learning[key]]],
      ),
    ) as typeof ChampionLearningContent.Type;
  const sameLearning = Schema.toEquivalence(ChampionLearningContent);
  const withNotes = (
    attention: ReadonlyArray<string>,
    prefix: string,
    notes: ReadonlyArray<string>,
  ) => [
    ...attention.filter((line) => !line.startsWith(prefix)),
    ...notes.map((note) => `${prefix}${note}`.slice(0, 1000)),
  ];
  const projectFor = Effect.fn("ChampionService.projectFor")(function* (repository: string) {
    if (Option.isNone(repositoryIdentities)) return null;
    const rows = yield* sql<{
      project_id: string;
      workspace_root: string;
    }>`SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at, project_id`.pipe(
      Effect.mapError(failure),
    );
    for (const row of rows)
      if (
        (yield* repositoryIdentities.value.resolve(row.workspace_root))?.canonicalKey === repository
      )
        return ProjectId.make(row.project_id);
    return null;
  });
  const repositoryOf = Effect.fn("ChampionService.repositoryOf")(function* (doc: Document) {
    if (doc.champion.folder !== undefined) return doc.champion.folder.repository;
    const project = yield* projects.getById(doc.champion.projectId).pipe(Effect.mapError(failure));
    if (Option.isNone(project) || Option.isNone(repositoryIdentities)) return null;
    return (
      (yield* repositoryIdentities.value.resolve(project.value.workspaceRoot))?.canonicalKey ?? null
    );
  });
  const currentLearnings = Effect.fn("ChampionService.currentLearnings")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT r.document_json FROM champion_learning_heads h JOIN champion_learning_revisions r ON r.id = h.revision_id WHERE h.champion_id = ${id} ORDER BY h.learning_id`.pipe(
      Effect.mapError(failure),
    );
    return yield* Effect.forEach(rows, (row) =>
      decodeRevision(row.document_json).pipe(Effect.mapError(failure)),
    );
  });
  const readingsOf = Effect.fn("ChampionService.readingsOf")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE champion_id = ${id}`;
    const readings: ChampionFolderReading[] = [];
    for (const row of rows)
      for (const sample of (yield* decodeCheck(row.document_json)).samples ?? [])
        readings.push({
          metricId: sample.metricId,
          version: sample.version,
          unit: sample.unit,
          status: sample.status,
          value: sample.value,
          observedAt: sample.observedAt,
          collectedAt: sample.collectedAt,
          source: sample.source,
          evidence: sample.evidence,
          revision: sample.revision,
          provenance: sample.provenance,
        });
    return readings;
  }, Effect.mapError(failure));
  const folderOf = Effect.fn("ChampionService.folderOf")(function* (
    doc: Document,
    repository: string,
  ) {
    const { champion } = doc;
    return {
      definition: {
        id: champion.id,
        name: champion.name,
        purpose: champion.purpose,
        repository,
        runner: { environmentId: here ?? "", label: hereLabel },
        lifecycle: champion.lifecycle,
        schedule: champion.schedule,
        charter: champion.charter,
        ...(champion.models === undefined ? {} : { models: champion.models }),
        ...(champion.journeys === undefined ? {} : { journeys: champion.journeys }),
        ...(champion.goalReview === undefined ? {} : { goalReview: champion.goalReview }),
      },
      metrics: doc.metrics,
      learnings: (yield* currentLearnings(champion.id)).map((revision) => ({
        ...learningContentOf(revision),
        learningId: revision.learningId,
        recordedAt: revision.recordedAt,
        reason: revision.reason,
        ...(revision.contribution === undefined ? {} : { contribution: revision.contribution }),
      })),
      findings: doc.findings
        .filter((finding) => !["verified", "dismissed"].includes(finding.status))
        .map((finding) => ({
          id: finding.id,
          metricId: finding.metricId,
          seriesId: finding.seriesId,
          title: finding.title,
          evidence: finding.evidence,
          status: finding.status,
          ...(finding.alarm === undefined ? {} : { alarm: finding.alarm }),
          ...(finding.firstSeenAt === undefined ? {} : { firstSeenAt: finding.firstSeenAt }),
          ...(finding.lastConfirmedAt === undefined
            ? {}
            : { lastConfirmedAt: finding.lastConfirmedAt }),
          revision: finding.revision,
          updatedAt: finding.updatedAt,
        })),
      readings: yield* readingsOf(champion.id),
    } as ChampionFolder;
  });
  /** Records a learning the folder holds unless its current revision already says the same. */
  const applyFolderLearning = Effect.fn("ChampionService.applyFolderLearning")(function* (
    id: string,
    learning: ChampionFolder["learnings"][number],
    reason: string,
    contribution: ChampionLearningContributor | undefined,
  ) {
    const [head] = yield* sql<{
      revision_id: string;
      document_json: string;
    }>`SELECT h.revision_id, r.document_json FROM champion_learning_heads h JOIN champion_learning_revisions r ON r.id = h.revision_id WHERE h.champion_id = ${id} AND h.learning_id = ${learning.learningId}`.pipe(
      Effect.mapError(failure),
    );
    const content = learningContentOf(learning);
    if (head !== undefined) {
      const current = yield* decodeRevision(head.document_json).pipe(Effect.mapError(failure));
      if (sameLearning(learningContentOf(current), content)) return;
    }
    yield* evidence.recordLearning(
      {
        id,
        learningId: learning.learningId,
        expectedCurrentId: head?.revision_id ?? null,
        reason,
        ...content,
      },
      contribution,
    );
  });
  const folderState = (
    path: string,
    repository: string,
    environmentId: string,
    label: string,
    definedIn: string | undefined,
  ) => ({
    path,
    repository,
    runner: { environmentId: EnvironmentId.make(environmentId), label },
    ...(definedIn === undefined ? {} : { definedIn }),
  });
  const folderName = (folder: FolderOnMain) =>
    folder.definedIn === undefined
      ? `agent-config ${folder.path}`
      : `its repository's ${folder.definedIn}`;
  /** A folder naming this machine and no local Champion synced from it: the local copy becomes the folder's. */
  const adoptFolder = Effect.fn("ChampionService.adoptFolder")(function* (
    folder: FolderOnMain,
    parsed: ReturnType<typeof parseChampionFolder>,
    blobs: Record<string, string>,
    base: string,
  ) {
    const definition = parsed.definition!;
    const existing = yield* read(definition.id).pipe(Effect.option);
    const projectId = yield* projectFor(definition.repository);
    if (projectId === null) {
      const note = `no project on this machine has the repository ${definition.repository}, so ${folder.path} does not run here.`;
      if (Option.isSome(existing))
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(definition.id);
            yield* write({
              ...current,
              champion: {
                ...current.champion,
                attention: withNotes(current.champion.attention, FOLDER_PROBLEM, [note]),
              },
            });
          }),
        );
      else yield* Effect.logWarning("champions.folder-without-project", { path: folder.path });
      return;
    }
    const at = yield* now;
    const short = base.slice(0, 8);
    const metrics = parsed.metrics ?? [];
    const lifecycle =
      definition.lifecycle === "active" && metrics.length === 0 ? "paused" : definition.lifecycle;
    const config: ChampionConfig = {
      id: definition.id,
      projectId,
      name: definition.name,
      purpose: definition.purpose,
      schedule: definition.schedule,
      charter: definition.charter,
      ...(definition.models === undefined ? {} : { models: definition.models }),
      ...(definition.journeys === undefined ? {} : { journeys: definition.journeys }),
      ...(definition.goalReview === undefined ? {} : { goalReview: definition.goalReview }),
    };
    const ownerThreadId = ThreadId.make(yield* uuid);
    const checkId = `folder:${definition.id}:${short}`;
    const series = new Map(metrics.map((metric) => [`${metric.id}@${metric.version}`, metric]));
    const samples = parsed.readings.flatMap((reading) => {
      const metric =
        series.get(`${reading.metricId}@${reading.version}`) ??
        metrics.find((m) => m.id === reading.metricId);
      return metric === undefined
        ? []
        : [
            {
              ...reading,
              championId: definition.id,
              checkId,
              seriesId: metric.seriesId,
              threadId: ownerThreadId,
              runId: null,
              modelSelection: null,
            } satisfies ChampionSample,
          ];
    });
    const latestSamples = metrics.flatMap((metric) => {
      const latest = samples
        .filter((sample) => sample.metricId === metric.id)
        .toSorted((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      return latest === undefined
        ? []
        : [
            {
              metricId: metric.id,
              name: metric.name,
              version: latest.version,
              seriesId: latest.seriesId,
              unit: latest.unit,
              required: metric.required ?? true,
              value: latest.value,
              status: latest.status,
              health: "unknown" as const,
              observedAt: latest.observedAt,
              collectedAt: latest.collectedAt,
              revision: latest.revision,
              staleAt: null,
            },
          ];
    });
    const findings = parsed.findings.map(({ carriedOver, ...finding }): ChampionFinding => ({
      ...finding,
      evidence:
        `Carried over from ${carriedOver?.from ?? folder.path} (${carriedOver?.at ?? short}). ${finding.evidence}`.slice(
          0,
          8000,
        ),
      status: "open",
      decision: null,
      updatedAt: at,
    }));
    const learningIds = parsed.learnings.map((learning) => learning.learningId);
    yield* mutate(
      Effect.gen(function* () {
        if (Option.isSome(existing))
          yield* sql`UPDATE champions SET project_id = ${projectId} WHERE id = ${definition.id}`.pipe(
            Effect.mapError(failure),
          );
        yield* write({
          champion: {
            ...config,
            lifecycle,
            ownerThreadId,
            setupThreadId: null,
            nextCheckAt: lifecycle === "active" ? yield* nextDue(config) : null,
            lastCheckAt: null,
            outstandingCheckId: null,
            outstandingSetupId: null,
            attention: withNotes([], FOLDER_PROBLEM, parsed.problems),
            openFindingCount: 0,
            updatedAt: at,
            latestSamples,
            folder: {
              ...folderState(
                folder.path,
                definition.repository,
                definition.runner.environmentId,
                definition.runner.label,
                folder.definedIn,
              ),
              savedAt: null,
            },
          },
          metrics,
          findings,
          folderFiles: blobs,
        });
        for (const metric of metrics) {
          const json = yield* encodeMetric(metric).pipe(Effect.mapError(failure));
          yield* sql`INSERT INTO champion_metric_definitions (champion_id, metric_id, version, created_at, document_json) VALUES (${definition.id}, ${metric.id}, ${metric.version}, ${metric.definedAt ?? at}, ${json}) ON CONFLICT DO NOTHING`.pipe(
            Effect.mapError(failure),
          );
        }
        if (samples.length > 0)
          yield* saveCheck({
            id: checkId,
            championId: definition.id,
            threadId: ownerThreadId,
            messageId: MessageId.make(checkId),
            commandId: CommandId.make(checkId),
            kind: "check",
            startedAt: at,
            measureOnly: true,
            metrics,
            reported: true,
            dispatched: true,
            dispatchKind: "send",
            samples,
          });
        if (Option.isSome(existing))
          for (const learning of yield* currentLearnings(definition.id))
            if (!learningIds.includes(learning.learningId))
              yield* sql`DELETE FROM champion_learning_heads WHERE champion_id = ${definition.id} AND learning_id = ${learning.learningId}`.pipe(
                Effect.mapError(failure),
              );
        yield* activity(
          definition.id,
          "configuration",
          `Adopted from ${folderName(folder)} at ${short}: ${metrics.length} metrics, ${parsed.learnings.length} learnings, ${findings.length} open findings carried over, ${samples.length} readings.`,
        );
      }),
    );
    const problems: string[] = [];
    for (const learning of parsed.learnings)
      yield* applyFolderLearning(
        definition.id,
        learning,
        learning.reason,
        learning.contribution,
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => problems.push(`learnings/${learning.learningId}: ${error.message}`)),
        ),
      );
    if (problems.length > 0)
      yield* noteFolderProblems(definition.id, [...parsed.problems, ...problems]);
  });
  const noteFolderProblems = Effect.fn("ChampionService.noteFolderProblems")(function* (
    id: string,
    notes: ReadonlyArray<string>,
  ) {
    yield* mutate(
      Effect.gen(function* () {
        const current = yield* read(id);
        const attention = withNotes(current.champion.attention, FOLDER_PROBLEM, notes);
        if (attention.join("\n") !== current.champion.attention.join("\n"))
          yield* write({ ...current, champion: { ...current.champion, attention } });
      }),
    );
  });
  /** Applies what an agent changed in a folder this machine already runs from; the file wins. */
  const applyFolderEdits = Effect.fn("ChampionService.applyFolderEdits")(function* (
    folder: FolderOnMain,
    parsed: ReturnType<typeof parseChampionFolder>,
    blobs: Record<string, string>,
    known: Record<string, string>,
    base: string,
  ) {
    const definition = parsed.definition!;
    const id = definition.id;
    const short = base.slice(0, 8);
    const reason = `Edited in agent-config at ${short}`;
    const problems = [...parsed.problems];
    const changed = (path: string) => blobs[path] !== known[path];
    const doc = yield* read(id);
    let gainedFirstMetrics = false;
    if (changed("metrics.json") && parsed.metrics !== null) {
      const current = yield* read(id);
      const inputs = parsed.metrics.map((metric) => withAlarm(metricInputOf(metric), metric.alarm));
      const retires = current.metrics
        .filter((metric) => !inputs.some((input) => input.id === metric.id))
        .map((metric) => metric.id);
      const differs =
        retires.length > 0 ||
        inputs.some((input) => {
          const stored = current.metrics.find((metric) => metric.id === input.id);
          return (
            stored === undefined || !sameDefinition(stored, input) || stored.alarm !== input.alarm
          );
        });
      if (differs)
        yield* applyMetricChange({
          id,
          metrics: inputs,
          ...(retires.length > 0 ? { retires } : {}),
          reason,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => problems.push(`metrics.json not applied: ${error.message}`)),
          ),
        );
      if (current.metrics.length === 0 && (yield* read(id)).metrics.length > 0)
        gainedFirstMetrics = true;
    }
    if (
      gainedFirstMetrics ||
      changed("champion.md") ||
      doc.champion.folder?.path !== folder.path ||
      doc.champion.folder?.definedIn !== folder.definedIn
    ) {
      const projectId =
        definition.repository === doc.champion.folder?.repository
          ? doc.champion.projectId
          : yield* projectFor(definition.repository);
      if (projectId === null || projectId !== doc.champion.projectId)
        problems.push(
          `its repository is now ${definition.repository}; a Champion keeps its project, so move it by giving it a new id.`,
        );
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(id);
          const lifecycle =
            definition.lifecycle === "active" && current.metrics.length === 0
              ? "paused"
              : definition.lifecycle;
          const config: ChampionConfig = {
            id,
            projectId: current.champion.projectId,
            name: definition.name,
            purpose: definition.purpose,
            schedule: definition.schedule,
            charter: definition.charter,
            ...(definition.models === undefined ? {} : { models: definition.models }),
            ...(definition.journeys === undefined ? {} : { journeys: definition.journeys }),
            ...(definition.goalReview === undefined ? {} : { goalReview: definition.goalReview }),
          };
          const {
            models: _models,
            journeys: _journeys,
            goalReview: _goalReview,
            ...kept
          } = current.champion;
          const scheduleMoved =
            lifecycle === "active" &&
            (current.champion.lifecycle !== "active" ||
              !isSameSchedule(current.champion.schedule, definition.schedule));
          yield* write({
            ...current,
            champion: {
              ...kept,
              ...config,
              lifecycle,
              nextCheckAt:
                lifecycle !== "active"
                  ? null
                  : scheduleMoved
                    ? yield* nextDue(config)
                    : current.champion.nextCheckAt,
              folder: {
                ...folderState(
                  folder.path,
                  current.champion.folder?.repository ?? definition.repository,
                  definition.runner.environmentId,
                  definition.runner.label,
                  folder.definedIn,
                ),
                savedAt: current.champion.folder?.savedAt ?? null,
              },
            },
          });
          yield* activity(
            id,
            "configuration",
            `Configuration updated from ${folderName(folder)} at ${short}.`,
          );
        }),
      );
    }
    const contribution: ChampionLearningContributor = {
      environmentId: null,
      environmentLabel: null,
      linkSessionId: null,
      threadId: `agent-config@${short}`,
      threadTitle: "File edit in agent-config",
      role: null,
    };
    for (const learning of parsed.learnings)
      yield* applyFolderLearning(id, learning, reason, contribution).pipe(
        Effect.catch((error) =>
          Effect.sync(() => problems.push(`learnings/${learning.learningId}: ${error.message}`)),
        ),
      );
    const vanished = Object.keys(known)
      .filter((path) => path.startsWith("learnings/") && path.endsWith(".md") && !(path in blobs))
      .flatMap((path) => {
        try {
          return [decodeURIComponent(path.slice("learnings/".length, -".md".length))];
        } catch {
          return [];
        }
      });
    if (vanished.length > 0)
      yield* mutate(
        Effect.gen(function* () {
          for (const learning of yield* currentLearnings(id))
            if (vanished.includes(learning.learningId)) {
              yield* sql`DELETE FROM champion_learning_heads WHERE champion_id = ${id} AND learning_id = ${learning.learningId}`.pipe(
                Effect.mapError(failure),
              );
              yield* activity(
                id,
                "configuration",
                `Learning "${learning.topic}" was removed from agent-config at ${short}; its revisions are kept.`,
              );
            }
        }),
      );
    yield* mutate(
      Effect.gen(function* () {
        const current = yield* read(id);
        yield* write({
          ...current,
          folderFiles: blobs,
          champion: {
            ...current.champion,
            attention: withNotes(current.champion.attention, FOLDER_PROBLEM, problems),
          },
        });
      }),
    );
  });
  /** Applies one folder on main; false while a file in it could not be applied, so it is not saved over. */
  const importFolder = Effect.fn("ChampionService.importFolder")(function* (
    folder: FolderOnMain,
    base: string,
  ) {
    const parsed = parseChampionFolder(
      folder.files.map((file) => ({ path: file.path, content: file.content })),
    );
    const definition = parsed.definition;
    if (definition === null || definition.id !== folder.id) {
      const problems =
        definition === null ? parsed.problems : ["champion.md's id differs from its folder name"];
      yield* Effect.logWarning("champions.folder-unreadable", { path: folder.path, problems });
      if (Option.isSome(yield* read(folder.id).pipe(Effect.option)))
        yield* noteFolderProblems(folder.id, problems);
      return false;
    }
    const existing = yield* read(definition.id).pipe(Effect.option);
    if (definition.runner.environmentId !== here) {
      if (Option.isNone(existing)) return true;
      const state = folderState(
        folder.path,
        definition.repository,
        definition.runner.environmentId,
        definition.runner.label,
        folder.definedIn,
      );
      const stored = existing.value.champion.folder;
      if (
        stored?.path === state.path &&
        stored.definedIn === folder.definedIn &&
        stored.runner.environmentId === state.runner.environmentId &&
        stored.runner.label === state.runner.label
      )
        return true;
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(definition.id);
          yield* write({
            ...current,
            champion: {
              ...current.champion,
              folder: { ...state, savedAt: current.champion.folder?.savedAt ?? null },
            },
          });
          yield* activity(
            definition.id,
            "configuration",
            `${folderName(folder)} says ${definition.runner.label} runs this Champion, so this machine starts no more work for it.`,
          );
        }),
      );
      return true;
    }
    const blobs = Object.fromEntries(
      folder.files.filter((file) => isManagedFile(file.path)).map((file) => [file.path, file.blob]),
    );
    const synced =
      Option.isSome(existing) && existing.value.champion.folder?.runner.environmentId === here;
    if (!synced) yield* adoptFolder(folder, parsed, blobs, base);
    else {
      const known = existing.value.folderFiles ?? {};
      const unchanged =
        existing.value.champion.folder?.path === folder.path &&
        existing.value.champion.folder.definedIn === folder.definedIn &&
        Object.keys(blobs).length === Object.keys(known).length &&
        Object.entries(blobs).every(([path, blob]) => known[path] === blob);
      if (!unchanged) yield* applyFolderEdits(folder, parsed, blobs, known, base);
    }
    const after = yield* read(definition.id).pipe(Effect.option);
    return (
      Option.isSome(after) &&
      !after.value.champion.attention.some((line) => line.startsWith(FOLDER_PROBLEM))
    );
  });
  const saveFolder = Effect.fn("ChampionService.saveFolder")(
    function* (
      root: string,
      base: { commit: string },
      onMain: ReadonlyMap<string, ReadonlyArray<AgentConfigGit.FolderFile>>,
      doc: Document,
    ) {
      const repository = yield* repositoryOf(doc);
      if (repository === null || here === null) return true;
      const path =
        doc.champion.folder?.path ?? championFolderPath(folderGroup(repository), doc.champion.id);
      const definedIn = doc.champion.folder?.definedIn;
      // A repository-hosted Champion's definition and learnings are its repository's; only its records are saved here.
      const rendered = renderChampionFolder(yield* folderOf(doc, repository)).filter(
        (file) => definedIn === undefined || isRecordFile(file.path),
      );
      const message = `champions: save ${doc.champion.name}`;
      const changesOn = (files: ReadonlyArray<AgentConfigGit.FolderFile>) =>
        folderChanges(
          path,
          files.filter((file) => definedIn === undefined || isRecordFile(file.path)),
          rendered,
        );
      let pushed = false;
      let refused: string | null = null;
      const changes = changesOn(onMain.get(path) ?? []);
      if (changes.length > 0) {
        const commit = yield* AgentConfigGit.commitChanges(root, {
          base: base.commit,
          changes,
          message,
        });
        if (commit !== null && (yield* AgentConfigGit.pushToMain(root, commit)) === "pushed") {
          base.commit = commit;
          pushed = true;
        } else if (commit !== null) {
          const result = yield* AgentConfigGit.publish(root, {
            prefix: `${path}/`,
            message,
            changes: (files) =>
              Effect.succeed(
                changesOn(
                  files.map((file) => ({ ...file, path: file.path.slice(path.length + 1) })),
                ),
              ),
          });
          if (result.outcome === "rejected")
            refused = "main kept moving while saving; it will try again.";
          else {
            pushed = result.outcome === "pushed";
            base.commit = result.outcome === "pushed" ? result.commit : result.base;
          }
        }
      }
      const renderedFiles = Object.fromEntries(
        rendered.map((file) => [file.path, AgentConfigGit.blobId(file.content)]),
      );
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(doc.champion.id);
          const files =
            definedIn === undefined
              ? renderedFiles
              : Object.fromEntries(
                  [
                    ...Object.entries(current.folderFiles ?? {}).filter(
                      ([file]) => !isRecordFile(file),
                    ),
                    ...Object.entries(renderedFiles),
                  ].toSorted(([a], [b]) => a.localeCompare(b)),
                );
          const folder = {
            ...folderState(path, repository, here, hereLabel, definedIn),
            savedAt:
              pushed || current.champion.folder?.savedAt == null
                ? refused === null
                  ? yield* now
                  : (current.champion.folder?.savedAt ?? null)
                : current.champion.folder.savedAt,
          };
          const attention = withNotes(
            current.champion.attention,
            NOT_SAVED,
            refused === null ? [] : [refused],
          );
          if (
            refused === null &&
            !pushed &&
            json(current.champion.folder ?? null) ===
              json({ ...folder, savedAt: current.champion.folder?.savedAt ?? null }) &&
            json(current.folderFiles ?? {}) === json(files) &&
            attention.join("\n") === current.champion.attention.join("\n")
          )
            return;
          yield* write({
            ...current,
            folderFiles: refused === null ? files : (current.folderFiles ?? {}),
            champion: { ...current.champion, folder, attention },
          });
        }),
      );
      return refused === null;
    },
    (effect, _root, _base, _onMain, doc) =>
      effect.pipe(
        Effect.catchTags({
          AgentConfigGitError: (error) =>
            mutate(
              Effect.gen(function* () {
                const current = yield* read(doc.champion.id);
                const attention = withNotes(current.champion.attention, NOT_SAVED, [
                  `${error.operation} failed: ${error.detail}`,
                ]);
                if (attention.join("\n") !== current.champion.attention.join("\n"))
                  yield* write({ ...current, champion: { ...current.champion, attention } });
              }),
            ),
        }),
      ),
  );
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const mirrorsRoot = Option.isSome(serverConfig)
    ? `${serverConfig.value.baseDir}/caches/champion-mirrors`
    : null;
  /** The earliest-created unarchived local project for each canonical repository key. */
  const localRepositories = Effect.fn("ChampionService.localRepositories")(function* () {
    const repositories = new Map<string, string>();
    if (Option.isNone(repositoryIdentities)) return repositories;
    const rows = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at, project_id`.pipe(
      Effect.mapError(failure),
    );
    for (const row of rows) {
      const key = (yield* repositoryIdentities.value.resolve(row.workspace_root))?.canonicalKey;
      if (key != null && !repositories.has(key)) repositories.set(key, row.workspace_root);
    }
    return repositories;
  });
  /** Repository-hosted Champions on each local repository's published integration branch. */
  let hostedRead: {
    readonly at: number;
    readonly key: string;
    readonly reads: ReadonlyArray<{
      canonicalKey: string;
      published: Effect.Success<ReturnType<typeof ProjectChampionGit.readPublished>>;
    }>;
  } | null = null;
  const hostedOnMain = Effect.fn("ChampionService.hostedOnMain")(function* (
    agentConfig: ReadonlyMap<string, ReadonlyArray<AgentConfigGit.FolderFile>>,
    reuse: boolean,
  ) {
    const found: Array<{ folder: FolderOnMain; commit: string; where: string }> = [];
    if (mirrorsRoot === null) return found;
    const repositories = yield* localRepositories();
    const key = json([...repositories]);
    const at = yield* Clock.currentTimeMillis;
    const cached = hostedRead;
    const fetched =
      reuse && cached !== null && cached.key === key && at - cached.at < HOSTED_POLL_MS
        ? cached.reads
        : null;
    const reads =
      fetched ??
      (yield* Effect.forEach(
        repositories,
        ([canonicalKey, checkout]) =>
          ProjectChampionGit.readPublished({ mirrorsRoot, canonicalKey, checkout }).pipe(
            Effect.catchTags({
              AgentConfigGitError: (error) =>
                Effect.logWarning("champions.repository-read-failed", {
                  repository: canonicalKey,
                  error,
                }).pipe(Effect.as(null)),
            }),
            Effect.map((published) => ({ canonicalKey, published })),
          ),
        { concurrency: 4 },
      ));
    if (fetched === null) hostedRead = { at, key, reads };
    for (const { canonicalKey, published } of reads) {
      if (published === null) continue;
      for (const folder of hostedFolders(canonicalKey, published.files, agentConfig))
        found.push({
          folder,
          commit: published.commit,
          where: `${canonicalKey} ${folder.definedIn}`,
        });
    }
    return found;
  });
  /** Holds each Champion defined in two places, and lets the rest go. */
  const noteDefinedTwice = Effect.fn("ChampionService.noteDefinedTwice")(function* (
    twice: ReadonlyMap<string, string>,
  ) {
    const rows = yield* sql<{ id: string }>`SELECT id FROM champions`.pipe(
      Effect.mapError(failure),
    );
    for (const row of rows) {
      const note = twice.get(row.id);
      const held = (yield* read(row.id)).champion.attention.some((line) =>
        line.startsWith(DEFINED_TWICE),
      );
      if (note === undefined && !held) continue;
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(row.id);
          const attention = withNotes(
            current.champion.attention,
            DEFINED_TWICE,
            note === undefined ? [] : [note],
          );
          if (attention.join("\n") !== current.champion.attention.join("\n"))
            yield* write({ ...current, champion: { ...current.champion, attention } });
        }),
      );
    }
  });
  /** The last fetched agent-config main, reused by dirty saves so they skip the network fetch. */
  let agentConfigRead: {
    readonly at: number;
    readonly root: string;
    readonly commit: string;
    readonly files: ReadonlyArray<AgentConfigGit.FolderFile>;
  } | null = null;
  const syncFoldersWith = Effect.fn("ChampionService.syncFolders")(function* (
    reuseHosted: boolean,
  ) {
    yield* Effect.gen(function* () {
      const root = yield* agentPolicyRoot;
      if (Option.isNone(root) || here === null) return;
      yield* folderLock.withPermits(1)(
        Effect.gen(function* () {
          const readAt = yield* Clock.currentTimeMillis;
          const cachedRead = agentConfigRead;
          const reused =
            reuseHosted &&
            cachedRead !== null &&
            cachedRead.root === root.value &&
            readAt - cachedRead.at < HOSTED_POLL_MS
              ? cachedRead
              : null;
          const commit =
            reused?.commit ??
            (yield* AgentConfigGit.fetchMain(root.value).pipe(Effect.mapError(failure)));
          const files =
            reused?.files ??
            (yield* AgentConfigGit.readFiles(root.value, commit, CHAMPIONS_PREFIX).pipe(
              Effect.mapError(failure),
            ));
          agentConfigRead = reused ?? { at: readAt, root: root.value, commit, files };
          const byFolder = filesByFolder(files);
          const hosted = yield* hostedOnMain(byFolder, reuseHosted);
          const folders = [
            ...foldersOnMain(files).map((folder) => ({
              folder,
              commit,
              where: `agent-config ${folder.path}`,
            })),
            ...hosted,
          ];
          const twice = new Map<string, string>();
          const firstWhere = new Map<string, string>();
          for (const { folder, where } of folders) {
            const other = firstWhere.get(folder.id);
            if (other === undefined) firstWhere.set(folder.id, where);
            else
              twice.set(
                folder.id,
                `${folder.id} is defined in ${other} and in ${where}; it runs on no machine until one is removed.`,
              );
          }
          for (const [id, note] of twice)
            yield* Effect.logWarning("champions.folder-defined-twice", { id, note });
          yield* noteDefinedTwice(twice);
          const seen = new Set(firstWhere.keys());
          // A folder with a file that does not parse is left as the agent wrote it until they fix it.
          const unsettled = new Set<string>(twice.keys());
          for (const { folder, commit: base } of folders) {
            if (twice.has(folder.id)) continue;
            const settled = yield* importFolder(folder, base).pipe(
              Effect.catch((error) =>
                Effect.logWarning("champions.folder-import-failed", {
                  path: folder.path,
                  error,
                }).pipe(Effect.as(false)),
              ),
            );
            if (!settled) unsettled.add(folder.id);
          }
          const onMain = byFolder;
          const base = { commit };
          let saveFailed = false;
          const rows = yield* sql<{
            document_json: string;
          }>`SELECT document_json FROM champions ORDER BY id`.pipe(Effect.mapError(failure));
          for (const row of rows) {
            const doc = yield* decodeDocument(row.document_json).pipe(Effect.mapError(failure));
            if (!runsHere(doc.champion) || twice.has(doc.champion.id)) continue;
            if (unsettled.has(doc.champion.id)) {
              yield* mutate(
                Effect.gen(function* () {
                  const current = yield* read(doc.champion.id);
                  const attention = withNotes(current.champion.attention, NOT_SAVED, [
                    "a file in its folder could not be applied; saving resumes once it is fixed.",
                  ]);
                  if (attention.join("\n") !== current.champion.attention.join("\n"))
                    yield* write({ ...current, champion: { ...current.champion, attention } });
                }),
              );
              continue;
            }
            if (
              doc.champion.folder === undefined &&
              (doc.champion.lifecycle === "retired" || seen.has(doc.champion.id))
            )
              continue;
            const saved = yield* saveFolder(root.value, base, onMain, doc).pipe(
              Effect.catch((error) =>
                Effect.logWarning("champions.folder-save-failed", { id: doc.champion.id, error }),
              ),
            );
            if (saved !== true) saveFailed = true;
          }
          if (saveFailed) agentConfigRead = null;
          else if (base.commit !== commit) {
            const pushedFiles = yield* AgentConfigGit.readFiles(
              root.value,
              base.commit,
              CHAMPIONS_PREFIX,
            ).pipe(Effect.orElseSucceed(() => null));
            agentConfigRead =
              pushedFiles === null
                ? null
                : {
                    at: agentConfigRead?.at ?? readAt,
                    root: root.value,
                    commit: base.commit,
                    files: pushedFiles,
                  };
          }
        }),
      );
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processes));
  });
  const syncFolders: ChampionService["Service"]["syncFolders"] = syncFoldersWith(false);
  yield* scheduler.register(
    "champion-folders",
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      if (at - folderSyncedAt < (folderDirty ? FOLDER_SOON_MS : FOLDER_EVERY_MS)) return;
      const soon = folderDirty;
      folderSyncedAt = at;
      folderDirty = false;
      yield* syncFoldersWith(soon).pipe(
        Effect.catchCause((cause) => Effect.logWarning("champions.folder-sync-failed", { cause })),
      );
    }),
  );

  return ChampionService.of({
    hasThreadContext,
    verifyApproval,
    setModels,
    modelDefaults: readDefaults,
    startMeasurementFromOwner,
    runtimeState: evidence.runtimeState,
    learningQuery: evidence.learningQuery,
    learningSearch: learnings.search,
    learningTopics: learnings.topics,
    learningRead: learnings.read,
    contributeLearning,
    confirmLearning,
    noteLearning,
    admitDelegation,
    recordedDelegationBinding: evidence.recordedBinding,
    recordLearning,
    list,
    get,
    upsert,
    setLifecycle,
    changeMetrics,
    completeSetup,
    cancelSetup,
    findingAction,
    setup: Effect.fn("ChampionService.setup")((input) => start(input.id, "setup")),
    runCheck: Effect.fn("ChampionService.runCheck")((input) => start(input.id, "check")),
    runReview: Effect.fn("ChampionService.runReview")((input) => start(input.id, "review")),
    startMetricsLead,
    checkContext,
    changeMetricsFromCheck,
    report,
    submitReport,
    journeysStart,
    journeyCandidate,
    candidateReplay,
    candidateSettle,
    journeyRecord,
    guardDelegation,
    delegationOutcome,
    history,
    runDue,
    syncFolders,
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(ChampionService, make).pipe(Layer.provide(ProcessRunner.layer));
