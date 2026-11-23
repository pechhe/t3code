import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_WEAVE_ORIGIN } from "@t3tools/shared/weaveOrigins";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

export const projectId = ProjectId.make("project-weave");
export const delegation = `yshqd_${"d".repeat(43)}`;
export const origin = "https://weave.example.test";
export const otherDelegation = `yshqd_${"e".repeat(43)}`;
export const otherOrigin = "https://weave-other.example.test";
export const hourMs = 60 * 60 * 1_000;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const delegations = new Map([
  [origin, delegation],
  [otherOrigin, otherDelegation],
  // Weave's own address, where the default points: a connection there is the same service.
  [DEFAULT_WEAVE_ORIGIN, delegation],
]);

/**
 * Weave's exchange as `POST /api/mcp/agents` documents it: it mints tokens only for T3's own
 * `observer` (one per environment, renewed by a new exchange, refused once the person revokes it)
 * and answers any other role `400` `role_unknown`. Every claim T3 sent is kept in `exchanges`.
 */
const makeFakeWeave = () => {
  const agents: Array<{
    id: string;
    origin: string;
    agentRef: string;
    ended: boolean;
    revoked: boolean;
  }> = [];
  const tokens = new Map<string, { agentId: string; expiresAt: number; origin: string }>();
  const mcpCalls: Array<{
    origin: string;
    token: string;
    scope: string | null;
    agentId: string | undefined;
  }> = [];
  /** `toolCallsHang` holds every `tools/call` open after Weave receives it, as a slow Weave would. */
  const state = { unreachable: false, delegationRevoked: false, toolCallsHang: false };
  /** Answers a `tools/call` with Weave's structured outcome; tests replace it with Forge data. */
  const tools: {
    call: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
    onCall?: Effect.Effect<void>;
  } = { call: () => ({ status: "succeeded", value: null }) };
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; agentId: string }> = [];
  const exchanges: Array<Record<string, string>> = [];
  let minted = 0;

  const respond = (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
    status: number,
    body: unknown,
  ) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(stringifyJson(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      // The real client's error carries the request, bearer header included.
      if (state.unreachable)
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        });
      const now = yield* Clock.currentTimeMillis;
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const url = new URL(request.url);
      const weaveOrigin = url.origin;
      if (url.pathname === "/api/mcp/agents") {
        if (bearer !== delegations.get(weaveOrigin) || state.delegationRevoked)
          return respond(request, 401, { error: "invalid_delegation" });
        const claim = parseJson(body) as Record<string, string>;
        exchanges.push(claim);
        if (claim.role !== "observer") return respond(request, 400, { error: "role_unknown" });
        const forRef = agents.filter(
          (a) => a.origin === weaveOrigin && a.agentRef === claim.agentRef,
        );
        if (claim.action === "end") {
          const live = forRef.find((a) => !a.ended && !a.revoked);
          if (live) live.ended = true;
          return respond(request, 200, { ended: live !== undefined });
        }
        if (forRef.some((a) => a.revoked)) return respond(request, 403, { error: "agent_revoked" });
        let agent = forRef.find((a) => !a.ended);
        if (!agent) {
          agent = {
            id: `agent-${agents.length + 1}`,
            origin: weaveOrigin,
            agentRef: claim.agentRef!,
            ended: false,
            revoked: false,
          };
          agents.push(agent);
        }
        const token = `yshqa_${String(++minted).padStart(43, "t")}`;
        const expiresAt = now + 12 * hourMs;
        tokens.set(token, { agentId: agent.id, expiresAt, origin: weaveOrigin });
        return respond(request, 200, {
          token,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          agent: { executingAgentId: `agent:${agent.id}`, role: "observer", model: null },
        });
      }
      if (url.pathname === "/api/mcp") {
        // A token is honoured only by the Weave that issued it.
        const record = tokens.get(bearer);
        const agent = agents.find((a) => a.id === record?.agentId);
        const valid =
          record !== undefined &&
          record.origin === weaveOrigin &&
          record.expiresAt > now &&
          agent !== undefined &&
          !agent.ended &&
          !agent.revoked &&
          !state.delegationRevoked;
        mcpCalls.push({
          origin: weaveOrigin,
          scope: url.searchParams.get("scope"),
          token: bearer,
          agentId: valid ? agent.id : undefined,
        });
        if (!valid) return respond(request, 401, { error: "invalid_token" });
        const message = parseJson(body) as {
          id: number;
          method: string;
          params?: { name: string; arguments: Record<string, unknown> };
        };
        if (message.method === "tools/call" && message.params !== undefined) {
          toolCalls.push({
            name: message.params.name,
            args: message.params.arguments,
            agentId: agent.id,
          });
          if (tools.onCall !== undefined) yield* tools.onCall;
          if (state.toolCallsHang) return yield* Effect.never;
          const outcome =
            message.params.name === "fixture_agent"
              ? { status: "succeeded", value: agent.id }
              : tools.call(message.params.name, message.params.arguments);
          return respond(request, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [], structuredContent: outcome },
          });
        }
        return respond(request, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { agent: agent.id },
        });
      }
      return respond(request, 404, {});
    }),
  );
  return { client, agents, exchanges, tokens, mcpCalls, state, tools, toolCalls };
};
/** Weave's fake as a test drives it: its answers, its outages and the calls it received. */
export type FakeWeave = ReturnType<typeof makeFakeWeave>;

