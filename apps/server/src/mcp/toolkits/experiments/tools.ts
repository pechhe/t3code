import {
  Experiment,
  ExperimentDefinition,
  ExperimentEvidenceInput,
  ExperimentEvidence,
  ExperimentEvaluationInput,
  ExperimentEvaluation,
  ExperimentEvidenceReadInput,
  ExperimentEvidenceBundle,
  ExperimentTransitionInput,
  ExperimentAssignmentsInput,
  ExperimentAssignment,
  ExperimentReportInput,
  ExperimentReport,
  ExperimentOutcomeInput,
  ExperimentOutcome,
  ExperimentHistoricalInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Experiments.ExperimentService,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const create = Tool.make("t3_experiments_create", {
  ...shared,
  description: "Create an immutable experiment draft. Does not start it or spend model allowance.",
  parameters: ExperimentDefinition,
  success: Experiment,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const transition = Tool.make("t3_experiments_transition", {
  ...shared,
  description:
    "Start, pause, resume or stop an experiment. Existing assignments retain their policy; no replay is launched.",
  parameters: ExperimentTransitionInput,
  success: Experiment,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const list = Tool.make("t3_experiments_list", {
  ...shared,
  description: "List experiments in this environment.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(Experiment),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const assignments = Tool.make("t3_experiments_assignments", {
  ...shared,
  description: "Read durable experiment assignments for a thread or experiment.",
  parameters: ExperimentAssignmentsInput,
  success: Schema.Array(ExperimentAssignment),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const report = Tool.make("t3_experiments_report", {
  ...shared,
  description:
    "Read experiment evidence, actual model selections and usage completeness. Observational imports remain separate.",
  parameters: ExperimentReportInput,
  success: ExperimentReport,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const record_outcome = Tool.make("t3_experiments_record_outcome", {
  ...shared,
  description:
    "Record an evidence-linked experiment outcome. Label automated judgements and self-reports accurately; do not infer completion from a successful turn.",
  parameters: ExperimentOutcomeInput,
  success: ExperimentOutcome,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const import_historical = Tool.make("t3_experiments_import_historical", {
  ...shared,
  description:
    "Import a historical assignment with its original provenance. It is observational, never T3-randomized.",
  parameters: ExperimentHistoricalInput,
  success: ExperimentAssignment,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const record_evidence = Tool.make("t3_experiments_record_evidence", {
  ...shared,
  description:
    "Append immutable, bounded evidence for an experiment episode. Captures are agent supplied; missing evidence must be explicit. Does not evaluate or start work.",
  parameters: ExperimentEvidenceInput,
  success: ExperimentEvidence,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const record_evaluation = Tool.make("t3_experiments_record_evaluation", {
  ...shared,
  description:
    "Record a versioned, evidence-linked evaluation of an episode. Cite exact capture IDs and mark unknowns; automated judgments and self-reports are not independent verification. Evaluation usage is separate from measured work.",
  parameters: ExperimentEvaluationInput,
  success: ExperimentEvaluation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const read_evidence = Tool.make("t3_experiments_read_evidence", {
  ...shared,
  description:
    "Read an episode's immutable evidence bundle and evaluations. Paginate captures with nextOffset; evaluationsTruncated marks older evaluations beyond the bounded window.",
  parameters: ExperimentEvidenceReadInput,
  success: ExperimentEvidenceBundle,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ExperimentsToolkit = Toolkit.make(
  create,
  transition,
  list,
  assignments,
  report,
  record_outcome,
  record_evidence,
  record_evaluation,
  read_evidence,
  import_historical,
);
