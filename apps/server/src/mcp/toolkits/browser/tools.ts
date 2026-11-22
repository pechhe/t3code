import {
  BrowserNavigationTarget,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationDialogInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationSnapshotMetadata,
  PreviewAutomationStatus,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
  PreviewListResult,
  PreviewTabId,
  PreviewTaskCancelInput,
  PreviewTaskRequest,
  PreviewTaskResult,
  PreviewViewportSize,
  ToolActivityIcon,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];
const failure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);
const tabId = Schema.optional(PreviewTabId);

const threadBound = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.listsBrowserTools) as T;

/** The step actions `browser_act` runs, in the order its description gives them. */
const BROWSER_ACT_ACTIONS = [
  "navigate",
  "click",
  "type",
  "press",
  "hover",
  "select",
  "drag",
  "scroll",
  "wait",
  "resize",
  "appearance",
  "upload",
  "dialog",
  "evaluate",
] as const;
export type BrowserActAction = (typeof BROWSER_ACT_ACTIONS)[number];

// `url` already covers websites, so a dev server is the only other place to go.
const EnvironmentPortTarget = BrowserNavigationTarget.members[1];

const OpenTool = threadBound(
  Tool.make("browser_open", {
    description:
      "Open a new browser tab and get its `tabId` for every other browser_* call. Default: a fresh headless tab on T3's server Chromium, with empty storage, only you can use, that `browser_task` can drive; it lists `logins`, the saved login keys a task may type here. `backend:'phi'` opens Henry's Phi browser instead, only when the work needs his logins or eyes: `phiLane` shadow (isolated incognito), agents (the shared sign-in Space, can hand off) or user (his own window, only when he asked; without `url` it takes over his selected tab). `show:true` opens it in this thread's browser panel for the user, following the project's browser setting, and `profileId` (from `browser_status` profiles) uses saved browser logins. A task's browser agent keeps the backend and lane its task chose. For a dev server pass `target` instead of `url`. Close tabs you open with `browser_close`. Page code, loops over pages or in-page timings belong in `t3 browser run <file>` (see its --help).",
    parameters: Schema.Struct({
      url: PreviewAutomationOpenInput.fields.url,
      target: Schema.optional(EnvironmentPortTarget),
      backend: Schema.optional(Schema.Literals(["headless", "phi"])).annotate({
        description: "Default headless.",
      }),
      phiLane: PreviewAutomationOpenInput.fields.phiLane,
      show: Schema.optional(
        Schema.Boolean.annotate({ description: "Show it in this thread's browser panel." }),
      ),
      profileId: PreviewAutomationOpenInput.fields.profileId,
      viewport: Schema.optional(PreviewViewportSize).annotate({
        description: "Fixes a headless tab's size for its life.",
      }),
    }),
    success: PreviewAutomationStatus,
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser tab")
    .annotate(Tool.Destructive, false),
);

const StatusTool = threadBound(
  Tool.make("browser_status", {
    description:
      "Report a tab without reading its page: URL, title, loading, viewport, owner, pending dialog or file picker, downloads, `logins` and the backend's supported operations. Phi status can return `humanMessages`: follow those instructions from the user. Without `tabId`: the thread's browser, listing its `tabs` (including ones the user opened, which you may read but act on only when unclaimed) and `profiles`. `list:true` pages through the thread's browser panel tabs. `recording:'start'|'stop'` records a tab; stop returns the file's path.",
    parameters: Schema.Struct({
      tabId,
      list: Schema.optional(Schema.Boolean),
      cursor: Schema.optional(NonNegativeInt),
      limit: Schema.optional(clampedPositiveInt(50)),
      recording: Schema.optional(Schema.Literals(["start", "stop"])),
    }),
    success: Schema.Union([
      PreviewAutomationStatus,
      Schema.Struct({ ...PreviewListResult.fields, nextCursor: Schema.NullOr(NonNegativeInt) }),
      PreviewAutomationRecordingStatus,
      PreviewAutomationRecordingArtifact,
    ]),
    failure,
    dependencies: [
      ...dependencies,
      PreviewManager.PreviewManager,
      FileSystem.FileSystem,
      ServerConfig.ServerConfig,
    ],
  })
    .annotate(Tool.Title, "Get browser status")
    .annotate(Tool.Destructive, false),
);

// `fullScreenshot` and `pixelsRequired` are the server's own requests, not parameters.
const {
  fullScreenshot: _fullScreenshot,
  pixelsRequired: _pixelsRequired,
  ...snapshotFields
} = PreviewAutomationSnapshotInput.fields;

// Not read-only: save=true writes the screenshot to disk.
export const BrowserSnapshotTool = threadBound(
  Tool.make("browser_snapshot", {
    description:
      "Read a tab's page: state, diagnostics, action history, image size and each element once with a `ref` (in `accessibilityTree` on headless, in `visibleText` on Phi). Target one with `locator='aria-ref=<ref>'` in `browser_act`, or pass `locator` here to read one region such as a card or dialog. Refs die on navigation, a new snapshot or takeover. Works on a tab the user drives. Text caps near 20 KB and lists what it left out. `includeImage:true` is for you to see the page; to show the user, `save:true` and embed ![alt](screenshotPath). Refused while a task holds the tab.",
    parameters: Schema.Struct({
      ...snapshotFields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({ description: "Default false. True only to see the page." }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({ description: "Write PNG, return `screenshotPath`." }),
      ),
    }),
    success: Schema.Union([PreviewAutomationSnapshot, PreviewAutomationSnapshotMetadata]),
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Inspect browser page")
    .annotate(Tool.Destructive, false),
);

const { tabId: _navigateTab, ...navigateFields } = PreviewAutomationNavigateInput.fields;
const { tabId: _waitTab, ...waitFields } = PreviewAutomationWaitForInput.fields;
const { tabId: _resizeTab, ...resizeFields } = PreviewAutomationResizeInput.fields;
const { tabId: _uploadTab, ...uploadFields } = PreviewAutomationUploadInput.fields;
const { tabId: _evaluateTab, ...evaluateFields } = PreviewAutomationEvaluateInput.fields;
const { tabId: _dialogTab, ...dialogFields } = PreviewAutomationDialogInput.fields;
const { tabId: _schemeTab, ...schemeFields } = PreviewAutomationSetColorSchemeInput.fields;

/**
 * One flat step shape keeps the listing small; the server decodes each step with its action's
 * strict input, which names the fields it takes.
 */
export const BrowserActStep = Schema.Struct({
  action: Schema.Literals(BROWSER_ACT_ACTIONS),
  url: navigateFields.url,
  readiness: navigateFields.readiness,
  locator: Schema.optional(Schema.String).annotate({
    description: "Playwright locator, e.g. aria-ref=<ref> or role=button[name='Send'].",
  }),
  selector: Schema.optional(Schema.String).annotate({ description: "Legacy CSS selector." }),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  clickCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  text: Schema.optional(Schema.String),
  clear: Schema.optional(Schema.Boolean),
  key: Schema.optional(Schema.String),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
  values: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.optional(Schema.String),
  target: Schema.optional(Schema.Union([Schema.String, EnvironmentPortTarget])).annotate({
    description: "drag: the drop locator. navigate: a dev server instead of url.",
  }),
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  textAbsent: waitFields.textAbsent,
  locatorAbsent: waitFields.locatorAbsent,
  urlIncludes: waitFields.urlIncludes,
  mode: Schema.optional(resizeFields.mode),
  preset: resizeFields.preset,
  width: resizeFields.width,
  height: resizeFields.height,
  orientation: resizeFields.orientation,
  colorScheme: Schema.optional(schemeFields.colorScheme),
  paths: Schema.optional(uploadFields.paths),
  accept: Schema.optional(dialogFields.accept),
  promptText: dialogFields.promptText,
  expression: Schema.optional(evaluateFields.expression),
  awaitPromise: evaluateFields.awaitPromise,
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "This step's limit. Default 15000; maximum 60000.",
  }),
});
export type BrowserActStep = typeof BrowserActStep.Type;

const ActTool = threadBound(
  Tool.make("browser_act", {
    description:
      "Run steps in order on one of your tabs (default: the current tab, resolved once), stopping at the first that fails; its `failed` says which and why, and the steps before it happened. Each step names an `action`: navigate (url, or target for a dev server), click (locator, selector or x/y; button, clickCount), type (text, clear), press (key, modifiers), hover, select (values), drag (source, target), scroll (deltaX/deltaY), wait (all of locator, locatorAbsent, text, textAbsent, urlIncludes hold; text matches case), resize ({mode:'fill'}, {mode:'freeform',width,height} or {mode:'preset',preset,orientation}), appearance (colorScheme dark, light or system), upload (absolute paths to the open file picker, or locator of an <input type=file>; [] cancels), dialog (accept, promptText) and evaluate (expression: JavaScript in the page, returning `{value}`). Target elements by `locator` from your latest browser_snapshot. Headless tabs and browser agents get no upload, dialog or page code. A call takes at most 25 steps, 10 for an implementer or reviewer. Page tools write only on user request.",
    parameters: Schema.Struct({
      tabId,
      steps: Schema.Array(BrowserActStep).check(Schema.isMinLength(1)),
    }),
    success: Schema.Struct({
      toolIcon: Schema.optional(ToolActivityIcon),
      tabId: Schema.NullOr(PreviewTabId),
      completed: NonNegativeInt,
      results: Schema.Array(Schema.Unknown),
      failed: Schema.optional(
        Schema.Struct({
          step: NonNegativeInt,
          action: Schema.String,
          error: Schema.String,
          message: Schema.String,
        }),
      ),
    }),
    failure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  })
    .annotate(Tool.Title, "Act in browser tab")
    .annotate(Tool.Destructive, true),
);

const TaskTool = Tool.make("browser_task", {
  description:
    "Run a bounded browser job on a headless tab from browser_open. Prefer `steps` for scripted flows; goal mode explores. Take browser_snapshot first and name targets as the page shows them now: an exact `name`; `nameIncludes` with a part shown once for changing text (an age, a count); a `role` alone for the page's only element with that role; or, for a click or check, `text`, the element's whole visible line. Names over 900 characters cannot match. An ambiguous refusal lists candidate targets; retry with the chosen target under a new requestId. Copy a candidate's whole target, `ordinal` and `matchSet` included; an ordinal without its `matchSet`, or after the page's matches changed, stops as `stale-target`: snapshot again. A click, key press or submit target matching several elements takes a `hint` (\"in the header\"): Jev picks one and the result names it. Give the exact fields with supplied values, the only clicks, drags (`drag: { from, to }`, with real mouse input), key presses (such as Tab to accept a suggestion; leave `press.target` out to press on whatever holds focus, as a person tabs through a page) or URLs allowed, an explicit submit (dispatched at most once) and the checks that define success; every check must pass on the final page. A `focus` check passes when its target holds focus; the result also reports the focused element's role and name, or that nothing holds focus. For a password, bind a saved login from browser_open's `logins` (`control: login`): the server types it, and you never see it; after a blocked login, run it again as a task. With `steps`, it runs your ordered list (run an id, or screenshot) with no model call except for a hint, and Jev only uncovers a covered or late target using offered actions no step names; without `steps`, Jev picks among your offers towards `goal`, or with `pageReach` from any visible control too (exploring, unscripted paths): set `origins` and `avoid` (such as Delete or Send) on real data. A target the page plainly lacks stops it as `target-not-found` with the nearest matches. Screenshots return paths with step, URL and framing; set `includeImages` to see the last three yourself. Repeat a `requestId` to read the run's state; other inputs under it conflict; `browser_close` with it stops the run. After `blocked`, snapshot and send a new request under a new `requestId`. On `inspect-first` an uncertain mutation may have happened: snapshot before anything else and do not repeat it blindly. Limits default to 12 actions, 16 decisions, 60 s, with ceilings 24, 32, 120 s. No typed passwords, no generated text.",
  parameters: PreviewTaskRequest,
  success: PreviewTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, BrowserTaskService.BrowserTaskService],
})
  .annotate(Tool.Title, "Run bounded browser task")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true)
  // Listed only to a session granted bounded tasks; each call rechecks the thread, task and project.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.listsBoundedBrowser);

