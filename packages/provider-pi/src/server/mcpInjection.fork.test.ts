import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { T3_MCP_URL_ENV } from "./mcpExtensionSource.ts";
import { T3_MCP_AGENT_SERVERS_ENV, T3_PI_READ_ONLY_ENV } from "./piT3Extension.ts";

import { buildPiRpcLaunch } from "./mcpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("hands the thread's agent servers to the bridge and never an inherited list", () => {
    const weave = {
      name: "weave",
      url: "http://127.0.0.1:43123/mcp/weave",
      authorizationHeader: "Bearer thread-weave-credential",
    };
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_MCP_AGENT_SERVERS_ENV]: '[{"name":"stale"}]' },
      mcpSession: undefined,
      agentServers: [weave],
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.deepEqual(JSON.parse(launch.env[T3_MCP_AGENT_SERVERS_ENV]!), [weave]);

    for (const input of [
      { agentServers: [], extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts" },
      { agentServers: [weave], extensionPath: undefined },
    ]) {
      const without = buildPiRpcLaunch({
        launchArgs: [],
        environment: { [T3_MCP_AGENT_SERVERS_ENV]: '[{"name":"stale"}]' },
        mcpSession: undefined,
        ...input,
      });
      assert.isUndefined(without.env[T3_MCP_AGENT_SERVERS_ENV]);
    }
  });

  it("withholds mutating built-ins and extension tools while keeping provider extensions for a read-only session", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,bash",
        "--exclude-tools=grep",
        "--provider",
        "anthropic",
        "--extension=./user.ts",
        "-e",
        "./other.ts",
      ],
      environment: {},
      mcpSession,
      agentServers: [
        {
          name: "weave",
          url: "http://127.0.0.1:43123/mcp/weave",
          authorizationHeader: "Bearer weave-token",
        },
      ],
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      readOnlyTools: true,
    });
    assert.notInclude(launch.args, "read,bash");
    assert.notInclude(launch.args, "--exclude-tools=grep");
    assert.include(launch.args, "--extension=./user.ts");
    assert.include(launch.args, "./other.ts");
    assert.notInclude(launch.args, "--no-extensions");
    // Pi's own MCP serves T3's and the agent servers' tools, so it stays on while any are allowed.
    assert.notInclude(launch.args, "--no-mcp");
    assert.deepEqual(launch.args.slice(-2), ["--extension", "/tmp/cache/pi-t3-mcp-extension.ts"]);
    const excluded = launch.args.indexOf("--exclude-tools");
    assert.deepEqual(launch.args.slice(excluded, excluded + 2), [
      "--exclude-tools",
      "bash,edit,write,powershell,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
    ]);
    const added = launch.args.indexOf("--tools");
    assert.deepEqual(launch.args.slice(added, added + 2), [
      "--tools",
      "read,grep,find,ls,tool_search,codemode,mcp__t3-code__*,mcp__t3_code__*,mcp__weave__*",
    ]);
    assert.include(launch.args, "anthropic");
    assert.equal(launch.env[T3_MCP_URL_ENV], mcpSession.endpoint);
    assert.equal(launch.env[T3_PI_READ_ONLY_ENV], "1");

    const withoutMcp = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_READ_ONLY_ENV]: "1" },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      readOnlyTools: true,
    });
    assert.include(withoutMcp.args, "--no-mcp");
    assert.deepEqual(
      withoutMcp.args.slice(
        withoutMcp.args.indexOf("--tools"),
        withoutMcp.args.indexOf("--tools") + 2,
      ),
      ["--tools", "read,grep,find,ls,tool_search,codemode"],
    );
    assert.deepEqual(
      withoutMcp.args.slice(
        withoutMcp.args.indexOf("--exclude-tools"),
        withoutMcp.args.indexOf("--exclude-tools") + 2,
      ),
      [
        "--exclude-tools",
        "bash,edit,write,powershell,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource,mcp__*",
      ],
    );

    const writable = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_READ_ONLY_ENV]: "1" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.isUndefined(writable.env[T3_PI_READ_ONLY_ENV]);
  });
});
