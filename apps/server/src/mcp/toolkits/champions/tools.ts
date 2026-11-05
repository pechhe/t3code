import {
  ChampionAcceptInput,
  ChampionCheckContext,
  ChampionDetail,
  ChampionFindingActionInput,
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
    "Accept metric definitions only on user instruction. The champion owner cannot accept its own proposal.",
  parameters: ChampionAcceptInput,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const finding_action = Tool.make("t3_champions_finding_action", {
  ...shared,
  description: "Dismiss or reopen a finding, or record a product decision and rationale.",
  parameters: ChampionFindingActionInput,
  success: ChampionDetail,
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
    "Submit metric proposals from the authenticated setup run. Retains draft until user acceptance.",
  parameters: ChampionProposal,
  success: ChampionDetail,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const report = Tool.make("t3_champions_report", {
  ...shared,
  description:
    "Complete this check using the frozen metric methods from t3_champions_check_context. Copy metricId, version, unit and source verbatim; never paraphrase source. Put execution commands, paths and collection details in evidence. Failed collection uses value null and status error, never a fabricated numeric value. Include each required metric exactly once and reconcile findings. Server derives identity and provenance.",
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
  check_context,
  propose_metrics,
  report,
  update_finding,
);
