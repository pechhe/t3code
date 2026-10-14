import * as ExperimentService from "../../../experiments/ExperimentService.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  ROLLOVER_NOTE_RULES,
  ROLLOVER_NOTE_SECTIONS,
  ROLLOVER_NOTE_TOOL_NAME,
} from "../../../orchestration-v2/ContextRollover.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const WriteRolloverNoteTool = Tool.make(ROLLOVER_NOTE_TOOL_NAME, {
  description: `Needs an agent running inside a T3 thread with context rollover on. Save a handoff note for this thread. When your turn ends, T3 continues the thread on a fresh provider session seeded with this note instead of the transcript. Call it when T3 asks for a handoff note, then end your turn. Pass the whole note as markdown with these sections:\n${ROLLOVER_NOTE_SECTIONS}\n${ROLLOVER_NOTE_RULES}`,
  parameters: Schema.Struct({ note: Schema.String.check(Schema.isMinLength(1)) }),
  success: Schema.Struct({ message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    ExperimentService.ExperimentService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Title, "Write a context rollover note")
  // Saves a note in memory only; it changes neither the workspace nor the thread.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const RolloverToolkit = Toolkit.make(WriteRolloverNoteTool);
