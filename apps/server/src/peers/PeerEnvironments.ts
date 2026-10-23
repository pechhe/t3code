import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PeerEnvironmentError,
  type PeerEnvironment,
  type PeerEnvironmentStatus,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** Every linked environment, with its credentials, as one secret. */
const PEERS_SECRET = "peer-environments";
/** A peer session is renewed once it has less than this left. */
const RENEW_WITHIN = Duration.days(7);
/** How long a probe's answer is trusted when listing. */
const STATUS_TTL = Duration.minutes(1);
/** How long a tool call or probe waits for one route. */
const DEFAULT_CALL_TIMEOUT = Duration.seconds(2);
const LINK_TIMEOUT = Duration.seconds(10);
/** A renewal is not repeated once the peer has answered, so it is given time to arrive. */
const RENEW_TIMEOUT = Duration.seconds(60);
/** After a failed renewal, the next attempt waits this long. */
const RENEW_RETRY = Duration.minutes(1);

const StoredPeer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  routes: Schema.Array(TrimmedNonEmptyString),
  token: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  linkedAt: Schema.DateTimeUtcFromString,
});
type StoredPeer = typeof StoredPeer.Type;

const decodePeers = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(StoredPeer)));
const encodePeers = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredPeer)));

const PeerSession = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});
const decodePeerSession = HttpClientResponse.schemaBodyJson(PeerSession);
const decodeDescriptor = HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor);

