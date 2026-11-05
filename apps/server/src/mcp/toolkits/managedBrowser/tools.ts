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
    "Opt-in: run a bounded navigation, form or target-screenshot job through Jev on your own integrated tab, instead of driving it step by step. Name the goal, the exact fields with supplied values, the only clicks or URLs allowed, an explicit submit target (dispatched at most once) and the checks that define success. Fields you supply are filled directly and Jev only picks among your other offered steps; every check must pass on the final page, so its DONE proves nothing. Takes `requestId`: repeat it to read the run's state; other inputs under it conflict. A closed tab or a server restart ends the run's tab, so repeating the request is refused rather than rerun: an earlier task may still have taken effect, so read the page in a new tab before repeating work under a new `requestId`. Refused on Phi. Limits default to 12 actions, 16 decisions, 60 s, with ceilings 24, 32, 120 s. The tab holds an exclusive lease while it runs, so other browser calls on it are refused except preview_status, t3_preview_close and preview_task_cancel. Afterwards keep going with normal preview tools in the same tab: on `inspect-first` take preview_snapshot before changing anything, since an uncertain mutation may have happened and repeating it may repeat its effect. No passwords, no generated text.",
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
