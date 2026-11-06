import {
  OrchestratorMcpFailure,
  PreviewTaskCancelInput,
  PreviewTaskRequest,
  PreviewTaskResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

import { PreviewControlsToolkit } from "../previewControls/tools.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "../preview/tools.ts";

const preview = PreviewStandardToolkit.tools;
const controls = PreviewControlsToolkit.tools;

/** The task's own browser tools; no page evaluation, file upload or control-plane authority. */
export const ManagedBrowserToolkit = Toolkit.make(
  preview.preview_open,
  preview.preview_status,
  preview.preview_navigate,
  preview.preview_interact,
  preview.preview_wait_for,
  preview.preview_resize,
  preview.preview_set_appearance,
  preview.preview_recording_start,
  preview.preview_recording_stop,
  preview.preview_handoff,
  preview.preview_resume,
  controls.t3_preview_list,
  controls.t3_preview_close,
);

/** The snapshot tool returns an image, so it registers apart from the rest. */
export const ManagedBrowserSnapshotToolkit = PreviewSnapshotToolkit;

const taskDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BrowserTaskService.BrowserTaskService,
];

const PreviewTaskTool = Tool.make("preview_task", {
  description:
    "Opt-in: run a bounded browser job on your own integrated tab instead of driving it step by step. Take preview_snapshot first and name targets exactly as the page shows them now. Give the exact fields with supplied values, the only clicks or URLs allowed, an explicit submit (dispatched at most once) and the checks that define success; every check must pass on the final page. With `steps`, it runs your ordered list (run an id, or screenshot) with no model call, and Jev only uncovers a covered or late target using offered actions no step names; without `steps`, Jev picks among your offers towards `goal`. A target the page plainly lacks stops it as `target-not-found` with the nearest matches. Screenshots return paths with step, URL and framing; set `includeImages` to see the last three yourself. Repeat a `requestId` to read the run's state; other inputs under it conflict. A closed tab or server restart ends the run's tab, so a repeat is refused: read the page in a new tab before repeating work under a new `requestId`. Refused on Phi. Limits default to 12 actions, 16 decisions, 60 s, with ceilings 24, 32, 120 s. The tab is leased while it runs; only preview_status, t3_preview_close and preview_task_cancel work on it. Afterwards continue with preview tools in the same tab; on `inspect-first` take preview_snapshot before changing anything. No passwords, no generated text.",
  parameters: PreviewTaskRequest,
  success: PreviewTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Run bounded browser task")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

const PreviewTaskCancelTool = Tool.make("preview_task_cancel", {
  description:
    "Stop a running preview_task: nothing further is dispatched, but an action already in flight may still take effect and is reported as uncertain. Returns the run's state.",
  parameters: PreviewTaskCancelInput,
  success: PreviewTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Cancel bounded browser task")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false);

export const ManagedBrowserTaskToolkit = Toolkit.make(PreviewTaskTool, PreviewTaskCancelTool);
