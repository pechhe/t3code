import type {
  ModelSelection,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  firstAccount,
  isAccountFree,
  pooledModelOf,
  pooledModels,
  selectionAccountId,
  selectionOnAccount,
} from "@t3tools/shared/accountPools";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as Orchestrator from "./Orchestrator.ts";

interface RouteOptions {
  /** The role resolver already placed this work on an account, under conservation. */
  readonly placed?: boolean | undefined;
}

/**
 * Picks the account a selection runs on before the orchestrator sees it. A pinned selection stays;
 * a thread keeps its account for the same model, so its prompt cache keeps paying off (one that
 * has not run yet gives it up once skipped); new work takes the model's first account that is not
 * skipped.
 */
export const make = (input: {
  readonly providerRegistry: Option.Option<ProviderRegistry.ProviderRegistry["Service"]>;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, Orchestrator.OrchestratorV2Error>;
}) => {
  const route = Effect.fn("AccountRouting.route")(function* (
    selection: ModelSelection,
    threadId: ThreadId | undefined,
    options?: RouteOptions,
  ) {
    if (selection.pinned === true || options?.placed === true) return selection;
    if (Option.isNone(input.providerRegistry)) return selection;
    const providers = yield* input.providerRegistry.value.getProviders;
    const settings = yield* input.serverSettings.getSettings.pipe(Effect.orDie);
    const pools = pooledModels(providers, settings);
    const pool = pooledModelOf(pools, selection);
    if (pool === undefined) return selection;
    const shell = threadId === undefined ? null : yield* input.getThreadShell(threadId);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const pick = { readOnly: shell?.agentTask?.sourceAccess === "read-only" };
    if (shell !== null && pooledModelOf(pools, shell.modelSelection) === pool) {
      const current = selectionAccountId(providers, shell.modelSelection);
      const kept = pool.accounts.find((entry) => entry.account.id === current);
      // A thread that has not run yet may have been placed by a role, under conservation.
      if (
        kept !== undefined &&
        (shell.latestRunId != null || isAccountFree(pool, kept, settings.accountSkips, nowMs, pick))
      )
        return selectionOnAccount(kept, selection.options);
    }
    const target = firstAccount(pool, settings.accountSkips, nowMs, pick);
    return target === undefined ? selection : selectionOnAccount(target, selection.options);
  });

  const routeCommand = (
    command: OrchestrationV2ServerCommand,
    options?: RouteOptions,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorV2Error> => {
    switch (command.type) {
      case "thread.create":
        return route(command.modelSelection, undefined, {
          placed: options?.placed === true || command.agentTask !== undefined,
        }).pipe(Effect.map((modelSelection) => ({ ...command, modelSelection })));
      // A role's delegation is placed by the resolver; a bare model follows the order.
      case "delegated_task.request":
        return command.agentTask !== undefined
          ? Effect.succeed(command)
          : route(command.modelSelection, undefined).pipe(
              Effect.map((modelSelection) => ({ ...command, modelSelection })),
            );
      case "message.dispatch": {
        const selection = command.modelSelection;
        // A failover or limit recovery already names the account the turn continues on.
        if (
          selection === undefined ||
          command.manualContinuationOfRunId !== undefined ||
          command.usageLimitContinuationOfRunId !== undefined
        )
          return Effect.succeed(command);
        return route(selection, command.threadId).pipe(
          Effect.map((modelSelection) => ({ ...command, modelSelection })),
        );
      }
      case "thread.model-selection.set":
      case "provider.switch":
        return route(command.modelSelection, command.threadId).pipe(
          Effect.map((modelSelection) => ({ ...command, modelSelection })),
        );
      default:
        return Effect.succeed(command);
    }
  };

  return { routeCommand };
};
