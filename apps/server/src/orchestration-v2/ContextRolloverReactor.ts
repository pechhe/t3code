import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RunAttemptId,
  type ProviderThreadId,
  type TurnItemId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ExperimentService from "../experiments/ExperimentService.ts";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  boundRolloverThresholds,
  ROLLOVER_MIN_GROWTH_TOKENS,
  ROLLOVER_NUDGE_COMMAND_PREFIX,
  rolloverHardNudge,
  rolloverNudgeSummary,
  rolloverHeld,
  rolloverSoftNudge,
  rolloverUsageAction,
  assignedRolloverThresholds,
  type RolloverPhase,
} from "./ContextRollover.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

interface ThreadRollover {
  phase: RolloverPhase;
  providerThreadId: ProviderThreadId | null;
  recovery?: { usedTokens: number; observationId: string };
  /** The last context size the provider reported. */
  used: number;
  /** Last known context window for this provider session; omitted reports do not erase it. */
  maxTokens: number | null;
  /** Provider report time, used to reject delayed reports without masking compaction. */
  usageUpdatedAt: number | null;
  /**
   * The context after the last native compaction ("pending" until the next usage
   * report), or null when it has not compacted. Nudges wait until the conversation
   * grows past it, so a threshold below a compacted context's size cannot nudge
   * again and again.
   */
  floor: number | "pending" | null;
  /** The warning that a threshold sits below this floor was logged. */
  floorWarned: boolean;
  /** The run attempt whose nudge was last weighed, so a turn's start is weighed once. */
  attemptId: RunAttemptId | null;
}

const floorOf = (state: ThreadRollover) => (typeof state.floor === "number" ? state.floor : null);
const encodeEnrollmentPolicy = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type RolloverEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-turn.updated" | "run.updated" | "turn-item.updated" }
>;

/**
 * Times a thread's native compaction. Past the soft threshold the running agent is
 * asked to reach a natural break and record what would otherwise be lost; past the
 * hard threshold, to finish the step in hand. The provider compacts the conversation
 * itself at its configured window: nothing here ends a run or starts another.
 */
