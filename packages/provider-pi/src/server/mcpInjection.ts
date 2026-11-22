import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { StoredAgentRole } from "@t3tools/contracts";

import type { AgentMcpServer } from "@t3tools/provider-core/server/AgentMcpServers";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  BROWSER_RUN_TOKEN_ENV,
  BROWSER_RUN_URL_ENV,
  agentCommandEnvironment,
} from "@t3tools/provider-core/server/mcpSession";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import {
  PI_T3_EXTENSION_SOURCE,
  T3_MCP_AGENT_SERVERS_ENV,
  T3_PI_INSTRUCTIONS_ENV,
  T3_PI_AGENT_ROLE_ENV,
  T3_PI_NO_PR_LINKING_ENV,
  T3_PI_AGENT_CONFIG_ROOT_ENV,
  piChildInstructionsFor,
  T3_PI_READ_ONLY_ENV,
  T3_PI_READ_ONLY_SHELL_ENV,
} from "./piT3Extension.ts";

import { PI_READ_ONLY_SHELL_FILENAME, PI_READ_ONLY_SHELL_SOURCE } from "./readOnlyShellSource.ts";

const decodeStoredRole = Schema.decodeUnknownOption(StoredAgentRole);

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

export const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi treats equals-form tokens as extension flags; split only known built-ins.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Arbitrary extension flags may consume one following non-flag token.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

/** Pi's mutating built-ins and built-in extension/MCP tools withheld in read-only sessions. */
const PI_MUTATING_BUILTIN_TOOLS = [
  "bash",
  "edit",
  "write",
  "powershell",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;
/** Plain names form an explicit --tools allowlist so user extensions cannot add tools. */
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "tool_search", "codemode"] as const;

export const PI_PROJECT_TRUST_ARGUMENTS = new Set(["--approve", "-a", "--no-approve", "-na"]);

