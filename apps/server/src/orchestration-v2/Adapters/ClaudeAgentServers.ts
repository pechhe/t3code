import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";

/** Every agent server's tools are pre-approved whole: the server limits the agent to its role's. */
export const claudeAgentServerAllowedTools = (
  agentServers: ReadonlyArray<AgentMcpServers.AgentMcpServer>,
): ReadonlyArray<string> => agentServers.map((server) => `mcp__${server.name}__*`);

/** The thread's agent servers, such as Weave, as Claude's HTTP MCP servers. */
export const claudeAgentMcpServers = (
  agentServers: ReadonlyArray<AgentMcpServers.AgentMcpServer>,
) =>
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
