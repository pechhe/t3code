import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";

export const museSessionMcpServers = (servers: ReadonlyArray<AgentMcpServers.AgentMcpServer>) =>
  Object.fromEntries(
    servers.map((server) => [
      server.name,
      {
        // Muse's required default fails runs if a server is unreachable; make it optional.
        transport: "streamableHttp",
        mode: "optional",
        url: server.url,
        headers: { Authorization: server.authorizationHeader },
      },
    ]),
  );
