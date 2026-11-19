import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import type { AcpMcpOverAcpServer } from "./mcpOverAcpBridge.ts";

/**
 * The thread's agent servers, such as Weave, reached through the same bridge as T3's own. A
 * server named `t3-code` is skipped: that name is T3's own server.
 */
export const acpAgentBridgeServers = (
  agentServers: ReadonlyArray<AgentMcpServers.AgentMcpServer>,
): ReadonlyArray<AcpMcpOverAcpServer> =>
  agentServers
    .filter((server) => server.name !== "t3-code")
    .map((server) => ({
      serverId: server.name,
      endpoint: server.url,
      authorization: server.authorizationHeader,
    }));
