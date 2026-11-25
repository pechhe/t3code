import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as BlackholeService from "../../../blackhole/BlackholeService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Pi threads have pi-blackhole's own `recall`; T3's would be a second one over the same history.
const enabled = () => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.providerDriver !== "pi";
};

/** pi-blackhole's `recall`, same grammar and wording, over the thread's T3 history (fork: T3-916). */
export const RecallToolkit = Toolkit.make(
  Tool.make("recall", {
    description:
      "Search session history and earlier lines omitted, file write/edit content by text/regex. " +
      "Expand entries (#N), drill-down file content (#N:path) or message text (#N:text) with paging, or aggregate touched files (mode:touched). " +
      "Responses are capped at a character budget; #N:text / #N:path page the full stored payload. Omit threadId for this thread.",
    parameters: Schema.Struct({
      query: Schema.optional(
        Schema.String.annotate({
          description:
            "Text/regex search; #N expands entry; #N:path drills file (#N:file auto-selects); #N:text pages a message body; #N:path:full all lines; #N:path:offset:limit range; 12-char hex for observations. Only full-file writes indexed.",
        }),
      ),
      expand: Schema.optional(
        Schema.Array(Schema.Number).annotate({ description: "Entry indices to return in full." }),
      ),
      page: Schema.optional(Schema.Number),
      scope: Schema.optional(Schema.Literals(["lineage", "all"])),
      mode: Schema.optional(
        Schema.Literals(["hybrid", "file", "touched"]).annotate({
          description: "file: file content only; touched: files by path.",
        }),
      ),
      threadId: Schema.optional(ThreadId),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      BlackholeService.BlackholeService,
    ],
  })
    .annotate(Tool.Title, "Recall this thread's history")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, enabled),
);
