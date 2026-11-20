import {
  CommandId,
  isProviderOverloadedFailureCode,
  isReadOnlyTask,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type RunId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { failoverCommand, failoverSelection, isUsageLimitFailure } from "./AccountFailover.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

/** How long a delegated task waits before trying its model again after an upstream error. */
export const DELEGATED_RETRY_DELAY_MS = 30_000;
/** Tries after the first, before the parent hears the provider's error. */
export const DELEGATED_RETRY_ATTEMPTS = 3;

const CONTINUE_TEXT = "Continue where you left off.";
const TERMINAL_TASK: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const delegatedRecoveryEffectId = (runId: RunId) => `effect:delegated-recovery:${runId}`;

/** An overload, a rate limit with no reset, or a provider or connection error past T3's reach. */
const isUpstreamFailure = (failure: OrchestrationV2ProviderFailure) =>
  failure.class === "transport_error" ||
  (failure.class === "provider_error" &&
    (isProviderOverloadedFailureCode(failure.code) ||
      failure.code === "api_error_429" ||
      /^api_error_5\d\d$/.test(failure.code ?? "")));

/** A delegated task's failure that a recovery may continue rather than report. */
export const isDelegatedRecoverableFailure = (failure: OrchestrationV2ProviderFailure) =>
  failure.class === "usage_limit" || isUpstreamFailure(failure);

export type DelegatedRecovery =
  | { readonly type: "failover"; readonly selection: ModelSelection }
  | { readonly type: "retry" }
  | { readonly type: "deliver" };

/**
 * What a delegated task does after a failed run. A usage limit moves to the next account in the
 * user's order serving the same model, unless the task's account was named. An upstream error,
 * including a rate limit with no account to move to, on a role with no other model tries again, up to
 * `DELEGATED_RETRY_ATTEMPTS` times. Anything else reaches the parent.
 */
export const planDelegatedRecovery = Effect.fn("DelegatedTaskRecovery.plan")(function* (input: {
  readonly run: Pick<OrchestrationV2Run, "modelSelection">;
  readonly failure: OrchestrationV2ProviderFailure;
  /** Failed runs straight before this one in the thread. */
  readonly priorFailures: number;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettingsValue,
    "pooledModelKeys" | "modelAccounts" | "accountSkips" | "providerModelPreferences"
  >;
  readonly readOnly?: boolean | undefined;
  readonly nowMs: number;
  /** Whether the role has another model it could run on now. */
  readonly otherModelAvailable: () => Effect.Effect<boolean>;
}) {
  if (isUsageLimitFailure(input.failure)) {
    const selection = failoverSelection({
      selection: input.run.modelSelection,
      providers: input.providers,
      settings: input.settings,
      nowMs: input.nowMs,
      options: { readOnly: input.readOnly, enforceConservation: true },
    });
    if (selection !== undefined) return { type: "failover", selection } as const;
    // With no account left, a provider-side rate limit still gets its retries.
    if (!isUpstreamFailure(input.failure)) return { type: "deliver" } as const;
  }
  if (
    !isUpstreamFailure(input.failure) ||
    input.priorFailures >= DELEGATED_RETRY_ATTEMPTS ||
    (yield* input.otherModelAvailable())
  )
    return { type: "deliver" } as const;
  return { type: "retry" } as const;
});

const priorFailures = (runs: ReadonlyArray<OrchestrationV2Run>, run: OrchestrationV2Run) => {
  const earlier = runs
    .filter((candidate) => candidate.ordinal < run.ordinal && candidate.status !== "rolled_back")
    .toSorted((a, b) => b.ordinal - a.ordinal);
  const firstSuccess = earlier.findIndex((candidate) => candidate.status !== "failed");
  return firstSuccess < 0 ? earlier.length : firstSuccess;
};

export const delegatedRecoveryContinuation = (input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly recovery: Exclude<DelegatedRecovery, { readonly type: "deliver" }>;
}): OrchestrationV2Command => {
  // The failover shares AccountFailover's identity, so only one of them continues the task.
  if (input.recovery.type === "failover")
    return failoverCommand({
      threadId: input.threadId,
      runId: input.run.id,
      selection: input.recovery.selection,
    });
  const identity = `delegated-retry:${input.threadId}:${input.run.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: input.threadId,
    manualContinuationOfRunId: input.run.id,
    modelSelection: input.run.modelSelection,
    text: CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
};

/**
 * Runs a delegated task's recovery effect: continues the task in its own thread, or reports the
 * failure to the parent. The effect's own pending state is what keeps the parent waiting.
 */
export const makeRecoverDelegatedRun = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  return Effect.fn("DelegatedTaskRecovery.recover")(function* (
    threads: ThreadManagement.ThreadManagementService["Service"],
    settings: ServerSettings.ServerSettingsService["Service"],
    input: { readonly threadId: ThreadId; readonly sourceRunId: RunId },
  ) {
    const records = yield* threads.getThreadRecords(input.threadId, ["runs", "turnItems"], {
      turnItemTypes: ["error"],
      turnItemRunIds: [input.sourceRunId],
    });
    const run = records.runs.find((candidate) => candidate.id === input.sourceRunId);
    const failure = run === undefined ? null : latestRootProviderFailure(run, records.turnItems);
    const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    // Something else already continued the thread, such as the sweep or the user.
    if (run === undefined || failure === null || latest?.id !== run.id) return;
    // A task its parent already ended, such as by cancelling it, is not continued.
    const parentThreadId = records.thread.lineage.parentThreadId;
    const taskOpen = Effect.gen(function* () {
      if (parentThreadId === null) return true;
      const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      return subagents.some(
        (task) => task.childThreadId === input.threadId && !TERMINAL_TASK.has(task.status),
      );
    });
    if (!(yield* taskOpen)) return;
    const binding = records.thread.agentTask;
    const plan = Effect.gen(function* () {
      const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
      const currentSettings = yield* settings.getSettings;
      return yield* planDelegatedRecovery({
        run,
        failure,
        priorFailures: priorFailures(records.runs, run),
        providers,
        settings: currentSettings,
        readOnly: isReadOnlyTask(binding),
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        otherModelAvailable: () =>
          Option.isNone(managed) || binding === undefined
            ? Effect.succeed(false)
            : managed.value
                .otherModels({
                  binding,
                  providers,
                  runtimeMode: records.thread.runtimeMode,
                  model: run.modelSelection.model,
                })
                .pipe(Effect.map((models) => models.length > 0)),
      });
    });
    let recovery = yield* plan;
    if (recovery.type === "retry") {
      yield* Effect.sleep(Duration.millis(DELEGATED_RETRY_DELAY_MS));
      // The parent may have cancelled meanwhile, and the usage read the error prompted may
      // since have shown the account out.
      if (!(yield* taskOpen)) return;
      recovery = yield* plan;
    }
    if (recovery.type === "deliver") {
      yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
      return;
    }
    yield* threads.dispatch(
      delegatedRecoveryContinuation({ threadId: input.threadId, run, recovery }),
    );
  });
});
