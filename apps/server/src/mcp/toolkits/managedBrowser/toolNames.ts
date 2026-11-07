/**
 * The tools a managed browser task's `/mcp/browser` endpoint serves. Adapters pre-approve exactly
 * these and nothing else; `McpManagedBrowser.test.ts` checks the list against the toolkit.
 */
export const MANAGED_BROWSER_TOOL_NAMES = [
  "t3_decide",
  "preview_open",
  "preview_status",
  "preview_navigate",
  "preview_interact",
  "preview_snapshot",
  "preview_wait_for",
  "preview_resize",
  "preview_set_appearance",
  "preview_recording_start",
  "preview_recording_stop",
  "preview_handoff",
  "preview_resume",
  "t3_preview_list",
  "t3_preview_close",
  "preview_task",
  "preview_task_cancel",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
] as const;
