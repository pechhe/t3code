import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ContextRolloverNotes,
  lowestSoftThreshold,
  ROLLOVER_RESUME_TEXT,
  rolloverHardNudge,
  rolloverHeld,
  rolloverSoftNudge,
  rolloverUsageAction,
  threadRolloverThresholds,
  type RolloverPhase,
  type RolloverThresholds,
} from "./ContextRollover.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

interface ThreadRollover {
  phase: RolloverPhase;
  /** The last context size the provider reported. */
  used: number;
  /** The run-end hard nudge was sent; a run that ends without a note again gets no second one. */
  fallbackSent: boolean;
}

type RolloverEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-turn.updated" | "run.updated" }
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

  const threads = new Map<ThreadId, ThreadRollover>();

  const thresholdsFor = Effect.fn("ContextRolloverReactor.thresholdsFor")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const settings = yield* settingsService.getSettings;
    const thread = yield* projections.getThread(threadId);
    if (rolloverHeld(thread.rolloverHold, yield* Clock.currentTimeMillis)) return null;
    return threadRolloverThresholds(settings.contextRollover, thread, run.modelSelection.model);
  });

  const message = Effect.fn("ContextRolloverReactor.message")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    text: string,
    mode: "steer" | "start",
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:context-rollover-nudge:${threadId}:${uuid}`),
      threadId,
      messageId: MessageId.make(`message:context-rollover-nudge:${uuid}`),
      text,
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
    const state = threads.get(event.threadId) ?? { phase: "idle", used, fallbackSent: false };
    state.used = used;
    threads.set(event.threadId, state);
    if (turn.status !== "running") return;
    // Usage reports arrive many times a turn; read the thread only past the lowest threshold.
    // Usage below it (a fresh thread, or one the provider compacted) starts over.
    const lowest = lowestSoftThreshold((yield* settingsService.getSettings).contextRollover);
    if (lowest === null || used < lowest) {
      state.phase = "idle";
      state.fallbackSent = false;
      return;
    }
    if (notes.get(event.threadId) !== undefined) return;
    const { runs } = yield* projections.getThreadRecords(event.threadId, ["runs"]);
    const run = runs.find((candidate) => candidate.activeAttemptId === turn.runAttemptId);
    if (run === undefined || (run.status !== "running" && run.status !== "waiting")) return;
    const thresholds = yield* thresholdsFor(event.threadId, run);
    if (thresholds === null) return;
    if (used < thresholds.soft) {
      state.phase = "idle";
      state.fallbackSent = false;
      return;
    }
    const action = rolloverUsageAction(state.phase, used, thresholds);
    if (action === "none") return;
    state.phase = action === "hard" ? "hardNudged" : "softNudged";
    yield* message(
      event.threadId,
      run,
      action === "hard" ? rolloverHardNudge(used) : rolloverSoftNudge(used, thresholds.hard),
      "steer",
    );
  });

  const rollOver = Effect.fn("ContextRolloverReactor.rollOver")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    note: string,
  ) {
    // A queued message can start before the rollover does; a rollover cannot queue
    // behind it. Drop the note, settle a delegated result held for the rollover, and
    // let the run now going be asked for a fresh note past the threshold.
    const giveUp = (reason: string) =>
      Effect.gen(function* () {
        notes.delete(threadId);
        yield* engine.recoverDelegatedTask(threadId, run.id);
        const state = threads.get(threadId);
        if (state !== undefined) {
          state.phase = "idle";
          state.fallbackSent = false;
        }
        yield* Effect.logInfo("context rollover deferred to a new note", { threadId, reason });
      });
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (runs.some((other) => other.id !== run.id && !isTerminalRunStatus(other.status))) {
      return yield* giveUp("another run started first");
    }
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
          detail: ROLLOVER_RESUME_TEXT,
        },
        attachments: [],
        modelSelection: run.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        contextRollover: { note, ofRunId: run.id },
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) => giveUp(String(error)).pipe(Effect.as(false))),
      );
    if (!dispatched) return;
    notes.delete(threadId);
    threads.set(threadId, { phase: "idle", used: 0, fallbackSent: false });
  });

  const onRunEnd = Effect.fn("ContextRolloverReactor.onRunEnd")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const pending = notes.get(threadId);
    // A note belongs to the run that wrote it; another run ending leaves it waiting.
    if (pending !== undefined && pending.runId !== run.id) return;
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
    const state = threads.get(threadId);
    if (state === undefined || state.phase === "idle" || run.status !== "completed") return;
    if (state.fallbackSent) return;
    const thresholds: RolloverThresholds | null = yield* thresholdsFor(threadId, run);
    if (thresholds === null || state.used < thresholds.soft) return;
    // Another run already follows this one: a queued message, or a nudge that
    // arrived after the turn ended and started its own run.
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (runs.some((other) => other.id !== run.id && !isTerminalRunStatus(other.status))) return;
    // Asked for a note and ended the turn without one: ask once more, now.
    state.phase = "hardNudged";
    state.fallbackSent = true;
    yield* message(threadId, run, rolloverHardNudge(state.used), "start");
  });

  const handle = (event: RolloverEvent) => {
    if (event.type === "provider-turn.updated") return onUsage(event);
    return isTerminalRunStatus(event.payload.status)
      ? onRunEnd(event.threadId, event.payload)
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
            return event.payload.tokenUsage === undefined ? Effect.void : worker.enqueue(event);
          case "run.updated":
            return worker.enqueue(event);
          case "thread.rollover-hold-set":
            // A hold forgets a soft nudge not yet answered; lifting it starts over.
            return Effect.sync(() => {
              const state = threads.get(event.threadId);
              if (state === undefined) return;
              state.phase = "idle";
              state.fallbackSent = false;
            });
          case "thread.archived":
          case "thread.deleted":
            return Effect.sync(() => {
              threads.delete(event.threadId);
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
