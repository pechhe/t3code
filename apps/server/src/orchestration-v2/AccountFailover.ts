import {
  CommandId,
  isProviderOverloadedFailureCode,
  MessageId,
  type AccountBlockReason,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  accountIdOf,
  blockClearedByReading,
  governingUsageWindows,
  pickAccount,
  pooledKeyIn,
  pooledModelOf,
  pooledModels,
  selectionAccountId,
  selectionOnAccount,
  type AccountRoutingSettings,
  type RouteOptions,
  type RoutingContext,
} from "@t3tools/shared/accountPools";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AccountAvailability from "../provider/AccountAvailability.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const CONTINUE_TEXT = "Continue where you left off.";

/** A failure the provider reported as running out of allowance, in its own words or T3's class. */
export const isUsageLimitFailure = (
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message">,
) =>
  failure.class === "usage_limit" ||
  /\b(?:insufficient\s+credits?|not enough credits?|rate limit|credit limit|usage limit|quota[- ]limit(?:ed)?)\b/iu.test(
    failure.message,
  );

/** What a failure says about its account, or nothing when it says nothing about the account. */
export const accountFailureReason = (
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message" | "code">,
): AccountBlockReason | undefined => {
  if (isUsageLimitFailure(failure)) return "usage-limit";
  if (failure.code === "api_error_429") return "rate-limit";
  if (isProviderOverloadedFailureCode(failure.code)) return "overload";
  return undefined;
};

/**
 * Where a run that failed with a usage limit continues: the best account still available for its
 * model, other than the failed one. A pinned account, or none left, leaves it waiting.
 */
export const failoverSelection = (input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: AccountRoutingSettings;
  readonly context: RoutingContext;
  readonly options?: RouteOptions | undefined;
}): ModelSelection | undefined => {
  if (input.selection.pinned === true) return undefined;
  const pool = pooledModelOf(pooledModels(input.providers, input.settings), input.selection);
  if (pool === undefined) return undefined;
  const pick = pickAccount(pool, input.context, {
    ...input.options,
    exclude: selectionAccountId(input.providers, input.selection),
  });
  return pick.type === "account"
    ? selectionOnAccount(pick.target, input.selection.options)
    : undefined;
};

