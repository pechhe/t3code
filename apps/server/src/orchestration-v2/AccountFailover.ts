import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import {
  nextAccount,
  nextLocalMidnightMs,
  pooledKeyIn,
  pooledModelOf,
  pooledModels,
  selectionAccountId,
  selectionOnAccount,
  skipAfterLimit,
  skipPatch,
  type PickOptions,
} from "@t3tools/shared/accountPools";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

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

/**
 * Where a run that failed with a usage limit continues: the next account in its model's order
 * that is not skipped. A pinned account, or none left, leaves it waiting.
 */
export const failoverSelection = (input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettingsValue,
    "pooledModelKeys" | "modelAccounts" | "modelLinks" | "accountSkips" | "providerModelPreferences"
  >;
  readonly nowMs: number;
  readonly options?: PickOptions | undefined;
}): ModelSelection | undefined => {
  if (input.selection.pinned === true) return undefined;
  const pool = pooledModelOf(pooledModels(input.providers, input.settings), input.selection);
  if (pool === undefined) return undefined;
  const next = nextAccount(
    pool,
    selectionAccountId(input.providers, input.selection),
    input.settings.accountSkips,
    input.nowMs,
    input.options,
  );
  return next === undefined ? undefined : selectionOnAccount(next, input.selection.options);
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

/**
 * Skips an account for a model when a run on it fails with a usage limit, and continues that
 * thread on the next account in the order. Delegated tasks continue through their own recovery
 * effect, which holds the parent's delivery while they do.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    if (Option.isNone(registry)) return;
    // Two failures at once must not each write the skips they read.
    const skipWrites = yield* Semaphore.make(1);

    const recordSkip = Effect.fn("AccountFailover.recordSkip")(function* (input: {
      readonly run: OrchestrationV2Run;
      readonly failure: OrchestrationV2ProviderFailure;
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly nowMs: number;
    }) {
      const { run, providers, nowMs } = input;
      const provider = providers.find(
        (candidate) => candidate.instanceId === run.modelSelection.instanceId,
      );
      const model = provider?.models.find(
        (candidate) => candidate.slug === run.modelSelection.model,
      );
      const initial = yield* settings.getSettings;
      const key =
        provider === undefined || model === undefined
          ? undefined
          : pooledKeyIn(initial, provider, model);
      if (key === undefined || !initial.pooledModelKeys?.includes(key)) return initial;
      const account = selectionAccountId(providers, run.modelSelection);
      const skip = skipAfterLimit({
        failureResetAt: input.failure.resetAt,
        provider,
        model: run.modelSelection.model,
        nowMs,
        midnightMs: nextLocalMidnightMs(nowMs),
      });
      return yield* skipWrites.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* settings.getSettings;
          return yield* settings.updateSettings({
            accountSkips: {
              [account]: skipPatch(current.accountSkips, account, key, skip, nowMs),
            },
          });
        }),
      );
    });

    const onFailedRun = Effect.fn("AccountFailover.onFailedRun")(function* (
      run: OrchestrationV2Run,
    ) {
      const records = yield* threads.getThreadRecords(run.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [run.id],
      });
      const failure = latestRootProviderFailure(run, records.turnItems);
      if (failure === null || !isUsageLimitFailure(failure)) return;
      const providers = yield* registry.value.getProviders;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const current = yield* recordSkip({ run, failure, providers, nowMs });
      const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (records.thread.agentTask !== undefined || latest?.id !== run.id) return;
      const selection = failoverSelection({
        selection: run.modelSelection,
        providers,
        settings: current,
        nowMs,
      });
      if (selection === undefined) return;
      yield* threads.dispatch(
        failoverCommand({ threadId: run.threadId, runId: run.id, selection }),
      );
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type !== "run.updated" || event.payload.status !== "failed"
          ? Effect.void
          : onFailedRun(event.payload).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.account-failover.failed", {
                  threadId: event.payload.threadId,
                  runId: event.payload.id,
                  cause,
                }),
              ),
            ),
      ),
    );
  }),
);
