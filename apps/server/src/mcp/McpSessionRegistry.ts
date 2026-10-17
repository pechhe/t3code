import * as PhiBrowser from "../preview/PhiBrowser.ts";
import * as Option from "effect/Option";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * When false, the credential is minted without the "preview" capability so
   * the user's choice to withhold agent browser access holds everywhere the
   * token is honored (#7083). Defaults to full access.
   */
  readonly browserToolsAvailable?: boolean;
  readonly browserBackends?: import("@t3tools/contracts").AgentBrowserBackends;
  readonly phiBrowserSkillDirectory?: string;
  /**
   * A managed browser task's credential: the preview capability only, pinned to Phi, and valid
   * only on the narrow `/mcp/browser` endpoint. Nothing the task's settings say can move it.
   */
  readonly managedBrowser?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Closes the browser tabs a thread's sessions opened and leaves its credentials valid, so the
   * thread's next browser call opens a fresh tab.
   */
  readonly releaseThreadBrowser: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `t3-code` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const MANAGED_BROWSER_BACKENDS = { enabled: ["phi"], default: "phi" } as const;

/** The only endpoint a managed browser task's credential reaches. */
export const MANAGED_BROWSER_MCP_PATH = "/mcp/browser";

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

/** The origin provider processes on this host use to reach the server's MCP endpoints. */
export const mcpEndpointOrigin = (address: HttpServer.HttpServer["Service"]["address"]): string =>
  NetAddress.isInetAddress(address)
    ? `http://${getHttpMcpEndpointHost(address.address)}:${address.port}`
    : "http://127.0.0.1";

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const phi = yield* Effect.serviceOption(PhiBrowser.PhiBrowser);
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  // Closing a session's browser resources can be slow. A credential is denied the moment it
  // leaves `state`; cleanup then runs here, off the request path, so neither a stop nor the next
  // credential waits on it. Phi keeps its journal until each close succeeds, and releases every
  // session again when the server stops, so a cancelled fiber orphans nothing.
  const cleanups = yield* FiberSet.make<void, never>();
  const releasePhiSessions = (sessions: ReadonlyArray<string>) =>
    Option.isSome(phi) && sessions.length > 0
      ? FiberSet.run(
          cleanups,
          Effect.forEach(sessions, (id) => phi.value.releaseSession(id), { discard: true }),
        ).pipe(Effect.asVoid)
      : Effect.void;
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const origin = mcpEndpointOrigin(httpServer.address);
  const endpoint = `${origin}/mcp`;
  const managedBrowserEndpoint = `${origin}${MANAGED_BROWSER_MCP_PATH}`;

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const expireDead = Effect.fn("McpSessionRegistry.expireDead")(function* (timestamp: number) {
    const expired = yield* SynchronizedRef.modify(state, ({ records }) => {
      const live = pruneDead(records, timestamp);
      const sessions = Array.from(records)
        .filter(([hash]) => !live.has(hash))
        .map(([, record]) => record.scope.thread.providerSessionId);
      return [sessions, { records: live }] as const;
    });
    yield* releasePhiSessions(expired);
  });

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      yield* expireDead(issuedAt);
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const managedBrowser = request.managedBrowser === true;
      const browserToolsAvailable = managedBrowser || (request.browserToolsAvailable ?? true);
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>(
          managedBrowser
            ? ["preview"]
            : [
                "orchestration",
                "worktree",
                "pull-requests",
                ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
              ],
        ),
        issuedAt,
        ...(managedBrowser
          ? { managedBrowser: true as const, browserBackends: MANAGED_BROWSER_BACKENDS }
          : request.browserBackends === undefined
            ? {}
            : { browserBackends: request.browserBackends }),
        ...(request.phiBrowserSkillDirectory === undefined
          ? {}
          : { phiBrowserSkillDirectory: request.phiBrowserSkillDirectory }),
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint: managedBrowser ? managedBrowserEndpoint : endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          ...(managedBrowser ? { managedBrowser: true } : {}),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      yield* expireDead(timestamp);
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* expireDead(timestamp);
      yield* SynchronizedRef.update(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    Effect.gen(function* () {
      const sessions = yield* SynchronizedRef.modify(state, ({ records }) => {
        const removed = Array.from(records.values())
          .filter(predicate)
          .map((record) => record.scope.thread.providerSessionId);
        return [
          removed,
          { records: new Map(Array.from(records).filter(([, record]) => !predicate(record))) },
        ] as const;
      });
      yield* releasePhiSessions(sessions);
    });

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    releaseThreadBrowser: Effect.fn("McpSessionRegistry.releaseThreadBrowser")(
      function* (threadId) {
        const { records } = yield* SynchronizedRef.get(state);
        yield* releasePhiSessions(
          Array.from(records.values())
            .filter((record) => record.scope.thread.threadId === threadId)
            .map((record) => record.scope.thread.providerSessionId),
        );
      },
    ),
    revokeAll: revokeWhere(() => true),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
