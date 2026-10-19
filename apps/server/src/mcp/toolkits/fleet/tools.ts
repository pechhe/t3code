import { FleetSummary, FleetSummaryInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as FleetSummaryService from "../../../fleet/FleetSummaryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const FleetToolkit = Toolkit.make(
  Tool.make("t3_fleet_summary", {
    description:
      "Read all projects' unsettled, non-archived threads and fleet health here and on linked environments, without transcript content. Subagents roll up under their parent. Pass the previous cursor as changedSince for changed rows and removals; health and source availability are always returned. An unavailable peer is never idle. Build state is at most a minute old, read through the shared Build cache; release candidate state is the approval's stored observation.",
    parameters: FleetSummaryInput,
    success: FleetSummary,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      FleetSummaryService.FleetSummaryService,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
