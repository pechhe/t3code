import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * A T3-owned HTTP MCP server a thread's agent reaches beside `t3-code`, such as Weave's
 * `yardsmith-hq`. The server decides what this agent may do, by the identity its credential is
 * bound to, so adapters attach it without an approval prompt for its tools. The header carries a
 * credential T3 issued for this thread alone, never the upstream service's own secret.
 */
export interface AgentMcpServer {
  readonly name: string;
  readonly url: string;
  readonly authorizationHeader: string;
}

/**
 * The one list every adapter attaches: the server owns which servers a thread gets and their
 * lifecycle, and each adapter only translates the list into its provider's own MCP config.
 */
export class AgentMcpServers extends Context.Service<
  AgentMcpServers,
  {
    readonly read: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<AgentMcpServer>>;
  }
>()("@t3tools/provider-core/server/AgentMcpServers") {}

/** Reads the thread's servers through the environment's service, or none where it has none. */
export const makeReader = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(AgentMcpServers);
  return (threadId: ThreadId | null | undefined): Effect.Effect<ReadonlyArray<AgentMcpServer>> =>
    threadId === null || threadId === undefined || Option.isNone(service)
      ? Effect.succeed([])
      : service.value.read(threadId);
});
