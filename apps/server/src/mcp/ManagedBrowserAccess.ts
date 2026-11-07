import {
  type AgentBrowserBackends,
  type AgentRole,
  type AgentToolProfile,
  BOUNDED_BROWSER_ROLES,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectId,
  sessionToolFamilies,
  usesPhi,
  isLeafAgentTask,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertLiveCaller, type Caller, loadCaller } from "./threadAccess.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * Whether a role listing carries the preview family (the browser profile's), from the one policy
 * table, so a child is refused exactly when its endpoint lists no browser.
 * Reads use the listing recorded on their credential, because a read must not gain the thread load,
 * liveness check or refusal it never had; actions use the thread's live task binding below.
 */
export const listsBrowserFamily = ({
  toolProfile,
  agentRole,
}: {
  readonly toolProfile?: AgentToolProfile | undefined;
  readonly agentRole?: AgentRole | undefined;
}) => sessionToolFamilies({ toolProfile, agentRole, delegated: true }).has("preview");

/** Whether this caller's own live task drives a browser of its own. */
export const drivesOwnBrowser = ({ caller }: Caller) =>
  caller?.agentTask !== undefined &&
  isLeafAgentTask(caller.agentTask) &&
  listsBrowserFamily({
    toolProfile: caller.agentTask.toolProfile,
    agentRole: caller.agentTask.role,
  });

/**
 * The calling thread's project still allowing agent browsing and its selected backend. Resolved on
 * every call rather than at session start, so a credential that outlives a settings change cannot
 * keep acting on its own.
 */
export const assertProjectBrowserAccess = Effect.fn("mcp.assertProjectBrowserAccess")(function* (
  caller: Caller,
) {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const resolved = Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(
        Effect.map((value) => resolveProjectSettings(value, caller.caller!.projectId).settings),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  if (resolved === undefined)
    return yield* refuse("Browser access could not be confirmed; managed browsing is paused.");
  if (!resolved.enableAgentBrowserAccess)
    return yield* refuse("Agent browser access was turned off for this project.");
  const backend =
    caller.scope.taskBrowser?.backend ?? caller.scope.browserBackends?.default ?? "integrated";
  if (!resolved.agentBrowserBackends.enabled.includes(backend))
    return yield* refuse(
      `${backend === "phi" ? "Phi" : "Integrated"} browsing was turned off for this project.`,
    );
  return caller;
});

/**
 * A managed browser task's authority, checked on every call rather than at session start: the
 * credential must be one minted for a browser task, still owned by that task's thread, and
 * the project's browser settings must still allow its selected backend. Closing a tab skips the settings check
 * so cleanup survives revoked access.
 */
export const assertManagedBrowserCaller = Effect.fn("mcp.assertManagedBrowserCaller")(
  function* (options: { readonly checkSettings: boolean }) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.managedBrowser !== true || scope.thread === undefined)
      return yield* refuse("This tool is only available to a managed browser task.");
    const caller: Caller = yield* loadCaller();
    if (!usesPhi(caller.caller?.agentTask?.toolProfile))
      return yield* refuse("The calling thread is not a managed browser task.");
    return options.checkSettings ? yield* assertProjectBrowserAccess(caller) : caller;
  },
);

/**
 * Whether a thread may run bounded browser tasks, from what the server recorded about it and
 * never from what a caller says. An ordinary or scheduled thread and a Spec lead may; a managed
 * leaf only when its role policy granted them at binding. A subagent with no task record, work
 * owned by an outside client and work from a linked environment may not.
 */
export const boundedBrowserEligible = (
  thread: Pick<
    OrchestrationV2ThreadShell,
    "agentTask" | "lineage" | "linkOrigin" | "delegatedFrom"
  >,
): boolean => {
  if (thread.linkOrigin !== undefined || thread.delegatedFrom !== undefined) return false;
  const task = thread.agentTask;
  if (task === undefined) return thread.lineage.relationshipToParent !== "subagent";
  if (task.externalOwner !== undefined) return false;
  if (!isLeafAgentTask(task)) return true;
  return task.browserTasks === true && BOUNDED_BROWSER_ROLES.has(task.role);
};

/** Bounded tasks always use the integrated browser, so its project setting is what decides. */
export const projectAllowsBoundedBrowser = (settings: {
  readonly enableAgentBrowserAccess: boolean;
  readonly agentBrowserBackends: AgentBrowserBackends;
}) =>
  settings.enableAgentBrowserAccess && settings.agentBrowserBackends.enabled.includes("integrated");

const BOUNDED_BACKENDS: AgentBrowserBackends = { enabled: ["integrated"], default: "integrated" };

/**
 * The scope bounded tools act with: a fresh integrated tab with no profile, owned by this
 * provider session's bounded lane, whatever browser the session itself drives.
 */
export const boundedBrowserScope = (
  scope: McpInvocationContext.McpThreadInvocationScope,
  projectId: ProjectId,
): McpInvocationContext.McpThreadInvocationScope => ({
  ...scope,
  capabilities: new Set(["preview"]),
  managedBrowser: true,
  managedProjectId: projectId,
  taskBrowser: { backend: "integrated" },
  browserBackends: BOUNDED_BACKENDS,
  browserLane: "bounded",
});

/**
 * A bounded browser call's authority, checked on every call: a T3 thread credential minted with
 * the capability, still owned by a live run of that thread, whose recorded task still grants it.
 * Effects also need the project to allow integrated agent browsing now; closing and cancelling
 * skip that check so cleanup survives revoked access.
 */
export const assertBoundedBrowserCaller = Effect.fn("mcp.assertBoundedBrowserCaller")(
  function* (options: { readonly checkSettings: boolean }) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.boundedBrowser !== true || scope.thread === undefined || scope.client !== undefined)
      return yield* refuse("Bounded browser tasks are not available to this session.");
    const caller: Caller = yield* loadCaller();
    yield* assertLiveCaller(caller);
    const shell = caller.caller!;
    const leafRole = isLeafAgentTask(shell.agentTask) ? shell.agentTask?.role : undefined;
    if (!boundedBrowserEligible(shell) || scope.agentRole !== leafRole)
      return yield* refuse("This thread may not run bounded browser tasks.");
    if (options.checkSettings) {
      const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const resolved = Option.isSome(settings)
        ? yield* settings.value.getSettings.pipe(
            Effect.map((value) => resolveProjectSettings(value, shell.projectId).settings),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      if (resolved === undefined)
        return yield* refuse("Browser access could not be confirmed; bounded browsing is paused.");
      if (!projectAllowsBoundedBrowser(resolved))
        return yield* refuse("Integrated agent browsing is turned off for this project.");
    }
    return {
      caller,
      scope: boundedBrowserScope(
        scope as McpInvocationContext.McpThreadInvocationScope,
        shell.projectId,
      ),
    };
  },
);
