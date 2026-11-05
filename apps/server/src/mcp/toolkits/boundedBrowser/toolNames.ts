/**
 * The tools a session granted bounded browser tasks lists. Adapters pre-approve exactly these
 * for a managed leaf; `BoundedBrowser.test.ts` checks the list against the toolkits.
 */
export const BOUNDED_BROWSER_TOOL_NAMES = [
  "t3_browser_open",
  "t3_browser_status",
  "t3_browser_snapshot",
  "t3_browser_task",
  "t3_browser_task_cancel",
  "t3_browser_close",
] as const;
