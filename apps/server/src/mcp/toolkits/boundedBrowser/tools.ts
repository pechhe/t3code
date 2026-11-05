import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewAutomationOpenInput,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationStatus,
  PreviewTabId,
  PreviewTaskCancelInput,
  PreviewTaskRequest,
  PreviewTaskResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];
const taskDependencies = [...dependencies, BrowserTaskService.BrowserTaskService];
const failure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);
const TabInput = Schema.Struct({ tabId: PreviewTabId });

/** Listed only to a session granted them; each call rechecks the thread, its task and project. */
const bounded = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, McpInvocationContext.listsBoundedBrowser) as T;

const OpenTool = bounded(
  Tool.make("t3_browser_open", {
    description:
      "Open a fresh tab for bounded browser work: integrated browser, new isolated storage, no saved logins, in the background. Returns its `tabId`; pass it to every other t3_browser_* call. Each call opens another tab, and only this session can use it. Use it for a page you need to check or a form you were given values for; close the tab when done.",
    parameters: Schema.Struct({ url: PreviewAutomationOpenInput.fields.url }),
    success: PreviewAutomationStatus,
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Open bounded browser tab")
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, false),
);

const StatusTool = bounded(
  Tool.make("t3_browser_status", {
    description:
      "Report one of your bounded tabs: URL, title, loading, viewport and whether a task holds it. Never returns page content.",
    parameters: TabInput,
    success: PreviewAutomationStatus,
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Get bounded tab status")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const BoundedBrowserSnapshotTool = bounded(
  Tool.make("t3_browser_snapshot", {
    description:
      "Read one of your bounded tabs only when you need to see it: after a task reports `inspect-first` or is blocked, or to judge the page yourself. Returns page state and semantic elements; `locator` narrows it to one element. `includeImage=true` shows you the screenshot; `save=true` writes the PNG and returns `screenshotPath`, which you can open or embed as ![alt](path). Refused while a task holds the tab.",
    parameters: Schema.Struct({
      tabId: PreviewTabId,
      locator: PreviewAutomationSnapshotInput.fields.locator,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({ description: "Default false. True to see the page." }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({ description: "Write PNG, return `screenshotPath`." }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Inspect bounded tab")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);

const TaskTool = bounded(
  Tool.make("t3_browser_task", {
    description:
      "Run a bounded navigation, form or target-screenshot job through Jev on your own tab from t3_browser_open. Name the goal, the exact fields with supplied values, the only clicks or URLs allowed, an explicit submit target (dispatched at most once) and the checks that define success. Supplied fields are filled directly and Jev only picks among your other offered steps; every check must pass on the final page, so its DONE proves nothing. Returns checks, actions taken and any artifact path, never the pages seen on the way. Repeat a `requestId` to read the run's state; other inputs under it conflict. After `blocked`, take t3_browser_snapshot and send a new bounded request under a new `requestId`, or close and reopen the tab. On `inspect-first` an uncertain mutation may have happened: snapshot before anything else and do not repeat it blindly. A closed tab or server restart ends the run's tab; repeating its request is refused. Limits default to 12 actions, 16 decisions, 60 s, with ceilings 24, 32, 120 s. No passwords, no generated text.",
    parameters: PreviewTaskRequest,
    success: PreviewTaskResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: taskDependencies,
  })
    .annotate(Tool.Title, "Run bounded browser task")
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
);

const CancelTool = bounded(
  Tool.make("t3_browser_task_cancel", {
    description:
      "Stop a running t3_browser_task: nothing further is dispatched, but an action already in flight may still take effect and is reported as uncertain. Works after browser access is turned off.",
    parameters: PreviewTaskCancelInput,
    success: PreviewTaskResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: taskDependencies,
  })
    .annotate(Tool.Title, "Cancel bounded browser task")
    .annotate(Tool.Destructive, false),
);

const CloseTool = bounded(
  Tool.make("t3_browser_close", {
    description:
      "Close one of your bounded tabs. Works after browser access is turned off. An effect already sent from the tab is not undone.",
    parameters: TabInput,
    success: Schema.Struct({}),
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Close bounded tab")
    .annotate(Tool.Destructive, true),
);

export const BoundedBrowserToolkit = Toolkit.make(
  OpenTool,
  StatusTool,
  TaskTool,
  CancelTool,
  CloseTool,
);

/** The snapshot tool returns an image, so it registers apart from the rest. */
export const BoundedBrowserSnapshotToolkit = Toolkit.make(BoundedBrowserSnapshotTool);
