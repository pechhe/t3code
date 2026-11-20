// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { PI_T3_EXTENSION_SOURCE } from "./piT3Extension.ts";

export interface FakePiTool {
  readonly name: string;
  readonly sourceInfo?: { readonly path?: string };
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

export interface FakeMcpServerConfig {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly timeout: number;
  readonly exposure: string;
  readonly toolExposure?: Record<string, string>;
}

type Hook = (event: never, ctx: never) => unknown;

export interface FixtureOptions {
  readonly role?: string;
  readonly agentConfigRoot?: string;
  readonly runtimeMode?: string;
  /** A delegated task's instructions, as T3 passes them to a child Pi session. */
  readonly delegatedInstructions?: string;
  /** Omits the thread's t3-code session, as a thread without T3 tools has none. */
  readonly withoutT3?: boolean;
  readonly agentServers?: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
    readonly authorizationHeader: string;
  }>;
  /** Replaces the whole process environment the extension sees. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly toolSearchAvailable?: boolean;
  readonly codemodeAvailable?: boolean;
  readonly defaultTools?: ReadonlyArray<string>;
  readonly createThreadsAvailable?: boolean;
  /** Replaces every tool Pi reports, builtin discovery tools included. */
  readonly allTools?: ReadonlyArray<FakePiTool>;
  readonly agentDir?: string;
  /** Pi's builtin MCP extension, which owns /mcp; false as with --no-mcp or an adapter replacing it. */
  readonly builtinMcp?: boolean;
  readonly skillCommands?: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly sourceInfo: { readonly path: string };
  }>;
  /** The result T3 answers tools/call with, as the command guard sees it. */
  readonly result?: unknown;
  readonly controlStatus?: number;
  /** Extra globals for the extension's module scope, such as a fake child_process. */
  readonly globals?: Record<string, unknown>;
}

const extensionSource = NodeModule.stripTypeScriptTypes(
  PI_T3_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
    "export default async function",
    "async function",
  ),
);

