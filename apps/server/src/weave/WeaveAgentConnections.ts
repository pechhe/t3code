import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { currentWeaveOrigin, sameWeaveAddress } from "@t3tools/shared/weaveOrigins";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const STORE_NAME = "weave-connection";
/** Where the connection was stored before the Weave names; moved to STORE_NAME at start. */
const LEGACY_STORE_NAME = "hq-connection";
/** Before the connection belonged to the environment, each project stored its own. */
const PROJECT_STORE_FILE = /^(hq-connection-[0-9a-f]{32})\.bin$/;

/** Weave tokens last at most 12 hours; renewing this early keeps a read from meeting an expired one. */
const RENEW_BEFORE_EXPIRY_MS = 15 * 60 * 1_000;
const WEAVE_REQUEST_TIMEOUT = "60 seconds";

/** Why the server's own read of Weave failed. `refused` covers a revoked delegation or observer. */
export class WeaveObserveError extends Schema.TaggedError<WeaveObserveError>()(
  "WeaveObserveError",
  {
    reason: Schema.Literals(["not_connected", "refused", "unavailable", "failed"]),
    /** Weave's failure code when the tool itself failed, such as `build_item_unavailable`. */
    code: Schema.optional(Schema.String),
  },
) {}

/** Why a person's Forge decision could not be posted. Weave's own refusals come back as responses. */
export class WeaveDecisionError extends Schema.TaggedError<WeaveDecisionError>()(
  "WeaveDecisionError",
  {
    /** `other_origin`: T3 is now connected to another Weave server than the one the caller named. */
    reason: Schema.Literals(["not_connected", "other_origin", "unavailable"]),
  },
) {}

/** Weave's answer to one decisions call, with the connection that made it. */
export interface WeaveDecisionResponse {
  readonly origin: string;
  /** Identifies the origin and delegation used, as `read` does, without revealing either. */
  readonly connection: string;
  readonly status: number;
  readonly text: string;
}

export class WeaveConnectionError extends Schema.TaggedError<WeaveConnectionError>()(
  "WeaveConnectionError",
  { reason: Schema.Literals(["invalid_origin", "invalid_delegation", "store_failed"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_origin":
        return "The Weave origin must be an https URL (http only for localhost).";
      case "invalid_delegation":
        return "That is not a Weave delegation. Use Connect to Weave in T3's Settings → Weave instead.";
      case "store_failed":
        return "T3 could not read or save its Weave connection.";
    }
  }
}

const StoredConnection = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, delegation: Schema.String }),
);
const encodeStored = Schema.encodeEffect(StoredConnection);
const decodeStored = Schema.decodeUnknownOption(StoredConnection);

const ExchangeResponse = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeExchange = Schema.decodeUnknownOption(ExchangeResponse);
const WeaveError = Schema.Struct({ error: Schema.String });
const decodeWeaveError = Schema.decodeUnknownOption(WeaveError);

const ToolCallResponse = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
      code: Schema.optional(Schema.String),
    }),
  }),
});
const decodeToolCall = Schema.decodeUnknownOption(ToolCallResponse);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const DELEGATION_PATTERN = /^yshqd_[A-Za-z0-9_-]{43}$/;

