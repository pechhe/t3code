/**
 * Agents act in Weave, formerly YardSmith HQ, as themselves (pechhe/yardsmith#2478). The environment keeps one HQ
 * connection, the person's HQ delegation, in the server secret store, and every project uses it.
 * Each thread's agent reaches HQ through T3's own `/mcp/yardsmith-hq` endpoint, authenticated by
 * a credential bound to that thread; T3 exchanges the delegation for the agent's HQ token, renews it, and presents it to
 * HQ's `/api/mcp` on the agent's behalf. The delegation and the agent token therefore never
 * leave this process: no provider config, argv, environment, workspace or prompt carries them,
 * and a long-lived provider process (Codex keeps a thread's MCP headers for its lifetime) never
 * holds a token that can expire.
 */
import type { OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { currentHqOrigin } from "@t3tools/shared/hqOrigins";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { mcpEndpointOrigin } from "../mcp/McpSessionRegistry.ts";

export const HQ_MCP_SERVER_NAME = "yardsmith-hq";
export const HQ_MCP_PATH = "/mcp/yardsmith-hq";

const STORE_NAME = "hq-connection";
/** Before the connection belonged to the environment, each project stored its own. */
const PROJECT_STORE_FILE = /^(hq-connection-[0-9a-f]{32})\.bin$/;

/** HQ tokens last at most 12 hours; renewing this early keeps a call from meeting an expired one. */
const RENEW_BEFORE_EXPIRY_MS = 15 * 60 * 1_000;
const HQ_REQUEST_TIMEOUT = "60 seconds";

export interface HqAgent {
  readonly threadId: ThreadId;
  /** `lead` for a top-level thread, the canonical role of a delegated task. */
  readonly role: string;
  readonly model: string;
}

/**
 * The role a thread's agent acts under in HQ: its delegated task's canonical role, or `lead` for
 * a top-level thread. Any other thread has none and gets no HQ server: a raw, off-policy child,
 * or a fork or side chat with no task (an agent can fork itself), would otherwise act with the
 * lead's full authority.
 */
export const hqAgentRole = (
  thread: Pick<OrchestrationV2AppThread, "agentTask" | "lineage">,
): string | undefined =>
  thread.agentTask?.role ?? (thread.lineage.parentThreadId === null ? "lead" : undefined);

/** What an adapter injects as the `yardsmith-hq` MCP server. It carries no HQ credential. */
export interface HqMcpConnection {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

interface HqForwardRequest {
  readonly authorization: string | undefined;
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
  readonly accept: string | undefined;
  readonly protocolVersion: string | undefined;
}

interface HqForwardResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

/** Why the server's own read of HQ failed. `refused` covers a revoked delegation or observer. */
export class HqObserveError extends Schema.TaggedError<HqObserveError>()("HqObserveError", {
  reason: Schema.Literals(["not_connected", "refused", "unavailable", "failed"]),
  /** HQ's failure code when the tool itself failed, such as `build_item_unavailable`. */
  code: Schema.optional(Schema.String),
}) {}

/** Why a person's Build decision could not be posted. HQ's own refusals come back as responses. */
export class HqDecisionError extends Schema.TaggedError<HqDecisionError>()("HqDecisionError", {
  /** `other_origin`: T3 is now connected to another HQ than the one the caller named. */
  reason: Schema.Literals(["not_connected", "other_origin", "unavailable"]),
}) {}

/** HQ's answer to one decisions call, with the connection that made it. */
export interface HqDecisionResponse {
  readonly origin: string;
  /** Identifies the origin and delegation used, as `read` does, without revealing either. */
  readonly connection: string;
  readonly status: number;
  readonly text: string;
}

export class HqConnectionError extends Schema.TaggedError<HqConnectionError>()(
  "HqConnectionError",
  { reason: Schema.Literals(["invalid_origin", "invalid_delegation", "store_failed"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_origin":
        return "The Weave origin must be an https URL (http only for localhost).";
      case "invalid_delegation":
        return "That is not a Weave delegation. Use Connect to Weave in T3's Settings → Integrations instead.";
      case "store_failed":
        return "T3 could not read or save its Weave connection.";
    }
  }
}

/** Why HQ would not let a thread's agent in. Each is reported to the agent and logged by code. */
type HqRefusal =
  | "not_connected"
  | "invalid_delegation"
  | "agent_revoked"
  | "agent_role_conflict"
  | "agent_invalid"
  | "unauthorized"
  | "unavailable";

const refusalMessages: Record<HqRefusal, string> = {
  not_connected: "T3 is no longer connected to Weave.",
  invalid_delegation:
    "Weave refused T3's delegation: it was revoked or has expired. Choose Connect to Weave in T3's Settings → Integrations to sign in again.",
  agent_revoked:
    "Weave refused this agent (agent_revoked): the person revoked it in Weave Settings → Connections. This thread can no longer act in Weave.",
  agent_role_conflict:
    "Weave refused this agent (agent_role_conflict): this thread already acts in Weave under another role, and a thread keeps the role it first had.",
  agent_invalid: "Weave refused this agent's identity.",
  unauthorized: "Weave refused this agent's token.",
  unavailable: "Weave is unreachable. Try again shortly.",
};

const StoredConnection = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, delegation: Schema.String }),
);
const encodeStored = Schema.encodeEffect(StoredConnection);
const decodeStored = Schema.decodeUnknownOption(StoredConnection);

