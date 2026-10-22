import {
  isToolListedForSession,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  type SessionToolProfile,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { buildPiRpcLaunch } from "../../../../packages/provider-pi/src/server/mcpInjection.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { ExperimentsToolkit } from "./toolkits/experiments/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

const tools = [
  ...Object.values(OrchestratorToolkit.tools),
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(DeviceToolkit.tools),
  ...Object.values(ExperimentsToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(WorktreeToolkit.tools),
];

const names = (session: SessionToolProfile | undefined) =>
  new Set(
    tools.filter((tool) => isToolListedForSession(tool.name, session)).map((tool) => tool.name),
  );

const payloadChars = (session: SessionToolProfile | undefined) =>
  tools
    .filter((tool) => isToolListedForSession(tool.name, session))
    .reduce(
      (total, tool) =>
        total +
        (Tool.getDescription(tool) ?? "").length +
        JSON.stringify(Tool.getJsonSchema(tool)).length,
      0,
    );

const session = (
  toolProfile: SessionToolProfile["toolProfile"],
  agentRole?: SessionToolProfile["agentRole"],
) => ({ toolProfile, agentRole }) satisfies SessionToolProfile;

it("keeps an ordinary thread's listing under the payload budget", () => {
  expect(payloadChars(undefined), "ordinary payload chars").toBeLessThan(40_000);
});

it("lists the preview family only for Phi profiles, and device only for a UI verifier", () => {
  const ordinary = names(undefined);
  expect(ordinary.has("preview_interact")).toBe(false);
  expect(ordinary.has("preview_open")).toBe(false);
  expect(ordinary.has("device_open")).toBe(false);
  expect(ordinary.has("t3_experiments_list")).toBe(false);
  expect(ordinary.has("t3_worktree_status")).toBe(false);

  const browser = names(session("phi", "browser"));
  expect(browser.has("preview_interact")).toBe(true);
  expect(browser.has("device_open")).toBe(false);

  const verifier = names(session("phi", "ui-verifier"));
  expect(verifier.has("preview_interact")).toBe(true);
  expect(verifier.has("device_open")).toBe(true);

  const worker = names(session("implementation-phi", "ui-worker"));
  expect(worker.has("preview_interact")).toBe(true);
  expect(worker.has("t3_worktree_status")).toBe(true);

  const researcher = names(session("web-research", "researcher"));
  expect(researcher.has("t3_experiments_list")).toBe(true);
  expect(researcher.has("preview_interact")).toBe(false);
});

it("hands all three harnesses the same session endpoint", () => {
  for (const profile of [
    undefined,
    session("phi", "browser"),
    session("implementation", "scout"),
  ]) {
    const key = sessionEndpointKey(profile);
    const endpoint = `http://127.0.0.1:43123${SESSION_TOOL_ENDPOINTS[key].path}`;
    const mcpSession = {
      environmentId: "environment-test" as never,
      threadId: "thread-test" as never,
      providerSessionId: "provider-session-test",
      providerInstanceId: "codex" as never,
      endpoint,
      authorizationHeader: "Bearer test-token",
      browserToolsAvailable: true,
    };

    const codex = codexThreadRuntimeParams({ mcpSession });
    const claude = claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
    });
    const pi = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/extension.ts",
    });

    const codexConfig = codex.config["mcp_servers.t3-code"] as { url: string };
    expect(codexConfig.url).toBe(endpoint);
    const claudeServer = claude.mcpServers?.["t3-code"];
    expect(claudeServer !== undefined && "url" in claudeServer ? claudeServer.url : undefined).toBe(
      endpoint,
    );
    expect(pi.env.T3_MCP_URL).toBe(endpoint);
    expect(pi.env.T3_MCP_BEARER_TOKEN).toBe("test-token");
  }
});
