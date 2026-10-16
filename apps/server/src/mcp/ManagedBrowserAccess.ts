import { OrchestratorMcpFailure, usesPhi } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { type Caller, loadCaller } from "./threadAccess.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

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
    if (!options.checkSettings) return caller;
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
  },
);
