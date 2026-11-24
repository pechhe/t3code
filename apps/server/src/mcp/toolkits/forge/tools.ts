import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ForgeReadService from "../../../weave/ForgeReadService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ForgeReadTool = Tool.make("t3_forge_read", {
  description:
    "Read Forge Specs, Tickets, Arcs or Decisions by ref (WV-143, #9252, 9252, UUID or Forge URL), including acceptance rows and the full Doc body. Pin the Doc with bodyRevision; Specs include related context by default.",
  parameters: Schema.Struct({
    ref: Schema.Trim.check(Schema.isMinLength(1)),
    bodyRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    includeContext: Schema.optional(Schema.Boolean),
  }),
  success: ForgeReadService.ForgeReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, ForgeReadService.ForgeReadService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ForgeToolkit = Toolkit.make(ForgeReadTool);
