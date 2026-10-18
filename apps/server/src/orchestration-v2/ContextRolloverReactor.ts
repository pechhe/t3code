import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type RunAttemptId,
  type ProviderThreadId,
  type TurnItemId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { pickRolloverMember } from "@t3tools/shared/providerPools";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ContextRolloverNotes,
  boundRolloverThresholds,
  ROLLOVER_MIN_GROWTH_TOKENS,
  ROLLOVER_RESUME_TEXT,
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
   * The context the session began with after a rollover ("pending" until its
   * first usage report), or null when it did not begin with one. Nudges wait
   * until the session grows past it, so a threshold below a fresh session's size
   * cannot roll over again and again.
   */
  floor: number | "pending" | null;
  /** The warning that a threshold sits below this floor was logged. */
  floorWarned: boolean;
  /** The run attempt whose nudge was last weighed, so a turn's start is weighed once. */
  attemptId: RunAttemptId | null;
  rollover?: { assignmentId: string; fromRunId: RunId; usedTokens: number; startedAt: number };
}

const floorOf = (state: ThreadRollover) => (typeof state.floor === "number" ? state.floor : null);
const encodeEnrollmentPolicy = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type RolloverEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-turn.updated" | "run.updated" | "turn-item.updated" }
>;

/**
 * Hands a thread to a fresh provider session before its context fills up. Past
 * the soft threshold the running agent is asked to write a handoff note at its
 * next natural break; past the hard threshold it is asked to write it now. When
 * the run that wrote the note completes, the thread continues on a fresh native
 * session seeded with the note.
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
  const notes = yield* ContextRolloverNotes;
  const crypto = yield* Crypto.Crypto;
  const experiments = yield* ExperimentService.ExperimentService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);

  // A rolled-over session starts fresh, so a pooled thread may move to the
  // pool's preferred member without paying for a second handoff.
  const rolloverModelSelection = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (Option.isNone(providerRegistry)) return run.modelSelection;
      const providers = yield* providerRegistry.value.getProviders;
      const instanceId = pickRolloverMember({
        providers,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        member: run.modelSelection.instanceId,
      });
      return { ...run.modelSelection, instanceId };
    });

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
    mode: "steer" | "start",
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:context-rollover-nudge:${threadId}:${uuid}`),
      threadId,
      messageId: MessageId.make(`message:context-rollover-nudge:${uuid}`),
      text,
      // Shown as a work log row, not a user message; the request is its detail.
      notification: { source: { kind: "system" }, outcome: "updated", summary, detail: text },
      attachments: [],
      modelSelection: run.modelSelection,
      dispatchMode:
        mode === "steer"
          ? { type: "steer_active", targetRunId: run.id }
          : { type: "start_immediately" },
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
    if (
      previousState?.floor !== "pending" &&
      previousState?.providerThreadId !== turn.providerThreadId
    ) {
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
    const freshSession = state.floor === "pending";
    state.providerThreadId = turn.providerThreadId;
    state.used = used;
    const maxTokens = turn.tokenUsage?.maxTokens;
    if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
      state.maxTokens = maxTokens;
    }
    if (state.floor === "pending" && state.rollover !== undefined) {
      const previous = state.rollover;
      yield* experiments.recordObservation({
        id: `rollover:${previous.assignmentId}:${run.id}:fresh-context`,
        assignmentId: previous.assignmentId,
        runId: run.id,
        kind: "fresh-context",
        episodeId: `rollover:${previous.assignmentId}:${previous.fromRunId}`,
        usedTokens: used,
        maxTokens: state.maxTokens,
        recoveredTokens: Math.max(0, previous.usedTokens - used),
        delayMs: Math.max(0, (yield* Clock.currentTimeMillis) - previous.startedAt),
        lowYield: previous.usedTokens - used < ROLLOVER_MIN_GROWTH_TOKENS,
        evidence: [`rollover-of-run:${previous.fromRunId}`, `provider-turn:${turn.id}`],
      });
      state.recovery = {
        usedTokens: used,
        observationId: `rollover:${previous.assignmentId}:${run.id}:fresh-context`,
      };
      delete state.rollover;
    }
    const assignment = yield* experiments.getRolloverAssignment(event.threadId);
    if (assignment !== null && previousUsed !== undefined && !freshSession && used < previousUsed) {
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
    if (notes.get(threadId) !== undefined) return;
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
        "context rollover threshold is below a fresh session's size; waiting for growth",
        {
          threadId,
          model: run.modelSelection.model,
          freshSessionTokens: floor,
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
      action === "hard" ? rolloverHardNudge(used) : rolloverSoftNudge(used, thresholds.hard),
      rolloverNudgeSummary(action, used),
      "steer",
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

  const finishRollover = Effect.fn("ContextRolloverReactor.finishRollover")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const policy = yield* thresholdsFor(threadId, run);
    const before = threads.get(threadId);
    const startedAt = yield* Clock.currentTimeMillis;
    if (policy?.assignment !== undefined && before !== undefined) {
      yield* experiments.recordObservation({
        id: `rollover:${policy.assignment.id}:${run.id}:rollover`,
        assignmentId: policy.assignment.id,
        runId: run.id,
        kind: "rollover",
        episodeId: `rollover:${policy.assignment.id}:${run.id}`,
        usedTokens: before.used,
        maxTokens: before.maxTokens,
        evidence: [`rollover-of-run:${run.id}`],
      });
    }
    notes.delete(threadId);
    compactions.delete(threadId);
    threads.set(threadId, {
      phase: "idle",
      used: 0,
      providerThreadId: null,
      maxTokens: null,
      usageUpdatedAt: null,
      floor: "pending",
      floorWarned: false,
      attemptId: null,
      ...(policy?.assignment === undefined || before === undefined
        ? {}
        : {
            rollover: {
              assignmentId: policy.assignment.id,
              fromRunId: run.id,
              usedTokens: before.used,
              startedAt,
            },
          }),
    });
  });

  const rollOver = Effect.fn("ContextRolloverReactor.rollOver")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    note: string,
  ) {
    // A separately started turn may supersede this note. Queued delivery below
    // instead carries it into the new turn without adding a bookkeeping run.
    const giveUp = (reason: string) =>
      Effect.gen(function* () {
        notes.delete(threadId);
        yield* engine.recoverDelegatedTask(threadId, run.id);
        const state = threads.get(threadId);
        if (state !== undefined) {
          state.phase = "idle";
        }
        yield* Effect.logInfo("context rollover deferred to a new note", { threadId, reason });
      });
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    // Queue delivery consumes the saved note in its own fresh session. It can
    // commit before this asynchronous reactor observes the source run ending.
    if (runs.some((other) => other.rolloverOfRunId === run.id)) {
      return yield* finishRollover(threadId, run);
    }
    // A held queue waits for the user, so it would never consume the note; the
    // fresh session starts now and the held messages stay held behind it.
    if (runs.some((other) => other.status === "queued" && other.queueHeld !== true)) return;
    if (
      runs.some(
        (other) =>
          other.id !== run.id && other.status !== "queued" && !isTerminalRunStatus(other.status),
      )
    ) {
      return yield* giveUp("another run started first");
    }
    const policy = yield* thresholdsFor(threadId, run);
    const before = threads.get(threadId);
    const modelSelection = yield* rolloverModelSelection(run);
    const dispatched = yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:context-rollover:${run.id}`),
        threadId,
        messageId: MessageId.make(`message:context-rollover:${run.id}`),
        text: ROLLOVER_RESUME_TEXT,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "Context rolled over to a fresh session",
          // The handoff note the fresh session was seeded with.
          detail: note,
        },
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        contextRollover: { note, ofRunId: run.id },
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (policy?.assignment !== undefined && before !== undefined) {
              yield* experiments.recordObservation({
                id: `rollover:${policy.assignment.id}:${run.id}:restart-failure`,
                assignmentId: policy.assignment.id,
                runId: run.id,
                kind: "restart-failure",
                episodeId: `rollover:${policy.assignment.id}:${run.id}`,
                usedTokens: before.used,
                maxTokens: before.maxTokens,
                evidence: [`rollover-of-run:${run.id}`, "fresh-session-dispatch-failed"],
              });
            }
            yield* giveUp(String(error));
            return false;
          }),
        ),
      );
    if (!dispatched) return;
    yield* finishRollover(threadId, run);
  });

  const onRunEnd = Effect.fn("ContextRolloverReactor.onRunEnd")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (run.rolloverOfRunId !== undefined) {
      const assignment = yield* experiments.getRolloverAssignment(threadId);
      if (assignment !== null)
        yield* experiments.recordObservation({
          id: `rollover:${assignment.id}:${run.id}:continuation-ended`,
          assignmentId: assignment.id,
          runId: run.id,
          kind: "continuation-ended",
          episodeId: `rollover:${assignment.id}:${run.rolloverOfRunId}`,
          usedTokens: threads.get(threadId)?.used ?? null,
          maxTokens: threads.get(threadId)?.maxTokens ?? null,
          evidence: [`run:${run.id}`, `run-status:${run.status}`],
        });
    }
    const pending = notes.get(threadId);
    // A queued turn can be cancelled before it starts and consumes the note.
    // Release the source result when no queued delivery remains to consume it;
    // cancellation must not create an unsolicited continuation turn.
    if (pending !== undefined && pending.runId !== run.id) {
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (runs.some((candidate) => !isTerminalRunStatus(candidate.status))) return;
      const source = runs.find((candidate) => candidate.id === pending.runId);
      if (source?.status !== "completed") return;
      notes.delete(threadId);
      const state = threads.get(threadId);
      if (state !== undefined) state.phase = "idle";
      yield* engine.recoverDelegatedTask(threadId, source.id);
      return;
    }
    if (pending !== undefined) {
      // The user stopped the run, or it failed: no resumption they did not ask for.
      // The next usage report asks again.
      if (run.status !== "completed") {
        notes.delete(threadId);
        threads.delete(threadId);
        return;
      }
      return yield* rollOver(threadId, run, pending.note);
    }
    // A run that ends without a note needs no bookkeeping turn, but the request
    // was not answered: forget it so the next turn past a threshold is asked again.
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
    if (assignment === null) return;
    const state = threads.get(event.threadId);
    const id = `rollover:${assignment.id}:${run.id}:native-compaction:${item.id}`;
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
      item.afterTokenCount !== undefined &&
      (state.usageUpdatedAt === null ||
        DateTime.toEpochMillis(item.updatedAt) >= state.usageUpdatedAt)
    ) {
      state.recovery = { usedTokens: item.afterTokenCount, observationId: id };
    }
  });

  const handle = (event: RolloverEvent) => {
    if (event.type === "provider-turn.updated") {
      return event.payload.tokenUsage === undefined ? onTurnStart(event) : onUsage(event);
    }
    if (event.type === "turn-item.updated") return onCompaction(event);
    activeRuns.delete(event.threadId);
    if (isTerminalRunStatus(event.payload.status)) return onRunEnd(event.threadId, event.payload);
    if (
      event.payload.rolloverOfRunId !== undefined &&
      notes.get(event.threadId)?.runId === event.payload.rolloverOfRunId
    ) {
      return projections.getThreadRecords(event.threadId, ["runs"]).pipe(
        Effect.flatMap(({ runs }) => {
          const source = runs.find((run) => run.id === event.payload.rolloverOfRunId);
          return source === undefined ? Effect.void : finishRollover(event.threadId, source);
        }),
      );
    }
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
              notes.delete(event.threadId);
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