/** Runs the extension in a node:vm with a fake Pi and a fixture T3 behind node:http. */
export async function loadPiT3Extension(options: FixtureOptions = {}) {
  const handlers = new Map<string, Hook[]>();
  const commands = new Map<string, (args: string) => Promise<void>>();
  const servers: Array<{ readonly name: string; readonly config: FakeMcpServerConfig }> = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  const transports: Array<{ readonly url: string; readonly authorization: string }> = [];
  const exitHandlers: Array<() => void> = [];
  const allTools: FakePiTool[] = [
    ...(options.allTools ?? [
      ...(options.toolSearchAvailable === true
        ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
        : []),
      ...(options.codemodeAvailable === true
        ? [{ name: "codemode", sourceInfo: { path: "builtin:codemode" } }]
        : []),
      ...(options.createThreadsAvailable === true
        ? [{ name: "mcp__t3_code__create_threads", sourceInfo: { path: "<mcp>" } }]
        : []),
    ]),
  ];
  let defaultTools = options.defaultTools;

  const respond = async (
    url: string,
    transport: { body: string; headers: Record<string, string> },
  ) => {
    transports.push({ url, authorization: transport.headers.authorization! });
    const request = JSON.parse(transport.body) as {
      id?: number;
      method: string;
      params?: unknown;
    };
    requests.push(request);
    if (options.controlStatus !== undefined) {
      return new Response("fixture failure", { status: options.controlStatus });
    }
    const result =
      request.method === "tools/call"
        ? (options.result ?? { content: [{ type: "text", text: "ok" }] })
        : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };

  const environment: NodeJS.ProcessEnv = options.environment ?? {
    ...(options.withoutT3
      ? {}
      : { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" }),
    ...(options.agentServers === undefined
      ? {}
      : { T3_MCP_AGENT_SERVERS: JSON.stringify(options.agentServers) }),
    T3_PI_MCP_EXTENSION_PATH: "/fixture/pi-t3-extension.ts",
    ...(options.runtimeMode === undefined ? {} : { T3_PI_RUNTIME_MODE: options.runtimeMode }),
    ...(options.role === undefined ? {} : { T3_PI_AGENT_ROLE: options.role }),
    ...(options.agentConfigRoot === undefined
      ? {}
      : { T3_PI_AGENT_CONFIG_ROOT: options.agentConfigRoot }),
    ...(options.delegatedInstructions === undefined
      ? {}
      : { T3_PI_INSTRUCTIONS: options.delegatedInstructions }),
  };

  await NodeVM.runInNewContext(`${extensionSource}\nt3McpExtension(pi)`, {
    process: {
      cwd: () => "/fixture/workspace",
      env: environment,
      argv: options.argv ?? [],
      once: (_event: string, handler: () => void) => exitHandlers.push(handler),
    },
    AbortSignal,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    NodeChildProcess,
    NodeCrypto,
    NodeFS,
    NodeFSP,
    NodeOS,
    NodePath,
    getAgentDir: () => options.agentDir ?? "/fixture/agent-dir",
    stripFrontmatter: (content: string) => content,
    getCurrentSystemPrompt: (messages: Array<{ content: string }>) =>
      messages.map((message) => message.content).join("\n"),
    getCurrentTools: (messages: Array<{ toolsAdded?: unknown[] }>) =>
      messages.flatMap((message) => message.toolsAdded ?? []),
    NodeHTTP: fixtureHttp(respond),
    NodeHTTPS: fixtureHttp(respond),
    ...options.globals,
    pi: {
      on: (name: string, handler: Hook) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand: (name: string, command: { handler: (args: string) => Promise<void> }) =>
        commands.set(name, command.handler),
      getCommands: () => [
        ...(options.builtinMcp === false
          ? []
          : [{ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } }]),
        ...(options.skillCommands ?? []),
      ],
      getAllTools: () => allTools,
      getActiveTools: () => allTools.map((tool) => tool.name),
      getSettings: () => ({ defaultTools }),
      registerMcpServer: (name: string, config: FakeMcpServerConfig) =>
        servers.push({ name, config }),
    },
  });

  return {
    /**
     * Pi's extension runner for one event: every registered handler runs in order, and the last
     * result wins. The context carries Pi's trusted-folder defaults unless a test replaces them.
     */
    hook: <Fn extends (...args: never[]) => unknown>(name: string) => {
      const registered = handlers.get(name);
      if (registered === undefined) throw new Error(`The extension registered no ${name} hook`);
      const withDefaults = (ctx: unknown) => ({
        cwd: "/fixture/workspace",
        isProjectTrusted: () => true,
        ui: { notify: () => {}, confirm: async () => true },
        ...(typeof ctx === "object" && ctx !== null ? ctx : {}),
      });
      const [only, ...rest] = registered;
      if (only !== undefined && rest.length === 0) {
        return ((event: never, ctx: never) =>
          only(event, withDefaults(ctx) as never)) as unknown as Fn;
      }
      return (async (event: never, ctx: never) => {
        let result: unknown;
        for (const handler of registered) {
          result = (await handler(event, withDefaults(ctx) as never)) ?? result;
        }
        return result;
      }) as unknown as Fn;
    },
    commands,
    servers,
    requests,
    transports,
    allTools,
    setDefaultTools: (tools: ReadonlyArray<string> | undefined) => {
      defaultTools = tools;
    },
    runExitHandlers: () => {
      for (const handler of exitHandlers) handler();
    },
  };
}

/** A node:http stand-in that answers each POST from the fixture responder. */
function fixtureHttp(
  respond: (
    url: string,
    transport: { body: string; headers: Record<string, string> },
  ) => Promise<Response>,
) {
  return {
    request: (
      url: URL,
      options: { headers: Record<string, string> },
      onResponse: (res: unknown) => void,
    ) => {
      const events = new NodeEvents.EventEmitter();
      return Object.assign(events, {
        destroy: () => {},
        setTimeout: () => {},
        end: (body: string) => {
          void respond(url.toString(), { body, headers: options.headers }).then(
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
