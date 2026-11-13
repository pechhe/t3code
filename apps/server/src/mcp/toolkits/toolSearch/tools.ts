import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";

const ToolSearchTool = Tool.make(McpToolExposure.TOOL_SEARCH, {
  description:
    "Find T3 Code tools and their input schemas. Call a result by name if it becomes a callable tool; otherwise use call_mcp_tool with its name and arguments matching inputSchema. Search by name or purpose: threads, projects, worktrees, browser, devices, schedules, pull requests, secrets, environment links. Exact names work too.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  success: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ToolSearchToolkit = Toolkit.make(ToolSearchTool);

export const CallMcpTool = Tool.make(McpToolExposure.CALL_MCP_TOOL, {
  description:
    "Call a T3 Code tool found by tool_search when it is not available as a callable tool. Pass its exact name and arguments matching the returned inputSchema. The target tool enforces the same permissions and validates its arguments.",
  parameters: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
  success: Schema.Unknown,
});
