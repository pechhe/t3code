// Fork-owned (T3-832): the Pi extension T3 loads. Upstream's mcpExtensionSource.ts stays as upstream
// ships it; see fork/differences.md for which of its changes to port here.
// No T3 imports inside the string; resolve Pi from the user's Pi install.
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { t3ChildInstructions } from "@t3tools/provider-core/server/delegatedChildInstructions";

import {
  PI_FILE_CHANGE_TOOLS,
  PI_T3_SERVICE_TIER_COMMAND,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./mcpExtensionSource.ts";
import {
  PI_READ_ONLY_SHELL_FILENAME,
  PI_READ_ONLY_SHELL_EXTENSION_SOURCE,
} from "./readOnlyShellSource.ts";

/** JSON list of the thread's agent servers (`name`, `url`, `authorizationHeader`), such as Weave. */
export const T3_MCP_AGENT_SERVERS_ENV = "T3_MCP_AGENT_SERVERS";
/**
 * The exact instruction text a delegated Pi thread receives, chosen here so the
 * generated extension carries no selection logic of its own. Unset for a parent
 * thread, which uses `ORCHESTRATION_INSTRUCTIONS`.
 */
export const T3_PI_INSTRUCTIONS_ENV = "T3_PI_INSTRUCTIONS";
export const T3_PI_NO_PR_LINKING_ENV = "T3_PI_NO_PR_LINKING";
export const T3_PI_AGENT_ROLE_ENV = "T3_PI_AGENT_ROLE";
export const T3_PI_AGENT_CONFIG_ROOT_ENV = "T3_PI_AGENT_CONFIG_ROOT";
export const T3_PI_READ_ONLY_ENV = "T3_PI_READ_ONLY";
export const T3_PI_READ_ONLY_SHELL_ENV = "T3_PI_READ_ONLY_SHELL";
/** Pi's own MCP client waits this long for a T3 tool; the server streams progress meanwhile. */
export const T3_TOOL_TIMEOUT_SECONDS = 30 * 60;

/** The child text for a thread whose endpoint lists `listing`. */
export const piChildInstructionsFor = (listing: {
  readonly preview: boolean;
  readonly html: boolean;
  readonly readOnlyShell?: boolean;
  readonly canDelegate?: boolean;
}): string => {
  const instructions = t3ChildInstructions(listing).trim();
  return listing.readOnlyShell === true
    ? instructions +
        "\n\nYour shell cannot change the assigned checkout's source files; everything outside the checkout, its .jj and .git metadata and its git-ignored paths that already exist stay writable, so jj, git and SlipJay commands work. pnpm exec/run fail here, so call tools directly, such as node_modules/.bin/vp. A command cannot create a new file or directory directly in a source directory, ignored or not: when one fails for that reason, report the path instead of working around it."
    : instructions;
};

export const PI_T3_EXTENSION_SOURCE = `\
import { getAgentDir, stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeHTTP from "node:http";
import * as NodeHTTPS from "node:https";
import * as NodePath from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const AGENT_SERVERS_ENV = ${JSON.stringify(T3_MCP_AGENT_SERVERS_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const INSTRUCTIONS_ENV = ${JSON.stringify(T3_PI_INSTRUCTIONS_ENV)};
const NO_PR_LINKING_ENV = ${JSON.stringify(T3_PI_NO_PR_LINKING_ENV)};
const ROLE_ENV = ${JSON.stringify(T3_PI_AGENT_ROLE_ENV)};
const CONFIG_ROOT_ENV = ${JSON.stringify(T3_PI_AGENT_CONFIG_ROOT_ENV)};
const READ_ONLY_ENV = ${JSON.stringify(T3_PI_READ_ONLY_ENV)};
const READ_ONLY_SHELL_ENV = ${JSON.stringify(T3_PI_READ_ONLY_SHELL_ENV)};
const EXTENSION_PATH_ENV = ${JSON.stringify(T3_PI_MCP_EXTENSION_PATH_ENV)};
const READ_ONLY_SHELL_FILENAME = ${JSON.stringify(PI_READ_ONLY_SHELL_FILENAME)};
${PI_READ_ONLY_SHELL_EXTENSION_SOURCE}
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PULL_REQUEST_LINKING_INSTRUCTIONS = ${JSON.stringify(PULL_REQUEST_LINKING_INSTRUCTIONS)};
const SERVICE_TIER_COMMAND = ${JSON.stringify(PI_T3_SERVICE_TIER_COMMAND)};
const PROTOCOL = "2025-06-18";
const CONTROL_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_SECONDS = ${T3_TOOL_TIMEOUT_SECONDS};
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
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

/** Pi names a server's tools \`mcp__<namespace>__<tool>\`, with \`-\` and other characters as \`_\`. */
const mcpNamespace = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

// T3 keys "Always allow this session" on this text, so a cut summary ends with the
// full input's hash: calls that differ only past the cut get separate grants.
function toolInputSummary(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }
  if (text.length <= 4_000) return text;
  const hash = NodeCrypto.createHash("sha256").update(text, "utf16le").digest("hex");
  return text.slice(0, 4_000) + "\\n... " + (text.length - 4_000) +
    " more characters not shown (sha256 " + hash + ")";
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


const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DEFINITION_REF_PREFIXES = ["#/$defs/", "#/definitions/"];

function definitionRefName(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  for (const prefix of DEFINITION_REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (name.length > 0 && !name.includes("/")) return name;
  }
  return undefined;
}

function definitionRefs(schema: unknown, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) definitionRefs(entry, into);
    return;
  }
  if (!isSchemaObject(schema)) return;
  const ref = definitionRefName(schema.$ref);
  if (ref !== undefined) into.add(ref);
  for (const value of Object.values(schema)) definitionRefs(value, into);
}

function cutRefs(schema: unknown, cuts: (target: string) => boolean): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => cutRefs(entry, cuts));
  if (!isSchemaObject(schema)) return schema;
  const ref = definitionRefName(schema.$ref);
  if (ref !== undefined && cuts(ref)) {
    const { $ref: _ref, ...rest } = schema;
    return rest;
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, cutRefs(value, cuts)]),
  );
}

/**
 * Some providers refuse any recursive schema (opencode-go) or a loop of required
 * fields (Gemini), and none can declare one losslessly. A $ref that leads back to
 * its own definition becomes an untyped schema; the server still validates it all.
 */
function cutDefinitionCycles(schema: Record<string, unknown>): Record<string, unknown> {
  for (const keyword of ["$defs", "definitions"]) {
    const definitions = schema[keyword];
    if (!isSchemaObject(definitions)) continue;
    const edges = new Map<string, ReadonlySet<string>>();
    for (const [name, definition] of Object.entries(definitions)) {
      const targets = new Set<string>();
      definitionRefs(definition, targets);
      edges.set(name, targets);
    }
    const reaches = (from: string, to: string) => {
      const seen = new Set<string>();
      const pending = [from];
      while (pending.length > 0) {
        const next = pending.pop();
        if (next === undefined || seen.has(next)) continue;
        if (next === to) return true;
        seen.add(next);
        pending.push(...(edges.get(next) ?? []));
      }
      return false;
    };
    const looping = [...edges.keys()].filter((name) =>
      [...(edges.get(name) ?? [])].some((target) => reaches(target, name)),
    );
    if (looping.length === 0) continue;
    return {
      ...schema,
      [keyword]: Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [
          name,
          looping.includes(name)
            ? cutRefs(definition, (target) => reaches(target, name))
            : definition,
        ]),
      ),
    };
  }
  return schema;
}

/** Cuts the $ref loops of every tool schema in a provider request (see cutDefinitionCycles). */
function cutSchemaCycles(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const cut = cutSchemaCycles(entry);
      if (cut !== entry) changed = true;
      return cut;
    });
    return changed ? next : value;
  }
  if (!isSchemaObject(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const cut = cutSchemaCycles(entry);
    if (cut !== entry) changed = true;
    next[key] = cut;
  }
  const own = "$defs" in next || "definitions" in next ? cutDefinitionCycles(next) : next;
  return own !== next || changed ? own : value;
}

/**
 * T3's control calls (the command guard and the run-setup report) are not model tools, so
 * they go to T3 directly rather than through Pi's MCP client.
 */
function createControlClient(endpoint: string, token: string, timeoutMs: number) {
  let nextId = 1;
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;
  const authorization = token.startsWith("Bearer ") ? token : \`Bearer \${token}\`;

  const post = (
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; sessionId: string | undefined; contentType: string; body: string }> =>
    new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const transport = url.protocol === "https:" ? NodeHTTPS : NodeHTTP;
      const body = JSON.stringify(payload);
      const req = transport.request(
        url,
        {
          method: "POST",
          signal,
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "content-type": "application/json",
            // Effect's HTTP MCP rejects post-initialize requests without it.
            "mcp-protocol-version": PROTOCOL,
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
            "content-length": String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const header = (name: string) => {
              const value = res.headers[name];
              return Array.isArray(value) ? value[0] : value;
            };
            resolve({
              status: res.statusCode ?? 0,
              sessionId: header("mcp-session-id"),
              contentType: header("content-type") ?? "",
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(\`T3 request timed out after \${Math.round(timeoutMs / 1000)}s\`)),
      );
      req.on("error", reject);
      req.end(body);
    });

  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
    const response = await post({ jsonrpc: "2.0", id: nextId++, method, params }, signal);
    if (response.sessionId) sessionId = response.sessionId;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(\`T3 \${method} failed (\${response.status}): \${response.body.slice(0, 400)}\`);
    }
    if (response.body.length === 0) return undefined;
    const parsed = parseSseOrJson(response.body, response.contentType);
    if (parsed.error) throw new Error(parsed.error.message ?? \`T3 \${method} returned an error\`);
    return parsed.result;
  };

  const initialize = (signal?: AbortSignal) => {
    initialized ??= (async () => {
      await request(
        "initialize",
        { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t3-pi-control", version: "1.0.0" } },
        signal,
      );
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal).catch(() => undefined);
    })().catch((error: unknown) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  };

  return {
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      await initialize(signal);
      return request("tools/call", { name, arguments: args }, signal);
    },
    reportSetup: (composed: unknown) => request("t3/run-setup", composed),
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") cleanReadOnlyShellScratch();
  });
  // RPC has no trust prompt, so Pi skips an untrusted folder's protected resources. Session
  // replacement reruns this factory without project_trust, and T3 drops notices outside a turn,
  // so check each session's first turn. An explicit --no-approve is deliberate and stays quiet.
  let projectTrustChecked = false;
  pi.on("before_agent_start", (_event, ctx) => {
    if (projectTrustChecked) return;
    projectTrustChecked = true;
    if (ctx.isProjectTrusted() || process.argv.some((arg) => arg === "--no-approve" || arg === "-na")) return;
    ctx.ui.notify(
      \`Pi did not load project settings, extensions, skills, prompts, MCP servers or system prompt files for \${ctx.cwd} because the folder is not trusted. To load them, run the configured Pi binary there with the same PI_CODING_AGENT_DIR (if set), trust the folder or its parent with /trust, then start a new thread in that same worktree. To trust every project, add --approve to Pi's launch arguments in T3 Code settings; to keep them off without this notice, add --no-approve.\`,
      "warning",
    );
  });

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

  // Pi has no service tier setting, so T3 sets one through this command before each turn.
  // Only a tier the active model advertises is sent; Standard sends none.
  let serviceTier: string | undefined;
  pi.registerCommand(SERVICE_TIER_COMMAND, {
    description: "Set the service tier T3 Code sends with provider requests",
    handler: async (args) => {
      serviceTier = args.trim() || undefined;
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
    // previous response's usage even when a fork's instructions/tools differ,
    // then reserves almost all remaining context for output. OpenRouter can
    // reject even a short conversation. Remove this cap when Pi accounts for
    // the current request prefix reliably (api/simple-options + utils/estimate).
    if (ctx.model?.provider === "openrouter") {
      for (const key of ["max_tokens", "max_completion_tokens"]) {
        const limit = replacement[key];
        if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
          replacement[key] = 32_768;
          changed = true;
        }
      }
    }
    // Pi's MCP declares server schemas as given; some models refuse a recursive one.
    for (const holder of [replacement, replacement.config]) {
      if (!isSchemaObject(holder) || holder.tools === undefined) continue;
      const tools = cutSchemaCycles(holder.tools);
      if (tools === holder.tools) continue;
      if (holder === replacement) replacement.tools = tools;
      else replacement.config = { ...holder, tools };
      changed = true;
    }
    const tiers = (ctx.model as { serviceTiers?: unknown } | undefined)?.serviceTiers;
    if (
      serviceTier !== undefined &&
      Array.isArray(tiers) &&
      tiers.some((tier) => tier?.id === serviceTier)
    ) {
      replacement.service_tier = serviceTier;
      changed = true;
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  // OmO reports Pi's builtin search with angle brackets around the same path.
  const BUILTIN_TOOL_SEARCH_PATHS = new Set(["builtin:tool-search", "<builtin:tool-search>"]);
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && BUILTIN_TOOL_SEARCH_PATHS.has(tool.sourceInfo?.path ?? ""));

  // A codemode script's own tool calls reach this hook under their own names, so the
  // container needs no allowance of its own. Its model calls reach no tool: they
  // answer from provider models and write nothing to the workspace.
  const hasBuiltinCodemode = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "codemode" && tool.sourceInfo?.path === "builtin:codemode");

  const isCodemodeOptedOut = () => {
    const defaults = (pi as { getSettings?: () => { defaultTools?: unknown } }).getSettings?.()?.defaultTools;
    return Array.isArray(defaults) && defaults.includes("-codemode");
  };

  const isCodemodeContainer = (name: string) => name === "codemode" && hasBuiltinCodemode();

  const isBuiltinReadOnlyTool = (name: string) => {
    if (!READ_ONLY_TOOLS.has(name)) return false;
    if (typeof pi.getAllTools !== "function") return true;
    const registered = pi.getAllTools().find((tool) => tool.name === name);
    return registered?.sourceInfo?.path === undefined
      ? true
      : registered.sourceInfo.path === \`builtin:\${name}\`;
  };

  // T3's annotated reads, every T3 tool for a delegated task (its asking would wait on nobody,
  // and T3 refuses what its class may not call), and every tool of an agent server, which itself
  // decides what this thread's role may do there.
  const delegatedTask = process.env[INSTRUCTIONS_ENV] !== undefined;
  type T3Server = {
    readonly name: string;
    readonly agent: boolean;
    readonly url: string;
    readonly authorization: string;
  };
  const servers: T3Server[] = [];
  let control: ReturnType<typeof createControlClient> | undefined;
  const isApprovedMcpTool = (name: string) => {
    const server = servers.find((candidate) => name.startsWith(\`mcp__\${mcpNamespace(candidate.name)}__\`));
    // A same-named server from mcp.json is someone else's: it inherits no approval.
    if (server === undefined || overridden.has(mcpNamespace(server.name))) return false;
    if (server.agent || delegatedTask) return true;
    return pi.getAllTools().some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true);
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
      if (control === undefined) return undefined;
      const result = (await control.callTool(
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
    if (event.toolName === "tool_search" && hasBuiltinToolSearch()) {
      const input = event.input as { query?: unknown; limit?: number };
      // A loaded declaration rides on every later request: load the tools a query names, else at most three.
      const words = (typeof input.query === "string" ? input.query : "")
        .split(/[\\s,]+/).map((word) => word.replace(/^\\+/, "")).filter((word) => word.length > 0);
      const names = new Set(pi.getAllTools().flatMap((tool) => [tool.name, tool.name.replace(/^mcp__.+?__/, "")]));
      const exact = words.length > 0 && words.every((word) => names.has(word));
      input.limit = exact ? words.length : Math.min(input.limit ?? 3, 3);
    }
    const refusal = await guardRefusal(event, ctx);
    if (refusal !== undefined) return refusal;
    if (env(READ_ONLY_ENV) === "1") {
      // Pi must execute mutated inputs for nested codemode calls as well as direct calls.
      if (event.toolName === "bash" && env(READ_ONLY_SHELL_ENV) === "1" &&
          pi.getAllTools?.().some((tool) => tool.name === "bash" && tool.sourceInfo?.path === "builtin:bash")) {
        try {
          const input = event.input as { command: string };
          input.command = await readOnlyShellCommand(input.command);
          return;
        } catch (error) {
          return { block: true, reason: "The read-only shell is unavailable on this host: " +
            (error instanceof Error ? error.message : String(error)) };
        }
      }
      if (
        isBuiltinReadOnlyTool(event.toolName) ||
        isCodemodeContainer(event.toolName) ||
        (event.toolName === "tool_search" && hasBuiltinToolSearch()) ||
        isApprovedMcpTool(event.toolName)
      ) {
        return;
      }
      return {
        block: true,
        reason: \`\${event.toolName} is not allowed in a read-only T3 Code session.\`,
      };
    }
    const mode = runtimeMode();
    if (mode === "full-access") return;
    if (
      isCodemodeContainer(event.toolName) ||
      (event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) ||
      isApprovedMcpTool(event.toolName)
    ) {
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

  // T3 drops notices outside a turn, so connection warnings wait for each session's first turn.
  const connectionNotices: string[] = [];
  pi.on("before_agent_start", (_event, ctx) => {
    for (const notice of connectionNotices.splice(0)) ctx.ui.notify(notice, "warning");
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  const hasT3 = endpoint !== undefined && token !== undefined;
  if (hasT3) {
    servers.push({
      name: "t3-code",
      agent: false,
      url: endpoint,
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
    });
    control = createControlClient(endpoint, token, CONTROL_TIMEOUT_MS);
  }
  try {
    const agentServers = JSON.parse(env(AGENT_SERVERS_ENV) ?? "[]") as ReadonlyArray<{
      readonly name?: unknown;
      readonly url?: unknown;
      readonly authorizationHeader?: unknown;
    }>;
    for (const server of agentServers) {
      if (
        typeof server.name === "string" && mcpNamespace(server.name) !== mcpNamespace("t3-code") &&
        typeof server.url === "string" && typeof server.authorizationHeader === "string"
      ) {
        servers.push({ name: server.name, agent: true, url: server.url, authorization: server.authorizationHeader });
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

  // Pi's MCP connects these with the thread's credentials. A server of the same name in
  // mcp.json takes precedence there and Pi does not say so, so read its config to report it.
  const configuredServers = (ctx: ExtensionContext) => {
    const found = new Map<string, string>();
    const files = [NodePath.join(getAgentDir(), "mcp.json")];
    if (ctx.isProjectTrusted()) files.push(NodePath.join(ctx.cwd, ".pi", "mcp.json"));
    for (const file of files) {
      try {
        const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
          readonly mcpServers?: Record<string, unknown>;
        };
        for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
          // An entry without command, url or type only adjusts a user-level server of that name.
          if (typeof entry === "object" && entry !== null && ("command" in entry || "url" in entry || "type" in entry)) {
            found.set(mcpNamespace(name), file);
          }
        }
      } catch {
        // A missing or unreadable file configures nothing; Pi reports invalid ones itself.
      }
    }
    return found;
  };
  const overridden = new Set<string>();
  const checkOverrides = (ctx: ExtensionContext) => {
    overridden.clear();
    const configured = configuredServers(ctx);
    for (const server of servers) {
      const file = configured.get(mcpNamespace(server.name));
      if (file === undefined) continue;
      overridden.add(mcpNamespace(server.name));
      connectionNotices.push(
        \`A "\${server.name}" MCP server in \${file} replaces this thread's own \${server.name} connection, so its tools run with that server's settings and credentials instead. Rename or remove it there to use the thread's.\`,
      );
    }
  };

  const helper = delegatedTask && env(ROLE_ENV) !== "lead";
  const directTools = helper ? ["ask_advice", "task_status"] : ["agent_roles", "delegate_task", "task_status"];
  // Without Pi's own tool_search or codemode nothing can reach undeclared tools, as on a
  // completions gateway, so every tool is declared.
  const exposureNow = () =>
    hasBuiltinToolSearch() ? "deferred" : hasBuiltinCodemode() && !isCodemodeOptedOut() ? "codemode" : "direct";
  let registeredExposure: string | undefined;
  const register = () => {
    if (!builtinMcpConnects()) return;
    const exposure = exposureNow();
    // Detect the pair after extensions load; Pi still uses T3 on hosts without it.
    const available = new Set(pi.getActiveTools?.() ?? pi.getAllTools().map((tool) => tool.name));
    const nativeWeb = available.has("google_search") && available.has("read_url_content");
    const registrationKey = exposure + ":" + nativeWeb;
    if (registrationKey === registeredExposure) return;
    registeredExposure = registrationKey;
    for (const server of servers) {
      pi.registerMcpServer(server.name, {
        url: server.url,
        headers: { Authorization: server.authorization, ...(!server.agent && nativeWeb ? { "t3-native-web-tools": "1" } : {}) },
        timeout: TOOL_TIMEOUT_SECONDS,
        exposure,
        ...(exposure !== "direct" && !server.agent
          ? { toolExposure: Object.fromEntries(directTools.map((name) => [name, "direct"])) }
          : {}),
      });
    }
  };

  // Pi's builtin MCP extension owns /mcp and connects registered servers; --no-mcp, "-builtin:mcp"
  // or an extension that replaces /mcp leaves registrations unconnected.
  const builtinMcpConnects = () =>
    typeof pi.registerMcpServer === "function" &&
    pi.getCommands().some((command) => command.name === "mcp" && command.sourceInfo?.path === "builtin:mcp");

  // Builtins load after CLI extensions, so which discovery tools exist is known only now.
  pi.on("session_start", (_event, ctx) => {
    if (!builtinMcpConnects()) {
      connectionNotices.push(
        \`Pi's built-in MCP support is off or replaced, so this thread has no \${servers.map((server) => server.name).join(" or ")} tools. Remove --no-mcp or "-builtin:mcp" from Pi's launch arguments or settings, or the extension that replaces /mcp.\`,
      );
      return;
    }
    register();
    checkOverrides(ctx);
  });

  if (!hasT3) return;

  // Keep guidance in the system prompt so leading slash commands still expand.
  let reportedSetup = false;
  let promptFiles: Array<{ path: string; characters: number }> = [];
  let promptSkills: Array<{ name: string; path: string }> = [];
  pi.on("context_with_system", async (event) => {
    if (reportedSetup) return;
    reportedSetup = true;
    const tools = getCurrentTools(event.messages).map((tool) => ({ name: tool.name, characters: JSON.stringify(tool).length }));
    try {
      await control?.reportSetup({
        systemPromptCharacters: getCurrentSystemPrompt(event.messages).length,
        instructions: promptFiles,
        skills: promptSkills,
        tools: { count: tools.length, characters: tools.reduce((sum, tool) => sum + tool.characters, 0), declarations: tools },
      });
    } catch {
      // Measurement is best-effort and must not stop a provider turn.
    }
  });
  const realPath = async (path: string) => NodeFSP.realpath(path).catch(() => NodePath.resolve(path));
  pi.on("before_agent_start", async (event) => {
    register();
    const options = event.systemPromptOptions;
    const root = env(CONFIG_ROOT_ENV);
    const role = env(ROLE_ENV);
    const browser = helper && role === "browser";
    const resolvedRoot = root ? await realPath(root) : undefined;
    const seen = new Set<string>();
    if (options?.contextFiles) {
      const kept = [];
      for (const file of options.contextFiles) {
        const path = await realPath(file.path);
        // Keep only the global policy, even when Pi loaded it through a symlink.
        if (browser && path !== (resolvedRoot && NodePath.join(resolvedRoot, "AGENTS.md"))) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        if (helper) {
          const marker = /^<!-- lead-only-below -->\\r?$/m.exec(file.content);
          if (marker) file.content = file.content.slice(0, marker.index);
        }
        kept.push(file);
      }
      options.contextFiles.splice(0, options.contextFiles.length, ...kept);
    }
    if (helper && (role === "browser" || role === "scout" || role === "advisor")) {
      options?.skills?.splice(0);
    } else if (helper && resolvedRoot && options?.skills) {
      const kept = [];
      for (const skill of options.skills) {
        const relative = NodePath.relative(resolvedRoot, await realPath(skill.filePath));
        if (relative === "" || (!relative.startsWith(".." + NodePath.sep) && relative !== ".." && !NodePath.isAbsolute(relative))) continue;
        kept.push(skill);
      }
      options.skills.splice(0, options.skills.length, ...kept);
    }
    reportedSetup = false;
    promptFiles = options?.forceSystemPrompt === undefined
      ? options?.contextFiles?.map((file) => ({ path: file.path, characters: file.content.length })) ?? [] : [];
    promptSkills = options?.forceSystemPrompt === undefined
      ? options?.skills?.map((skill) => ({ name: skill.name, path: skill.filePath })) ?? [] : [];
    const instructions = (process.env[INSTRUCTIONS_ENV] ?? ORCHESTRATION_INSTRUCTIONS) + (!helper && !env(NO_PR_LINKING_ENV) ? "\\n\\n" + PULL_REQUEST_LINKING_INSTRUCTIONS : "");
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
