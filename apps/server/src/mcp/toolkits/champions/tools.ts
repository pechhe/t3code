import {
  ChampionClassChoicesInput,
  ChampionClassChoicesResult,
  ChampionRuntimeState,
  ChampionLearningQueryInput,
  ChampionLearningQueryResult,
  ChampionLearningRecordInput,
  ChampionLearningRevision,
  ChampionInvestigationStartInput,
  ChampionInvestigationCancelInput,
  ChampionInvestigation,
  ChampionSynthesisInput,
  ChampionRecommendation,
  ChampionRecommendationInput,
  ChampionAgentAcceptInput,
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
  ChampionMetricsLeadResult,
  ChampionFindingDeliveryInput,
  ChampionGetInput,
  ChampionHistoryInput,
  ChampionHistoryResult,
  ChampionLifecycleInput,
  ChampionListInput,
  ChampionListResult,
  ChampionProposal,
  ChampionSetupCompleteInput,
  ChampionProposeInput,
  ChampionReportInput,
  ChampionUpsertInput,
  OrchestratorMcpFailure,
  OrchestratorMcpEnvironmentTarget,
  EnvironmentId,
  ChampionLearningSearchInput,
  ChampionLearningSearchResult,
  ChampionLearningTopicsInput,
  ChampionLearningTopicsResult,
  ChampionLearningReadInput,
  ChampionLearningReadResult,
  ChampionLearningContributeInput,
  ChampionLearningForwardedFrom,
  ChampionLearningConfirmInput,
  ChampionLearningNoteInput,
  ChampionLearningEntry,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
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
const class_choices = Tool.make("t3_champions_class_choices", {
  ...shared,
  description:
    "Read server-resolved eligible agent classes for a destination project and classification, with policy provenance and honest refusals. New draft historical selection fields come from these choices; never guess a model.",
  parameters: ChampionClassChoicesInput,
  success: ChampionClassChoicesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const recommendation = Tool.make("t3_champions_recommendation", {
  ...shared,
  description:
    "Read one exact retained recommendation scoped to its Champion, finding and finding attempt.",
  parameters: ChampionRecommendationInput,
  success: ChampionRecommendation,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const runtime_state = Tool.make("t3_champions_runtime_state", {
  ...shared,
  description: "Read bounded Champion execution provenance, investigations and recommendations.",
  parameters: ChampionGetInput,
  success: ChampionRuntimeState,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const learning_query = Tool.make("t3_champions_learning_query", {
  ...shared,
  description:
    "Champion owners: retrieve scoped learning by exact topic before investigating; retain the retrieval receipt. Due filters mark uncertainty without launching work. Other agents use t3_champions_learning_search, which writes nothing.",
  parameters: ChampionLearningQueryInput,
  success: ChampionLearningQueryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const record_learning = Tool.make("t3_champions_record_learning", {
  ...shared,
  description:
    "Retain an immutable learning revision as the authenticated Champion owner. Include failed attempts, dated evidence, applicability and review conditions. Leaves return evidence to their owner.",
  parameters: ChampionLearningRecordInput,
  success: ChampionLearningRevision,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const start_investigation = Tool.make("t3_champions_start_investigation", {
  ...shared,
  description:
    "Record at most three distinct read-only hypotheses for a finding after current learning retrieval. Returned branches give exact managed workId and attemptId. Delegate through the normal managed task tool; admission enforces capacity and budget.",
  parameters: ChampionInvestigationStartInput,
  success: ChampionInvestigation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const cancel_investigation = Tool.make("t3_champions_cancel_investigation", {
  ...shared,
  description:
    "Persist cancellation intent for the exact investigation. Managed cancellation is reconciled durably; unknown children continue to hold capacity.",
  parameters: ChampionInvestigationCancelInput,
  success: ChampionInvestigation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const synthesize = Tool.make("t3_champions_synthesize", {
  ...shared,
  description:
    "Retain immutable synthesis as the authenticated owner and request a revision-bound decision. Write recommendation as concise, coherent prose covering the action, rationale, benefits, material trade-offs, uncertainty and proposed scope, without labelled sections or a taxonomy. Supporting structured fields remain in history. Approval preserves charter, design, review and release authority.",
  parameters: ChampionSynthesisInput,
  success: ChampionRecommendation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const learning_search = Tool.make("t3_champions_learning_search", {
  ...shared,
  description:
    "Search what Champions have learned before working in an area one covers: words match each learning's plain sentence, question and conclusion, ranked by relevance then recency. Omit projectId to search every Champion; name a linked environment with environmentId to search its Champions. Filters: due (review date passed), contributed (from other agents), needs-review. Reads only: no retrieval receipt, so it never admits an investigation.",
  parameters: Schema.Struct({
    ...ChampionLearningSearchInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionLearningSearchResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const learning_topics = Tool.make("t3_champions_learning_topics", {
  ...shared,
  description:
    "List the topics Champions hold learnings on, with counts and the latest date, here or in a linked environment.",
  parameters: Schema.Struct({
    ...ChampionLearningTopicsInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionLearningTopicsResult,
})
  .annotate(Tool.Readonly, true)
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
const contribute_learning = Tool.make("t3_champions_contribute_learning", {
  ...shared,
  description:
    "Record what you learned in an area a Champion covers, as an orchestrating thread that is not that Champion; name its environment with environmentId when it runs elsewhere. Same content and rules as the Champion's own: plainSummary first, dated evidence, failed or inconclusive attempts, and a review condition. It counts at once, marked as contributed by you; the Champion confirms or supersedes it on its next check. Delegated workers cannot: report the learning to your lead instead. A new learning takes a fresh learningId and expectedCurrentId null.",
  parameters: Schema.Struct({
    ...ChampionLearningContributeInput.fields,
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
    "As the authenticated Champion owner, confirm a learning another agent contributed after checking it. It records a confirmation on that revision and makes no new revision. To disagree, supersede it with t3_champions_record_learning and a reason instead.",
  parameters: ChampionLearningConfirmInput,
  success: ChampionLearningEntry,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const learning_note = Tool.make("t3_champions_learning_note", {
  ...shared,
  description:
    "As the authenticated Champion owner, add the plain sentence to a current learning recorded without one: one sentence someone outside engineering understands, saying what was learned. It is a presentation note; the revision, its conclusion and retrieval receipts stay as they are.",
  parameters: ChampionLearningNoteInput,
  success: ChampionLearningEntry,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const list = Tool.make("t3_champions_list", {
  ...shared,
  description:
    "Read compact champion summaries here, or in a linked environment named with environmentId.",
  parameters: Schema.Struct({
    ...ChampionListInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const get = Tool.make("t3_champions_get", {
  ...shared,
  description:
    "Read champion configuration, metrics, pending proposal and open findings, here or in a linked environment named with environmentId.",
  parameters: Schema.Struct({
    ...ChampionGetInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const history = Tool.make("t3_champions_history", {
  ...shared,
  description: "Read a bounded page of measurement history and activity.",
  parameters: ChampionHistoryInput,
  success: ChampionHistoryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const upsert = Tool.make("t3_champions_upsert", {
  ...shared,
  description:
    "Create a paused champion draft or edit its explicit setup/routine selections and charter.",
  parameters: ChampionUpsertInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const lifecycle = Tool.make("t3_champions_lifecycle", {
  ...shared,
  description:
    "Pause, resume or retire a champion. In-flight work continues; resume never backfills.",
  parameters: ChampionLifecycleInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const setup = Tool.make("t3_champions_setup", {
  ...shared,
  description: "Start stronger-model setup, preserving the draft and pending proposal.",
  parameters: ChampionGetInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const run_check = Tool.make("t3_champions_run_check", {
  ...shared,
  description: "Run a measurement now. A paused champion measures only; retired champions refuse.",
  parameters: ChampionGetInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const propose = Tool.make("t3_champions_propose", {
  ...shared,
  description: "Edit a pending metric proposal. Requires subsequent user acceptance.",
  parameters: ChampionProposeInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const accept = Tool.make("t3_champions_accept", {
  ...shared,
  description:
    "Accept the pending metric proposal named by proposalId (from t3_champions_get) for the user. It needs approvalQuote: the user's exact words approving it, copied from a message they typed in this thread. Without one it is refused and the proposal keeps waiting for them on the Champion page. A proposal replaced since you read it is refused.",
  parameters: ChampionAgentAcceptInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const finding_action = Tool.make("t3_champions_finding_action", {
  ...shared,
  description:
    "Dismiss or reopen a finding, request the user's decision on it, or answer that decision for them. For a decision, reason is a one-line question and proposal holds the recommended action, one sentence of why and the other options in a few words each; the user can approve the proposal in one click. To answer (resolve_decision), pass decisionId, the answer as reason, and approvalQuote: the user's exact words, copied from a message they typed in this thread. Without one it is refused and the decision keeps waiting for them on the Champion page.",
  parameters: ChampionAgentFindingActionInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const start_metrics_lead = Tool.make("t3_champions_start_metrics_lead", {
  ...shared,
  description:
    "Fix with a lead, as the Champion page does: start a thread on the lead role's current model to shape and lead a fix for this champion's metrics. Returns the new thread's id.",
  parameters: ChampionGetInput,
  success: ChampionMetricsLeadResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const check_context = Tool.make("t3_champions_check_context", {
  ...shared,
  description:
    "Read the check claim and frozen metric definitions bound to your authenticated live run.",
  parameters: Tool.EmptyParams,
  success: ChampionCheckContext,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const propose_metrics = Tool.make("t3_champions_propose_metrics", {
  ...shared,
  description:
    "Submit metric proposals from your authenticated setup run or routine check. The proposal waits for the user to accept it on the Champion page; a check still reports as usual.",
  parameters: ChampionProposal,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const report = Tool.make("t3_champions_report", {
  ...shared,
  description:
    "Complete this check using the frozen metric methods from t3_champions_check_context. Copy metricId, version, unit and source verbatim; never paraphrase source. Put execution commands, paths and collection details in evidence. Failed collection uses value null and status error, never a fabricated numeric value. Include each required metric exactly once and reconcile findings. Open summary with one or two plain sentences on progress towards the champion's goal; the Champion page shows it under the goal. Server derives identity and provenance.",
  parameters: ChampionReportInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const journeys_start = Tool.make("t3_champions_journeys_start", {
  ...shared,
  description:
    "Start this journey check's target. The server defers a check on a busy machine and refuses an ineligible target before any browser starts, then returns the shards, the journey limit, the paths earlier checks walked, recently changed files and bugs to re-test. Your browser reaches only the shards.",
  parameters: ChampionJourneysStartInput,
  success: ChampionJourneyPlan,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const journey_candidate = Tool.make("t3_champions_journey_candidate", {
  ...shared,
  description:
    "File a failing journey as a candidate, with the tab it ran in. A candidate notifies nobody and is not a finding; only an independent replay can make it one.",
  parameters: ChampionJourneyCandidateInput,
  success: Schema.Struct({ candidateId: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const candidate_replay = Tool.make("t3_champions_candidate_replay", {
  ...shared,
  description:
    "Start a fresh isolated target to replay a candidate, or to re-test a confirmed finding on this build, and return the identities and brief for a delegated browser agent.",
  parameters: ChampionCandidateReplayInput,
  success: ChampionCandidateReplay,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const candidate_settle = Tool.make("t3_champions_candidate_settle", {
  ...shared,
  description:
    "Have the server read a finished replay's verdict from its agent and settle the candidate: a confirmed bug becomes a finding, a rejected one is counted with its reason, and a re-test that passes on a later build closes its finding.",
  parameters: ChampionCandidateSettleInput,
  success: ChampionCandidateSettled,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const journey_record = Tool.make("t3_champions_journey_record", {
  ...shared,
  description:
    "Read what the server recorded about one journey check: concurrency, timing, latency per shard, machine peaks, spend, candidates, and every network destination allowed or blocked. includeJourneys adds each journey's recorded steps.",
  parameters: ChampionJourneyRecordInput,
  success: ChampionJourneyRecordResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const update_finding = Tool.make("t3_champions_update_finding", {
  ...shared,
  description:
    "Record accepted child delivery with revision, Forge Spec, or comparable improvement verification. No child identity supplied by model is trusted.",
  parameters: ChampionFindingDeliveryInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const discard_proposal = Tool.make("t3_champions_discard_proposal", {
  ...shared,
  description: "Discard pending metrics without changing accepted metric versions.",
  parameters: ChampionGetInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const cancel_setup = Tool.make("t3_champions_cancel_setup", {
  ...shared,
  description:
    "Cancel setup using the existing thread stop command, retaining accepted metrics and the draft.",
  parameters: ChampionGetInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const complete_setup = Tool.make("t3_champions_complete_setup", {
  ...shared,
  description:
    "Complete your authenticated setup run without proposing changes. Retains any existing pending proposal and accepted metrics.",
  parameters: ChampionSetupCompleteInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
export const ChampionsToolkit = Toolkit.make(
  class_choices,
  runtime_state,
  recommendation,
  learning_query,
  learning_search,
  learning_topics,
  learning_read,
  record_learning,
  contribute_learning,
  confirm_learning,
  learning_note,
  start_investigation,
  cancel_investigation,
  synthesize,

  discard_proposal,
  cancel_setup,
  complete_setup,
  list,
  get,
  history,
  upsert,
  lifecycle,
  setup,
  run_check,
  propose,
  accept,
  finding_action,
  start_metrics_lead,
  check_context,
  propose_metrics,
  report,
  journeys_start,
  journey_candidate,
  candidate_replay,
  candidate_settle,
  journey_record,
  update_finding,
);
