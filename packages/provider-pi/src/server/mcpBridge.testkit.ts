// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeEvents from "node:events";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema?: unknown;
  readonly exposure?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  }>;
}

type AgentStartHook = (
  event: {
    systemPrompt: string;
    systemPromptOptions?: { sections?: Record<string, string> | null; forceSystemPrompt?: string };
  },
  ctx: {
    model?: { api: string };
    ui: { notify: (message: string, severity: string) => void };
  },
) => Promise<{ systemPrompt: string } | undefined>;

export async function loadMcpBridge(
  options: {
    readonly modern?: boolean;
    readonly result?: unknown;
    readonly toolSearchAvailable?: boolean;
    readonly toolSearchDisabled?: boolean;
    readonly allowsTool?: (name: string) => boolean;
    readonly runtimeMode?: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** A delegated task's instructions, as T3 passes them to a child Pi session. */
    readonly delegatedInstructions?: string;
    readonly inputSchema?: Record<string, unknown>;
    /** Overrides the fixture catalogue's declared result schema. */
    readonly outputSchema?: unknown;
    /** Omits the thread's t3-code session, as a thread without T3 tools has none. */
    readonly withoutT3?: boolean;
    readonly agentServers?: ReadonlyArray<{
      readonly name: string;
      readonly url: string;
      readonly authorizationHeader: string;
      readonly tools: ReadonlyArray<string>;
    }>;
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  let activeTools = ["read"];
  let bridgeSourcePath = "/fixture/pi-t3-extension.ts";
  const transports: Array<{
    readonly url: string;
    readonly authorization: string;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const catalog = [
    {
      name: "orchestrator_capabilities",
      description: "Discover available providers and models.",
      annotations: { readOnlyHint: true },
    },
    { name: "delegate_task", description: "Delegate work to another agent." },
    {
      name: "task_status",
      description: "Check delegated work.",
      annotations: { readOnlyHint: false },
    },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ].map((tool) => ({
    ...tool,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    outputSchema: options.outputSchema ?? {
      type: "object",
      properties: { count: { type: "number" } },
    },
  }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  const respond = async (
    url: string,
    transport: { body: string; headers: Record<string, string>; signal?: AbortSignal },
  ) => {
    transport.signal?.throwIfAborted();
    transports.push({
      url,
      authorization: transport.headers.authorization!,
      signal: transport.signal,
    });
    const request = JSON.parse(transport.body) as {
      id: number;
      method: string;
      params?: unknown;
    };
    requests.push(request);
    const agentServer = options.agentServers?.find((server) => server.url === url);
    const result =
      request.method === "tools/list"
        ? {
            tools:
              agentServer === undefined
                ? catalog
                : agentServer.tools.map((name) => ({
                    name,
                    description: name,
                    inputSchema: { type: "object", properties: {} },
                  })),
          }
        : request.method === "tools/call"
          ? (options.result ?? { content: [{ type: "text", text: "browser snapshot" }] })
          : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      cwd: () => "/fixture/workspace",
      env: options.environment ?? {
        ...(options.withoutT3
          ? {}
          : { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" }),
        ...(options.agentServers === undefined
          ? {}
          : {
              T3_MCP_AGENT_SERVERS: JSON.stringify(
                options.agentServers.map(({ name, url, authorizationHeader }) => ({
                  name,
                  url,
                  authorizationHeader,
                })),
              ),
            }),
        T3_PI_MCP_EXTENSION_PATH: "/fixture/pi-t3-extension.ts",
        T3_PI_RUNTIME_MODE: options.runtimeMode,
        ...(options.delegatedInstructions === undefined
          ? {}
          : { T3_PI_INSTRUCTIONS: options.delegatedInstructions }),
      },
    },
    AbortSignal,
    NodeCrypto,
    NodePath,
    Type: { Unsafe: (schema: unknown) => schema },
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    // The extension posts through node:http; route it to the same fixture responder.
    NodeHTTP: fixtureHttp(() => respond),
    NodeHTTPS: fixtureHttp(() => respond),
    pi: {
      on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
      registerCommand: () => {},
      registerTool: (tool: RegisteredTool) => {
        if (options.allowsTool && !options.allowsTool(tool.name)) return;
        const index = tools.findIndex((current) => current.name === tool.name);
        if (index === -1) tools.push(tool);
        else tools[index] = tool;
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names.filter((name) => options.allowsTool?.(name) ?? true);
      },
      getAllTools: () => [
        ...tools.map((tool) => ({ name: tool.name, sourceInfo: { path: bridgeSourcePath } })),
        ...(options.toolSearchAvailable &&
        !options.toolSearchDisabled &&
        (options.allowsTool?.("tool_search") ?? true)
          ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
          : []),
      ],
      ...(options.modern
        ? {
            registerMcpServer: (name: string, config: Record<string, unknown>) =>
              servers.push({ name, config }),
            unregisterMcpServer: () => servers.splice(0),
          }
        : {}),
    },
  });
  return {
    handlers,
    tools,
    setBridgeSourcePath: (path: string) => {
      bridgeSourcePath = path;
    },
    requests,
    servers,
    transports,
    getActiveTools: () => activeTools,
    restoreActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}

/** A node:http stand-in that answers each POST from the fixture responder. */
function fixtureHttp(
  responder: () => (
    url: string,
    transport: { body: string; headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<Response>,
) {
  return {
    request: (
      url: URL,
      options: { headers: Record<string, string>; signal?: AbortSignal },
      onResponse: (res: unknown) => void,
    ) => {
      const events = new NodeEvents.EventEmitter();
      return Object.assign(events, {
        destroy: () => {},
        end: (body: string) => {
          void responder()(url.toString(), {
            body,
            headers: options.headers,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }).then(
            async (response) => {
              const res = new NodeEvents.EventEmitter();
              onResponse(
                Object.assign(res, {
                  statusCode: response.status,
                  headers: Object.fromEntries(response.headers.entries()),
                }),
              );
              res.emit("data", Buffer.from(await response.text()));
              res.emit("end");
            },
            (error) => events.emit("error", error),
          );
        },
      });
    },
  };
}
