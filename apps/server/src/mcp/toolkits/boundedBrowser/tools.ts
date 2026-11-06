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
      "Open a fresh tab for bounded browser work: integrated browser, new isolated storage, no cookies from elsewhere, in the background. Returns its `tabId`; pass it to every other t3_browser_* call, and `logins`, the saved login keys a task may type on this origin. Each call opens another tab, and only this session can use it. Use it for a page you need to check or a form you were given values for; close the tab when done.",
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
      "Report one of your bounded tabs: URL, title, loading, viewport, whether a task holds it, and `logins` for its origin. Never returns page content.",
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
      "Run a bounded browser job on your own tab from t3_browser_open. Take t3_browser_snapshot first and name targets as the page shows them now: an exact `name`; `nameIncludes` with a part shown once for changing text (an age, a count); a `role` alone for the page's only element with that role; or, for a click or check, `text`, the element's whole visible line. Names over 900 characters cannot match. A click, key press or submit target matching several elements takes a `hint` (\"in the header\"): Jev picks one and the result names it. Give the exact fields with supplied values, the only clicks, key presses (such as Tab to accept a suggestion) or URLs allowed, an explicit submit (dispatched at most once) and the checks that define success; every check must pass on the final page. For a password, bind a saved login from t3_browser_open's `logins` (`control: login`): the server types it, and you never see it; after a blocked login, run it again as a task. With `steps`, it runs your ordered list (run an id, or screenshot) with no model call except for a hint, and Jev only uncovers a covered or late target using offered actions no step names; without `steps`, Jev picks among your offers towards `goal`. A target the page plainly lacks stops it as `target-not-found` with the nearest matches. Screenshots return paths with step, URL and framing; set `includeImages` to see the last three yourself. Repeat a `requestId` to read the run's state; other inputs under it conflict. After `blocked`, snapshot and send a new request under a new `requestId`. On `inspect-first` an uncertain mutation may have happened: snapshot before anything else and do not repeat it blindly. Limits default to 12 actions, 16 decisions, 60 s, with ceilings 24, 32, 120 s. No typed passwords, no generated text.",
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
