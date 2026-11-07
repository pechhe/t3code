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
  ChampionCheckContext,
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
} from "@t3tools/contracts";
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
    "Retrieve scoped learning by exact topic before investigating; retain the retrieval receipt. Due filters mark uncertainty without launching work.",
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
const list = Tool.make("t3_champions_list", {
  ...shared,
  description: "Read compact champion summaries in this environment.",
  parameters: ChampionListInput,
  success: ChampionListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const get = Tool.make("t3_champions_get", {
  ...shared,
  description: "Read champion configuration, metrics, pending proposal and open findings.",
  parameters: ChampionGetInput,
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
  record_learning,
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
  update_finding,
);