const ExchangeResponse = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeExchange = Schema.decodeUnknownOption(ExchangeResponse);
const HqError = Schema.Struct({ error: Schema.String });
const decodeHqError = Schema.decodeUnknownOption(HqError);

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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const BuildWriteCall = Schema.Struct({
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({ name: Schema.String }),
});
const decodeBuildWriteCall = Schema.decodeUnknownOption(BuildWriteCall);
/**
 * HQ's Build tools that only read, and the heartbeat, which only renews a session and comes
 * often. Any other `hq_build_*` call may change what a card shows, so a tool HQ adds later
 * expires the display caches until it is listed here.
 */
const BUILD_TOOLS_KEEPING_CARDS = new Set([
  "hq_build_acceptance",
  "hq_build_acceptance_queue",
  "hq_build_acceptance_readiness",
  "hq_build_accounting",
  "hq_build_attempts",
  "hq_build_binds",
  "hq_build_context",
  "hq_build_eligibility",
  "hq_build_heartbeat",
  "hq_build_list",
  "hq_build_pipeline",
  "hq_build_pipeline_overview",
  "hq_build_rd_entry_proposals",
  "hq_build_read",
  "hq_build_read_run_artifact",
  "hq_build_release_plan",
  "hq_build_reports",
  "hq_build_repositories",
  "hq_build_repository_list",
  "hq_build_repository_release_line",
  "hq_build_runs",
  "hq_build_sessions",
  "hq_build_usage",
  "hq_build_waits",
]);
const isBuildWrite = (tool: string) =>
  tool.startsWith("hq_build_") && !BUILD_TOOLS_KEEPING_CARDS.has(tool);

const containsBuildWrite = (body: Uint8Array): boolean => {
  const parsed = decodeJson(new TextDecoder().decode(body));
  if (Option.isNone(parsed)) return false;
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  return messages.some((message) =>
    Option.exists(decodeBuildWriteCall(message), (call) => isBuildWrite(call.params.name)),
  );
};

const DELEGATION_PATTERN = /^yshqd_[A-Za-z0-9_-]{43}$/;

/** HQ's origin, or null when it is not https (http is allowed only for a local HQ). */
export const normalizeHqOrigin = (input: string): string | null => {
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

interface StoredHqConnection {
  readonly origin: string;
  readonly delegation: string;
}

interface AgentToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly role: string;
  readonly model: string;
  /** The connection it was exchanged under, and so the only HQ it may be presented to. */
  readonly origin: string;
  readonly delegation: string;
}

