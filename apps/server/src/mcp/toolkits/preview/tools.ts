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

const PreviewActionResult = Schema.Struct(presentationFields).annotate({
  description: "The preview action completed successfully.",
});

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report browser backend identity, connectivity, supported operations and tab state. Phi status can also return humanMessages from its console; read and follow those user instructions before continuing. A disconnected backend is not permission to use another one. Integrated tabs include control owner, pending dialog, URL, title, visibility, loading state, viewport mode and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Server hosts also list every tab in the thread (tabs) with its owner, including tabs the user opened, and the browser profiles preview_open accepts. You can read any listed tab; act only on your own tabs, or on an unclaimed tab while no human controls it.",
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
      "Open a browser tab for this thread. Integrated tabs open their inline preview by default. Set backend=phi for Phi, or omit backend for the effective default. Phi opens outside the inline panel; phiLane=shadow creates an isolated incognito window, and phiLane=agents uses the shared sign-in Space with exclusive task custody. phiLane=user works in the user's own window, only when the user asks for it: without url it takes over the tab they have selected, so you can carry on where they left off; with url it opens a new tab there. Closing a user-lane tab releases it and closes only a tab you opened. The user stays in control, so re-snapshot before each step; a snapshot needs the tab still selected in their window. The user lane cannot resize or hand off. A tab keeps its backend/profile/lane; changing them requires a new tab. Set open=false for background-only automation. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. Parallel subagents sharing a provider session must each open with reuseExistingTab=false and pass their returned tabId on every call. Pass profileId (an id or name from preview_status profiles) to open under a browser profile and its saved logins; omit it for the user's default profile. Another agent session's tabs can be read but not operated.",
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
      "Accept or dismiss the server browser dialog reported by preview_status. For a prompt, supply promptText when accepting. Requires this agent to own the tab, or the tab to be unclaimed with no human in control. Desktop hosts may not support this operation.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
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
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
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
      "Inspect a page before interacting. Pass tabId to inspect a specific tab, including one the user opened (see preview_status tabs), even while they control it; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Returns page state, semantic elements, diagnostics, action history, and screenshot dimensions. Each element is listed once, with a ref: server snapshots in an accessibilityTree, Phi in visibleText. Pass locator=aria-ref=<ref> to target one exact element, including inside frames. Hidden and zero-size elements are left out, and very long names are cut. Pass locator on this tool to snapshot only one region, such as a card or dialog, when the full page is more than you need. Refresh refs after navigation, another snapshot, or human takeover. The text is capped near 20 KB and lists what it omitted. Integrated browsing supports preview_evaluate for further inspection; Phi deliberately rejects page evaluation, and lists ARIA state (pressed, selected, expanded, checked, current) at the start of its visibleText instead. Set includeImage=true only when you need to see the page, including a screenshot you also save; the image stays in tool history. Set save=true to write the PNG to disk and get back only the url and screenshotPath. Embed that path in your reply as ![alt](screenshotPath) so the user sees it. This is the only way to show the user a screenshot; the image in the tool result is not saved anywhere.",
    parameters: Schema.Struct({
      ...PreviewAutomationSnapshotInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Include the PNG image in the tool response. Defaults to false. Set true only when you need to see the page.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Write the screenshot PNG to disk and return its absolute path as screenshotPath. Unless includeImage=true, return only the url and screenshotPath. Defaults to false.",
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
      "Give files on the environment to the page in the tab selected by tabId, or this agent session's current tab when omitted. After clicking an upload control, preview_status reports the open fileChooser; call this with absolute paths to answer it, or with an empty list to cancel. Pass a locator for an <input type=file> to set its files without a picker. Server browser tabs only.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Needs the same control as clicking: it works on your own tabs and on the user's tab only while nobody controls it. To read a tab the user is driving, use preview_snapshot. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match. textAbsent and locatorAbsent wait for text or an element to go away, such as a card leaving after Accept or a dialog closing. A timeout names the condition that never held.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and transfer the compressed recording once (up to 50 MiB) to an evidence file readable in this agent's environment. Returns its environment-local path after transfer succeeds.",
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