function mcpToolPatternsForServer(name: string): ReadonlyArray<string> {
  const canonical = name.replaceAll("-", "_");
  return canonical === name ? [`mcp__${name}__*`] : [`mcp__${name}__*`, `mcp__${canonical}__*`];
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const extensionDest = piT3McpExtensionDestPath(cacheDir);
  for (const [filename, source] of [
    [PI_READ_ONLY_SHELL_FILENAME, PI_READ_ONLY_SHELL_SOURCE],
    [PI_T3_MCP_EXTENSION_FILENAME, PI_T3_EXTENSION_SOURCE],
  ] as const) {
    const dest = `${cacheDir.replace(/\\/g, "/")}/${filename}`;
    const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
    if (existing !== source) {
      // Concurrent pi launches read this file: stage it in a per-call directory
      // and rename so readers and other writers never see a partial file.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stagingDir = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
          const staging = `${stagingDir.replace(/\\/g, "/")}/${filename}`;
          yield* fs.writeFileString(staging, source);
          yield* fs.rename(staging, dest).pipe(Effect.retry({ times: 3 }));
        }),
      );
    }
  }
  return extensionDest;
});

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly agentServers?: ReadonlyArray<AgentMcpServer>;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  // T3 stops these processes as soon as they answer. They run --offline because Pi's startup
  // catalog refresh renews expired OAuth tokens, and a stop mid-request loses the rotated one.
  readonly shortLived?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  /** Keeps an extension-loaded MCP adapter from starting servers when extensions stay on. */
  readonly disableMcp?: boolean;
  /** A read-only managed session: keeps extensions for providers, but enforces a closed tool allowlist. */
  readonly readOnlyTools?: boolean;
  readonly readOnlyShell?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasT3Extension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasT3Mcp = hasT3Extension && input.mcpSession !== undefined;
  const delegatedRole = Option.getOrUndefined(decodeStoredRole(input.mcpSession?.delegatedRole));
  const agentServers = hasT3Extension ? (input.agentServers ?? []) : [];
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true || input.readOnlyTools === true
      ? withoutToolSelectionArgs(extensionSafeArgs)
      : extensionSafeArgs;
  const allowedReadOnlyMcpPatterns = [
    ...new Set([
      ...(hasT3Mcp ? mcpToolPatternsForServer("t3-code") : []),
      ...agentServers.flatMap((server) => mcpToolPatternsForServer(server.name)),
    ]),
  ];
  const readOnlyShell =
    hasT3Extension && input.readOnlyTools === true && input.readOnlyShell === true;
  const readOnlyAllowedTools = [
    ...PI_READ_ONLY_TOOLS,
    ...(delegatedRole === "scout" ? ["google_search", "read_url_content"] : []),
    ...(readOnlyShell ? ["bash"] : []),
    ...allowedReadOnlyMcpPatterns,
  ];
  const readOnlyExcludedTools = [
    ...PI_MUTATING_BUILTIN_TOOLS.filter((tool) => !readOnlyShell || tool !== "bash"),
    ...(allowedReadOnlyMcpPatterns.length === 0 ? ["mcp__*"] : []),
  ];
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...launchArgs,
    ...(input.shortLived === true && !launchArgs.includes("--offline") ? ["--offline"] : []),
    // Restrictions must follow launch args so user flags cannot re-enable unattended tools/extensions.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true
      ? [
          "--no-tools",
          ...(input.disableMcp === true && !launchArgs.includes("--no-mcp") ? ["--no-mcp"] : []),
        ]
      : input.readOnlyTools === true
        ? [
            // Pi's own MCP serves T3's and the agent servers' tools, so it stays on when any are
            // allowed; the allowlist below keeps the user's other servers' tools out.
            ...(allowedReadOnlyMcpPatterns.length === 0 && !launchArgs.includes("--no-mcp")
              ? ["--no-mcp"]
              : []),
            "--tools",
            readOnlyAllowedTools.join(","),
            "--exclude-tools",
            readOnlyExcludedTools.join(","),
          ]
        : hasT3Mcp && !launchArgs.some((arg) => /^(?:--exclude-tools|-xt)(?:=|$)/u.test(arg))
          ? ["--exclude-tools", "generate_image"]
          : []),
  ];
  if (
    hasT3Extension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const environment = { ...input.environment };
  // MCP credentials belong to this T3 session; discard inherited server/parent credentials.
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  delete environment[T3_PI_MCP_EXTENSION_PATH_ENV];
  delete environment[T3_MCP_AGENT_SERVERS_ENV];
  delete environment[T3_PI_READ_ONLY_ENV];
  delete environment[T3_PI_READ_ONLY_SHELL_ENV];
  delete environment[T3_PI_INSTRUCTIONS_ENV];
  delete environment[T3_PI_AGENT_ROLE_ENV];
  delete environment[T3_PI_NO_PR_LINKING_ENV];
  delete environment[T3_PI_AGENT_CONFIG_ROOT_ENV];
  delete environment[BROWSER_RUN_URL_ENV];
  delete environment[BROWSER_RUN_TOKEN_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(hasT3Extension && input.extensionPath !== undefined
        ? { [T3_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }
        : {}),
      ...(hasT3Extension && input.readOnlyTools === true ? { [T3_PI_READ_ONLY_ENV]: "1" } : {}),
      ...(readOnlyShell ? { [T3_PI_READ_ONLY_SHELL_ENV]: "1" } : {}),
      ...(hasT3Extension && input.runtimeMode !== undefined
        ? {
            [T3_PI_RUNTIME_MODE_ENV]:
              input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
          }
        : {}),
      ...(hasT3Mcp && input.mcpSession?.pullRequestLinking === false
        ? { [T3_PI_NO_PR_LINKING_ENV]: "1" }
        : {}),
      ...(hasT3Mcp && delegatedRole !== undefined ? { [T3_PI_AGENT_ROLE_ENV]: delegatedRole } : {}),
      ...(hasT3Mcp && input.mcpSession?.agentConfigRoot !== undefined
        ? { [T3_PI_AGENT_CONFIG_ROOT_ENV]: input.mcpSession.agentConfigRoot }
        : {}),
      ...(hasT3Mcp && input.mcpSession?.delegated === true
        ? {
            [T3_PI_INSTRUCTIONS_ENV]: piChildInstructionsFor({
              preview: input.mcpSession.listsPreview === true,
              html: input.mcpSession.listsHtml !== false,
              readOnlyShell,
              canDelegate:
                delegatedRole !== "scout" &&
                delegatedRole !== "advisor" &&
                delegatedRole !== "browser",
            }),
          }
        : {}),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
      ...(agentServers.length > 0
        ? { [T3_MCP_AGENT_SERVERS_ENV]: JSON.stringify(agentServers) }
        : {}),
      // Pi's own bash tool inherits these, so `t3 browser run` reaches the thread's browser-run
      // endpoint without exposing the session's full MCP bearer to a shell.
      ...(hasT3Mcp ? agentCommandEnvironment(input.mcpSession) : {}),
    },
  };
}
