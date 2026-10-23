import {
  type AgentBrowserBackends,
  type AgentRole,
  type AgentToolProfile,
  OrchestratorMcpFailure,
  sessionToolFamilies,
  usesPhi,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { type Caller, loadCaller } from "./threadAccess.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * A task whose whole job is one browser works on Phi alone. Its credential is pinned to that one
 * backend, so an integrated tab, or a project whose default is integrated, can never route its
 * actions elsewhere; `McpSessionRegistry` pins a `/mcp/browser` credential the same way.
 */
export const PHI_ONLY_BROWSER_BACKENDS: AgentBrowserBackends = {
  enabled: ["phi"],
  default: "phi",
};

/**
 * Whether a role listing carries the preview family, which is the browser and ui-verifier roles.
 * The one policy table decides, so a child is refused exactly when its endpoint lists no browser.
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
  listsBrowserFamily({
    toolProfile: caller.agentTask.toolProfile,
    agentRole: caller.agentTask.role,
  });

/**
 * The calling thread's project still allowing agent browsing, and still allowing Phi. Resolved on
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
  if (!resolved.agentBrowserBackends.enabled.includes("phi"))
    return yield* refuse("Phi browsing was turned off for this project.");
  return caller;
});

/**
 * A managed browser task's authority, checked on every call rather than at session start: the
 * credential must be one minted for a Phi-pinned task, still owned by that task's thread, and
 * the project's browser settings must still allow Phi. Closing a tab skips the settings check
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
