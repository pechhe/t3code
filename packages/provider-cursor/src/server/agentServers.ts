import type { McpServerConfig } from "@cursor/sdk";
import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";

export const cursorAgentMcpServers = (
  agentServers: ReadonlyArray<AgentMcpServers.AgentMcpServer>,
): Record<string, McpServerConfig> =>
  Object.fromEntries(
    agentServers.map((server) => [
      server.name,
      {
        type: "http" as const,
        url: server.url,
        headers: { Authorization: server.authorizationHeader },
      },
    ]),
  );
