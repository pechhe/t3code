import { OrchestratorMcpFailure, PreviewAutomationError, PreviewTabId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BrowserRuns from "../../../browserRuns/BrowserRuns.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewToolkit } from "../preview/tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];
const failure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const RunSummary = Schema.Struct({
  runId: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "time-limit", "output-limit"]),
  durationMs: Schema.Number,
  tabs: Schema.Number,
  outputBytes: Schema.Number,
});

const OpenRunTool = Tool.make("t3_browser_run_open", {
  description:
    "Open a browser run: fresh, empty storage that all its tabs and pop-ups share, a time limit and an output limit. Send its `runId` as the `t3-browser-run` header on every later call. When the limit passes, its tabs close.",
  parameters: Schema.Struct({
    timeLimitSeconds: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: BrowserRuns.BROWSER_RUN_LIMITS.maxSeconds }),
      ),
    ),
    outputLimitBytes: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: BrowserRuns.BROWSER_RUN_LIMITS.maxOutputBytes }),
      ),
    ),
    workspace: Schema.optional(Schema.String).annotate({
      description:
        "Outside a T3 thread only: an absolute path inside the project whose browser settings apply.",
    }),
  }),
  success: Schema.Struct({
    runId: Schema.String,
    deadline: Schema.String,
    outputLimitBytes: Schema.Number,
  }),
  failure,
  dependencies,
}).annotate(Tool.OpenWorld, true);

const CloseRunTool = Tool.make("t3_browser_run_close", {
  description: "End this connection's run: its tabs close and it leaves one record.",
  parameters: Schema.Struct({
    outcome: Schema.optional(Schema.Literals(["succeeded", "failed"])),
  }),
  success: RunSummary,
  failure,
  dependencies,
}).annotate(Tool.Destructive, true);

const InitScriptTool = Tool.make("t3_browser_run_init_script", {
  description:
    "Run page code before every page loads in this run, in its open tabs' next loads and in every tab it opens later.",
  parameters: Schema.Struct({ script: Schema.String.check(Schema.isMaxLength(64_000)) }),
  success: Schema.Struct({}),
  failure,
  dependencies,
}).annotate(Tool.Destructive, true);

const LoginTool = Tool.make("t3_browser_login", {
  description:
    "Type a saved BROWSER_LOGIN_ login's password into a password field of one of this run's tabs, by locator. The value stays on the server and is redacted from output; page code is refused on that tab afterwards. `outcome` says whether it was typed, and why not.",
  parameters: Schema.Struct({
    tabId: PreviewTabId,
    key: Schema.String,
    locator: Schema.String,
  }),
  success: Schema.Struct({
    outcome: Schema.Literals(["filled", "stale", "origin", "not-password", "not-focused"]),
  }),
  failure,
  dependencies,
}).annotate(Tool.Destructive, true);

const TabsTool = Tool.make("t3_browser_run_tabs", {
  description:
    "List this run's open tabs, oldest first, including windows its pages opened, with each one's URL.",
  success: Schema.Struct({
    tabs: Schema.Array(Schema.Struct({ tabId: Schema.String, url: Schema.NullOr(Schema.String) })),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const CloseTabTool = Tool.make("t3_browser_close", {
  description: "Close one of this run's tabs.",
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
  failure,
  dependencies,
}).annotate(Tool.Destructive, true);

/** Listed to every caller this endpoint admits, thread or not; its handlers recheck access per call. */
const listedToRunCallers = () => true;

/** Upstream lists its preview tools to thread callers only, which would hide them from `t3 browser run` outside a thread. */
const forRun = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, listedToRunCallers) as T;

const preview = Object.fromEntries(
  Object.entries(PreviewToolkit.tools).map(([name, tool]) => [name, forRun(tool)]),
) as unknown as typeof PreviewToolkit.tools;

/**
 * The browser-run endpoint's tools: upstream's preview operations under their own names, on the
 * run's headless tabs, plus what a script needs that they lack. Never listed to an agent session.
 */
export const BrowserRunToolkit = Toolkit.make(
  OpenRunTool,
  CloseRunTool,
  InitScriptTool,
  LoginTool,
  TabsTool,
  CloseTabTool,
  preview.preview_open,
  preview.preview_status,
  preview.preview_navigate,
  preview.preview_resize,
  preview.preview_interact,
  preview.preview_upload,
  preview.preview_evaluate,
  preview.preview_wait_for,
  preview.preview_recording_start,
  preview.preview_recording_stop,
);

/** The snapshot tool returns an image, so it registers apart from the rest. */
export const BrowserRunSnapshotTool = preview.preview_snapshot;
export const BrowserRunSnapshotToolkit = Toolkit.make(BrowserRunSnapshotTool);
