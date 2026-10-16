// @effect-diagnostics nodeBuiltinImport:off - the fake peer is a real Node HTTP server, as the MCP SDK transport needs.
// @effect-diagnostics globalDate:off - the fake peer is plain Node code outside any Effect.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";

const ownId = EnvironmentId.make("environment-own");
const peerId = EnvironmentId.make("environment-peer");

const descriptor = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0",
  capabilities: { repositoryIdentity: false },
});

/** What the fake peer has been asked, and what it will accept. */
interface PeerState {
  codes: Set<string>;
  tokens: Set<string>;
  unlinked: Array<string>;
  hasEnvironmentTool: boolean;
  sessionDays: number;
  issued: number;
  /** When set, a renewal reaches the peer, then waits here before the peer answers. */
  renewGate?: { readonly reached: () => void; readonly released: Promise<void> };
}

/** How a fake peer's `/mcp` misbehaves, to stand in for another server on a stale address. */
interface PeerBehavior {
  /** Answers 401, as a different server now holding this address would. */
  readonly denyMcp?: boolean;
  /** Never answers. */
  readonly hangMcp?: boolean;
}

/** A peer environment's HTTP surface: the descriptor, the link endpoints and a stateless `/mcp`. */
const startPeer = (
  state: PeerState,
  environment = descriptor(peerId, "Peer"),
  behavior: PeerBehavior = {},
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly url: string }>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            const chunks: Array<Buffer> = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              void handle(Buffer.concat(chunks).toString("utf8"));
            });
            const bearer = request.headers.authorization?.replace(/^Bearer /, "");
            const json = (status: number, body: unknown) => {
              response.writeHead(status, { "content-type": "application/json" });
              response.end(JSON.stringify(body));
            };
            const issue = () => {
              state.issued += 1;
              const token = `token-${state.issued}`;
              state.tokens.add(token);
              return {
                token,
                expiresAt: new Date(Date.now() + state.sessionDays * 86_400_000).toISOString(),
              };
            };
            const handle = async (text: string) => {
              if (request.url === "/.well-known/t3/environment") return json(200, environment);
              if (request.url === "/api/auth/peer/link") {
                const { code } = JSON.parse(text) as { code: string };
                if (!state.codes.delete(code)) return json(401, { error: "invalid" });
                return json(200, issue());
              }
              if (request.url === "/api/auth/peer/renew") {
                if (bearer === undefined || !state.tokens.delete(bearer)) {
                  return json(401, { error: "invalid" });
                }
                const renewed = issue();
                // The peer has committed the renewal; its answer is still on the way.
                if (state.renewGate !== undefined) {
                  state.renewGate.reached();
                  await state.renewGate.released;
                }
                return json(200, renewed);
              }
              if (request.url === "/api/auth/peer/unlink") {
                if (bearer !== undefined) state.unlinked.push(bearer);
                return json(200, { revoked: bearer !== undefined && state.tokens.delete(bearer) });
              }
              if (request.url === "/mcp") {
                if (behavior.hangMcp === true) return;
                if (behavior.denyMcp === true) return json(401, { error: "another server" });
                if (bearer === undefined || !state.tokens.has(bearer)) {
                  return json(401, { error: "invalid" });
                }
                // Stateless: there is no session to end.
                if (request.method !== "POST") return json(405, {});
                const mcp = new McpServer({ name: "peer", version: "1.0.0" });
                if (state.hasEnvironmentTool) {
                  mcp.registerTool(
                    "t3_environment_read",
                    { description: "Read the environment" },
                    () => ({
                      content: [{ type: "text", text: environment.label }],
                      structuredContent: { environmentId: environment.environmentId },
                    }),
                  );
                } else {
                  mcp.registerTool("other_tool", { description: "Another tool" }, () => ({
                    content: [{ type: "text", text: "other" }],
                  }));
                }
                const transport = new StreamableHTTPServerTransport({
                  enableJsonResponse: true,
                });
                await mcp.connect(transport as Transport);
                return transport.handleRequest(request, response, JSON.parse(text));
              }
              return json(404, {});
            };
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({
              server,
              url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
            }),
          );
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

const newState = (): PeerState => ({
  codes: new Set(["code-1", "code-2"]),
  tokens: new Set(),
  unlinked: [],
  hasEnvironmentTool: true,
  sessionDays: 30,
  issued: 0,
});

const layerPeers = PeerEnvironments.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ownId),
      getDescriptor: Effect.succeed(descriptor(ownId, "Own")),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peers-test-" })),
  Layer.provide(NodeServices.layer),
);

const withPeers = <A, E>(
  use: (peers: PeerEnvironments.PeerEnvironments["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* PeerEnvironments.PeerEnvironments);
  }).pipe(Effect.provide(layerPeers), Effect.scoped);

it.live("links an environment, reads through it, and unlinks it", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const peer = yield* startPeer(state);

      const linked = yield* peers.link({ code: "code-1", routes: [`${peer.url}/`] });
      expect(linked).toMatchObject({ environmentId: peerId, label: "Peer", status: "ok" });

      expect(yield* peers.list).toMatchObject([{ environmentId: peerId, status: "ok" }]);

      const read = yield* peers.callTool({
        environmentId: peerId,
        name: "t3_environment_read",
        arguments: {},
      });
      expect(read.structuredContent).toEqual({ environmentId: peerId });

      yield* peers.unlink({ environmentId: peerId });
      expect(state.unlinked).toEqual(["token-1"]);
      expect(yield* peers.list).toEqual([]);
      const afterUnlink = yield* peers
        .callTool({ environmentId: peerId, name: "t3_environment_read", arguments: {} })
        .pipe(Effect.flip);
      expect(afterUnlink).toMatchObject({ status: "not_linked" });
    }),
  ),
);

