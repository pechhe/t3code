import { Toolkit } from "effect/ai";

import { PreviewControlsToolkit } from "../previewControls/tools.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "../preview/tools.ts";

const preview = PreviewStandardToolkit.tools;
const controls = PreviewControlsToolkit.tools;

/**
 * Everything a managed browser task can call: the operations Phi supports, its bounded
 * handoff, and listing or closing its own tabs. There is no evaluate, upload or recording, and
 * no orchestration, thread, worktree or settings tool. The `/mcp/browser`
 * endpoint registers this and nothing else, so what is not here is not listed or callable.
 */
export const ManagedBrowserToolkit = Toolkit.make(
  preview.preview_open,
  preview.preview_status,
  preview.preview_navigate,
  preview.preview_interact,
  preview.preview_wait_for,
  preview.preview_resize,
  preview.preview_handoff,
  preview.preview_resume,
  controls.t3_preview_list,
  controls.t3_preview_close,
);

/** The snapshot tool returns an image, so it registers apart from the rest. */
export const ManagedBrowserSnapshotToolkit = PreviewSnapshotToolkit;
