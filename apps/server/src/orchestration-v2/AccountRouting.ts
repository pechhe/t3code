import type {
  ModelSelection,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  PooledModelKey,
  ThreadId,
} from "@t3tools/contracts";
import {
  pickAccount,
  rankAccounts,
  pooledModelOfSelection,
  pooledModels,
  routedModelIds,
  selectionAccountId,
  selectionOnAccount,
} from "@t3tools/shared/accountPools";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { routingSnapshot, type RoutingDecisions } from "../agents/RoutingDecisions.ts";
import type * as AccountAvailability from "../provider/AccountAvailability.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";

interface RouteOptions {
  /** The role resolver already placed this work on an account, through the same picker. */
  readonly placed?: boolean | undefined;
}

/** Henry reads times in London, labelled with the zone. */
const londonTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(DateTime.toDate(DateTime.makeUnsafe(iso)));

/**
 * Picks a selection's account before the orchestrator sees it; a pinned one stays. A thread keeps
 * an available account for its model so its prompt cache keeps paying off. A turn no account can
 * take without spending into a reserve is refused, naming when one returns.
 */
export const make = (input: {
  readonly providerRegistry: Option.Option<ProviderRegistry.ProviderRegistry["Service"]>;
  readonly availability: Option.Option<AccountAvailability.AccountAvailability["Service"]>;
  /** Where the decision is kept for the run it starts; absent where nothing records setups. */
  readonly decisions?: Option.Option<RoutingDecisions["Service"]> | undefined;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, Orchestrator.OrchestratorV2Error>;
}) => {
  // What each account served, so a thread on one that is later removed keeps its model.
  const seen = new Map<string, PooledModelKey>();
  const route = Effect.fn("AccountRouting.route")(function* (
    command: OrchestrationV2ServerCommand,
    selection: ModelSelection,
    shell: OrchestrationV2ThreadShell | null,
    startsTurn: boolean,
  ) {
    if (selection.pinned === true) return selection;
    if (Option.isNone(input.providerRegistry)) return selection;
    // Routing runs on the thread-launch path, so it never waits on a usage-history scan.
    const providers = yield* input.providerRegistry.value.getProviders.pipe(
      Effect.provideService(ProviderRegistry.ProviderUsageWithoutScan, true),
    );
    const settings = yield* input.serverSettings.getSettings.pipe(Effect.orDie);
    const pools = pooledModels(providers, settings);
    for (const [id, key] of routedModelIds(pools)) seen.set(id, key);
    const pool = pooledModelOfSelection(pools, providers, settings, selection, seen);
    if (pool === undefined) return selection;
    const blocks = Option.isSome(input.availability)
      ? (yield* input.availability.value.state).blocks
      : [];
    const context = { blocks, nowMs: DateTime.toEpochMillis(yield* DateTime.now) };
    const routeOptions = {
      readOnly: shell?.agentTask?.sourceAccess === "read-only",
      current:
        shell !== null &&
        pooledModelOfSelection(pools, providers, settings, shell.modelSelection, seen) === pool
          ? selectionAccountId(providers, shell.modelSelection)
          : undefined,
    };
    const pick = pickAccount(pool, context, routeOptions);
    // The run this turn starts is recorded with the alternatives as they stood now.
    const decisions = input.decisions;
    if (
      startsTurn &&
      command.type === "message.dispatch" &&
      decisions !== undefined &&
      Option.isSome(decisions)
    ) {
      const target = pick.type === "account" ? pick.target : pick.coolingDown;
      const ranked = rankAccounts(pool, context, routeOptions).map(({ entry, availability }) => ({
        provider: entry.provider,
        model: entry.model,
        availability,
      }));
      const chosen = ranked.find(
        (candidate) =>
          target !== undefined &&
          candidate.provider.instanceId === target.provider.instanceId &&
          candidate.model === target.model,
      );
      if (chosen !== undefined)
        yield* decisions.value.note(
          command.threadId,
          routingSnapshot({
            kind: "account-pool",
            nowMs: context.nowMs,
            pinned: false,
            modelNamed: command.modelSelection !== undefined,
            chosen,
            ranked,
          }),
        );
    }
    if (pick.type === "account") return selectionOnAccount(pick.target, selection.options);
    // A cool-down is a guess, so the turn is tried there rather than refused.
    if (pick.coolingDown !== undefined)
      return selectionOnAccount(pick.coolingDown, selection.options);
    if (!startsTurn) return selection;
    return yield* new Orchestrator.OrchestratorCommandRejectedError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `${pool.displayName} has no account available: each is out of usage or held at its reserve${
        pick.returnsAt === undefined ? "" : ` until ${londonTime(pick.returnsAt)}`
      }. Pick an account to use it anyway.`,
    });
  });

  const routeOnThread = (
    command: OrchestrationV2ServerCommand,
    selection: ModelSelection,
    threadId: ThreadId,
  ) =>
    input
      .getThreadShell(threadId)
      .pipe(Effect.flatMap((shell) => route(command, selection, shell, false)));

  const routeCommand = (
    command: OrchestrationV2ServerCommand,
    options?: RouteOptions,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorV2Error> => {
    switch (command.type) {
      case "thread.create":
        return options?.placed === true || command.agentTask !== undefined
          ? Effect.succeed(command)
          : route(command, command.modelSelection, null, false).pipe(
              Effect.map((modelSelection) => ({ ...command, modelSelection })),
            );
      // A role's delegation is placed by the resolver; a bare model follows the route.
      case "delegated_task.request":
        return command.agentTask !== undefined
          ? Effect.succeed(command)
          : route(command, command.modelSelection, null, true).pipe(
              Effect.map((modelSelection) => ({ ...command, modelSelection })),
            );
      case "message.dispatch": {
        // A failover or limit recovery already names the account the turn continues on.
        if (
          command.manualContinuationOfRunId !== undefined ||
          command.usageLimitContinuationOfRunId !== undefined
        )
          return Effect.succeed(command);
        return Effect.gen(function* () {
          const shell = yield* input.getThreadShell(command.threadId);
          // A follow-up that names no model continues the thread's, and moves with it.
          const selection = command.modelSelection ?? shell?.modelSelection;
          if (selection === undefined) return command;
          const routed = yield* route(command, selection, shell, true);
          return command.modelSelection === undefined &&
            routed.instanceId === selection.instanceId &&
            routed.model === selection.model
            ? command
            : { ...command, modelSelection: routed };
        });
      }
      case "thread.model-selection.set":
      case "provider.switch":
        return routeOnThread(command, command.modelSelection, command.threadId).pipe(
          Effect.map((modelSelection) => ({ ...command, modelSelection })),
        );
      default:
        return Effect.succeed(command);
    }
  };

  return { routeCommand };
};
