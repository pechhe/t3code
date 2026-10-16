import { OrchestratorMcpFailure, TerminalSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const TERMINAL_READ_DEFAULT_LINES = 200;

const TerminalReadTool = Tool.make("t3_terminal_read", {
  description: `Needs an agent running inside a T3 thread. Read the user's terminal for this thread: the terminal panel the user types into, not your own shell. Use it to see what a command the user ran printed, for example after they ran one you suggested. Returns this thread's open terminals and the plain-text output of one, newest lines last: the terminal that changed most recently, or terminalId from the list. lines (default ${TERMINAL_READ_DEFAULT_LINES}, at most 2000) caps how many trailing lines come back, and truncated says whether earlier output was left out. Only terminals of this thread are visible; a thread with no terminal open returns an empty list.`,
  parameters: Schema.Struct({
    terminalId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
    lines: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2000)),
    ),
  }),
  success: Schema.Struct({
    terminals: Schema.Array(TerminalSummary),
    terminal: Schema.NullOr(TerminalSummary),
    output: Schema.String,
    truncated: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, TerminalManager.TerminalManager],
})
  .annotate(Tool.Title, "Read this thread's terminal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalToolkit = Toolkit.make(TerminalReadTool);