it.live("refuses a code the peer rejects, and an environment that is this one", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const peer = yield* startPeer(state);
      const rejected = yield* peers.link({ code: "wrong", routes: [peer.url] }).pipe(Effect.flip);
      expect(rejected).toMatchObject({ reason: "rejected", environmentId: peerId });

      const self = yield* startPeer(newState(), descriptor(ownId, "Own"));
      const selfLink = yield* peers.link({ code: "code-1", routes: [self.url] }).pipe(Effect.flip);
      expect(selfLink).toMatchObject({ reason: "self_link" });
      expect(yield* peers.list).toEqual([]);
    }),
  ),
);

it.live("reports a peer that is gone, rejects its credential, or lacks the tool", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const peer = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: [peer.url] });
      const call = peers
        .callTool({ environmentId: peerId, name: "t3_environment_read", arguments: {} })
        .pipe(Effect.flip);

      // Revoked on the peer.
      state.tokens.clear();
      expect(yield* call).toMatchObject({ status: "unauthorized" });
      expect(yield* peers.list).toMatchObject([{ status: "unauthorized" }]);

      // A build that has not got the tool.
      state.tokens.add("token-1");
      state.hasEnvironmentTool = false;
      expect(yield* call).toMatchObject({ status: "unsupported" });

      // Gone altogether.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            peer.server.closeAllConnections();
            peer.server.close(() => resolve());
          }),
      );
      expect(yield* call).toMatchObject({ status: "offline" });
    }),
  ),
);

it.live("tries the next route when the first does not answer", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const peer = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: ["http://127.0.0.1:1", peer.url] });
      const read = yield* peers.callTool({
        environmentId: peerId,
        name: "t3_environment_read",
        arguments: {},
      });
      expect(read.isError).toBe(false);
    }),
  ),
);

it.live("renews a session that is close to expiring and keeps reading", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      state.sessionDays = 1;
      const peer = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: [peer.url] });
      expect([...state.tokens]).toEqual(["token-1"]);

      const read = yield* peers.callTool({
        environmentId: peerId,
        name: "t3_environment_read",
        arguments: {},
      });
      expect(read.isError).toBe(false);
      // The old token is gone from the peer, the new one is held and works again.
      expect([...state.tokens]).toEqual(["token-2"]);
      yield* peers.callTool({ environmentId: peerId, name: "t3_environment_read", arguments: {} });
    }),
  ),
);

it.live("falls back to a later route when an earlier address now answers as another server", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const stale = yield* startPeer(state, descriptor(peerId, "Peer"), { denyMcp: true });
      const live = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: [stale.url, live.url] });

      const read = yield* peers.callTool({
        environmentId: peerId,
        name: "t3_environment_read",
        arguments: {},
      });
      expect(read.isError).toBe(false);
    }),
  ),
);

it.live(
  "shares one deadline across a peer's routes, so a hung address leaves the next one time",
  () =>
    withPeers((peers) =>
      Effect.gen(function* () {
        const state = newState();
        const hung = yield* startPeer(state, descriptor(peerId, "Peer"), { hangMcp: true });
        const live = yield* startPeer(state);
        yield* peers.link({ code: "code-1", routes: [hung.url, live.url] });

        const read = yield* peers.callTool({
          environmentId: peerId,
          name: "t3_environment_read",
          arguments: {},
          timeout: Duration.millis(600),
        });
        expect(read.isError).toBe(false);
      }),
    ),
);

it.live("answers a peer whose every route hangs within its one deadline", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const first = yield* startPeer(state, descriptor(peerId, "Peer"), { hangMcp: true });
      const second = yield* startPeer(state, descriptor(peerId, "Peer"), { hangMcp: true });
      yield* peers.link({ code: "code-1", routes: [first.url, second.url] });

      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* peers
        .callTool({
          environmentId: peerId,
          name: "t3_environment_read",
          arguments: {},
          timeout: Duration.millis(400),
        })
        .pipe(Effect.flip);
      expect(outcome).toMatchObject({ status: "timeout" });
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(1_500);
    }),
  ),
);

it.live("ends a session renewed while its link was being removed", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      state.sessionDays = 1;
      let release!: () => void;
      let reached!: () => void;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      state.renewGate = {
        reached: () => reached(),
        released: new Promise<void>((resolve) => (release = resolve)),
      };
      const peer = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: [peer.url] });

      const call = yield* peers
        .callTool({ environmentId: peerId, name: "t3_environment_read", arguments: {} })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => reachedPromise);
      yield* peers.unlink({ environmentId: peerId });
      release();

      expect(yield* Fiber.join(call)).toMatchObject({ status: "not_linked" });
      // The peer issued a replacement while the link was going; it must not be left alive.
      expect([...state.tokens]).toEqual([]);
      expect(yield* peers.list).toEqual([]);
    }),
  ),
);

it.live("lists what is linked without contacting a peer when asked not to probe", () =>
  withPeers((peers) =>
    Effect.gen(function* () {
      const state = newState();
      const peer = yield* startPeer(state);
      yield* peers.link({ code: "code-1", routes: [peer.url] });
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            peer.server.closeAllConnections();
            peer.server.close(() => resolve());
          }),
      );

      // The peer is gone, yet this answers at once with what was last known.
      expect(yield* peers.stored).toMatchObject([{ environmentId: peerId, status: "ok" }]);
      expect(yield* peers.list).toMatchObject([{ environmentId: peerId, status: "ok" }]);
    }),
  ),
);
