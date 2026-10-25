// No T3 imports inside the string; resolve Pi and typebox from the user's Pi install.
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3ChildInstructions,
} from "@t3tools/provider-core/server/orchestrationInstructions";

export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
/** JSON list of the thread's agent servers (`name`, `url`, `authorizationHeader`), such as Weave. */
export const T3_MCP_AGENT_SERVERS_ENV = "T3_MCP_AGENT_SERVERS";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
/** "1" when the thread is a delegated child, which gets the shorter child text. */
/**
 * The exact instruction text a delegated Pi thread receives, chosen here so the
 * generated extension carries no selection logic of its own. Unset for a parent
 * thread, which uses `ORCHESTRATION_INSTRUCTIONS`.
 */
export const T3_PI_INSTRUCTIONS_ENV = "T3_PI_INSTRUCTIONS";

/**
 * The child text a Pi process may need, keyed by what its endpoint lists, so the
 * generated extension never names a tool its own listing lacks.
 */
export const PI_CHILD_INSTRUCTION_VARIANTS: Readonly<Record<string, string>> = {
  none: t3ChildInstructions({ preview: false, html: false }).trim(),
  html: t3ChildInstructions({ preview: false, html: true }).trim(),
  preview: t3ChildInstructions({ preview: true, html: false }).trim(),
  "preview-html": t3ChildInstructions({ preview: true, html: true }).trim(),
};

const piChildInstructionKey = (listing: {
  readonly preview: boolean;
  readonly html: boolean;
}): keyof typeof PI_CHILD_INSTRUCTION_VARIANTS =>
  listing.preview ? (listing.html ? "preview-html" : "preview") : listing.html ? "html" : "none";

/** The child text for a thread whose endpoint lists `listing`. */
export const piChildInstructionsFor = (listing: {
  readonly preview: boolean;
  readonly html: boolean;
}): string => PI_CHILD_INSTRUCTION_VARIANTS[piChildInstructionKey(listing)] ?? "";

export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