/** Weave's origin, or null when it is not https (http is allowed only for a local Weave server). */
export const normalizeWeaveOrigin = (input: string): string | null => {
  try {
    const url = new URL(input);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
  } catch {
    return null;
  }
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

interface StoredWeaveConnection {
  readonly origin: string;
  readonly delegation: string;
}

/** The server's own `observer` agent for one Weave connection, shared by every project and thread. */
interface ObserverToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class WeaveAgentConnections extends Context.Service<
  WeaveAgentConnections,
  {
    readonly connect: (input: {
      readonly origin: string;
      readonly delegation: string;
    }) => Effect.Effect<{ readonly origin: string }, WeaveConnectionError>;
    readonly disconnect: Effect.Effect<void, WeaveConnectionError>;
    readonly connectionChanges: Stream.Stream<void>;
    /** `connection` identifies the stored origin and delegation without revealing the delegation. */
    readonly read: Effect.Effect<
      {
        readonly origin: string;
        readonly connection: string;
        /** Weave has refused this delegation (revoked or expired) and nothing has worked since. */
        readonly refused?: boolean;
      } | null,
      WeaveConnectionError
    >;
    /**
     * Calls a Weave server MCP tool permitted to T3's own `observer` agent, whether or not any provider
     * runs. `connection` identifies the origin and delegation used,
     * so callers can key what they cache by it without seeing the delegation.
     */
    readonly observe: (
      tool: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<
      { readonly origin: string; readonly connection: string; readonly value: unknown },
      WeaveObserveError
    >;
    /**
     * Only Forge Home may decide with the person's delegation. An explicit `origin` refuses
     * to post to any other Weave.
     */
    readonly decide: (input: {
      readonly body: Record<string, unknown>;
      readonly origin?: string;
    }) => Effect.Effect<WeaveDecisionResponse, WeaveDecisionError>;
  }
>()("t3/weave/WeaveAgentConnections") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const connectionChanges = yield* PubSub.sliding<void>(1);
  const crypto = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const observers = new Map<string, ObserverToken>();
  /** Connections Weave answered 401 to, by `connectionKey`, until a call under them succeeds. */
  const refusedConnections = new Set<string>();
  const observerLock = yield* KeyedLock.make<string>();

  const digest = (value: string) =>
    crypto
      .digest(Digest.sha256, new TextEncoder().encode(value))
      .pipe(Effect.map(bytesToHex), Effect.orDie);
  const storeFailed = () => new WeaveConnectionError({ reason: "store_failed" });

  const readStoredState = store.get(STORE_NAME).pipe(
    Effect.map(Option.flatMap((bytes) => decodeStored(new TextDecoder().decode(bytes)))),
    Effect.map(
      Option.map((stored) => ({
        // Weave answers on one address now, so a connection stored at an older one is used, and
        // reported, at the current one: its exchange, decisions and links all go there.
        connection: { ...stored, origin: currentWeaveOrigin(stored.origin) },
        superseded: stored.origin !== currentWeaveOrigin(stored.origin),
      })),
    ),
    Effect.mapError(storeFailed),
  );
  const readStored = readStoredState.pipe(Effect.map(Option.map((state) => state.connection)));

  // Never pass an HTTP client error on: it carries the request, and so the bearer credential.
  const postAgents = (
    stored: { readonly origin: string; readonly delegation: string },
    body: Record<string, string>,
  ) =>
    HttpClientRequest.post(`${stored.origin}/api/mcp/agents`).pipe(
      HttpClientRequest.bearerToken(stored.delegation),
      HttpClientRequest.bodyJsonUnsafe(body),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.json.pipe(Effect.map((json) => ({ status: response.status, json }))),
      ),
      Effect.timeout(WEAVE_REQUEST_TIMEOUT),
      Effect.mapError(() => "unavailable" as const),
    );

  const connectionKey = (stored: StoredWeaveConnection) =>
    digest(`${stored.origin}\n${stored.delegation}`);

  // Every project and thread in this environment shares one observer per Weave connection.
  const observerToken = (key: string, stored: StoredWeaveConnection) =>
    observerLock.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = observers.get(key);
        if (cached !== undefined && cached.expiresAt - now > RENEW_BEFORE_EXPIRY_MS)
          return cached.value;
        const { status, json } = yield* postAgents(stored, {
          action: "exchange",
          agentRef: environmentId,
          role: "observer",
          harness: "t3",
        }).pipe(Effect.mapError(() => new WeaveObserveError({ reason: "unavailable" })));
        const exchanged = status === 200 ? decodeExchange(json) : Option.none();
        if (Option.isSome(exchanged)) refusedConnections.delete(key);
        else if (status === 401) refusedConnections.add(key);
        if (Option.isNone(exchanged))
          return yield* new WeaveObserveError({
            reason: status === 401 || status === 403 ? "refused" : "unavailable",
            code: Option.getOrUndefined(decodeWeaveError(json))?.error,
          });
        observers.set(key, {
          value: exchanged.value.token,
          expiresAt: Date.parse(exchanged.value.expiresAt),
        });
        return exchanged.value.token;
      }),
    );

  /** Ends the observer of a connection T3 no longer uses. */
  const releaseObserver = Effect.fn("WeaveAgentConnections.releaseObserver")(function* (
    stored: StoredWeaveConnection,
  ) {
    const key = yield* connectionKey(stored);
    yield* observerLock.withLock(
      key,
      Effect.gen(function* () {
        if (!observers.delete(key)) return;
        const { status } = yield* postAgents(stored, {
          action: "end",
          agentRef: environmentId,
          role: "observer",
        });
        if (status !== 200) return yield* Effect.fail("unavailable" as const);
      }).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("Could not end T3's Weave observer", { reason }),
        ),
      ),
    );
  });

  const observe: WeaveAgentConnections["Service"]["observe"] = Effect.fn(
    "WeaveAgentConnections.observe",
  )(function* (tool, args) {
    const stored = yield* readStored.pipe(
      Effect.mapError(() => new WeaveObserveError({ reason: "unavailable" })),
    );
    if (Option.isNone(stored)) return yield* new WeaveObserveError({ reason: "not_connected" });
    const key = yield* connectionKey(stored.value);
    const attempt = Effect.gen(function* () {
      const token = yield* observerToken(key, stored.value);
      const response = yield* callWeave(stored.value.origin, token, tool, args).pipe(
        Effect.mapError(() => new WeaveObserveError({ reason: "unavailable" })),
      );
      if (response.status === 401) {
        observers.delete(key);
        return Option.none<typeof response>();
      }
      return Option.some(response);
    });
    // A 401 means Weave no longer honours the token; one fresh exchange tells a stale token
    // from a revoked observer or delegation, which the exchange itself then refuses.
    const response = yield* attempt.pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            attempt.pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => Effect.fail(new WeaveObserveError({ reason: "refused" })),
                }),
              ),
            ),
        }),
      ),
    );
    const result =
      response.status === 200
        ? decodeJson(response.text).pipe(Option.flatMap(decodeToolCall))
        : Option.none();
    if (Option.isNone(result)) return yield* new WeaveObserveError({ reason: "unavailable" });
    const outcome = result.value.result.structuredContent;
    if (outcome.status !== "succeeded")
      return yield* new WeaveObserveError({
        reason: "failed",
        code: outcome.code ?? outcome.status,
      });
    return { origin: stored.value.origin, connection: key, value: outcome.value };
  });

  const decide: WeaveAgentConnections["Service"]["decide"] = Effect.fn(
    "WeaveAgentConnections.decide",
  )(function* (input) {
    // One read decides both where the decision goes and the credential it carries.
    const stored = yield* readStored.pipe(
      Effect.mapError(() => new WeaveDecisionError({ reason: "unavailable" })),
    );
    if (Option.isNone(stored)) return yield* new WeaveDecisionError({ reason: "not_connected" });
    const { origin, delegation } = stored.value;
    if (input.origin !== undefined && currentWeaveOrigin(input.origin) !== origin)
      return yield* new WeaveDecisionError({ reason: "other_origin" });
    const connection = yield* connectionKey(stored.value);
    // Never pass an HTTP client error on: it carries the request, and so the delegation.
    const { status, text } = yield* HttpClientRequest.post(`${origin}/api/build/decisions`).pipe(
      HttpClientRequest.bearerToken(delegation),
      HttpClientRequest.bodyJsonUnsafe(input.body),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.timeout(WEAVE_REQUEST_TIMEOUT),
      Effect.mapError(() => new WeaveDecisionError({ reason: "unavailable" })),
    );
    if (status === 401) refusedConnections.add(connection);
    else if (status < 400) refusedConnections.delete(connection);
    return { origin, connection, status, text };
  });

  const callWeave = (origin: string, token: string, tool: string, args: Record<string, unknown>) =>
    HttpClientRequest.post(`${origin}/api/mcp?scope=coding`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.timeout(WEAVE_REQUEST_TIMEOUT),
      Effect.mapError(() => "unavailable" as const),
    );

  /**
   * Adopts the connection a project stored before the environment owned one, then removes every
   * project copy so the delegation is stored once. An environment holds one connection, so the
   * first project's (in sorted order) is kept and the origins it displaced are reported.
   */
  yield* Effect.gen(function* () {
    const legacy = yield* store.get(LEGACY_STORE_NAME);
    if (Option.isSome(legacy)) {
      if (Option.isNone(yield* store.get(STORE_NAME))) yield* store.set(STORE_NAME, legacy.value);
      yield* store.remove(LEGACY_STORE_NAME);
    }
    const directory = store.directory;
    if (directory === undefined) return;
    const projectEntries = (yield* fileSystem.readDirectory(directory))
      .flatMap((file) => {
        const name = PROJECT_STORE_FILE.exec(file)?.[1];
        return name === undefined ? [] : [name];
      })
      .toSorted();
    if (projectEntries.length === 0) return;
    let adopted = Option.getOrUndefined(yield* readStored)?.origin;
    const dropped = new Set<string>();
    for (const name of projectEntries) {
      const bytes = yield* store.get(name);
      const stored = Option.flatMap(bytes, (value) =>
        decodeStored(new TextDecoder().decode(value)),
      );
      if (adopted === undefined && Option.isSome(bytes) && Option.isSome(stored)) {
        yield* store.set(STORE_NAME, bytes.value);
        adopted = stored.value.origin;
      } else if (
        Option.isSome(stored) &&
        adopted !== undefined &&
        !sameWeaveAddress(stored.value.origin, adopted)
      )
        dropped.add(currentWeaveOrigin(stored.value.origin));
      yield* store.remove(name);
    }
    const report = {
      origin: adopted ?? null,
      projectEntries: projectEntries.length,
      droppedOrigins: [...dropped].sort(),
    };
    yield* dropped.size === 0
      ? Effect.logInfo("Moved a project's Weave connection to the environment", report)
      : Effect.logWarning(
          "Moved a project's Weave connection to the environment and dropped other projects' Weave origins",
          report,
        );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not move a project's Weave connection to the environment", cause),
    ),
  );

  return WeaveAgentConnections.of({
    connectionChanges: Stream.fromPubSub(connectionChanges),
    connect: Effect.fn("WeaveAgentConnections.connect")(function* (input) {
      const address = normalizeWeaveOrigin(input.origin);
      if (address === null) return yield* new WeaveConnectionError({ reason: "invalid_origin" });
      // Stored at the address Weave answers on, so an older one never comes back.
      const origin = currentWeaveOrigin(address);
      const delegation = input.delegation.trim();
      if (!DELEGATION_PATTERN.test(delegation))
        return yield* new WeaveConnectionError({ reason: "invalid_delegation" });
      const encoded = yield* encodeStored({ origin, delegation }).pipe(Effect.orDie);
      const previous = yield* readStored;
      yield* store
        .set(STORE_NAME, new TextEncoder().encode(encoded))
        .pipe(Effect.mapError(storeFailed));
      if (
        Option.isSome(previous) &&
        (previous.value.origin !== origin || previous.value.delegation !== delegation)
      )
        yield* releaseObserver(previous.value);
      yield* PubSub.publish(connectionChanges, undefined);
      return { origin };
    }),
    disconnect: Effect.gen(function* () {
      const previous = yield* readStored;
      yield* store.remove(STORE_NAME).pipe(Effect.mapError(storeFailed));
      yield* PubSub.publish(connectionChanges, undefined);
      if (Option.isSome(previous)) yield* releaseObserver(previous.value);
    }).pipe(Effect.withSpan("WeaveAgentConnections.disconnect")),
    read: readStoredState.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: ({ connection: stored, superseded }) =>
            connectionKey(stored).pipe(
              Effect.map((connection) => ({
                origin: stored.origin,
                connection,
                // Weave refuses a delegation made for an address it no longer answers on, so it is
                // reported refused from the store itself and survives a restart until replaced.
                refused: superseded || refusedConnections.has(connection),
              })),
            ),
        }),
      ),
    ),
    observe,
    decide,
  });
});

export const layer = Layer.effect(WeaveAgentConnections, make);
