import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { pickPoolFailoverMember } from "@t3tools/shared/providerPools";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const CONTINUE_TEXT = "Continue where you left off.";

/** A usage-limit stop with its window still closed that nothing else already handles. */
function isLimitBlocked(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
): thread is ProjectionStore.ProjectionLimitRecoveryCandidate & {
  readonly latestRunId: RunId;
  readonly usageLimitResetAt: string;
} {
  return (
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit" &&
    !!thread.latestRunId &&
    !!thread.usageLimitResetAt &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.pendingRuntimeRequest === null
  );
}

/**
 * Continues a limited thread on the next account of the pool it runs on, with
 * the same model, instead of waiting for the reset. The failed run is the
 * identity: once the continuation starts it is no longer the latest run.
 */
export function poolFailoverCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): OrchestrationV2Command | null {
  if (!isLimitBlocked(thread) || Date.parse(thread.usageLimitResetAt) <= nowMs) return null;
  const limited = thread.modelSelection.instanceId;
  for (const pool of providers) {
    if (pool.poolMembers?.includes(limited) !== true) continue;
    const member = pickPoolFailoverMember({
      pool: {
        driver: pool.driver,
        members: pool.poolMembers,
        preferredMember: pool.poolPreferredMember,
      },
      providers,
      nowMs,
      limited,
    });
    if (member === undefined) continue;
    const identity = `limit-pool-switch:${thread.id}:${thread.latestRunId}`;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(identity),
      messageId: MessageId.make(identity),
      threadId: thread.id,
      manualContinuationOfRunId: thread.latestRunId,
      modelSelection: { ...thread.modelSelection, instanceId: member },
      text: CONTINUE_TEXT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
  }
  return null;
}

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (!isLimitBlocked(thread)) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * The command that moves a limited thread on, skipping any the server has
 * already rejected: a rejection is recorded for good, so retrying it only
 * repeats the failure and, for a pool switch, hides the plain recovery below.
 */
export function nextRecoveryCommand(input: {
  readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly nowMs: number;
  readonly autoResume: boolean;
  readonly snooze: boolean;
  readonly rejected: ReadonlySet<string>;
}): OrchestrationV2Command | null {
  const poolSwitch =
    input.providers === null
      ? null
      : poolFailoverCommand(input.thread, input.providers, input.nowMs);
  const command =
    poolSwitch !== null && !input.rejected.has(poolSwitch.commandId)
      ? poolSwitch
      : limitRecoveryCommand(input.thread, input.autoResume, input.nowMs, input.snooze);
  return command !== null && !input.rejected.has(command.commandId) ? command : null;
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Optional like ThreadManagementService: without the registry there are no pools.
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  // Rejected command ids, kept for the process: the server remembers them, so a
  // restart costs one more attempt each.
  const rejected = yield* Ref.make<ReadonlySet<string>>(new Set());
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const poolSwitch = preferences.switchPooledAccountOnLimit && Option.isSome(providerRegistry);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      poolSwitch,
    });
    if (candidates.length === 0) return;
    const providers =
      poolSwitch && Option.isSome(providerRegistry)
        ? yield* providerRegistry.value.getProviders
        : null;
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const command = nextRecoveryCommand({
        thread,
        providers,
        nowMs,
        autoResume: preferences.autoResumeLimitedThreads,
        snooze: preferences.snoozeLimitedThreads,
        rejected: yield* Ref.get(rejected),
      });
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: (error) =>
            Ref.update(rejected, (ids) => new Set(ids).add(command.commandId)).pipe(
              Effect.andThen(
                Effect.logWarning("orchestration-v2.limit-recovery.command-rejected", {
                  threadId: thread.id,
                  commandId: command.commandId,
                  detail: error.detail,
                }),
              ),
            ),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
