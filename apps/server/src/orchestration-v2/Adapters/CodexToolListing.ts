import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

/**
 * What a turn's instructions may describe. It follows the endpoint's listing, not
 * the permission: a reader in a browser-enabled project lists no preview tool and
 * must not be told one exists.
 */
export const codexTurnInstructionListing = (
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
) => ({
  delegated: mcpSession?.delegated === true,
  listsPreview: mcpSession?.listsPreview === true,
  listsDevice: mcpSession?.listsDevice === true,
  ...(mcpSession?.listsHtml === false ? { listsHtml: false } : {}),
});

/** Off for every agent: T3's `delegate_task`, browser and `web_search` tools replace them. */
export const CODEX_HARNESS_EXTRAS_OFF = {
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.browser_use": false,
  "features.computer_use": false,
  web_search: "disabled",
} as const;