// These tools trigger file-change approvals, bypassed by Auto-accept edits.
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const AGENT_SERVERS_ENV = ${JSON.stringify(T3_MCP_AGENT_SERVERS_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const EXTENSION_PATH_ENV = ${JSON.stringify(T3_PI_MCP_EXTENSION_PATH_ENV)};
const INSTRUCTIONS_ENV = ${JSON.stringify(T3_PI_INSTRUCTIONS_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};

const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly outputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

const isNullSchema = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "null";

/** anyOf: [X, {type: "null"}] is just X; optionality is already carried by required. */
function collapseNullUnion(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(collapseNullUnion);
  if (typeof schema !== "object" || schema === null) return schema;
  const record = schema as Record<string, unknown>;
  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : undefined;
  if (anyOf !== undefined) {
    const nonNull = anyOf.filter((entry) => !isNullSchema(entry));
    if (nonNull.length === 1 && nonNull.length !== anyOf.length) {
      const { anyOf: _anyOf, ...rest } = record;
      const branch = nonNull[0];
      return collapseNullUnion(
        typeof branch === "object" && branch !== null
          ? { ...rest, ...(branch as Record<string, unknown>) }
          : rest,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, collapseNullUnion(value)]),
  );
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    // Zero-argument MCP tools may omit "properties", which some OpenAI-compatible
    // servers reject. Declare it, as Pi does for its own MCP tools.
    const collapsed = collapseNullUnion(schema) as Record<string, unknown>;
    return unsafe({
      ...collapsed,
      type: collapsed.type ?? "object",
      ...(collapsed.properties === undefined ? { properties: {} } : {}),
    });
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Pi's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function mcpScriptResult(result: JsonValue | undefined) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const { _meta: _ignored, ...scriptResult } = result;
  return scriptResult;
}

const PRIMITIVE_TYPES = new Set(["string", "number", "boolean", "integer", "null"]);

/**
 * The shape a caller needs to read a result is its field names, not the tree
 * below them: this keeps every top-level property with its primitive type and
 * collapses nested objects and arrays to "anything". A result schema carries
 * more detail than any caller reads, and pi renders this whole thing as the
 * declared return type of the tool.
 */
function summariseOutputSchema(schema: unknown) {
  if (typeof schema !== "object" || schema === null) return schema;
  const candidate = schema as { properties?: unknown; required?: unknown };
  const properties = candidate.properties;
  if (typeof properties !== "object" || properties === null) return schema;
  const summarised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    const type =
      typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
    summarised[key] = typeof type === "string" && PRIMITIVE_TYPES.has(type) ? { type } : {};
  }
  return {
    type: "object",
    properties: summarised,
    ...(Array.isArray(candidate.required) ? { required: candidate.required } : {}),
  };
}

function mcpOutputSchema(tool: McpTool) {
  return jsonSchemaToTypebox({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(tool.outputSchema === undefined
        ? {}
        : { structuredContent: summariseOutputSchema(tool.outputSchema) }),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  });
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  // Keep skill chips in the request. Pi expands only one leading /skill:
  // command, so use its own frontmatter loader for every selected chip here.
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("$")) return;
    const commands = pi.getCommands().filter((command) => command.source === "skill");
    const nativeSkill = /^\\/skill:([^ ]+)(?: |$)/.exec(event.text)?.[1];
    const seen = new Set<string>(nativeSkill === undefined ? [] : [nativeSkill]);
    const blocks: string[] = [];
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (name === undefined || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name);
      if (command === undefined) continue;
      seen.add(name);
      const path = command.sourceInfo.path;
      try {
        const body = stripFrontmatter(await NodeFSP.readFile(path, "utf8")).trim();
        blocks.push(
          \`<skill name="\${name}" location="\${path}">\\nReferences are relative to \${NodePath.dirname(path)}.\\n\\n\${body}\\n</skill>\`,
        );
      } catch {
        ctx.ui.notify(\`Could not load skill \${name} from \${path}.\`, "error");
      }
    }
    if (blocks.length === 0) return;
    return {
      action: "transform",
      text: event.text + "\\n\\n" + blocks.join("\\n\\n"),
      images: event.images,
    };
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");

  // T3's annotated reads, and every tool of an agent server, which itself decides
  // what this thread's role may do there.
  const approvedMcpTools = new Set<string>();
  const isApprovedMcpTool = (name: string) => {
    const extensionPath = env(EXTENSION_PATH_ENV);
    if (extensionPath === undefined || !approvedMcpTools.has(name) || typeof pi.getAllTools !== "function") return false;
    // A user extension may own the same name. Only our registered HTTP bridge
    // may inherit the canonical server's approval.
    return pi.getAllTools().some((tool) => tool.name === name &&
      typeof tool.sourceInfo?.path === "string" &&
      NodePath.resolve(tool.sourceInfo.path) === NodePath.resolve(extensionPath));
  };

  // The repository's guard runs in T3, not here: Pi leaves permission policy to
  // extensions, so this hook is the only point that sees a command before it runs.
  // Every mode asks, including full access, and a guard that cannot answer lets the
  // call through, as the harness hooks did.
  const guardRefusal = async (
    event: { readonly toolName: string; readonly input: unknown },
    ctx: { readonly signal?: AbortSignal },
  ): Promise<{ block: true; reason: string } | undefined> => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { readonly command?: unknown } | null | undefined;
    const command = typeof input?.command === "string" ? input.command : undefined;
    if (command === undefined || command.trim().length === 0) return undefined;
    try {
      const t3 = servers.find((server) => server.name === "t3-code");
      if (t3 === undefined) return undefined;
      const result = (await t3.client.callTool(
        "t3_guard_command",
        { cwd: process.cwd(), command },
        ctx.signal,
      )) as
        | {
            readonly structuredContent?: { readonly allowed?: boolean; readonly reason?: string | null };
            readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
          }
        | undefined;
      const decision = result?.structuredContent as
        | { readonly allowed?: boolean; readonly reason?: string | null }
        | undefined;
      if (decision?.allowed !== false) return undefined;
      const reason =
        typeof decision.reason === "string" && decision.reason.trim().length > 0
          ? decision.reason
          : "This command is blocked by the repository's SlipJay guard.";
      return { block: true, reason };
    } catch {
      return undefined;
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    const refusal = await guardRefusal(event, ctx);
    if (refusal !== undefined) return refusal;
    const mode = runtimeMode();
    if (mode === "full-access") return;
    if ((event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) || isApprovedMcpTool(event.toolName)) {
      return;
    }
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
      { signal: ctx.signal },
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
    }
  });

  type BridgeServer = {
    readonly name: string;
    readonly agent: boolean;
    readonly client: ReturnType<typeof createMcpClient>;
    catalog: ReadonlyArray<McpTool>;
    started: Promise<void> | undefined;
  };
  const bridgeServer = (name: string, agent: boolean, endpoint: string, token: string): BridgeServer => ({
    name,
    agent,
    client: createMcpClient(endpoint, token),
    catalog: [],
    started: undefined,
  });

  const servers: BridgeServer[] = [];
  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  const hasT3 = endpoint !== undefined && token !== undefined;
  if (hasT3) servers.push(bridgeServer("t3-code", false, endpoint, token));
  try {
    const agentServers = JSON.parse(env(AGENT_SERVERS_ENV) ?? "[]") as ReadonlyArray<{
      readonly name?: unknown;
      readonly url?: unknown;
      readonly authorizationHeader?: unknown;
    }>;
    for (const server of agentServers) {
      if (
        typeof server.name === "string" && server.name !== "t3-code" &&
        typeof server.url === "string" && typeof server.authorizationHeader === "string"
      ) {
        servers.push(bridgeServer(server.name, true, server.url, server.authorizationHeader));
      }
    }
  } catch {
    // A malformed list attaches no agent servers; T3's own tools still load.
  }
  if (!hasT3) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
  }
  if (servers.length === 0) return;

  // Tool exposure arrived with registerMcpServer in Pi 0.99. Keep the HTTP
  // bridge as the credential owner: mcp.json overrides native registrations.
  const supportsExposure = "registerMcpServer" in pi && typeof pi.registerMcpServer === "function";
  const directTools = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
  let deferOptionalTools = supportsExposure;

  const registerTools = () => {
    approvedMcpTools.clear();
    for (const server of servers) {
      // Preserve public names for saved loadouts and tool selectors. Hidden
      // canonical names reserve ownership against Pi's configured MCP servers.
      const publicPrefix = \`mcp__\${server.name}__\`;
      const canonicalPrefix = \`mcp__\${server.name.replaceAll("-", "_")}__\`;
      const prefixes = supportsExposure && canonicalPrefix !== publicPrefix
        ? [publicPrefix, canonicalPrefix]
        : [publicPrefix];
      for (const tool of server.catalog) {
        const name = tool.name;
        for (const prefix of prefixes) {
          if (server.agent || tool.annotations?.readOnlyHint === true) approvedMcpTools.add(\`\${prefix}\${name}\`);
          const exposure = prefix !== publicPrefix ? "hidden" :
            deferOptionalTools && (server.agent || !directTools.has(name)) ? "deferred" : "direct";
          pi.registerTool({
            name: \`\${prefix}\${name}\`,
            label: name,
            description: tool.description ?? name,
            parameters: jsonSchemaToTypebox(tool.inputSchema),
            ...(supportsExposure ? { outputSchema: mcpOutputSchema(tool) } : {}),
            ...(supportsExposure ? { exposure } : {}),
            async execute(_toolCallId, params, signal) {
              const result = await server.client.callTool(
                name,
                (params ?? {}) as Record<string, unknown>,
                signal,
              );
              const content = mcpModelContent(result);
              if (isMcpToolError(result) && !content.some((part) => part.type === "text" && part.text.length > 0)) {
                content.push({ type: "text", text: "MCP tool " + server.name + "/" + name + " returned an error" });
              }
              return {
                content,
                structuredContent: mcpScriptResult(result),
                details: { server: server.name, tool: name },
                ...(isMcpToolError(result) ? { isError: true } : {}),
              };
            },
          });
        }
      }
    }
  };

  const ensureStarted = (server: BridgeServer) => {
    if (server.started !== undefined) return server.started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await server.client.connect(signal);
      server.catalog = await server.client.listTools(signal);
      registerTools();
    })();
    server.started = attempt;
    void attempt.catch(() => {
      if (server.started === attempt) server.started = undefined;
    });
    return attempt;
  };

  // CLI extensions load before builtins, and Pi keeps the first registration
  // of a tool name. Register now so the bridge owns each server's namespace even
  // when mcp.json configures it; retry a failed connection at session_start.
  await Promise.all(servers.map((server) => ensureStarted(server).catch(() => undefined)));

  const reconcileDiscovery = () => {
    if (!supportsExposure) return;
    // A disabled or replaced search builtin cannot discover deferred tools.
    const hasToolSearch = hasBuiltinToolSearch();
    const exposureChanged = deferOptionalTools !== hasToolSearch;
    deferOptionalTools = hasToolSearch;
    if (exposureChanged) registerTools();
    const active = pi.getActiveTools();
    // The server already lists the thread's full set, so a completions gateway
    // needs no eager catalogue. Restore only the search builtin that discovers
    // deferred tools; Pi still applies --tools/--exclude-tools.
    const required = hasToolSearch ? ["tool_search"] : [];
    const missing = required.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  };

  // Tree navigation restores its saved loadout after session_start.
  pi.on("session_tree", () => reconcileDiscovery());
  pi.on("model_select", () => reconcileDiscovery());
  pi.on("session_start", async (_event, ctx) => {
    reconcileDiscovery();
    for (const server of servers) {
      try {
        await ensureStarted(server);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(\`\${server.name} MCP unavailable: \${message}\`, "warning");
      }
    }
  });

  if (!hasT3) return;

  const instructions = process.env[INSTRUCTIONS_ENV] ?? ORCHESTRATION_INSTRUCTIONS;

  // Keep guidance in the system prompt so leading slash commands still expand.
  pi.on("before_agent_start", (event) => {
    reconcileDiscovery();
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      // A full prompt override bypasses Pi's later section rendering.
      sections.t3_code_orchestration = instructions;
      return undefined;
    }
    return { systemPrompt: event.systemPrompt + "\\n\\n" + instructions };
  });
}
`;
