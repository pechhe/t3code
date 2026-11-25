import {
  ChampionModelDefaults,
  ChampionSetModelsInput,
  ChampionRuntimeState,
  ChampionLearningQueryInput,
  ChampionLearningQueryResult,
  ChampionLearningTopicsInput,
  ChampionLearningTopicsResult,
  ChampionLearningRecordInput,
  ChampionLearningRevision,
  ChampionMeasurement,
  ChampionMeasurementStartInput,
  ChampionAgentFindingActionInput,
  ChampionCandidateReplay,
  ChampionCandidateReplayInput,
  ChampionCandidateSettled,
  ChampionCandidateSettleInput,
  ChampionCheckContext,
  ChampionJourneyCandidateInput,
  ChampionJourneyPlan,
  ChampionJourneysStartInput,
  ChampionJourneyRecordInput,
  ChampionJourneyRecordResult,
  ChampionDetail,
  ChampionGetInput,
  ChampionHistoryInput,
  ChampionHistoryResult,
  ChampionListInput,
  ChampionMetricChange,
  ChampionReportInput,
  ChampionUpsertInput,
  OrchestratorMcpFailure,
  OrchestratorMcpEnvironmentTarget,
  EnvironmentId,
  ChampionLearningSearchInput,
  ChampionLearningSearchResult,
  ChampionLearningReadInput,
  ChampionLearningReadResult,
  ChampionLearningForwardedFrom,
  ChampionLearningConfirmInput,
  ChampionLearningNoteInput,
  ChampionLearningEntry,
} from "@t3tools/contracts";
import { ForwardedChampionApproval } from "../../../champions/ChampionApproval.ts";
import { ChampionDirectoryResult } from "../../../champions/ChampionDirectory.ts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Champions from "../../../champions/ChampionService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Champions.ChampionService,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const models = Tool.make("t3_champions_models", {
  ...shared,
  description:
    "Read or set this machine's Champion models, the ones every Champion runs on unless it has its own. checks is the model for readings; advice is the model for goal reviews and metric setup, and the fallback for cases. Each is a model with an optional backup that takes over when the model hits a usage limit and cannot move to another pooled account. Omit checks and advice to read; pass either to replace that slot as a whole, model and backup (a slot you leave out stays as it is). A Champion's own main model is set with models on t3_champions_upsert; the default's backup still applies. Returns the models now in force.",
  parameters: Schema.Struct({
    ...ChampionSetModelsInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionModelDefaults,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const get = Tool.make("t3_champions_get", {
  ...shared,
  description:
    "Read champion configuration, metrics, open findings (each with its case thread) and the goal-score series, here or in a linked environment named with environmentId. Set include to runtime_state for bounded execution provenance and measurements instead.",
  parameters: Schema.Struct({
    ...ChampionGetInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
    include: Schema.optional(Schema.Literals(["runtime_state"])),
  }),
  success: Schema.Union([ChampionDetail, ChampionRuntimeState]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const control = Tool.make("t3_champions_control", {
  ...shared,
  description:
    "Control a champion: pause, resume or retire it (in-flight work continues; resume never backfills), take readings now (run_check; a paused champion measures only; retired champions refuse), start a goal review now (run_review), start stronger-model setup (which changes the metrics itself), or cancel that setup keeping the current metrics and the draft.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "pause",
      "resume",
      "retire",
      "run_check",
      "run_review",
      "setup",
      "cancel_setup",
    ]),
    id: ChampionGetInput.fields.id,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const metrics = Tool.make("t3_champions_metrics", {
  ...shared,
  description:
    'Change a champion\'s metrics. The change applies at once: nobody accepts it, so tell the user what you changed. Use action edit with the champion id from any orchestrating thread, or action submit from your own authenticated setup run or routine check (a check still reports as usual). List only metrics to add or change; ones you do not list stay as they are, and to stop tracking one, name its id in retires. A champion tracks at most 32 metrics. Prove a metric works before adding it. Give a metric that is a plain read (a file, a count, a CLI query) collect: the argument list of a command the server runs itself at each check, with no shell, in the project root, within 30 seconds and with no provider keys or tokens in its environment. It must print a number, or JSON {"value": n, "revision"?: string, "evidence"?: string}. The server runs each new or changed command once before applying the change and refuses the whole change, with the command\'s output, if one fails. A metric without collect is measured by an agent at each check: measure it once yourself first, and put how in its description. A higher or lower metric may carry alarm, a value beyond its target whose reading starts a case at once; changing it keeps the metric\'s version.',
  parameters: Schema.Struct({
    action: Schema.Literals(["edit", "submit"]),
    id: Schema.optional(ChampionGetInput.fields.id),
    metrics: Schema.optional(ChampionMetricChange.fields.metrics),
    retires: ChampionMetricChange.fields.retires,
    reason: Schema.optional(ChampionMetricChange.fields.reason),
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const report = Tool.make("t3_champions_report", {
  ...shared,
  description:
    "Complete your readings run or goal review. Readings: use the frozen metric methods from t3_champions_check_context; copy metricId, version, unit and source verbatim, never paraphrase source; put execution commands, paths and collection details in evidence; failed collection uses value null and status error, never a fabricated value. Include every required metric it lists once; server-collected metrics are not listed and reporting one is refused. A goal review sends no samples and must send goalScore (score 0-10 for the whole goal, reasons it is not higher, change since the previous score citing readings); a readings run's goalScore is refused. Each new finding opens a case for an agent to work; supply existingFindingId to update an open one. Server derives identity and provenance. On a setup run, a summary alone completes it.",
  parameters: Schema.Struct({
    samples: Schema.optional(ChampionReportInput.fields.samples),
    findings: Schema.optional(ChampionReportInput.fields.findings),
    summary: Schema.optional(ChampionReportInput.fields.summary),
    goalScore: ChampionReportInput.fields.goalScore,
    journeys: Schema.optional(ChampionReportInput.fields.journeys),
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const learning_search = Tool.make("t3_champions_learning_search", {
  ...shared,
  description:
    "Search what Champions have learned before working in an area one covers: words match each learning's plain sentence, question and conclusion, ranked by relevance then recency. Omit projectId to search every Champion; name a linked environment with environmentId to search its Champions. Filters: due (review date passed), contributed (from other agents), needs-review. action topics lists the topics Champions hold learnings on instead. action query is the Champion owner's scoped lookup by exact topic, which retains a retrieval receipt a plain search never writes; it returns at most 20, and a linked environment may not use it.",
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["search", "topics", "query"])),
    ...ChampionLearningSearchInput.fields,
    ...ChampionLearningTopicsInput.fields,
    id: Schema.optional(ChampionLearningQueryInput.fields.id),
    topic: Schema.optional(ChampionLearningQueryInput.fields.topic),
    revisionId: Schema.optional(ChampionLearningQueryInput.fields.revisionId),
    due: Schema.optional(ChampionLearningQueryInput.fields.due),
    includeSuperseded: Schema.optional(ChampionLearningQueryInput.fields.includeSuperseded),
    observations: Schema.optional(ChampionLearningQueryInput.fields.observations),
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: Schema.Union([
    ChampionLearningSearchResult,
    ChampionLearningTopicsResult,
    ChampionLearningQueryResult,
  ]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const record_learning = Tool.make("t3_champions_record_learning", {
  ...shared,
  description:
    "Retain an immutable learning revision. As the authenticated Champion owner (the calling thread is that Champion's owner), include failed attempts, dated evidence, applicability and review conditions; leaves return evidence to their owner. As an orchestrating thread that is not that Champion, record what you learned in an area a Champion covers; name its environment with environmentId when it runs elsewhere. Same content and rules either way: plainSummary first, dated evidence, failed or inconclusive attempts, and a review condition. A contribution counts at once, marked as contributed by you; the Champion confirms or supersedes it on its next check. id is the existing Champion's id (championId in a learning search result), never a new one; a new learning takes a fresh learningId and expectedCurrentId null.",
  parameters: Schema.Struct({
    ...ChampionLearningRecordInput.fields,
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description: "Environment whose Champion this is. Omit for this one.",
      }),
    ),
    forwardedFrom: Schema.optional(
      ChampionLearningForwardedFrom.annotate({
        description: "Set by T3 when a linked environment passes the call on. Never set it.",
      }),
    ),
  }),
  success: ChampionLearningRevision,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const confirm_learning = Tool.make("t3_champions_confirm_learning", {
  ...shared,
  description:
    "As the authenticated Champion owner, confirm a learning another agent contributed (action confirm: learningId, revisionId and a note) after checking it. It records a confirmation on that revision and makes no new revision. To disagree, supersede it with t3_champions_record_learning and a reason instead. action note adds the plain sentence to a current learning recorded without one: one sentence someone outside engineering understands, saying what was learned; revision, conclusion and retrieval receipts stay as they are.",
  parameters: Schema.Struct({
    action: Schema.Literals(["confirm", "note"]),
    id: Schema.optional(ChampionLearningConfirmInput.fields.id),
    learningId: Schema.optional(ChampionLearningConfirmInput.fields.learningId),
    revisionId: Schema.optional(ChampionLearningConfirmInput.fields.revisionId),
    note: Schema.optional(ChampionLearningConfirmInput.fields.note),
    plainSummary: Schema.optional(ChampionLearningNoteInput.fields.plainSummary),
  }),
  success: ChampionLearningEntry,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const measurement = Tool.make("t3_champions_measurement", {
  ...shared,
  description:
    "Register a read-only browser audit, or a reviewer's confirmation of a completed one, of your live check; no finding needed. id is the champion's id. Returns the workId and attemptId for delegate_task: same role and sourceRevision, readOnly true.",
  parameters: ChampionMeasurementStartInput,
  success: ChampionMeasurement,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const finding_action = Tool.make("t3_champions_finding_action", {
  ...shared,
  description:
    "Close, reopen or answer on a finding, as the agent working its case or for the user. verify closes a finding confirmed fixed and dismiss one that needs no work, each with the evidence as reason; reopen opens it again with a fresh case. To answer a decision requested before cases replaced decision requests (action resolve_decision), pass decisionId, the answer as reason, and approvalQuote: the user's exact words, copied from a message they typed in this thread; without one it is refused and the decision keeps waiting on its card. A readings run or goal review only observes and may not use this tool; decision, diagnosis, reroute and spec are refused, and the case flow does that work.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "dismiss",
      "reopen",
      "verify",
      "resolve_decision",
      "decision",
      "diagnosis",
      "reroute",
      "spec",
    ]),
    id: Schema.optional(ChampionAgentFindingActionInput.fields.id),
    findingId: Schema.optional(ChampionAgentFindingActionInput.fields.findingId),
    decisionId: Schema.optional(ChampionAgentFindingActionInput.fields.decisionId),
    reason: Schema.optional(ChampionAgentFindingActionInput.fields.reason),
    approvalQuote: Schema.optional(ChampionAgentFindingActionInput.fields.approvalQuote),
    environmentId: OrchestratorMcpEnvironmentTarget,
    forwardedApproval: Schema.optional(ForwardedChampionApproval),
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const learning_read = Tool.make("t3_champions_learning_read", {
  ...shared,
  description:
    "Read one learning in full: its current revision with evidence and attempts, every earlier revision with what superseded it, and the Champion's confirmations. Reads only.",
  parameters: Schema.Struct({
    ...ChampionLearningReadInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionLearningReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const list = Tool.make("t3_champions_list", {
  ...shared,
  description:
    "Read compact Champion summaries from here and every linked environment, stamped with environmentId and environmentLabel. environments reports unreachable peers without failing the call. There is no paging: every summary is returned once. Omits charter, samples and execution configuration; use t3_champions_get with id (and environmentId for a peer) for full configuration and latest samples. projectId filters this environment only. Set environmentId to read just that environment.",
  parameters: Schema.Struct({
    ...ChampionListInput.fields,
    environmentId: Schema.optional(EnvironmentId),
  }),
  success: ChampionDirectoryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const history = Tool.make("t3_champions_history", {
  ...shared,
  description: "Read a bounded page of measurement history and activity.",
  parameters: Schema.Struct({
    ...ChampionHistoryInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionHistoryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const upsert = Tool.make("t3_champions_upsert", {
  ...shared,
  description:
    "Create a paused champion draft or edit its name, purpose, readings schedule, charter, goal review and own models (models.checks for its readings, models.advice for its goal reviews and metric setup; each is a main model that replaces the machine default, which keeps its backup; omit models to keep what it has, pass models {} to clear both and follow the defaults). goalReview sets the review's schedule (default weekly on Mondays at a time spread apart from other Champions, in UTC) and its score target (default 7).",
  parameters: Schema.Struct({
    ...ChampionUpsertInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const check_context = Tool.make("t3_champions_check_context", {
  ...shared,
  description:
    "Read the claim and frozen metric definitions bound to your authenticated live run. rhythm says whether it is a readings run or a goal review; metrics lists what you measure (none on a review); collected holds what the server already read by command for this run.",
  parameters: Tool.EmptyParams,
  success: ChampionCheckContext,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const journeys_start = Tool.make("t3_champions_journeys_start", {
  ...shared,
  description:
    "Start this journey check's target. The server defers a check on a busy machine and refuses an ineligible target before any browser starts, then returns the shards (with each shard's locale and workPaths), the services the target declares missing, the journey limit, the paths earlier checks walked, recently changed files and bugs to re-test. Your browser reaches only the shards.",
  parameters: ChampionJourneysStartInput,
  success: ChampionJourneyPlan,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const journey_candidate = Tool.make("t3_champions_journey_candidate", {
  ...shared,
  description:
    "File a failing journey as a candidate, with the tab it ran in. A candidate notifies nobody and is not a finding; only an independent replay can make it one.",
  parameters: ChampionJourneyCandidateInput,
  success: Schema.Struct({ candidateId: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const candidate_replay = Tool.make("t3_champions_candidate_replay", {
  ...shared,
  description:
    "Start a fresh isolated target to replay a candidate, or to re-test a confirmed finding on this build, and return the identities and brief for a delegated browser agent.",
  parameters: ChampionCandidateReplayInput,
  success: ChampionCandidateReplay,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const candidate_settle = Tool.make("t3_champions_candidate_settle", {
  ...shared,
  description:
    "Have the server read a finished replay's verdict from its agent and settle the candidate: a confirmed bug becomes a finding, a rejected one is counted with its reason, and a re-test that passes on a later build closes its finding.",
  parameters: ChampionCandidateSettleInput,
  success: ChampionCandidateSettled,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
const journey_record = Tool.make("t3_champions_journey_record", {
  ...shared,
  description:
    "Read what the server recorded about one journey check: concurrency, timing, latency per shard, machine peaks, spend, candidates, and every network destination allowed or blocked. includeJourneys adds each journey's recorded steps.",
  parameters: Schema.Struct({
    ...ChampionJourneyRecordInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionJourneyRecordResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ChampionsToolkit = Toolkit.make(
  models,
  get,
  control,
  metrics,
  report,
  learning_search,
  record_learning,
  confirm_learning,
  measurement,
  finding_action,
  learning_read,
  list,
  history,
  upsert,
  check_context,
  journeys_start,
  journey_candidate,
  candidate_replay,
  candidate_settle,
  journey_record,
);
