import {
  ChampionClassChoicesInput,
  ChampionClassChoicesResult,
  ChampionRuntimeState,
  ChampionLearningQueryInput,
  ChampionLearningQueryResult,
  ChampionLearningTopicsInput,
  ChampionLearningTopicsResult,
  ChampionLearningRecordInput,
  ChampionLearningRevision,
  ChampionInvestigationStartInput,
  ChampionInvestigationCancelInput,
  ChampionInvestigation,
  ChampionMeasurement,
  ChampionMeasurementStartInput,
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
  ChampionFindingDeliveryInput,
  ChampionGetInput,
  ChampionHistoryInput,
  ChampionHistoryResult,
  ChampionListInput,
  ChampionProposal,
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
  parameters: Schema.Struct({
    ...ChampionClassChoicesInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionClassChoicesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const get = Tool.make("t3_champions_get", {
  ...shared,
  description:
    "Read champion configuration, metrics, pending proposal and open findings, here or in a linked environment named with environmentId. Set include to runtime_state for bounded execution provenance, investigations and recommendations instead, or to recommendation with findingId, findingAttemptId and recommendationId for one exact retained recommendation.",
  parameters: Schema.Struct({
    ...ChampionGetInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
    include: Schema.optional(Schema.Literals(["runtime_state", "recommendation"])),
    findingId: Schema.optional(ChampionRecommendationInput.fields.findingId),
    findingAttemptId: Schema.optional(ChampionRecommendationInput.fields.findingAttemptId),
    recommendationId: Schema.optional(ChampionRecommendationInput.fields.recommendationId),
  }),
  success: Schema.Union([ChampionDetail, ChampionRuntimeState, ChampionRecommendation]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const control = Tool.make("t3_champions_control", {
  ...shared,
  description:
    "Control a champion: pause, resume or retire it (in-flight work continues; resume never backfills), run a measurement now (a paused champion measures only; retired champions refuse), start stronger-model setup preserving the draft and pending proposal, cancel that setup retaining accepted metrics and the draft, or discard pending metrics without changing accepted versions.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "pause",
      "resume",
      "retire",
      "run_check",
      "setup",
      "cancel_setup",
      "discard_proposal",
    ]),
    id: ChampionGetInput.fields.id,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const proposal = Tool.make("t3_champions_proposal", {
  ...shared,
  description:
    'Edit the pending metric proposal with action edit (champion id plus metrics and reason; requires subsequent user acceptance), or submit metric proposals from your authenticated setup run or routine check with action submit (metrics and reason; the proposal waits for the user to accept it on the Champion page, and a check still reports as usual). Accepted metrics you do not list are kept unchanged: list only metrics to add or change, and to stop tracking one, name its id in retires. A champion tracks at most 32 metrics. Give a metric that is a plain read (a file, a count, a CLI query) collect: the argument list of a command the server runs itself at each check, with no shell, in the project root, within 30 seconds and with no provider keys or tokens in its environment. It must print a number, or JSON {"value": n, "revision"?: string, "evidence"?: string}. Once accepted, the server measures that metric and no agent reports it.',
  parameters: Schema.Struct({
    action: Schema.Literals(["edit", "submit"]),
    id: Schema.optional(ChampionGetInput.fields.id),
    metrics: Schema.optional(ChampionProposal.fields.metrics),
    retires: ChampionProposal.fields.retires,
    reason: Schema.optional(ChampionProposal.fields.reason),
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const report = Tool.make("t3_champions_report", {
  ...shared,
  description:
    "Complete this check using the frozen metric methods from t3_champions_check_context. Copy metricId, version, unit and source verbatim; never paraphrase source. Put execution commands, paths and collection details in evidence. Failed collection uses value null and status error, never a fabricated numeric value. Include each required metric from t3_champions_check_context exactly once and reconcile findings; metrics the server reads by command are not listed there and a sample for one is refused. Open summary with one or two plain sentences on progress towards the champion's goal; the Champion page shows it under the goal. Server derives identity and provenance. With only a summary (no samples), it completes your authenticated setup run without proposing changes instead.",
  parameters: Schema.Struct({
    samples: Schema.optional(ChampionReportInput.fields.samples),
    findings: Schema.optional(ChampionReportInput.fields.findings),
    summary: Schema.optional(ChampionReportInput.fields.summary),
    journeys: Schema.optional(ChampionReportInput.fields.journeys),
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const learning_search = Tool.make("t3_champions_learning_search", {
  ...shared,
  description:
    "Search what Champions have learned before working in an area one covers: words match each learning's plain sentence, question and conclusion, ranked by relevance then recency. Omit projectId to search every Champion; name a linked environment with environmentId to search its Champions. Filters: due (review date passed), contributed (from other agents), needs-review. action topics lists the topics Champions hold learnings on instead. action query is the Champion owner's scoped lookup by exact topic before investigating, which retains the retrieval receipt a plain search never writes; it returns at most 20, and a linked environment may not use it. A plain search writes nothing, so it never admits an investigation.",
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
    "Retain an immutable learning revision. As the authenticated Champion owner (the calling thread is that Champion's owner), include failed attempts, dated evidence, applicability and review conditions; leaves return evidence to their owner. As an orchestrating thread that is not that Champion, record what you learned in an area a Champion covers; name its environment with environmentId when it runs elsewhere. Same content and rules either way: plainSummary first, dated evidence, failed or inconclusive attempts, and a review condition. A contribution counts at once, marked as contributed by you; the Champion confirms or supersedes it on its next check. A new learning takes a fresh learningId and expectedCurrentId null.",
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
  .annotate(Tool.Destructive, false);
const investigation = Tool.make("t3_champions_investigation", {
  ...shared,
  description:
    "Start or cancel a bounded investigation of a finding. Only action cancel may name a linked environment with environmentId; start is the Champion owner's own call, there. action start records at most three distinct read-only hypotheses after current learning retrieval; returned branches give exact managed workId and attemptId. Delegate through the normal managed task tool; admission enforces capacity and budget. action cancel persists cancellation intent for the exact investigation; managed cancellation is reconciled durably and unknown children continue to hold capacity.",
  parameters: Schema.Struct({
    action: Schema.Literals(["start", "cancel"]),
    id: Schema.optional(ChampionInvestigationStartInput.fields.id),
    findingId: Schema.optional(ChampionInvestigationStartInput.fields.findingId),
    investigationId: Schema.optional(ChampionInvestigationStartInput.fields.investigationId),
    question: Schema.optional(ChampionInvestigationStartInput.fields.question),
    topic: Schema.optional(ChampionInvestigationStartInput.fields.topic),
    retrievalReceiptId: Schema.optional(ChampionInvestigationStartInput.fields.retrievalReceiptId),
    alternatives: Schema.optional(ChampionInvestigationStartInput.fields.alternatives),
    requestId: Schema.optional(ChampionInvestigationCancelInput.fields.requestId),
    reason: Schema.optional(ChampionInvestigationCancelInput.fields.reason),
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionInvestigation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const measurement = Tool.make("t3_champions_measurement", {
  ...shared,
  description:
    "Register a read-only browser audit, or a reviewer's confirmation of a completed one, of your live check; no finding needed. id is the champion's id. Returns the workId and attemptId for delegate_task: same role and sourceRevision, readOnly true.",
  parameters: ChampionMeasurementStartInput,
  success: ChampionMeasurement,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const finding_action = Tool.make("t3_champions_finding_action", {
  ...shared,
  description:
    "Dismiss or reopen a finding, request the user's decision on it, or answer that decision for them. For a decision, reason is a one-line question and proposal holds the recommended action, one sentence of why and the other options in a few words each; the user can approve the proposal in one click. To answer (action resolve_decision), pass decisionId, the answer as reason, and approvalQuote: the user's exact words, copied from a message they typed in this thread. Without one it is refused and the decision keeps waiting for them on the Champion page. Actions handed_back, delivered, verify, inconclusive and spec record accepted child delivery with revision, Forge Spec, or comparable improvement verification instead; no child identity supplied by model is trusted. A metric breach is diagnosed first: after its read-only advisor completes, action diagnosis records diagnosis (what it found), route (repair, spec or decision) and evidence (one line of why); a repair, a Spec and a decision request are refused until then and must match that route. Action reroute, with route and the reason as evidence, records taking a different one.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "dismiss",
      "reopen",
      "decision",
      "resolve_decision",
      "handed_back",
      "delivered",
      "verify",
      "inconclusive",
      "spec",
      "diagnosis",
      "reroute",
    ]),
    route: ChampionFindingDeliveryInput.fields.route,
    diagnosis: ChampionFindingDeliveryInput.fields.diagnosis,
    id: Schema.optional(ChampionAgentFindingActionInput.fields.id),
    findingId: Schema.optional(ChampionFindingDeliveryInput.fields.findingId),
    decisionId: Schema.optional(ChampionAgentFindingActionInput.fields.decisionId),
    recommendationId: Schema.optional(ChampionAgentFindingActionInput.fields.recommendationId),
    proposal: Schema.optional(ChampionAgentFindingActionInput.fields.proposal),
    reason: Schema.optional(ChampionAgentFindingActionInput.fields.reason),
    approvalQuote: Schema.optional(ChampionAgentFindingActionInput.fields.approvalQuote),
    environmentId: OrchestratorMcpEnvironmentTarget,
    forwardedApproval: Schema.optional(ForwardedChampionApproval),
    operationId: Schema.optional(ChampionFindingDeliveryInput.fields.operationId),
    revision: Schema.optional(ChampionFindingDeliveryInput.fields.revision),
    specUrl: Schema.optional(ChampionFindingDeliveryInput.fields.specUrl),
    evidence: Schema.optional(ChampionFindingDeliveryInput.fields.evidence),
  }),
  success: ChampionDetail,
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
    "Read compact Champion summaries from here and every linked environment, stamped with environmentId and environmentLabel. environments reports unreachable peers without failing the call. There is no paging: every summary is returned once. projectId filters this environment only. Set environmentId to read just that environment.",
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
    "Create a paused champion draft or edit its explicit setup/routine selections and charter. On a journey champion, repairsVia names an active champion in the same project that repairs what it confirms; null clears it.",
  parameters: Schema.Struct({
    ...ChampionUpsertInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const accept = Tool.make("t3_champions_accept", {
  ...shared,
  description:
    "Accept the pending metric proposal named by proposalId (from t3_champions_get) for the user. It needs approvalQuote: the user's exact words approving it, copied from a message they typed in this thread. Without one it is refused and the proposal keeps waiting for them on the Champion page. A proposal replaced since you read it is refused. For a Champion in a linked environment, name it with environmentId: your quote is checked here against your thread, and the other environment accepts it only if the message was typed after the proposal was filed.",
  parameters: Schema.Struct({
    ...ChampionAgentAcceptInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
    forwardedApproval: Schema.optional(ForwardedChampionApproval),
  }),
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const check_context = Tool.make("t3_champions_check_context", {
  ...shared,
  description:
    "Read the check claim and frozen metric definitions bound to your authenticated live run. metrics lists what you measure; collected holds what the server already read by command for this check; handedOff lists findings a journey champion handed to this champion to repair.",
  parameters: Tool.EmptyParams,
  success: ChampionCheckContext,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const journeys_start = Tool.make("t3_champions_journeys_start", {
  ...shared,
  description:
    "Start this journey check's target. The server defers a check on a busy machine and refuses an ineligible target before any browser starts, then returns the shards (with each shard's locale and workPaths), the services the target declares missing, the journey limit, the paths earlier checks walked, recently changed files and bugs to re-test. Your browser reaches only the shards.",
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
  parameters: Schema.Struct({
    ...ChampionJourneyRecordInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: ChampionJourneyRecordResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ChampionsToolkit = Toolkit.make(
  class_choices,
  get,
  control,
  proposal,
  report,
  learning_search,
  record_learning,
  confirm_learning,
  investigation,
  measurement,
  finding_action,
  synthesize,
  learning_read,
  list,
  history,
  upsert,
  accept,
  check_context,
  journeys_start,
  journey_candidate,
  candidate_replay,
  candidate_settle,
  journey_record,
);
