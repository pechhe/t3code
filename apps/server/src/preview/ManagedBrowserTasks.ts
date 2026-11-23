import type {
  PreviewAutomationOpenInput,
  PreviewAutomationRequest,
  ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { BrowserContext, Response as BrowserResponse } from "playwright-core";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MANAGED_BROWSER_DENIAL_HEADER } from "./ManagedBrowserProxy.ts";
import * as JourneyBrowserPolicy from "./JourneyBrowserPolicy.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const LOST_TAB_MEMORY = 256;

/** Fails a managed task's navigation that the managed browser proxy refused. */
export const assertAllowedNavigation = (response: BrowserResponse | null) => {
  const denied = response?.headers()[MANAGED_BROWSER_DENIAL_HEADER];
  if (denied)
    throw new ServerBrowserPage.ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: denied,
    });
};

interface NetworkRefusalSource {
  readonly networkRefusalCount?: (context: BrowserContext) => number;
  readonly networkRefusals?: (context: BrowserContext) => ReadonlyArray<string>;
}

/**
 * Runs a managed task's operation. Its reply lists the requests the task's contexts refused,
 * and a failure that a new refusal caused reports that refusal instead.
 */
export const withNetworkRefusals = async <A, B>(
  source: NetworkRefusalSource,
  ownedContexts: () => ReadonlyArray<BrowserContext>,
  run: () => Promise<A>,
  present: (result: A) => B,
): Promise<B> => {
  const owned = () => [...new Set(ownedContexts())];
  const refusalsOf = (context: BrowserContext) => source.networkRefusals?.(context) ?? [];
  const before = new Map(
    owned().map((context) => [context, source.networkRefusalCount?.(context) ?? 0]),
  );
  try {
    const result = await run();
    const blocked = [...new Set(owned().flatMap(refusalsOf))];
    if (blocked.length === 0) return present(result);
    return present(
      ServerBrowserPage.transferSnapshotValueObservation(result, {
        ...(typeof result === "object" && result !== null ? result : {}),
        networkRefusals: blocked.slice(-10).map((message) => message.slice(0, 500)),
      } as A),
    );
  } catch (error) {
    const newlyBlocked = owned()
      .filter(
        (context) => (source.networkRefusalCount?.(context) ?? 0) > (before.get(context) ?? 0),
      )
      .flatMap(refusalsOf);
    if (newlyBlocked.length > 0)
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message: newlyBlocked.at(-1)!,
      });
    throw error;
  }
};

/**
 * Refuses what a managed integrated task may not do: page code, uploads, dialogs and handoffs
 * (outside a browser run's own page code and uploads), and choosing a persistent profile.
 */
export const refuseUnavailableOperation = (
  request: PreviewAutomationRequest,
  runLaneOperation: boolean,
) => {
  if (
    !runLaneOperation &&
    ["evaluate", "upload", "dialog", "handoff", "resume"].includes(request.operation)
  )
    throw new BrowserControlInterrupted({
      message: "This operation is not available to a managed integrated task.",
    });
  if (
    request.operation === "open" &&
    (request.input as PreviewAutomationOpenInput).profileId !== undefined
  )
    throw new BrowserControlInterrupted({
      message: "Managed integrated tasks cannot select a persistent browser profile.",
    });
};

type JourneyDecision = { readonly host: string; readonly port: number; readonly allowed: boolean };

/**
 * The server browser's record of managed integrated browser tasks: which agent sessions are
 * managed and for which project, the tabs a crash or disconnect took from them, and the
 * project policy their contexts browse under.
 */
export const make = Effect.fn("ManagedBrowserTasks.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const settingsChanges = Option.isSome(settingsService)
    ? yield* settingsService.value.subscribeChanges
    : Stream.empty;
  let settings = Option.isSome(settingsService)
    ? yield* settingsService.value.getSettings.pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  /** The port a managed context's proxy reaches this server on. */
  const serverPort =
    Option.isSome(httpServer) && NetAddress.isInetAddress(httpServer.value.address)
      ? httpServer.value.address.port
      : config.port;
  const sessions = new Map<string, ProjectId>();
  const lostTabs = new Map<string, string>();

  const signInPolicy = (projectId: ProjectId) => {
    if (settings === undefined) return null;
    const project = resolveProjectSettings(settings, projectId).settings;
    return project.enableAgentBrowserAccess &&
      project.agentBrowserBackends.enabled.includes("integrated")
      ? { signIn: project.agentBrowserSignIn, allowlist: project.agentBrowserLoopbackAllow }
      : null;
  };

  /** The loopback allowlist a project's managed tasks browse under, or null when it bars them. */
  const policy = (projectId: ProjectId) => signInPolicy(projectId)?.allowlist ?? null;

  return {
    policy,
    signInPolicy,
    /**
     * The options a managed task's browser context starts with. A Champion journey's context
     * reaches only its allowlist, runs at the lowest priority and reports each network decision.
     */
    contextOptions: (
      projectId: ProjectId,
      startTimeoutMs: number | undefined,
      journey: { readonly checkId: string; readonly allow: ReadonlyArray<string> } | undefined,
      onJourneyDecision: (checkId: string, decision: JourneyDecision) => void,
    ) => {
      // The open's remaining limit reaches the start, which has no limit of its own.
      const limit = startTimeoutMs === undefined ? {} : { startTimeoutMs };
      if (journey === undefined)
        return { serverPort, policy: async () => policy(projectId), ...limit };
      return {
        serverPort,
        ...limit,
        policy: async () => (policy(projectId) === null ? null : journey.allow),
        allowlistOnly: true,
        journey: { marker: JourneyBrowserPolicy.journeyBrowserMarker(journey.checkId) },
        onDecision: (decision: JourneyDecision) => onJourneyDecision(journey.checkId, decision),
      };
    },
    projectOf: (agentId: string | null | undefined) =>
      agentId == null ? undefined : sessions.get(agentId),
    isManaged: (agentId: string | null | undefined) => agentId != null && sessions.has(agentId),
    register: (agentId: string, projectId: ProjectId) => {
      sessions.set(agentId, projectId);
    },
    /** Remembers that a managed task lost this tab, so its next request on it says so. */
    recordLostTab: (key: string, agentId: string | null) => {
      if (agentId === null || !sessions.has(agentId)) return;
      lostTabs.set(key, agentId);
      if (lostTabs.size > LOST_TAB_MEMORY) lostTabs.delete(lostTabs.keys().next().value!);
    },
    lostTabOwner: (key: string) => lostTabs.get(key),
    /**
     * After each settings change, calls `revoke` with a test for the agent sessions whose
     * project policy the change withdrew or altered.
     */
    followPolicyChanges: (
      revoke: (revoked: (agentId: string | null) => boolean) => Promise<void>,
    ) =>
      settingsChanges.pipe(
        Stream.runForEach((next) =>
          Effect.promise(async () => {
            const previous = settings;
            settings = next;
            await revoke((agentId) => {
              const project = agentId === null ? undefined : sessions.get(agentId);
              return (
                project !== undefined &&
                (policy(project) === null ||
                  (previous !== undefined &&
                    JSON.stringify(
                      resolveProjectSettings(previous, project).settings.agentBrowserLoopbackAllow,
                    ) !== JSON.stringify(policy(project))))
              );
            });
          }),
        ),
      ),
  };
});
