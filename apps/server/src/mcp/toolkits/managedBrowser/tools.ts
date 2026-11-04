import { Toolkit } from "effect/ai";

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
