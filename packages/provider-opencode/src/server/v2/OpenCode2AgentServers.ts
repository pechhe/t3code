import type { ThreadId } from "@t3tools/contracts";
import { Permission } from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Digest from "effect/crypto/Digest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type * as OpenCode2Client from "./OpenCode2Client.ts";
import type { OpenCode2Connection } from "./OpenCode2Server.ts";

type Rule = Permission.Rule;

export interface ThreadMcpServer {
  readonly name: string;
  readonly directory: string;
  readonly url: string;
  readonly credential: string;
}

const MCP_TOOL_RELOAD_SETTLE = "250 millis";

// OpenCode hides tools over 64 chars and rejects names over 100; hash long thread IDs.
// Untraced: both exported wrappers already name the span.
export const threadMcpServerName = Effect.fnUntraced(function* (threadId: string, suffix: string) {
  const name = `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}${suffix}`;
  if (name.length <= 64) return name;
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `t3-code-${Hex.encode(digest).slice(0, 16)}${suffix}`;
});

/**
 * A thread's agent server, such as Weave, carries its T3 name as a prefix, so the `t3-code-*`
 * deny keeps every thread's servers on the shared OpenCode server from every other thread.
 */
const t3AgentMcpServerName = Effect.fn("t3AgentMcpServerName")(function* (
  threadId: string,
  agentServer: string,
) {
  return yield* threadMcpServerName(threadId, `-${agentServer}`);
});

/**
 * Last match wins: every thread's T3 servers are denied, then this thread's own allowed.
 * An agent server's tools never ask; that server decides what this thread's agent may do there.
 */
export const mcpRules = (mcpServerNames: ReadonlyArray<string>): ReadonlyArray<Rule> =>
  mcpServerNames.length === 0
    ? []
    : [
        { action: "t3-code-*", resource: "*", effect: "deny" },
        ...mcpServerNames.map((name): Rule => ({
          action: `${name}_*`,
          resource: "*",
          effect: "allow",
        })),
      ];

/** A thread's T3 server and its agent servers, named for one shared OpenCode server. */
/** `addTimeout` is the adapter's inventory timeout, so both follow one setting. */
export const makeOpenCodeThreadMcp = Effect.fnUntraced(function* (addTimeout: Duration.Input) {
  const crypto = yield* Digest.Digest;
  const readAgentServers = yield* AgentMcpServers.makeReader;
  const t3NameFor = (threadId: string) =>
    threadMcpServerName(threadId, "").pipe(Effect.provideService(Digest.Digest, crypto));
  const agentNameFor = (threadId: string, agentServer: string) =>
    t3AgentMcpServerName(threadId, agentServer).pipe(Effect.provideService(Digest.Digest, crypto));

  return {
    /** The server names the thread's rules allow. */
    ruleNames: Effect.fnUntraced(function* (threadId: ThreadId) {
      return [
        yield* t3NameFor(threadId),
        ...(yield* Effect.forEach(yield* readAgentServers(threadId), (server) =>
          agentNameFor(threadId, server.name),
        )),
      ];
    }),
    /**
     * Brings the thread's registered servers to the wanted set: T3's own when the thread has a
     * session and the server is not external, plus every agent server. Returns what is now
     * registered and whether T3's own is available.
     */
    sync: Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly mcpSession: McpProviderSessionConfig | undefined;
      readonly directory: string;
      readonly connection: Pick<OpenCode2Connection, "external" | "version">;
      readonly client: OpenCode2Client.OpenCode2Api["client"];
      readonly current: ReadonlyArray<ThreadMcpServer>;
      readonly removeMcp: (mcp: ThreadMcpServer) => Effect.Effect<unknown>;
    }) {
      const { mcpSession, directory, connection, client } = input;
      const t3Name = yield* t3NameFor(input.threadId);
      // An external server may not reach T3's MCP endpoints, as with 1.x.
      const wanted: ReadonlyArray<ThreadMcpServer> = connection.external
        ? []
        : [
            ...(mcpSession === undefined
              ? []
              : [
                  {
                    name: t3Name,
                    directory,
                    url: mcpSession.endpoint,
                    credential: mcpSession.authorizationHeader,
                  },
                ]),
            ...(yield* Effect.forEach(yield* readAgentServers(input.threadId), (server) =>
              agentNameFor(input.threadId, server.name).pipe(
                Effect.map((name) => ({
                  name,
                  directory,
                  url: server.url,
                  credential: server.authorizationHeader,
                })),
              ),
            )),
          ];
      const sameServer = (left: ThreadMcpServer, right: ThreadMcpServer) =>
        left.name === right.name &&
        left.directory === right.directory &&
        left.url === right.url &&
        left.credential === right.credential;
      const kept = input.current.filter((current) =>
        wanted.some((server) => sameServer(server, current)),
      );
      yield* Effect.forEach(
        input.current.filter((current) => !kept.includes(current)),
        input.removeMcp,
        { discard: true },
      );
      // Idle Location eviction drops runtime MCP servers without clearing T3's cache.
      // Re-adding an unchanged config keeps its existing connection.
      const fresh = kept.length === 0;
      const added = yield* Effect.filter(wanted, (server) =>
        client.mcp
          .add({
            server: server.name,
            location: { directory: server.directory },
            config: new Mcp.RemoteConfig({
              type: "remote",
              url: server.url,
              headers: { Authorization: server.credential },
              oauth: false,
            }),
          })
          .pipe(
            Effect.timeout(addTimeout),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                server.name === t3Name
                  ? "Could not add T3 Code's MCP server to OpenCode."
                  : "Could not add an agent MCP server to OpenCode.",
                cause,
              ).pipe(Effect.as(false)),
            ),
          ),
      );
      // A failed re-add leaves an unchanged server registered, so it is still removed later.
      const registered = wanted.filter(
        (server) => added.includes(server) || kept.some((current) => sameServer(current, server)),
      );
      const mcpAvailable = added.some((server) => server.name === t3Name);
      // Before 2.2.6, OpenCode loads a new server's tools 100 ms after it connects, and a prompt sent sooner lacks them.
      if (mcpAvailable && fresh && compareSemverVersions(connection.version, "2.2.6") < 0) {
        yield* Effect.sleep(MCP_TOOL_RELOAD_SETTLE);
      }
      return { registered, mcpAvailable };
    }),
  };
});
