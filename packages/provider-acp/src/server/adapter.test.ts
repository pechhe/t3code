import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { acpMcpContext } from "./adapter.ts";

const self = { command: "/usr/bin/node", entrypoint: "/opt/t3/bin.mjs" };
const weave = {
  name: "yardsmith-hq",
  url: "http://127.0.0.1:43123/mcp/yardsmith-hq",
  authorizationHeader: "Bearer thread-weave-credential",
};
const bridgeEnv = (endpoint: string, authorization: string) => [
  { name: "ELECTRON_RUN_AS_NODE", value: "1" },
  { name: "T3_ACP_MCP_ENDPOINT", value: endpoint },
  { name: "T3_ACP_MCP_AUTHORIZATION", value: authorization },
];

describe("ACP MCP context", () => {
  it("bridges each agent server beside T3's own under its own name and credential", () => {
    const context = acpMcpContext(
      {
        environmentId: EnvironmentId.make("environment-acp-mcp"),
        threadId: ThreadId.make("thread-acp-mcp"),
        providerSessionId: "mcp-session-acp",
        providerInstanceId: ProviderInstanceId.make("grok"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer t3-credential",
        browserToolsAvailable: false,
      },
      self,
      [weave],
    );
    assert.deepEqual(
      context.servers.map((server) => ("env" in server ? [server.name, server.env] : [])),
      [
        ["t3-code", bridgeEnv("http://127.0.0.1:43123/mcp", "Bearer t3-credential")],
        ["yardsmith-hq", bridgeEnv(weave.url, weave.authorizationHeader)],
      ],
    );
    assert.deepEqual(context.acpServers, [
      { type: "acp", name: "t3-code", serverId: "t3-code" },
      { type: "acp", name: "yardsmith-hq", serverId: "yardsmith-hq" },
    ]);
    // The terminal fallback carries only T3's own credential.
    assert.equal(context.processEnvironment?.T3_ACP_MCP_AUTHORIZATION, "Bearer t3-credential");
  });

  it("bridges agent servers for a thread without a T3 session", () => {
    const context = acpMcpContext(undefined, self, [weave]);
    assert.deepEqual(
      context.servers.map((server) => server.name),
      ["yardsmith-hq"],
    );
    assert.deepEqual(context.bridgeServers, [
      { serverId: "yardsmith-hq", endpoint: weave.url, authorization: weave.authorizationHeader },
    ]);
    assert.isUndefined(context.processEnvironment);
  });
});
