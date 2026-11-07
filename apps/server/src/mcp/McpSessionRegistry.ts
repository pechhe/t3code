import * as PreviewManager from "../preview/Manager.ts";
import * as PhiBrowser from "../preview/PhiBrowser.ts";
import * as Option from "effect/Option";
import {
  type AgentRole,
  type AgentToolProfile,
  ProviderInstanceId,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  sessionToolFamilies,
  ThreadId,
  toolFamily,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly toolProfile?: AgentToolProfile;
  readonly agentRole?: AgentRole;
  readonly webResearchTools?: boolean;
  /** A delegated child thread lists only its own work family and the leaf tools. */
  readonly delegated?: boolean;
  readonly browserBackends?: import("@t3tools/contracts").AgentBrowserBackends;
  readonly phiBrowserSkillDirectory?: string;
  /**
   * A managed browser task's credential: the preview capability only, pinned to its selected backend, and valid
   * only on the narrow `/mcp/browser` endpoint. Nothing the task's settings say can move it.
   */
  readonly managedBrowser?: boolean;
  readonly taskBrowser?: import("@t3tools/contracts").AgentTaskBrowser;
  /**
   * The thread may run bounded browser tasks. A delegated leaf without a browser endpoint of
   * its own then reaches only `/mcp/bounded-browser`; other sessions list them beside their tools.
   */
  readonly boundedBrowser?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /** A revoked credential never returns; an expired one can, when a trusted turn touches it. */
  readonly credentialState: (
    providerSessionId: string,
  ) => Effect.Effect<"live" | "expired" | "revoked">;
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
  /** Set once the credential expired and its browser resources were released. */
  readonly browserReleased?: boolean;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * A delegated leaf granted bounded tasks and no browser endpoint of its own: its credential
 * reaches only `/mcp/bounded-browser` and carries only the preview capability.
 */
export const boundedBrowserOnly = (request: {
  readonly boundedBrowser?: boolean | undefined;
  readonly managedBrowser?: boolean | undefined;
  readonly delegated?: boolean | undefined;
}): boolean =>
  request.boundedBrowser === true && request.managedBrowser !== true && request.delegated === true;

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
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const phi = yield* Effect.serviceOption(PhiBrowser.PhiBrowser);
  const previews = yield* Effect.serviceOption(PreviewManager.PreviewManager);
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  // Closing a session's browser resources can be slow. A credential is denied the moment it
  // leaves `state`; cleanup then runs here, off the request path, so neither a stop nor the next
  // credential waits on it. Phi keeps its journal until each close succeeds, and releases every
  // session again when the server stops, so a cancelled fiber orphans nothing.
  const cleanups = yield* FiberSet.make<void, never>();
  const releaseBrowserSessions = (
    sessions: ReadonlyArray<McpInvocationContext.McpThreadInvocationScope>,
  ) =>
    sessions.length === 0
      ? Effect.void
      : FiberSet.run(
          cleanups,
          Effect.forEach(
            sessions,
            (scope) =>
              Effect.gen(function* () {
                const session = scope.thread;
                const integrated =
                  scope.managedBrowser === true && scope.browserBackends?.default === "integrated";
                if (Option.isSome(phi) && !integrated)
                  yield* phi.value.releaseSession(session.providerSessionId);
                // Bounded tabs have their own owner, and close with the credential whatever its backend.
                const owners = [
                  ...(integrated ? [McpInvocationContext.browserOwnerKey(scope)] : []),
                  ...(scope.boundedBrowser === true
                    ? [McpInvocationContext.browserOwnerKey({ ...scope, browserLane: "bounded" })]
                    : []),
                ];
                if (Option.isSome(previews) && owners.length > 0) {
                  const { sessions: tabs } = yield* previews.value.list({
                    threadId: session.threadId,
                  });
                  yield* Effect.forEach(
                    tabs.filter(
                      (tab) =>
                        tab.automationOwner !== undefined && owners.includes(tab.automationOwner),
                    ),
                    (tab) =>
                      previews.value
                        .close({ threadId: ThreadId.make(tab.threadId), tabId: tab.tabId })
                        .pipe(Effect.ignore),
                    { discard: true },
                  );
                }
              }),
            { discard: true },
          ),
        ).pipe(Effect.asVoid);
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const origin = mcpEndpointOrigin(httpServer.address);
  const endpoint = `${origin}/mcp`;
  const managedBrowserEndpoint = `${origin}${MANAGED_BROWSER_MCP_PATH}`;
  const sessionEndpoints = Object.fromEntries(
    Object.entries(SESSION_TOOL_ENDPOINTS).map(([key, endpoint]) => [
      key,
      `${origin}${endpoint.path}`,
    ]),
  ) as Record<keyof typeof SESSION_TOOL_ENDPOINTS, string>;

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  // An expired credential stays until revoked so a trusted touch can restore it, but its browser
  // resources are released once it expires. A touch that restores it clears the mark.
  const expireDead = Effect.fn("McpSessionRegistry.expireDead")(function* (timestamp: number) {
    const expired = yield* SynchronizedRef.modify(state, ({ records }) => {
      const sessions: Array<McpInvocationContext.McpThreadInvocationScope> = [];
      const next = new Map(records);
      for (const [hash, record] of records) {
        if (record.browserReleased === true || timestamp - record.lastAliveAt <= livenessWindowMs) {
          continue;
        }
        next.set(hash, { ...record, browserReleased: true });
        sessions.push(record.scope);
      }
      return sessions.length === 0
        ? ([sessions, { records }] as const)
        : ([sessions, { records: next }] as const);
    });
    yield* releaseBrowserSessions(expired);
  });

  yield* currentTimeMillis.pipe(
    Effect.flatMap(expireDead),
    Effect.repeat(Schedule.spaced(Math.min(livenessWindowMs, 60_000))),
    Effect.forkScoped,
  );

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      yield* expireDead(issuedAt);
      const providerSessionId = yield* random.uuidV4();
      const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const managedBrowser = request.managedBrowser === true;
      const browserToolsAvailable = managedBrowser || (request.browserToolsAvailable ?? true);
      const boundedBrowser = request.boundedBrowser === true;
      const boundedOnly = boundedBrowserOnly(request);
      const endpointKey = managedBrowser
        ? undefined
        : boundedOnly
          ? ("bounded-browser" as const)
          : request.delegated === true ||
              request.toolProfile !== undefined ||
              request.agentRole !== undefined
            ? sessionEndpointKey({
                toolProfile: request.toolProfile,
                agentRole: request.agentRole,
                delegated: request.delegated,
              })
            : "control";
      // A managed browser task lists the narrow browser operations; every other session
      // reads its families from the one policy table, so an adapter can tell a
      // child what its own listing carries.
      const families =
        endpointKey === undefined
          ? undefined
          : boundedOnly
            ? SESSION_TOOL_ENDPOINTS["bounded-browser"].families
            : sessionToolFamilies({
                toolProfile: request.toolProfile,
                agentRole: request.agentRole,
                delegated: request.delegated,
              });
      const listsPreview = managedBrowser || families?.has("preview") === true;
      const grantsDevice = request.capabilities?.has("device") === true;
      // A managed browser task drives simulators as well as pages when agent device access is on.
      const listsDevice = managedBrowser ? grantsDevice : families?.has("device") === true;
      const listsHtml = !managedBrowser && families?.has("leaf") === true;
      const listsBackgroundWait =
        !managedBrowser &&
        (families === undefined || families.has(toolFamily("t3_background_wait")));
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        webResearchTools:
          request.toolProfile === "web-research" && request.webResearchTools === true,
        environmentId,
        // A retry after a reconnect or server restart arrives on a fresh credential, so request
        // identity follows the thread, which both share.
        requestNamespace: `thread:${request.threadId}`,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>(
          managedBrowser
            ? ["preview", ...(grantsDevice ? (["device"] as const) : [])]
            : boundedOnly
              ? ["preview"]
              : [
                  "orchestration",
                  "worktree",
                  "pull-requests",
                  ...(request.capabilities ??
                    (browserToolsAvailable ? (["preview"] as const) : [])),
                ],
        ),
        issuedAt,
        ...(request.toolProfile === undefined ? {} : { toolProfile: request.toolProfile }),
        ...(request.agentRole === undefined ? {} : { agentRole: request.agentRole }),
        ...(endpointKey === undefined ? {} : { endpointKey }),
        ...(boundedBrowser ? { boundedBrowser: true as const } : {}),
        ...(managedBrowser
          ? {
              managedBrowser: true as const,
              taskBrowser: request.taskBrowser ?? { backend: "integrated" as const },
              browserBackends: {
                enabled: [request.taskBrowser?.backend ?? ("integrated" as const)],
                default: request.taskBrowser?.backend ?? ("integrated" as const),
              },
            }
          : request.browserBackends === undefined
            ? {}
            : { browserBackends: request.browserBackends }),
        ...(request.phiBrowserSkillDirectory === undefined
          ? {}
          : { phiBrowserSkillDirectory: request.phiBrowserSkillDirectory }),
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint: managedBrowser
            ? managedBrowserEndpoint
            : endpointKey === undefined
              ? endpoint
              : sessionEndpoints[endpointKey],
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          ...(managedBrowser ? { managedBrowser: true } : {}),
          ...(boundedBrowser ? { boundedBrowser: true } : {}),
          ...(request.delegated === true ? { delegated: true } : {}),
          listsPreview,
          listsDevice,
          listsHtml,
          listsBackgroundWait,
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
        const record = records.get(tokenHash);
        if (!record || timestamp - record.lastAliveAt > livenessWindowMs) {
          return [undefined, { records }] as const;
        }
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope: record.scope, lastAliveAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const credentialState: McpSessionRegistryShape["credentialState"] = Effect.fn(
    "McpSessionRegistry.credentialState",
  )(function* (providerSessionId) {
    const timestamp = yield* currentTimeMillis;
    const { records } = yield* SynchronizedRef.get(state);
    let result: "expired" | "revoked" = "revoked";
    for (const record of records.values()) {
      if (record.scope.thread.providerSessionId !== providerSessionId) continue;
      if (timestamp - record.lastAliveAt <= livenessWindowMs) return "live" as const;
      result = "expired";
    }
    return result;
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { tokenHash, scope: record.scope, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
      // After the touch, so the touched thread's own credentials are restored, not released.
      yield* expireDead(timestamp);
    },
  );

  const revokeWhere = Effect.fn("revokeWhere")((predicate: (record: CredentialRecord) => boolean) =>
    Effect.gen(function* () {
      const sessions = yield* SynchronizedRef.modify(state, ({ records }) => {
        const removed = Array.from(records.values())
          .filter(predicate)
          .map((record) => record.scope);
        return [
          removed,
          { records: new Map(Array.from(records).filter(([, record]) => !predicate(record))) },
        ] as const;
      });
      yield* releaseBrowserSessions(sessions);
    }),
  );

  return McpSessionRegistry.of({
    issue,
    resolve,
    credentialState,
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
        yield* releaseBrowserSessions(
          Array.from(records.values())
            .filter((record) => record.scope.thread.threadId === threadId)
            .map((record) => record.scope),
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

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
