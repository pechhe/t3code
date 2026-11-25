/**
 * The browser tools a session granted bounded browser tasks lists. Adapters pre-approve exactly
 * these for a managed leaf; `SessionToolListings.test.ts` checks the list against the toolkit.
 */
export const BOUNDED_BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_status",
  "browser_snapshot",
  "browser_act",
  "browser_page_tools",
  "browser_task",
  "browser_close",
] as const;

/**
 * The tools a managed browser task's `/mcp/browser` endpoint serves. Adapters pre-approve exactly
 * these and nothing else; `McpManagedBrowser.test.ts` checks the list against the endpoint.
 */
export const MANAGED_BROWSER_TOOL_NAMES = [
  "t3_decide",
  "browser_open",
  "browser_status",
  "browser_snapshot",
  "browser_act",
  "browser_page_tools",
  "browser_handoff",
  "browser_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
] as const;

/** The only tools a managed browser task's session may use, or undefined for any other session. */
export const managedBrowserSessionTools = (
  session: { readonly managedBrowser?: boolean; readonly boundedBrowser?: boolean } | undefined,
): ReadonlyArray<string> | undefined =>
  session?.managedBrowser === true
    ? [...MANAGED_BROWSER_TOOL_NAMES, ...(session.boundedBrowser === true ? ["browser_task"] : [])]
    : undefined;