const HandoffTool = threadBound(
  Tool.make("browser_handoff", {
    description:
      "Hand a Phi Agents tab to the human for a login, 2FA, CAPTCHA or other manual step: `message` says what to do, and input stays blocked until they hand it back. Then call again with `resume:true`, which checks ownership and never takes control from them; give the tabId to recover a stopped session. Headless, shadow and user-lane tabs cannot hand off.",
    parameters: Schema.Struct({
      tabId,
      message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      resume: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Struct({
      tabId: Schema.optional(Schema.String),
      backend: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
    failure,
    dependencies,
  })
    .annotate(Tool.Title, "Hand a browser tab to the user")
    .annotate(Tool.Destructive, true),
);

const CloseTool = threadBound(
  Tool.make("browser_close", {
    description:
      "Close one of your tabs (`tabId`), or stop a running browser_task (`requestId`): nothing further is dispatched, but an action already in flight may still take effect and is reported as uncertain. Works after browser access is turned off. On the Phi user lane it lets go of the user's tab and closes only one you opened.",
    parameters: Schema.Struct({
      tabId,
      requestId: Schema.optional(PreviewTaskCancelInput.fields.requestId),
    }),
    // A union encodes with its first matching member, so the empty struct goes last.
    success: Schema.Union([PreviewTaskResult, Schema.Struct({})]),
    failure,
    dependencies: [
      ...dependencies,
      PreviewManager.PreviewManager,
      BrowserTaskService.BrowserTaskService,
    ],
  })
    .annotate(Tool.Title, "Close browser tab")
    .annotate(Tool.Destructive, true),
);

export const BrowserToolkit = Toolkit.make(
  OpenTool,
  StatusTool,
  ActTool,
  TaskTool,
  HandoffTool,
  CloseTool,
);

/** The snapshot tool returns an image, so it registers apart from the rest. */
export const BrowserSnapshotToolkit = Toolkit.make(BrowserSnapshotTool);