/** Why a call to a peer produced no result. `failed` means the peer answered with an error. */
export class PeerCallError extends Schema.TaggedError<PeerCallError>()("PeerCallError", {
  environmentId: EnvironmentId,
  status: Schema.Literals(["not_linked", "offline", "timeout", "unauthorized", "unsupported"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.status === "not_linked"
      ? "That environment is not linked."
      : `The linked environment is ${this.status}.`;
  }
}

/** The MCP SDK's own failure, kept as the cause until it is classified. */
class PeerTransportError extends Schema.TaggedError<PeerTransportError>()("PeerTransportError", {
  cause: Schema.Defect(),
}) {}

export interface PeerToolResult {
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly text: string;
}

export class PeerEnvironments extends Context.Service<
  PeerEnvironments,
  {
    /**
     * Trades a one-time read-scoped pairing code for a session on another
     * environment, trying `routes` in order, and stores it.
     */
    readonly link: (input: {
      readonly code: string;
      readonly routes: ReadonlyArray<string>;
    }) => Effect.Effect<PeerEnvironment, PeerEnvironmentError>;
    /** Linked environments' identities, without probing them. */
    readonly linked: Effect.Effect<
      ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
      PeerEnvironmentError
    >;
    /** Linked environments with the status of their last probe, probing stale ones. */
    readonly list: Effect.Effect<ReadonlyArray<PeerEnvironment>, PeerEnvironmentError>;
    /** Linked environments with whatever status is already known, contacting none of them. */
    readonly stored: Effect.Effect<ReadonlyArray<PeerEnvironment>, PeerEnvironmentError>;
    /** Drops the link and ends this server's session on the peer when it can be reached. */
    readonly unlink: (input: {
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<void, PeerEnvironmentError>;
    /**
     * Calls one MCP tool on a linked environment. Renews the session first
     * when it is close to expiring, and tries each route in order.
     */
    readonly callTool: (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      readonly timeout?: Duration.Duration;
    }) => Effect.Effect<PeerToolResult, PeerCallError | PeerEnvironmentError>;
  }
>()("t3/peers/PeerEnvironments") {}

const normalizeRoute = (route: string): string | undefined => {
  try {
    const url = new URL(route);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin + url.pathname.replace(/\/+$/, "")
      : undefined;
  } catch {
    return undefined;
  }
};

const summary = (peer: StoredPeer, status?: PeerEnvironmentStatus): PeerEnvironment => ({
  environmentId: peer.environmentId,
  label: peer.label,
  routes: peer.routes,
  ...(status === undefined ? {} : { status }),
  linkedAt: peer.linkedAt,
});

/** What a failed attempt on one route says about the peer. */
const classify = (cause: unknown): Exclude<PeerEnvironmentStatus, "ok"> => {
  if (cause instanceof StreamableHTTPError) {
    return cause.code === 401 || cause.code === 403 ? "unauthorized" : "offline";
  }
  if (cause instanceof McpError) return "unsupported";
  return "offline";
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const writeLock = yield* Semaphore.make(1);
  const statuses = yield* Ref.make(
    new Map<EnvironmentId, { readonly status: PeerEnvironmentStatus; readonly at: number }>(),
  );
  // When a renewal last failed for each peer, so a peer that cannot be reached is not retried on every call.
  const renewFailures = yield* Ref.make(new Map<EnvironmentId, number>());
  // The route that last worked for each peer, tried first.
  const preferredRoutes = yield* Ref.make(new Map<EnvironmentId, string>());

  const storageError = (cause: unknown) => new PeerEnvironmentError({ reason: "storage", cause });

  const readPeers = secrets.get(PEERS_SECRET).pipe(
    Effect.flatMap((stored) =>
      Option.isNone(stored)
        ? Effect.succeed<ReadonlyArray<StoredPeer>>([])
        : decodePeers(new TextDecoder().decode(stored.value)),
    ),
    Effect.mapError(storageError),
  );

  const writePeers = (peers: ReadonlyArray<StoredPeer>) =>
    encodePeers(peers).pipe(
      Effect.flatMap((text) => secrets.set(PEERS_SECRET, new TextEncoder().encode(text))),
      Effect.mapError(storageError),
    );

  const updatePeers = <A>(
    change: (
      peers: ReadonlyArray<StoredPeer>,
    ) => Effect.Effect<readonly [A, ReadonlyArray<StoredPeer>], PeerEnvironmentError>,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = yield* change(yield* readPeers);
        yield* writePeers(next);
        return result;
      }),
    );

  const rememberStatus = (environmentId: EnvironmentId, status: PeerEnvironmentStatus) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((at) =>
        Ref.update(statuses, (current) => new Map(current).set(environmentId, { status, at })),
      ),
    );

  const post = (url: string, body: unknown, token?: string, timeout = LINK_TIMEOUT) => {
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    return http
      .execute(token === undefined ? request : HttpClientRequest.bearerToken(request, token))
      .pipe(Effect.timeout(timeout));
  };

  const link: PeerEnvironments["Service"]["link"] = Effect.fn("PeerEnvironments.link")(
    function* (input) {
      const ownId = yield* environment.getEnvironmentId;
      const ownLabel = (yield* environment.getDescriptor).label;
      const routes = input.routes.flatMap((route) => normalizeRoute(route) ?? []);
      if (routes.length === 0) return yield* new PeerEnvironmentError({ reason: "unreachable" });

      let unreachable: unknown;
      for (const route of routes) {
        const descriptor = yield* http
          .get(`${route}/.well-known/t3/environment`)
          .pipe(Effect.timeout(LINK_TIMEOUT), Effect.flatMap(decodeDescriptor), Effect.option);
        // Not this environment's answer, or not an environment at all: try the next route.
        if (Option.isNone(descriptor)) continue;
        if (descriptor.value.environmentId === ownId) {
          return yield* new PeerEnvironmentError({
            reason: "self_link",
            environmentId: ownId,
          });
        }
        const response = yield* post(`${route}/api/auth/peer/link`, {
          code: input.code,
          label: ownLabel,
        }).pipe(Effect.result);
        if (response._tag === "Failure") {
          unreachable = response.failure;
          continue;
        }
        if (response.success.status >= 400 && response.success.status < 500) {
          return yield* new PeerEnvironmentError({
            reason: "rejected",
            environmentId: descriptor.value.environmentId,
          });
        }
        const session = yield* decodePeerSession(response.success).pipe(
          Effect.mapError(
            (cause) =>
              new PeerEnvironmentError({
                reason: "unsupported",
                environmentId: descriptor.value.environmentId,
                cause,
              }),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const peer: StoredPeer = {
          environmentId: descriptor.value.environmentId,
          label: descriptor.value.label,
          routes,
          token: session.token,
          expiresAt: session.expiresAt,
          linkedAt: DateTime.makeUnsafe(now) as DateTime.Utc,
        };
        const replaced = yield* updatePeers((peers) =>
          Effect.succeed([
            peers.find((existing) => existing.environmentId === peer.environmentId),
            [...peers.filter((existing) => existing.environmentId !== peer.environmentId), peer],
          ] as const),
        );
        // A second link replaces the first; the old session would otherwise outlive it.
        if (replaced !== undefined) {
          yield* post(`${route}/api/auth/peer/unlink`, {}, replaced.token).pipe(Effect.ignore);
        }
        yield* Ref.update(preferredRoutes, (current) =>
          new Map(current).set(peer.environmentId, route),
        );
        yield* rememberStatus(peer.environmentId, "ok");
        return summary(peer, "ok");
      }
      return yield* new PeerEnvironmentError({ reason: "unreachable", cause: unreachable });
    },
  );

  const latestPeer = (environmentId: EnvironmentId) =>
    readPeers.pipe(
      Effect.map((peers) => peers.find((peer) => peer.environmentId === environmentId)),
    );

  /**
   * Replaces a session near its end; the old token stops working on the peer. Runs once per call,
   * before any route is tried and outside its deadline, with a long timeout of its own: the peer
   * revokes the old token as it issues the new one, so a response that never arrives strands the
   * link until it is linked again. A failed attempt is not repeated for a minute.
   * Returns the peer as stored now, or undefined when it was unlinked meanwhile.
   */
  const freshPeer = Effect.fn("PeerEnvironments.freshPeer")(function* (
    peer: StoredPeer,
    route: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (peer.expiresAt.epochMilliseconds - now > Duration.toMillis(RENEW_WITHIN)) return peer;
    const failedAt = (yield* Ref.get(renewFailures)).get(peer.environmentId);
    if (failedAt !== undefined && now - failedAt < Duration.toMillis(RENEW_RETRY)) return peer;
    const response = yield* post(
      `${route}/api/auth/peer/renew`,
      {},
      peer.token,
      RENEW_TIMEOUT,
    ).pipe(
      Effect.flatMap((renewed) =>
        renewed.status >= 400
          ? Effect.succeed(undefined)
          : decodePeerSession(renewed).pipe(Effect.map((session) => session)),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (response === undefined) {
      yield* Ref.update(renewFailures, (current) => new Map(current).set(peer.environmentId, now));
      // Another call may have renewed it first, which revokes the token this one held.
      return yield* latestPeer(peer.environmentId);
    }
    const renewed: StoredPeer = { ...peer, token: response.token, expiresAt: response.expiresAt };
    const stored = yield* updatePeers((peers) => {
      const current = peers.find((existing) => existing.environmentId === peer.environmentId);
      // Unlinked, or replaced by another call, while the peer was answering.
      if (current === undefined || current.token !== peer.token) {
        return Effect.succeed([false, peers] as const);
      }
      return Effect.succeed([
        true,
        peers.map((existing) =>
          existing.environmentId === peer.environmentId ? renewed : existing,
        ),
      ] as const);
    });
    if (!stored) {
      // The new session would outlive the link that asked for it.
      yield* post(`${route}/api/auth/peer/unlink`, {}, response.token).pipe(Effect.ignore);
      return yield* latestPeer(peer.environmentId);
    }
    return renewed;
  });

  const callOnRoute = (
    peer: StoredPeer,
    route: string,
    name: string,
    args: Record<string, unknown>,
    timeout: Duration.Duration,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const client = new Client({ name: "t3-peer", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${route}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${peer.token}` } },
        });
        try {
          await client.connect(transport as Transport, { signal });
          const result = await client.callTool({ name, arguments: args }, undefined, { signal });
          const content = Array.isArray(result.content) ? result.content : [];
          const text = content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
          // Some servers report an unknown tool as a failed result, not a protocol error.
          if (result.isError === true && /^MCP error -32602: .*not found/i.test(text)) {
            throw new McpError(ErrorCode.InvalidParams, text);
          }
          return {
            isError: result.isError === true,
            structuredContent: result.structuredContent,
            text,
          } satisfies PeerToolResult;
        } finally {
          await transport.terminateSession().catch(() => undefined);
          await client.close().catch(() => undefined);
        }
      },
      catch: (cause) => new PeerTransportError({ cause }),
    }).pipe(
      Effect.timeout(timeout),
      Effect.mapError((cause): Exclude<PeerEnvironmentStatus, "ok"> =>
        Cause.isTimeoutError(cause) ? "timeout" : classify(cause.cause),
      ),
    );

  const callTool: PeerEnvironments["Service"]["callTool"] = Effect.fn("PeerEnvironments.callTool")(
    function* (input) {
      const found = (yield* readPeers).find((peer) => peer.environmentId === input.environmentId);
      if (found === undefined) {
        return yield* new PeerCallError({
          environmentId: input.environmentId,
          status: "not_linked",
        });
      }
      const preferred = (yield* Ref.get(preferredRoutes)).get(found.environmentId);
      const routes =
        preferred === undefined
          ? found.routes
          : [preferred, ...found.routes.filter((route) => route !== preferred)];
      const renewed = yield* freshPeer(found, routes[0] ?? "");
      if (renewed === undefined) {
        return yield* new PeerCallError({
          environmentId: found.environmentId,
          status: "not_linked",
        });
      }
      const peer = renewed;
      const timeout = input.timeout ?? DEFAULT_CALL_TIMEOUT;
      // One deadline for the peer, shared out evenly: a dead address must not multiply the wait,
      // nor leave a later address no time to answer.
      const perRoute = Duration.millis(Math.max(1, Duration.toMillis(timeout) / routes.length));
      const attempt = yield* Effect.gen(function* () {
        let last: Exclude<PeerEnvironmentStatus, "ok"> = "offline";
        let unauthorized = false;
        for (const route of routes) {
          const result = yield* callOnRoute(
            peer,
            route,
            input.name,
            input.arguments,
            perRoute,
          ).pipe(Effect.result);
          if (result._tag === "Success") {
            yield* Ref.update(preferredRoutes, (current) =>
              new Map(current).set(peer.environmentId, route),
            );
            return { _tag: "answered", value: result.success } as const;
          }
          last = result.failure;
          // A tool the peer lacks is the peer's build, not the route.
          if (last === "unsupported") break;
          // A stale address may now belong to another server; a later route can still be this peer.
          if (last === "unauthorized") unauthorized = true;
        }
        return {
          _tag: "failed",
          status: unauthorized && last !== "unsupported" ? ("unauthorized" as const) : last,
        } as const;
      }).pipe(
        Effect.timeoutOption(timeout),
        Effect.map((outcome) =>
          Option.isSome(outcome) ? outcome.value : ({ _tag: "failed", status: "timeout" } as const),
        ),
      );
      if (attempt._tag === "answered") {
        yield* rememberStatus(peer.environmentId, "ok");
        return attempt.value;
      }
      yield* rememberStatus(peer.environmentId, attempt.status);
      return yield* new PeerCallError({
        environmentId: peer.environmentId,
        status: attempt.status,
      });
    },
  );

  const probe = (peer: StoredPeer) =>
    callTool({
      environmentId: peer.environmentId,
      name: "t3_environment_read",
      arguments: {},
    }).pipe(
      Effect.map((): PeerEnvironmentStatus => "ok"),
      Effect.catchTags({
        PeerCallError: (error) => Effect.succeed(error.status),
        PeerEnvironmentError: () => Effect.succeed<PeerEnvironmentStatus>("offline"),
      }),
      Effect.map((status) => (status === "not_linked" ? ("offline" as const) : status)),
    );

  const list: PeerEnvironments["Service"]["list"] = Effect.gen(function* () {
    const peers = yield* readPeers;
    const now = yield* Clock.currentTimeMillis;
    const known = yield* Ref.get(statuses);
    return yield* Effect.forEach(
      peers,
      (peer) => {
        const cached = known.get(peer.environmentId);
        return cached !== undefined && now - cached.at < Duration.toMillis(STATUS_TTL)
          ? Effect.succeed(summary(peer, cached.status))
          : probe(peer).pipe(Effect.map((status) => summary(peer, status)));
      },
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.withSpan("PeerEnvironments.list"));

  const stored: PeerEnvironments["Service"]["stored"] = Effect.gen(function* () {
    const peers = yield* readPeers;
    const known = yield* Ref.get(statuses);
    return peers.map((peer) => summary(peer, known.get(peer.environmentId)?.status));
  }).pipe(Effect.withSpan("PeerEnvironments.stored"));

  const unlink: PeerEnvironments["Service"]["unlink"] = Effect.fn("PeerEnvironments.unlink")(
    function* (input) {
      const removed = yield* updatePeers((peers) =>
        Effect.succeed([
          peers.find((peer) => peer.environmentId === input.environmentId),
          peers.filter((peer) => peer.environmentId !== input.environmentId),
        ] as const),
      );
      if (removed === undefined) {
        return yield* new PeerEnvironmentError({
          reason: "not_linked",
          environmentId: input.environmentId,
        });
      }
      yield* Ref.update(statuses, (current) => {
        const next = new Map(current);
        next.delete(input.environmentId);
        return next;
      });
      // Best effort: an unreachable peer keeps a session that expires on its own and can be
      // revoked from its connections list.
      yield* Effect.forEach(
        removed.routes,
        (route) => post(`${route}/api/auth/peer/unlink`, {}, removed.token).pipe(Effect.ignore),
        { concurrency: 1 },
      );
    },
  );

  const linked: PeerEnvironments["Service"]["linked"] = readPeers.pipe(
    Effect.map((peers) => peers.map(({ environmentId, label }) => ({ environmentId, label }))),
  );

  return PeerEnvironments.of({ link, linked, list, stored, unlink, callTool });
});

export const layer = Layer.effect(PeerEnvironments, make);