/** Continues the failed run's turn on another account; one command per failed run. */
export const failoverCommand = (input: {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly selection: ModelSelection;
}): OrchestrationV2Command => {
  const identity = `limit-pool-switch:${input.threadId}:${input.runId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: input.threadId,
    manualContinuationOfRunId: input.runId,
    modelSelection: input.selection,
    text: CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
};

/** The account and routed model a run used, read from the providers serving it. */
const runAccount = (
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<AccountRoutingSettings, "modelLinks">,
  selection: Pick<ModelSelection, "instanceId" | "model">,
) => {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  const key =
    provider === undefined || model === undefined
      ? undefined
      : pooledKeyIn(settings, provider, model);
  return provider === undefined || key === undefined
    ? undefined
    : { provider, key, account: accountIdOf(provider, selection.model) };
};

/** An error turn item the provider is retrying or ended on, which says something about its account. */
const failureSignal = (event: OrchestrationV2DomainEvent) => {
  if (
    event.type !== "turn-item.updated" ||
    event.payload.type !== "error" ||
    // A recovered retry keeps the failure it recovered from; it is no new signal.
    event.payload.status === "completed" ||
    event.payload.runId === null
  )
    return undefined;
  const reason = accountFailureReason(event.payload.failure);
  return reason === undefined
    ? undefined
    : {
        threadId: event.payload.threadId,
        runId: event.payload.runId,
        failure: event.payload.failure,
        reason,
      };
};

/**
 * Keeps the server's memory of each account's failures for each model, and moves an interactive
 * thread whose run hit a usage limit to the next available account. A retry in progress and the
 * run's final failure are one attempt; a completed turn ends the account's block. Delegated tasks
 * continue through their own recovery effect, which holds the parent's delivery while they do.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const availability = yield* AccountAvailability.AccountAvailability;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    if (Option.isNone(registry)) return;
    const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
    // Read on the event stream, so it never waits on a usage-history scan.
    const currentProviders = registry.value.getProviders.pipe(
      Effect.provideService(ProviderRegistry.ProviderUsageWithoutScan, true),
    );

    const record = Effect.fn("AccountFailover.record")(function* (input: {
      readonly run: OrchestrationV2Run;
      readonly failure: OrchestrationV2ProviderFailure;
      readonly reason: AccountBlockReason;
    }) {
      const providers = yield* currentProviders;
      const current = yield* settings.getSettings;
      const used = runAccount(providers, current, input.run.modelSelection);
      if (used === undefined) return;
      const previous = (yield* availability.state).blocks.find(
        (block) => block.account === used.account && block.model === used.key,
      );
      const entry = pooledModelOf(
        pooledModels(providers, current),
        input.run.modelSelection,
      )?.accounts.find((candidate) => candidate.account.id === used.account);
      yield* availability.recordFailure({
        account: used.account,
        model: used.key,
        reason: input.reason,
        resetAt: input.failure.resetAt,
        attemptId: input.run.id,
        windowIds: governingUsageWindows(used.provider, input.run.modelSelection.model).flatMap(
          (window) => (window.id === "budget" ? [] : [window.id]),
        ),
        recovered:
          previous !== undefined &&
          blockClearedByReading(previous, {
            provider: used.provider,
            model: input.run.modelSelection.model,
            reserve: entry?.reserve,
          }),
      });
      if (input.reason === "usage-limit") {
        // A fresh reading for the bars and the evaluator; detached so a slow read never holds
        // the event stream.
        yield* registry.value
          .refreshInstanceUsage(input.run.modelSelection.instanceId)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }
    });

    const onFailureSignal = Effect.fn("AccountFailover.onFailureSignal")(function* (
      signal: NonNullable<ReturnType<typeof failureSignal>>,
    ) {
      const records = yield* threads.getThreadRecords(signal.threadId, ["runs"]);
      const run = records.runs.find((candidate) => candidate.id === signal.runId);
      if (run === undefined) return;
      yield* record({ run, failure: signal.failure, reason: signal.reason });
    });

    const onFailedRun = Effect.fn("AccountFailover.onFailedRun")(function* (
      run: OrchestrationV2Run,
    ) {
      const records = yield* threads.getThreadRecords(run.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [run.id],
      });
      const failure = latestRootProviderFailure(run, records.turnItems);
      const reason = failure === null ? undefined : accountFailureReason(failure);
      if (failure === null || reason === undefined) return;
      yield* record({ run, failure, reason });
      const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (
        reason !== "usage-limit" ||
        records.thread.agentTask !== undefined ||
        latest?.id !== run.id
      )
        return;
      const selection = failoverSelection({
        selection: run.modelSelection,
        providers: yield* currentProviders,
        settings: yield* settings.getSettings,
        context: { blocks: (yield* availability.state).blocks, nowMs: yield* nowMs },
      });
      if (selection === undefined) return;
      yield* threads.dispatch(
        failoverCommand({ threadId: run.threadId, runId: run.id, selection }),
      );
    });

    const onCompletedRun = Effect.fn("AccountFailover.onCompletedRun")(function* (
      run: OrchestrationV2Run,
    ) {
      // Most turns end with nothing blocked, and then there is nothing to read.
      if (!(yield* availability.remembersFailures)) return;
      const used = runAccount(
        yield* currentProviders,
        yield* settings.getSettings,
        run.modelSelection,
      );
      if (used !== undefined)
        yield* availability.recordSuccess({ account: used.account, model: used.key });
    });

    const logged = <E>(threadId: ThreadId, effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.account-failover.failed", { threadId, cause }),
        ),
      );

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "run.updated") {
          const run = event.payload;
          if (run.status === "failed") return logged(run.threadId, onFailedRun(run));
          if (run.status === "completed") return logged(run.threadId, onCompletedRun(run));
          return Effect.void;
        }
        const signal = failureSignal(event);
        return signal === undefined
          ? Effect.void
          : logged(signal.threadId, onFailureSignal(signal));
      }),
    );
  }),
);
