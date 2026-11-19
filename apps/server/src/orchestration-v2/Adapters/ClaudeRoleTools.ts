import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/** What a managed writer adds to the read-only set: the coding tools, nothing else from the preset. */
const CLAUDE_MANAGED_WRITER_EXTRA_TOOLS = ["Write", "Edit", "Bash"] as const;
const CLAUDE_WEB_RESEARCH_TOOLS = ["WebSearch", "WebFetch"] as const;
/** Off for every editor: T3's `delegate_task` and `web_search` replace them, and T3 can count the former. */
export const CLAUDE_HARNESS_EXTRA_TOOLS = [
  "Agent",
  "ListAgents",
  "Task",
  ...CLAUDE_WEB_RESEARCH_TOOLS,
] as const;
// Claude Code defers MCP tool schemas only when ToolSearch is available. A restricted tool list
// without it sends every schema up front: Weave alone added 50k+ tokens to each delegated session.
const CLAUDE_TOOL_SEARCH_TOOL = "ToolSearch";

/** A managed task's query loads no user or project setting sources, skills, plugins or MCP config. */
export const managedClaudeQueryIsolation = (): {
  readonly settingSources: Array<never>;
  readonly skills: Array<never>;
  readonly plugins: Array<never>;
  readonly strictMcpConfig: true;
} => ({ settingSources: [], skills: [], plugins: [], strictMcpConfig: true });

/** A managed task keeps only its model selection's settings, with every hook off. */
export const managedClaudeSettings = <S extends object>(selectionSettings: S | undefined) => ({
  ...selectionSettings,
  disableAllHooks: true,
});

/**
 * The tools a T3 role gives Claude: a reader its read-only set (plus web research when granted),
 * a managed writer the coding set, and every other editor the preset without the harness extras.
 * Managed Claude has no supported workspace-write sandbox, so only an attested read-only profile
 * or the explicitly admitted trusted route may reach its SDK.
 */
export function claudeRoleToolSets(input: {
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly sandboxKind: string | undefined;
  readonly readOnlyAllowedTools: ReadonlyArray<string>;
  readonly allowsGlobalReads: boolean;
}): {
  readonly tools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowedTools?: ReadonlyArray<string>;
} {
  const { runtimePolicy, sandboxKind } = input;
  if (
    runtimePolicy.managedAgent === true &&
    !(
      sandboxKind === "readOnly" ||
      (sandboxKind === "dangerFullAccess" &&
        runtimePolicy.runtimeMode === "full-access" &&
        runtimePolicy.approvalPolicy === "never")
    )
  ) {
    throw new Error("Managed Claude requires read-only execution or admitted trusted host access.");
  }
  const readOnlyTools = sandboxKind === "readOnly" ? input.readOnlyAllowedTools : undefined;
  const webTools =
    readOnlyTools !== undefined && runtimePolicy.webResearch === true
      ? CLAUDE_WEB_RESEARCH_TOOLS
      : [];
  // A managed writer keeps the coding set: the preset's other built-ins cost a worker ~20 KB per
  // first turn and do nothing T3's lazily loaded tools cannot (Henry, T3-532).
  const restrictedTools =
    readOnlyTools !== undefined
      ? [...readOnlyTools, ...webTools]
      : runtimePolicy.managedAgent === true
        ? [...input.readOnlyAllowedTools, ...CLAUDE_MANAGED_WRITER_EXTRA_TOOLS]
        : undefined;
  const tools = restrictedTools && [...restrictedTools, CLAUDE_TOOL_SEARCH_TOOL];
  const disallowedTools = restrictedTools === undefined ? CLAUDE_HARNESS_EXTRA_TOOLS : undefined;
  // Web tools need permission, so a web-research agent must pre-approve them.
  const allowedTools =
    readOnlyTools !== undefined && input.allowsGlobalReads
      ? [...readOnlyTools, ...webTools]
      : webTools.length > 0
        ? [...webTools]
        : undefined;
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}
