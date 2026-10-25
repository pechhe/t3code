import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationDialogInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationSnapshotInput,
  PreviewAutomationTabTargetInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields);

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report preview tab state: backend identity and connectivity, supported operations, owner, pending dialog, URL, title, loading, viewport and size. Phi status can also return `humanMessages` from its console: read and follow those user instructions before continuing. A disconnected backend is not permission to use another one. Pass `tabId` to inspect a specific tab; omit it for this session's current tab, or the tab the user is viewing when you have none. `tabs` lists every tab in this thread with its owner, including tabs the user opened, and `profiles` lists logins for `preview_open`. Read any listed tab. Act only on your tab, or an unclaimed tab with no human in control.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Open a preview tab in this thread and show it. `open=false` keeps it in the background. Set `backend=phi` for Phi, which opens outside the inline panel; omit it for the effective default. `phiLane=shadow` is an isolated incognito window, `phiLane=agents` the shared sign-in Space with exclusive task custody, and `phiLane=user` the user's own window, only when the user asks for it: without `url` it takes over the tab they have selected, so you can carry on where they left off, and with `url` it opens a new tab there. Closing a user-lane tab releases it and closes only a tab you opened; the user stays in control, so re-snapshot before each step, and that lane cannot resize or hand off. A tab keeps its backend, profile and lane. Reuses your current tab unless `tabId` or `reuseExistingTab=false` says otherwise. Parallel subagents sharing a provider session must each use `reuseExistingTab=false`, then their own returned `tabId`. `profileId` (an id or name from `preview_status` profiles) opens under a profile and its saved logins. Another agent session's tabs can be read but not operated.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the dialog `preview_status` reports. Pass `promptText` to accept a prompt. Needs your own tab, or an unclaimed one. Desktop hosts may not support this.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the chosen tab. Pass `url` for a website, or `target:{kind:'environment-port',port}` for a dev server. Exactly one of `url` and `target`.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize the chosen tab: {mode:'fill'}, {mode:'freeform',width,height}, or {mode:'preset',preset,orientation}. Changes CSS size only, not the user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Set `prefers-color-scheme` for the chosen tab: 'dark', 'light', or 'system' to clear the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Use it only when the current request asks for browser work, including checking an edit in the browser. Never use it unasked to verify your own edit, or to repeat a snapshot from an earlier turn. Works on a tab the user is driving, even while they control it. Returns page state, semantic elements, diagnostics, action history and screenshot size. Each element is listed once with a `ref`, in `accessibilityTree` for the server browser and in `visibleText` for Phi, whose ARIA state (pressed, selected, expanded, checked, current) leads that text and which refuses page evaluation. Target one element with `locator='aria-ref=<ref>'` from `accessibilityTree`, even inside frames, and pass `locator` here to snapshot only one region, such as a card or dialog. Hidden and zero-size elements are left out, very long names are cut, and refs die on navigation, a new snapshot or human takeover. Text caps near 20 KB and lists what it omitted; `preview_evaluate` reads more on the server browser. To show a user a screenshot, `save=true` and embed ![alt](screenshotPath) in your reply: the image in a tool result is saved nowhere, and `includeImage=true` is only for you to see the page.",
    parameters: Schema.Struct({
      ...PreviewAutomationSnapshotInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Default false. True only to see the page.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description: "Write PNG, return `screenshotPath`.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewInteractTool = browserTool(
  Tool.make("preview_interact", {
    description:
      "Run one interaction in the tab selected by tabId, or this agent session's current tab. action chooses it: click (one target, button/clickCount), type (text, clear), press (key, modifiers), hover, select (values), drag (source and target), or scroll (deltaX/deltaY). Target with locator, selector, or x/y for click and hover; locator or selector for the rest. Server browser tabs only.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      action: Schema.Literals([
        "click",
        "type",
        "press",
        "hover",
        "select",
        "drag",
        "scroll",
      ]).annotate({
        description: "The interaction to perform.",
      }),
      locator: Schema.optional(Schema.String).annotate({
        description: "Playwright selector, for example aria-ref=<ref> or role=button[name='Send'].",
      }),
      selector: Schema.optional(Schema.String).annotate({
        description: "Legacy CSS selector. Prefer locator.",
      }),
      x: Schema.optional(Schema.Finite).annotate({
        description: "Viewport X coordinate for click or hover. Must be paired with y.",
      }),
      y: Schema.optional(Schema.Finite).annotate({
        description: "Viewport Y coordinate for click or hover. Must be paired with x.",
      }),
      timeoutMs: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
          description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000.",
        }),
      ),
      button: Schema.optional(
        Schema.Literals(["left", "right", "middle"]).annotate({
          description:
            "Mouse button for action=click. Defaults to left; right opens the page context menu.",
        }),
      ),
      clickCount: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
          description: "1 for a click, 2 for a double-click, 3 for a triple-click. Defaults to 1.",
        }),
      ),
      text: Schema.optional(Schema.String).annotate({
        description: "Literal text to insert for action=type.",
      }),
      clear: Schema.optional(Schema.Boolean).annotate({
        description: "Clear the input before typing. Defaults to false.",
      }),
      values: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "Option values or labels for action=select. An empty list clears it.",
      }),
      source: Schema.optional(Schema.String).annotate({
        description: "Locator of the element to drag for action=drag.",
      }),
      target: Schema.optional(Schema.String).annotate({
        description: "Locator to drop onto for action=drag.",
      }),
      key: Schema.optional(Schema.String).annotate({
        description: "Key name for action=press, such as Enter, Escape, Tab, or a character.",
      }),
      modifiers: Schema.optional(
        Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])).annotate({
          description: "Modifier keys held while pressing for action=press.",
        }),
      ),
      deltaX: Schema.optional(Schema.Finite).annotate({
        description: "Horizontal scroll delta for action=scroll. Positive scrolls right.",
      }),
      deltaY: Schema.optional(Schema.Finite).annotate({
        description: "Vertical scroll delta for action=scroll. Positive scrolls down.",
      }),
    }),
    success: Schema.Struct({
      ...presentationFields,
      selected: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description: "The values now selected for action=select.",
        }),
      ),
    }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Interact with preview page"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Give files from this environment to the page. After a click opens a file picker, `preview_status` reports it. Pass absolute paths to answer it, or an empty list to cancel. Or pass a locator for an <input type=file>.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JavaScript in the page. It can change page state. Returns `{value}`, up to 64 KB. Needs your tab, or an unclaimed one. To read a tab the user drives, use `preview_snapshot`. Page tools reached here: read data only, never create, save, or display. Show results with `html_render`.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the chosen tab, this session's current one when `tabId` is omitted, until all supplied locator, selector, text and URL conditions match. `textAbsent` and `locatorAbsent` wait for text or an element to go away, such as a card leaving after Accept or a dialog closing. A timeout names the condition that never held.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the chosen tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the chosen tab. Returns a local path to the recording file (max 50 MiB).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

const PreviewHandoffTool = browserTool(
  Tool.make("preview_handoff", {
    description:
      "Hand a Phi Agents tab to the human for login or another manual step. Input stays blocked until the human hands back. Not supported in an incognito shadow window.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      message: Schema.String.check(Schema.isMaxLength(500)).annotate({
        description: "What the human should do in the tab before handing it back.",
      }),
    }),
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }),
);
const PreviewResumeTool = browserTool(
  Tool.make("preview_resume", {
    description:
      "Resume a Phi Agents tab after the human has handed control back. Checks ownership and never takes control from the human. Supply the task tabId to recover a stopped session.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }),
);

export const PreviewToolkit = Toolkit.make(
  PreviewHandoffTool,
  PreviewResumeTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewInteractTool,
  PreviewUploadTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewHandoffTool,
  PreviewResumeTool,
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewInteractTool,
  PreviewUploadTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