/** The server's own `observer` agent for one HQ connection, shared by every project and thread. */
interface ObserverToken {
  readonly value: string;
  readonly expiresAt: number;
}

interface ThreadConnection {
  readonly credential: string;
  readonly credentialHash: string;
  agent: HqAgent;
  token: AgentToken | undefined;
}

export class HqAgentConnections extends Context.Service<
  HqAgentConnections,
  {
    readonly connect: (input: {
      readonly origin: string;
      readonly delegation: string;
    }) => Effect.Effect<{ readonly origin: string }, HqConnectionError>;
    readonly disconnect: Effect.Effect<void, HqConnectionError>;
    readonly connectionChanges: Stream.Stream<void>;
    /** `connection` stands for the stored origin and delegation without revealing either. */
    readonly read: Effect.Effect<
      {
        readonly origin: string;
        readonly connection: string;
        /** HQ has refused this delegation (revoked or expired) and nothing has worked since. */
        readonly refused?: boolean;
      } | null,
      HqConnectionError
    >;
    /**
     * Calls an HQ MCP tool permitted to T3's own `observer` agent, whether or not any provider
     * runs. `connection` identifies the origin and delegation used,
     * so callers can key what they cache by it without seeing the delegation.
     */
    readonly observe: (
      tool: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<
      { readonly origin: string; readonly connection: string; readonly value: unknown },
      HqObserveError
    >;
    /**
     * Posts one of the person's own Build decisions, or the reads that refresh their cards, to HQ's
     * `/api/build/decisions` as the person, with the stored delegation (pechhe/yardsmith Spec
     * #4367). Only the server's Build Home calls this; no thread's MCP route can, so no agent decides
     * as the person through T3. `origin`, when given, refuses to post to any other HQ.
     */
    readonly decide: (input: {
      readonly body: Record<string, unknown>;
      readonly origin?: string;
    }) => Effect.Effect<HqDecisionResponse, HqDecisionError>;
    /** Gives the thread's agent a connection when T3 is connected to HQ, and none otherwise. */
    readonly prepare: (agent: HqAgent) => Effect.Effect<void>;
    readonly connection: (threadId: ThreadId) => Effect.Effect<HqMcpConnection | undefined>;
    /** Serves one MCP request from a thread's agent by forwarding it to HQ as that agent. */
    readonly forward: (request: HqForwardRequest) => Effect.Effect<HqForwardResponse>;
    /** Changes after proxied Build writes so display caches expire without another HQ call. */
    readonly buildWriteVersion: Effect.Effect<number>;
    /** Ends the thread's HQ agent (never revokes it); its next HQ call starts a new agent. */
    readonly end: (agent: Omit<HqAgent, "model">) => Effect.Effect<void>;
    /** Ends the agent and drops the thread's connection, for a deleted thread. */
    readonly forget: (agent: Omit<HqAgent, "model">) => Effect.Effect<void>;
  }
>()("t3/hq/HqAgentConnections") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const connectionChanges = yield* PubSub.sliding<void>(1);
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const endpoint = `${mcpEndpointOrigin((yield* HttpServer.HttpServer).address)}${HQ_MCP_PATH}`;
  const threads = new Map<ThreadId, ThreadConnection>();
  const threadByCredentialHash = new Map<string, ThreadId>();
  const tokenLock = yield* KeyedLock.make<ThreadId>();
  const observers = new Map<string, ObserverToken>();
  /** Connections HQ answered 401 to, by `connectionKey`, until a call under them succeeds. */
  const refusedConnections = new Set<string>();
  let buildWriteVersion = 0;
  const observerLock = yield* KeyedLock.make<string>();

  const digest = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.map(bytesToHex), Effect.orDie);
  const storeFailed = () => new HqConnectionError({ reason: "store_failed" });

  const readStoredState = store.get(STORE_NAME).pipe(
    Effect.map(Option.flatMap((bytes) => decodeStored(new TextDecoder().decode(bytes)))),
    Effect.map(
      Option.map((stored) => ({
        // Weave answers on one address now, so a connection stored at an older one is used, and
        // reported, at the current one: its exchange, decisions and links all go there.
        connection: { ...stored, origin: currentHqOrigin(stored.origin) },
        superseded: stored.origin !== currentHqOrigin(stored.origin),
      })),
    ),
    Effect.mapError(storeFailed),
  );
  const readStored = readStoredState.pipe(Effect.map(Option.map((state) => state.connection)));

  const dropToken = (threadId: ThreadId) => {
    const connection = threads.get(threadId);
    if (connection !== undefined) connection.token = undefined;
  };

  const agentRef = (threadId: ThreadId) => `${environmentId}/${threadId}`;

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
      Effect.timeout(HQ_REQUEST_TIMEOUT),
      Effect.mapError(() => "unavailable" as const),
    );

  /**
   * The thread's current HQ token for this stored connection, exchanged (or renewed) when it is
   * missing, near expiry, or was exchanged under another origin or delegation.
   */
  const agentToken = (threadId: ThreadId, stored: StoredHqConnection) =>
    tokenLock.withLock(
      threadId,
      Effect.gen(function* () {
        const connection = threads.get(threadId);
        if (connection === undefined) return yield* Effect.fail("unauthorized" as HqRefusal);
        const { agent } = connection;
        const now = yield* Clock.currentTimeMillis;
        const cached = connection.token;
        if (
          cached !== undefined &&
          cached.role === agent.role &&
          cached.model === agent.model &&
          cached.origin === stored.origin &&
          cached.delegation === stored.delegation &&
          cached.expiresAt - now > RENEW_BEFORE_EXPIRY_MS
        )
          return cached.value;
        const { status, json } = yield* postAgents(stored, {
          action: "exchange",
          agentRef: agentRef(threadId),
          role: agent.role,
          model: agent.model,
          harness: "t3",
        });
        const exchanged = status === 200 ? decodeExchange(json) : Option.none();
        const key = yield* connectionKey(stored);
        if (Option.isSome(exchanged)) refusedConnections.delete(key);
        else if (status === 401) refusedConnections.add(key);
        if (Option.isNone(exchanged)) {
          const code = Option.getOrUndefined(decodeHqError(json))?.error;
          return yield* Effect.fail<HqRefusal>(
            status === 401
              ? "invalid_delegation"
              : code === "agent_revoked" || code === "agent_role_conflict"
                ? code
                : status === 400
                  ? "agent_invalid"
                  : "unavailable",
          );
        }
        const token = {
          value: exchanged.value.token,
          expiresAt: Date.parse(exchanged.value.expiresAt),
          role: agent.role,
          model: agent.model,
          origin: stored.origin,
          delegation: stored.delegation,
        };
        connection.token = token;
        return token.value;
      }),
    );

  const connectionKey = (stored: StoredHqConnection) =>
    digest(`${stored.origin}\n${stored.delegation}`);

  // Every project and thread in this environment shares one observer per HQ connection.
  const observerToken = (key: string, stored: StoredHqConnection) =>
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
        }).pipe(Effect.mapError(() => new HqObserveError({ reason: "unavailable" })));
        const exchanged = status === 200 ? decodeExchange(json) : Option.none();
        if (Option.isSome(exchanged)) refusedConnections.delete(key);
        else if (status === 401) refusedConnections.add(key);
        if (Option.isNone(exchanged))
          return yield* new HqObserveError({
            reason: status === 401 || status === 403 ? "refused" : "unavailable",
            code: Option.getOrUndefined(decodeHqError(json))?.error,
          });
        observers.set(key, {
          value: exchanged.value.token,
          expiresAt: Date.parse(exchanged.value.expiresAt),
        });
        return exchanged.value.token;
      }),
    );

  /** Ends the observer of a connection T3 no longer uses. */
  const releaseObserver = Effect.fn("HqAgentConnections.releaseObserver")(function* (
    stored: StoredHqConnection,
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

  const observe: HqAgentConnections["Service"]["observe"] = Effect.fn("HqAgentConnections.observe")(
    function* (tool, args) {
      const stored = yield* readStored.pipe(
        Effect.mapError(() => new HqObserveError({ reason: "unavailable" })),
      );
      if (Option.isNone(stored)) return yield* new HqObserveError({ reason: "not_connected" });
      const key = yield* connectionKey(stored.value);
      const body = new TextEncoder().encode(
        encodeJson({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      );
      const attempt = Effect.gen(function* () {
        const token = yield* observerToken(key, stored.value);
        const response = yield* callHq(stored.value.origin, token, {
          authorization: undefined,
          body,
          contentType: "application/json",
          accept: "application/json, text/event-stream",
          protocolVersion: undefined,
        }).pipe(Effect.mapError(() => new HqObserveError({ reason: "unavailable" })));
        if (response.status === 401) {
          observers.delete(key);
          return Option.none<HqForwardResponse>();
        }
        return Option.some(response);
      });
      // A 401 means HQ no longer honours the token; one fresh exchange tells a stale token
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
                    onNone: () => Effect.fail(new HqObserveError({ reason: "refused" })),
                  }),
                ),
              ),
          }),
        ),
      );
      const result =
        response.status === 200
          ? decodeJson(new TextDecoder().decode(response.body)).pipe(Option.flatMap(decodeToolCall))
          : Option.none();
      if (Option.isNone(result)) return yield* new HqObserveError({ reason: "unavailable" });
      const outcome = result.value.result.structuredContent;
      if (outcome.status !== "succeeded")
        return yield* new HqObserveError({
          reason: "failed",
          code: outcome.code ?? outcome.status,
        });
      return { origin: stored.value.origin, connection: key, value: outcome.value };
    },
  );

  const decide: HqAgentConnections["Service"]["decide"] = Effect.fn("HqAgentConnections.decide")(
    function* (input) {
      // One read decides both where the decision goes and the credential it carries.
      const stored = yield* readStored.pipe(
        Effect.mapError(() => new HqDecisionError({ reason: "unavailable" })),
      );
      if (Option.isNone(stored)) return yield* new HqDecisionError({ reason: "not_connected" });
      const { origin, delegation } = stored.value;
      if (input.origin !== undefined && currentHqOrigin(input.origin) !== origin)
        return yield* new HqDecisionError({ reason: "other_origin" });
      const connection = yield* connectionKey(stored.value);
      // Never pass an HTTP client error on: it carries the request, and so the delegation.
      const { status, text } = yield* HttpClientRequest.post(`${origin}/api/build/decisions`).pipe(
        HttpClientRequest.bearerToken(delegation),
        HttpClientRequest.bodyJsonUnsafe(input.body),
        httpClient.execute,
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
        ),
        Effect.timeout(HQ_REQUEST_TIMEOUT),
        Effect.mapError(() => new HqDecisionError({ reason: "unavailable" })),
      );
      if (status === 401) refusedConnections.add(connection);
      else if (status < 400) refusedConnections.delete(connection);
      return { origin, connection, status, text };
    },
  );

  const callHq = (origin: string, token: string, request: HqForwardRequest) =>
    HttpClientRequest.post(`${origin}/api/mcp`).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        ...(request.accept === undefined ? {} : { accept: request.accept }),
        ...(request.protocolVersion === undefined
          ? {}
          : { "mcp-protocol-version": request.protocolVersion }),
      }),
      HttpClientRequest.bodyUint8Array(request.body, request.contentType ?? "application/json"),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.arrayBuffer.pipe(
          Effect.map((body): HqForwardResponse => ({
            status: response.status,
            contentType: response.headers["content-type"],
            body: new Uint8Array(body),
          })),
        ),
      ),
      Effect.timeout(HQ_REQUEST_TIMEOUT),
      Effect.mapError((): HqRefusal => "unavailable"),
    );

  /**
   * A refusal answers each JSON-RPC request in the body with an error, so the agent sees why;
   * an HTTP 401 would send MCP clients looking for OAuth instead.
   */
  const refusalResponse = (body: Uint8Array, refusal: HqRefusal): HqForwardResponse => {
    const parsed = Option.getOrUndefined(decodeJson(new TextDecoder().decode(body)));
    const error = (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message: refusalMessages[refusal], data: { reason: refusal } },
    });
    const ids = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((message) =>
      typeof message === "object" && message !== null && "id" in message ? [message.id] : [],
    );
    if (ids.length === 0) return { status: 202, contentType: undefined, body: new Uint8Array() };
    const payload = Array.isArray(parsed) ? ids.map(error) : error(ids[0]);
    return {
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(encodeJson(payload)),
    };
  };

  const forward: HqAgentConnections["Service"]["forward"] = Effect.fn("HqAgentConnections.forward")(
    function* (request) {
      const credential = request.authorization?.match(/^Bearer\s+(\S+)\s*$/)?.[1] ?? "";
      const threadId =
        credential === "" ? undefined : threadByCredentialHash.get(yield* digest(credential));
      if (threadId === undefined)
        return {
          status: 401,
          contentType: "application/json",
          body: new TextEncoder().encode(encodeJson({ error: "unknown_credential" })),
        };
      const attempt = Effect.gen(function* () {
        const connection = threads.get(threadId);
        if (connection === undefined) return yield* Effect.fail("unauthorized" as HqRefusal);
        const stored = yield* readStored.pipe(Effect.mapError((): HqRefusal => "unavailable"));
        if (Option.isNone(stored)) return yield* Effect.fail("not_connected" as HqRefusal);
        // One read of the stored connection decides both the exchange and where the token goes.
        const token = yield* agentToken(threadId, stored.value);
        const response = yield* callHq(stored.value.origin, token, request);
        if (response.status !== 401) return Option.some(response);
        // HQ refuses a revoked agent or delegation on the next request; exchanging again
        // learns which, or recovers from a token HQ no longer honours.
        dropToken(threadId);
        return Option.none<HqForwardResponse>();
      });
      const response = yield* attempt.pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              attempt.pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () => Effect.fail("unauthorized" as HqRefusal),
                  }),
                ),
              ),
          }),
        ),
        Effect.catch((refusal: HqRefusal) =>
          Effect.logWarning("Weave refused a thread's agent", {
            threadId,
            reason: refusal,
          }).pipe(Effect.as(refusalResponse(request.body, refusal))),
        ),
        // Even an ambiguous or interrupted write may have committed in HQ, so expire the display
        // caches once forwarding ends however it ends, without interpreting the response.
        Effect.ensuring(
          Effect.sync(() => {
            if (containsBuildWrite(request.body)) buildWriteVersion += 1;
          }),
        ),
      );
      return response;
    },
  );

  const end: HqAgentConnections["Service"]["end"] = Effect.fn("HqAgentConnections.end")(
    function* (agent) {
      yield* tokenLock.withLock(
        agent.threadId,
        Effect.gen(function* () {
          dropToken(agent.threadId);
          const stored = yield* readStored.pipe(Effect.mapError((): HqRefusal => "unavailable"));
          if (Option.isNone(stored)) return;
          const { status } = yield* postAgents(stored.value, {
            action: "end",
            agentRef: agentRef(agent.threadId),
            role: agent.role,
          });
          if (status !== 200) return yield* Effect.fail<HqRefusal>("unavailable");
        }).pipe(
          Effect.catch((reason: HqRefusal) =>
            Effect.logWarning("Could not end a thread's Weave agent", {
              threadId: agent.threadId,
              reason,
            }),
          ),
        ),
      );
    },
  );

  /**
   * Adopts the connection a project stored before the environment owned one, then removes every
   * project copy so the delegation is stored once.
   */
  yield* Effect.gen(function* () {
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
    for (const name of projectEntries) {
      const bytes = yield* store.get(name);
      const stored = Option.flatMap(bytes, (value) =>
        decodeStored(new TextDecoder().decode(value)),
      );
      if (adopted === undefined && Option.isSome(bytes) && Option.isSome(stored)) {
        yield* store.set(STORE_NAME, bytes.value);
        adopted = stored.value.origin;
      }
      yield* store.remove(name);
    }
    yield* Effect.logInfo("Moved a project's HQ connection to the environment", {
      origin: adopted ?? null,
      projectEntries: projectEntries.length,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not move a project's HQ connection to the environment", cause),
    ),
  );

  return HqAgentConnections.of({
    connectionChanges: Stream.fromPubSub(connectionChanges),
    connect: Effect.fn("HqAgentConnections.connect")(function* (input) {
      const address = normalizeHqOrigin(input.origin);
      if (address === null) return yield* new HqConnectionError({ reason: "invalid_origin" });
      // Stored at the address Weave answers on, so an older one never comes back.
      const origin = currentHqOrigin(address);
      const delegation = input.delegation.trim();
      if (!DELEGATION_PATTERN.test(delegation))
        return yield* new HqConnectionError({ reason: "invalid_delegation" });
      const encoded = yield* encodeStored({ origin, delegation }).pipe(Effect.orDie);
      const previous = yield* readStored;
      yield* store
        .set(STORE_NAME, new TextEncoder().encode(encoded))
        .pipe(Effect.mapError(storeFailed));
      // A new delegation or origin takes over at each thread's next exchange.
      for (const connection of threads.values()) connection.token = undefined;
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
      for (const connection of threads.values()) connection.token = undefined;
      if (Option.isSome(previous)) yield* releaseObserver(previous.value);
    }).pipe(Effect.withSpan("HqAgentConnections.disconnect")),
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
    prepare: Effect.fn("HqAgentConnections.prepare")(function* (agent) {
      const connected = yield* readStored.pipe(
        Effect.map(Option.isSome),
        Effect.catch(() =>
          Effect.logWarning("Could not read T3's HQ connection", {
            threadId: agent.threadId,
          }).pipe(Effect.as(false)),
        ),
      );
      const existing = threads.get(agent.threadId);
      if (!connected) return;
      if (existing !== undefined) {
        existing.agent = agent;
        return;
      }
      const credential = yield* crypto.randomBytes(32).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
        Effect.orDie,
      );
      const credentialHash = yield* digest(credential);
      threads.set(agent.threadId, { credential, credentialHash, agent, token: undefined });
      threadByCredentialHash.set(credentialHash, agent.threadId);
    }),
    // The credential stays stable for the thread's life: a live provider process keeps the
    // headers it started with, and Claude reopens its process when its MCP config changes.
    connection: (threadId) =>
      Effect.sync(() => {
        const connection = threads.get(threadId);
        return connection === undefined
          ? undefined
          : { endpoint, authorizationHeader: `Bearer ${connection.credential}` };
      }),
    observe,
    decide,
    forward,
    buildWriteVersion: Effect.sync(() => buildWriteVersion),
    end,
    forget: Effect.fn("HqAgentConnections.forget")(function* (agent) {
      yield* end(agent);
      const connection = threads.get(agent.threadId);
      if (connection === undefined) return;
      threads.delete(agent.threadId);
      threadByCredentialHash.delete(connection.credentialHash);
    }),
  });
});

export const layer = Layer.effect(HqAgentConnections, make);