/**
 * The real WeaveAgentConnections against a fake Weave, with every log line captured, `read` to
 * read Forge as T3's observer, and a check that no Weave credential
 * (the delegations and every token Weave minted) reached what a test collected. Given a secrets
 * directory, it uses the real file store there and connects nothing itself.
 */
export const makeWeaveHarnessAt = Effect.fnUntraced(function* (secretsDirectory?: string) {
  const weave = makeFakeWeave();
  const stored = new Map<string, Uint8Array>();
  const logs: Array<string> = [];
  const store =
    secretsDirectory === undefined
      ? Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
            set: (name, value) => Effect.sync(() => void stored.set(name, value)),
            create: (name, value) => Effect.sync(() => void stored.set(name, value)),
            getOrCreateRandom: () => Effect.die("unused"),
            remove: (name) => Effect.sync(() => void stored.delete(name)),
          } as ServerSecretStore.ServerSecretStore["Service"]),
        )
      : ServerSecretStore.layerAtDirectory(secretsDirectory);
  const connections = yield* Effect.service(WeaveAgentConnections.WeaveAgentConnections).pipe(
    Effect.provide(
      WeaveAgentConnections.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            store.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
            Layer.succeed(HttpClient.HttpClient, weave.client),
            Layer.succeed(
              ServerEnvironment.ServerEnvironment,
              ServerEnvironment.ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-weave")),
              } as ServerEnvironment.ServerEnvironment["Service"]),
            ),
          ),
        ),
      ),
    ),
  );
  const logger = Logger.make(
    ({ message }) => void logs.push(NodeUtil.inspect(message, { depth: 10 })),
  );
  const logLayer = Logger.layer([logger], { mergeWithExisting: false });
  const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(logLayer));

  /** One Forge read as T3's observer; Weave answers it with the observer's own id. */
  const read = () => withLogs(connections.observe("fixture_agent", {}));

  if (secretsDirectory === undefined) yield* connections.connect({ origin, delegation });

  /** No Weave credential may reach anything outside T3's own requests to Weave. */
  const assertNoSecretsIn = (...surfaces: ReadonlyArray<unknown>) => {
    const text = [
      ...surfaces.map((surface) => NodeUtil.inspect(surface, { depth: 20 })),
      ...logs,
    ].join("\n");
    for (const secret of [...delegations.values(), ...weave.tokens.keys()])
      assert.notInclude(text, secret);
  };

  return { weave, connections, read, logs, logLayer, stored, assertNoSecretsIn };
});

export const makeWeaveHarness = makeWeaveHarnessAt();