export class ContextRolloverReactor extends Context.Service<
  ContextRolloverReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ContextRolloverReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const experiments = yield* ExperimentService.ExperimentService;

  const threads = new Map<ThreadId, ThreadRollover>();
  const compactions = new Map<ThreadId, Set<TurnItemId>>();
  const activeRuns = new Map<ThreadId, { attemptId: RunAttemptId; run: OrchestrationV2Run }>();
  const enrollmentPolicies = new Map<ThreadId, string>();

  const runForAttempt = Effect.fn("ContextRolloverReactor.runForAttempt")(function* (
    threadId: ThreadId,
    attemptId: RunAttemptId,
  ) {
    const cached = activeRuns.get(threadId);
    if (cached?.attemptId === attemptId) return cached.run;
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const run = runs.find((candidate) => candidate.activeAttemptId === attemptId);
    // A miss is not cached: no run.updated follows to clear it if the run lands later.
    if (run !== undefined) activeRuns.set(threadId, { attemptId, run });
    return run;
  });

  const thresholdsFor = Effect.fn("ContextRolloverReactor.thresholdsFor")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const settings = yield* settingsService.getSettings;
    const thread = yield* projections.getThread(threadId);
    if (rolloverHeld(thread.rolloverHold, yield* Clock.currentTimeMillis)) return null;
    // A thread's own thresholds take it out of the rollover experiment.
    if (thread.rolloverThresholds != null) {
      const own = assignedRolloverThresholds(
        settings.contextRollover,
        thread,
        run.modelSelection.model,
        undefined,
      );
      return own === null ? null : { thresholds: own, assignment: undefined };
    }
    if (
      assignedRolloverThresholds(settings.contextRollover, thread, run.modelSelection.model, {
        softLimit: settings.contextRollover.softThreshold,
        hardLimit: settings.contextRollover.hardThreshold,
      }) === null
    )
      return null;
    // Definitions and settings are cheap reads. Only enrollment needs a writer
    // transaction; retry it when its inputs change, not on every usage report.
    const policyKey = encodeEnrollmentPolicy([
      settings.contextRollover,
      thread.projectId,
      thread.createdAt,
      thread.rolloverThresholds,
      thread.rolloverHold,
      thread.lineage,
      thread.creationSource,
      run.activeAttemptId,
      run.modelSelection,
      // Every experiment change goes through a transition that bumps updatedAt,
      // so these fields stand in for definitions that would be retained per thread.
      (yield* experiments.list()).map(({ id, status, startedAt, updatedAt }) => [
        id,
        status,
        startedAt,
        updatedAt,
      ]),
    ]);
    if (enrollmentPolicies.get(threadId) !== policyKey) {
      yield* experiments.assignForThread({
        threadLever: "rollover",
        threadId,
        projectId: thread.projectId,
        modelSelection: run.modelSelection,
        enrollment: "new",
        unitCreatedAt: DateTime.formatIso(thread.createdAt),
      });
      enrollmentPolicies.set(threadId, policyKey);
    }
    const assignment = (yield* experiments.getRolloverAssignment(threadId)) ?? undefined;
    const thresholds = assignedRolloverThresholds(
      settings.contextRollover,
      thread,
      run.modelSelection.model,
      assignment?.variant.rollover,
    );
    return thresholds === null ? null : { thresholds, assignment };
  });

  const message = Effect.fn("ContextRolloverReactor.message")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    text: string,
    summary: string,
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${ROLLOVER_NUDGE_COMMAND_PREFIX}${threadId}:${uuid}`),
      threadId,
      messageId: MessageId.make(`message:context-rollover-nudge:${uuid}`),
      text,
      // Shown as a work log row, not a user message; the request is its detail.
      notification: { source: { kind: "system" }, outcome: "updated", summary, detail: text },
      attachments: [],
      modelSelection: run.modelSelection,
      dispatchMode: { type: "steer_active", targetRunId: run.id },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const onUsage = Effect.fn("ContextRolloverReactor.onUsage")(function* (
    event: Extract<RolloverEvent, { readonly type: "provider-turn.updated" }>,
  ) {
    const turn = event.payload;
    const used = turn.tokenUsage?.usedTokens;
    // Native subagent turns report no run attempt; they are not the thread's own context.
    if (used === undefined || turn.runAttemptId === null) return;
    if (turn.status !== "running") return;
    // Resolve the active attempt before touching session state: late reports from
    // a previous run must not reset a fresh session's growth floor or nudge phase.
    const run = yield* runForAttempt(event.threadId, turn.runAttemptId);
    if (run === undefined || (run.status !== "running" && run.status !== "waiting")) return;
    let previousState = threads.get(event.threadId);
    // A provider switch is a different conversation, not a native context drop.
    if (previousState?.providerThreadId !== turn.providerThreadId) {
      previousState = undefined;
      compactions.delete(event.threadId);
    }
    const state: ThreadRollover = previousState ?? {
      providerThreadId: turn.providerThreadId,
      phase: "idle",
      used,
      maxTokens: null,
      usageUpdatedAt: null,
      floor: null,
      floorWarned: false,
      attemptId: null,
    };
    const reportedAt = Date.parse(turn.tokenUsage!.updatedAt);
    if (Number.isFinite(reportedAt)) {
      if (state.usageUpdatedAt !== null && reportedAt < state.usageUpdatedAt) return;
      state.usageUpdatedAt = reportedAt;
    }
    const previousUsed = previousState?.used;
    state.providerThreadId = turn.providerThreadId;
    state.used = used;
    const maxTokens = turn.tokenUsage?.maxTokens;
    if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
      state.maxTokens = maxTokens;
    }
    const assignment = yield* experiments.getRolloverAssignment(event.threadId);
    if (assignment !== null && previousUsed !== undefined && used < previousUsed) {
      const id = `rollover:${assignment.id}:${run.id}:context-drop:${turn.id}:${turn.tokenUsage!.updatedAt}`;
      yield* experiments.recordObservation({
        id,
        assignmentId: assignment.id,
        runId: run.id,
        kind: "context-drop",
        usedTokens: used,
        maxTokens: state.maxTokens,
        recoveredTokens: previousUsed - used,
        evidence: [`provider-turn:${turn.id}`, `previous-context-tokens:${previousUsed}`],
      });
      state.recovery = { usedTokens: used, observationId: id };
    } else if (
      assignment !== null &&
      state.recovery !== undefined &&
      used > state.recovery.usedTokens
    ) {
      const recovery = state.recovery;
      yield* experiments.recordObservation({
        id: `rollover:${assignment.id}:${run.id}:context-growth:${turn.id}:${turn.tokenUsage!.updatedAt}`,
        assignmentId: assignment.id,
        runId: run.id,
        kind: "context-growth",
        usedTokens: used,
        maxTokens: state.maxTokens,
        growthTokens: used - recovery.usedTokens,
        evidence: [`provider-turn:${turn.id}`, `after-observation:${recovery.observationId}`],
      });
      delete state.recovery;
    }
    if (state.floor === "pending" || (state.floor !== null && used < state.floor)) {
      state.floor = used;
    }
    state.attemptId = turn.runAttemptId;
    threads.set(event.threadId, state);
    yield* nudgeIfDue(event.threadId, run, turn, state, turn.tokenUsage!.updatedAt);
  });

  /**
   * A turn starting on a session already past a threshold is weighed against the
   * session's last reported context, so a request the previous turn ended without
   * answering reaches this turn before its first model response.
   */
  const onTurnStart = Effect.fn("ContextRolloverReactor.onTurnStart")(function* (
    event: Extract<RolloverEvent, { readonly type: "provider-turn.updated" }>,
  ) {
    const turn = event.payload;
    const state = threads.get(event.threadId);
    if (
      turn.status !== "running" ||
      turn.runAttemptId === null ||
      state === undefined ||
      state.phase !== "idle" ||
      state.floor === "pending" ||
      state.providerThreadId !== turn.providerThreadId ||
      state.attemptId === turn.runAttemptId
    )
      return;
    state.attemptId = turn.runAttemptId;
    const run = yield* runForAttempt(event.threadId, turn.runAttemptId);
    if (run === undefined || (run.status !== "running" && run.status !== "waiting")) return;
    yield* nudgeIfDue(event.threadId, run, turn, state, "turn-start");
  });

  const nudgeIfDue = Effect.fn("ContextRolloverReactor.nudgeIfDue")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    turn: Extract<RolloverEvent, { readonly type: "provider-turn.updated" }>["payload"],
    state: ThreadRollover,
    reportKey: string,
  ) {
    const used = state.used;
    const configured = yield* thresholdsFor(threadId, run);
    if (configured === null) return;
    const thresholds = boundRolloverThresholds(configured.thresholds, state.maxTokens);
    if (used < thresholds.soft) {
      state.phase = "idle";
      return;
    }
    const floor = floorOf(state);
    if (floor !== null && floor >= thresholds.soft && !state.floorWarned) {
      state.floorWarned = true;
      yield* Effect.logWarning(
        "context threshold is below a compacted context's size; waiting for growth",
        {
          threadId,
          model: run.modelSelection.model,
          compactedTokens: floor,
          softThreshold: thresholds.soft,
          nextNudgeAtTokens: floor + ROLLOVER_MIN_GROWTH_TOKENS,
        },
      );
    }
    const action = rolloverUsageAction(state.phase, used, thresholds, floor);
    if (action === "none") return;
    yield* message(
      threadId,
      run,
      action === "hard" ? rolloverHardNudge(used) : rolloverSoftNudge(used),
      rolloverNudgeSummary(action, used),
    );
    state.phase = action === "hard" ? "hardNudged" : "softNudged";
    if (configured.assignment !== undefined) {
      yield* experiments.recordObservation({
        id: `rollover:${configured.assignment.id}:${run.id}:${action}:${turn.id}:${reportKey}`,
        assignmentId: configured.assignment.id,
        runId: run.id,
        kind: action,
        episodeId: `rollover:${configured.assignment.id}:${run.id}`,
        configuredPolicy: {
          softLimit: configured.thresholds.soft,
          hardLimit: configured.thresholds.hard,
        },
        effectivePolicy: { softLimit: thresholds.soft, hardLimit: thresholds.hard },
        usedTokens: used,
        maxTokens: state.maxTokens,
        evidence: [`provider-turn:${turn.id}`],
      });
    }
  });

  const onRunEnd = (threadId: ThreadId) =>
    Effect.sync(() => {
      // A run that ends leaves a nudge unanswered or moot: the next turn past a threshold is asked again.
      const state = threads.get(threadId);
      if (state !== undefined) state.phase = "idle";
    });

  const onCompaction = Effect.fn("ContextRolloverReactor.onCompaction")(function* (
    event: Extract<RolloverEvent, { readonly type: "turn-item.updated" }>,
  ) {
    const item = event.payload;
    if (
      item.type !== "compaction" ||
      item.status !== "completed" ||
      item.runId === null ||
      item.providerTurnId === null
    )
      return;
    if (compactions.get(event.threadId)?.has(item.id)) return;
    const { runs, providerTurns } = yield* projections.getThreadRecords(event.threadId, [
      "runs",
      "providerTurns",
    ]);
    const run = runs.find((candidate) => candidate.id === item.runId);
    const turn = providerTurns.find((candidate) => candidate.id === item.providerTurnId);
    // A late item from a superseded attempt is historical evidence, not this session's compaction.
    if (
      run === undefined ||
      turn === undefined ||
      run.activeAttemptId !== turn.runAttemptId ||
      turn.runAttemptId === null
    )
      return;
    if (runs.some((candidate) => candidate.ordinal > run.ordinal && candidate.status !== "queued"))
      return;
    const assignment = yield* experiments.getRolloverAssignment(event.threadId);
    const state = threads.get(event.threadId);
    const id = `rollover:${assignment?.id}:${run.id}:native-compaction:${item.id}`;
    if (assignment !== null) {
      yield* experiments.recordObservation({
        id,
        assignmentId: assignment.id,
        runId: run.id,
        kind: "native-compaction",
        usedTokens: item.afterTokenCount ?? null,
        // The item reports no context maximum. Keep the persisted payload stable
        // across replay; a later usage report is not part of this native event.
        maxTokens: null,
        ...(item.beforeTokenCount === undefined || item.afterTokenCount === undefined
          ? {}
          : {
              recoveredTokens: Math.max(0, item.beforeTokenCount - item.afterTokenCount),
            }),
        evidence: [`turn-item:${item.id}`, `provider-turn:${item.providerTurnId}`],
      });
    }
    const seen = compactions.get(event.threadId) ?? new Set<TurnItemId>();
    seen.add(item.id);
    if (seen.size > 256) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    compactions.set(event.threadId, seen);
    if (
      state !== undefined &&
      state.providerThreadId === item.providerThreadId &&
      (state.usageUpdatedAt === null ||
        DateTime.toEpochMillis(item.updatedAt) >= state.usageUpdatedAt)
    ) {
      state.phase = "idle";
      state.floor = item.afterTokenCount ?? "pending";
      if (item.afterTokenCount !== undefined) {
        state.recovery = { usedTokens: item.afterTokenCount, observationId: id };
      }
    }
  });

  const handle = (event: RolloverEvent) => {
    if (event.type === "provider-turn.updated") {
      return event.payload.tokenUsage === undefined ? onTurnStart(event) : onUsage(event);
    }
    if (event.type === "turn-item.updated") return onCompaction(event);
    activeRuns.delete(event.threadId);
    if (isTerminalRunStatus(event.payload.status)) return onRunEnd(event.threadId);
    return event.payload.status === "running" || event.payload.status === "waiting"
      ? thresholdsFor(event.threadId, event.payload).pipe(Effect.asVoid)
      : Effect.void;
  };

  const worker = yield* makeDrainableWorker((event: RolloverEvent) =>
    handle(event).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("context rollover step skipped", {
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const start: ContextRolloverReactor["Service"]["start"] = Effect.fn(
    "ContextRolloverReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "provider-turn.updated":
            return event.payload.tokenUsage === undefined && event.payload.status !== "running"
              ? Effect.void
              : worker.enqueue(event);
          case "run.updated":
            return worker.enqueue(event);
          case "turn-item.updated":
            return event.payload.type === "compaction" && event.payload.status === "completed"
              ? worker.enqueue(event)
              : Effect.void;
          case "thread.rollover-hold-set":
          case "thread.rollover-thresholds-set":
            // A hold or moved thresholds forget a soft nudge not yet answered; it starts over.
            return Effect.sync(() => {
              enrollmentPolicies.delete(event.threadId);
              const state = threads.get(event.threadId);
              if (state === undefined) return;
              state.phase = "idle";
            });
          case "thread.archived":
          case "thread.deleted":
            return Effect.sync(() => {
              threads.delete(event.threadId);
              activeRuns.delete(event.threadId);
              enrollmentPolicies.delete(event.threadId);
              compactions.delete(event.threadId);
            });
          default:
            return Effect.void;
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("context rollover event stream failed", {
              cause: Cause.pretty(cause),
            }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ContextRolloverReactor["Service"];
});

export const layer = Layer.effect(ContextRolloverReactor, make);
