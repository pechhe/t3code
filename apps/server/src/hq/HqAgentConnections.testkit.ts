import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_HQ_ORIGIN } from "@t3tools/shared/hqOrigins";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse, HttpServer } from "effect/http";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

export const projectId = ProjectId.make("project-hq");
export const leadThread = ThreadId.make("thread-lead");
export const reviewerThread = ThreadId.make("thread-reviewer");
export const delegation = `yshqd_${"d".repeat(43)}`;
export const origin = "https://hq.example.test";
export const otherDelegation = `yshqd_${"e".repeat(43)}`;
export const otherOrigin = "https://hq-other.example.test";
export const hqEndpoint = "http://127.0.0.1:43123/mcp/weave";
export const hourMs = 60 * 60 * 1_000;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const delegations = new Map([
  [origin, delegation],
  [otherOrigin, otherDelegation],
  // Weave's own address, where the default points: a connection there is the same service.
  [DEFAULT_HQ_ORIGIN, delegation],
]);

/**
 * Weave's exchange as `POST /api/mcp/agents` documents it: one live agent per reference and role,
 * renewed by a new exchange, replaced after it ends, refused for ever once the person revokes it.
 * A reference keeps the role it first exchanged for.
 */
const makeFakeHq = () => {
  const agents: Array<{
    id: string;
    origin: string;
    agentRef: string;
    role: string;
    model: string;
    ended: boolean;
    revoked: boolean;
  }> = [];
  const tokens = new Map<string, { agentId: string; expiresAt: number; origin: string }>();
  const mcpCalls: Array<{
    origin: string;
    token: string;
    agentId: string | undefined;
    body: string;
  }> = [];
  /** `toolCallsHang` holds every `tools/call` open after Weave receives it, as a slow Weave would. */
  const state = { unreachable: false, delegationRevoked: false, toolCallsHang: false };
  /** Answers a `tools/call` with Weave's structured outcome; tests replace it with Forge data. */
  const tools: {
    call: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
  } = { call: () => ({ status: "succeeded", value: null }) };
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; agentId: string }> = [];
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
      const hqOrigin = url.origin;
      if (url.pathname === "/api/mcp/agents") {
        if (bearer !== delegations.get(hqOrigin) || state.delegationRevoked)
          return respond(request, 401, { error: "invalid_delegation" });
        const claim = parseJson(body) as Record<string, string>;
        const forRef = agents.filter(
          (a) => a.origin === hqOrigin && a.agentRef === claim.agentRef && a.role === claim.role,
        );
        if (claim.action === "end") {
          const live = forRef.find((a) => !a.ended && !a.revoked);
          if (live) live.ended = true;
          return respond(request, 200, { ended: live !== undefined });
        }
        if (forRef.some((a) => a.revoked)) return respond(request, 403, { error: "agent_revoked" });
        if (
          agents.some(
            (a) => a.origin === hqOrigin && a.agentRef === claim.agentRef && a.role !== claim.role,
          )
        )
          return respond(request, 409, { error: "agent_role_conflict" });
        let agent = forRef.find((a) => !a.ended);
        if (!agent) {
          agent = {
            id: `agent-${agents.length + 1}`,
            origin: hqOrigin,
            agentRef: claim.agentRef!,
            role: claim.role!,
            model: claim.model!,
            ended: false,
            revoked: false,
          };
          agents.push(agent);
        }
        agent.model = claim.model!;
        const token = `yshqa_${String(++minted).padStart(43, "t")}`;
        const expiresAt = now + 12 * hourMs;
        tokens.set(token, { agentId: agent.id, expiresAt, origin: hqOrigin });
        return respond(request, 200, {
          token,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          agent: { executingAgentId: `agent:${agent.id}`, role: agent.role, model: agent.model },
        });
      }
      if (url.pathname === "/api/mcp") {
        // A token is honoured only by the Weave that issued it.
        const record = tokens.get(bearer);
        const agent = agents.find((a) => a.id === record?.agentId);
        const valid =
          record !== undefined &&
          record.origin === hqOrigin &&
          record.expiresAt > now &&
          agent !== undefined &&
          !agent.ended &&
          !agent.revoked &&
          !state.delegationRevoked;
        mcpCalls.push({
          origin: hqOrigin,
          token: bearer,
          agentId: valid ? agent.id : undefined,
          body,
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
          if (state.toolCallsHang) return yield* Effect.never;
          const outcome = tools.call(message.params.name, message.params.arguments);
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
  return { client, agents, tokens, mcpCalls, state, tools, toolCalls };
};
/** Weave's fake as a test drives it: its answers, its outages and the calls it received. */
export type FakeHq = ReturnType<typeof makeFakeHq>;

/**
 * The real HqAgentConnections against a fake Weave, with every log line captured, a lead and a
 * spec-reviewer thread prepared once T3 is connected, and a check that no Weave credential
 * (the delegations and every token Weave minted) reached what a test collected. Given a secrets
 * directory, it uses the real file store there and connects nothing itself.
 */
export const makeHqHarnessAt = Effect.fnUntraced(function* (secretsDirectory?: string) {
  const hq = makeFakeHq();
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
  const connections = yield* Effect.service(HqAgentConnections.HqAgentConnections).pipe(
    Effect.provide(
      HqAgentConnections.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            NodeServices.layer,
            store.pipe(Layer.provide(NodeServices.layer)),
            Layer.succeed(HttpClient.HttpClient, hq.client),
            Layer.succeed(
              ServerEnvironment.ServerEnvironment,
              ServerEnvironment.ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-hq")),
              } as ServerEnvironment.ServerEnvironment["Service"]),
            ),
            Layer.succeed(
              HttpServer.HttpServer,
              HttpServer.HttpServer.of({
                address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
              }),
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

  let nextId = 0;
  const call = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const connection = yield* connections.connection(threadId);
      assert.isDefined(connection);
      const response = yield* withLogs(
        connections.forward({
          authorization: connection!.authorizationHeader,
          body: new TextEncoder().encode(
            stringifyJson({ jsonrpc: "2.0", id: ++nextId, method: "tools/list" }),
          ),
          contentType: "application/json",
          accept: "application/json, text/event-stream",
          protocolVersion: "2025-06-18",
        }),
      );
      return {
        status: response.status,
        text: new TextDecoder().decode(response.body),
        json: parseJson(new TextDecoder().decode(response.body)) as {
          result?: { agent: string };
          error?: { message: string; data: { reason: string } };
        },
      };
    });

  if (secretsDirectory === undefined) {
    yield* connections.connect({ origin, delegation });
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "claude-opus-5-5" });
    yield* connections.prepare({
      threadId: reviewerThread,
      role: "spec-reviewer",
      model: "gpt-5.5",
    });
  }

  /** No Weave credential may reach anything outside T3's own requests to Weave. */
  const assertNoSecretsIn = (...surfaces: ReadonlyArray<unknown>) => {
    const text = [
      ...surfaces.map((surface) => NodeUtil.inspect(surface, { depth: 20 })),
      ...logs,
    ].join("\n");
    for (const secret of [...delegations.values(), ...hq.tokens.keys()])
      assert.notInclude(text, secret);
  };

  return { hq, connections, call, logs, logLayer, stored, assertNoSecretsIn };
});

export const makeHqHarness = makeHqHarnessAt();

/** The shared agent-server list the adapters read, backed by a harness's connections. */
export const agentMcpServersFor = (connections: HqAgentConnections.HqAgentConnections["Service"]) =>
  HqAgentConnections.agentMcpServersLayer.pipe(
    Layer.provide(Layer.succeed(HqAgentConnections.HqAgentConnections, connections)),
  );
