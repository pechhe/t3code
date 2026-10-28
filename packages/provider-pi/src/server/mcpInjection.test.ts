import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  T3_MCP_AGENT_SERVERS_ENV,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";

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
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(launch.env[T3_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-t3-mcp-extension.ts");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [T3_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [T3_MCP_BEARER_ENV]: "stale-token",
        [T3_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasT3Mcp);
    assert.isUndefined(permissionOnly.env[T3_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[T3_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[T3_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[T3_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-t3-mcp-extension.ts",
    );
  });

  it("hands the thread's agent servers to the bridge and never an inherited list", () => {
    const weave = {
      name: "yardsmith-hq",
      url: "http://127.0.0.1:43123/mcp/yardsmith-hq",
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

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasT3Mcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("withholds mutating built-ins after any user tool selection for a read-only session", () => {
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
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      readOnlyTools: true,
    });
    assert.notInclude(launch.args, "read,bash");
    assert.notInclude(launch.args, "--exclude-tools=grep");
    assert.notInclude(launch.args, "--extension=./user.ts");
    assert.notInclude(launch.args, "./other.ts");
    assert.include(launch.args, "--no-extensions");
    assert.deepEqual(launch.args.slice(-2), ["--extension", "/tmp/cache/pi-t3-mcp-extension.ts"]);
    const excluded = launch.args.indexOf("--exclude-tools");
    assert.deepEqual(launch.args.slice(excluded, excluded + 2), [
      "--exclude-tools",
      "bash,edit,write",
    ]);
    const added = launch.args.indexOf("--tools");
    assert.deepEqual(launch.args.slice(added, added + 2), ["--tools", "+grep,+find,+ls"]);
    assert.include(launch.args, "anthropic");
    assert.isTrue(launch.hasT3Mcp);
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });
});
