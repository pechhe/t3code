import {
  Experiment,
  ExperimentDefinition,
  ExperimentTransitionInput,
  ExperimentAssignmentsInput,
  ExperimentAssignment,
  ExperimentReportInput,
  ExperimentReport,
  ExperimentOutcomeInput,
  ExperimentOutcome,
  ExperimentHistoricalInput,
  ExperimentWorkEnrollInput,
  ExperimentWorkUnit,
  ExperimentWorkAllocationInput,
  ExperimentWorkAllocation,
  ExperimentWorkEvidenceInput,
  ExperimentWorkEvidence,
  ExperimentWorkReadInput,
  ExperimentWorkReport,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Experiments.ExperimentService,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const workShared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    OrchestratorMcpService.OrchestratorMcpService,
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
const work_enroll = Tool.make("t3_work_enroll", {
  ...workShared,
  description: "Register a non-UI work unit for durable experiment allocation and evidence.",
  parameters: ExperimentWorkEnrollInput,
  success: ExperimentWorkUnit,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const work_allocate = Tool.make("t3_work_allocate", {
  ...workShared,
  description: "Record the allocation choice and any deviation for an enrolled work unit.",
  parameters: ExperimentWorkAllocationInput,
  success: ExperimentWorkAllocation,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const work_evidence = Tool.make("t3_work_evidence", {
  ...workShared,
  description: "Record evidence and usage attribution for an enrolled work unit.",
  parameters: ExperimentWorkEvidenceInput,
  success: ExperimentWorkEvidence,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const work_read = Tool.make("t3_work_read", {
  ...workShared,
  description: "Read the durable work report, including evidence and usage coverage.",
  parameters: ExperimentWorkReadInput,
  success: ExperimentWorkReport,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const work_outcome = Tool.make("t3_work_outcome", {
  ...workShared,
  description:
    "Record a self-reported outcome for an owned work assignment. Evidence remains self-reported.",
  parameters: ExperimentOutcomeInput,
  success: ExperimentOutcome,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
export const ExperimentsToolkit = Toolkit.make(
  create,
  transition,
  list,
  assignments,
  report,
  record_outcome,
  import_historical,
  work_enroll,
  work_allocate,
  work_evidence,
  work_read,
  work_outcome,
);
