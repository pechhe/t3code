import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

/** T3 refuses what a managed task's class may not call, so its own server needs no second rule here. */
export function agentServerPermissionRules(
  managedAgent: boolean,
  agentServerNames: ReadonlyArray<string>,
): PermissionRuleset {
  return (managedAgent ? ["t3-code", ...agentServerNames] : agentServerNames).map((name) => ({
    permission: `${name}_*`,
    pattern: "*",
    action: "allow" as const,
  }));
}

export const addAgentServers = (
  client: OpencodeClient,
  servers: ReadonlyArray<AgentMcpServers.AgentMcpServer>,
) =>
  Effect.forEach(
    servers,
    (server) =>
      OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
        client.mcp.add({
          name: server.name,
          config: {
            type: "remote",
            url: server.url,
            headers: { Authorization: server.authorizationHeader },
            oauth: false,
          },
        }),
      ),
    { discard: true },
  );
