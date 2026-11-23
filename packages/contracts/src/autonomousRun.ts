import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const OrchestrationV2ThreadRunCheckpoint = Schema.Struct({
  phase: TrimmedNonEmptyString,
  note: Schema.optional(TrimmedNonEmptyString),
  at: IsoDateTime,
});
export type OrchestrationV2ThreadRunCheckpoint = typeof OrchestrationV2ThreadRunCheckpoint.Type;

export const OrchestrationV2ThreadRunState = Schema.Literals(["active", "paused", "attention"]);
export type OrchestrationV2ThreadRunState = typeof OrchestrationV2ThreadRunState.Type;

/**
 * A thread's responsibility for an Arc, which outlasts its turns and is independent of Away.
 * Kept unchanged on the wire so shipped clients and ArcRunChip/ArcRunView decode and render safely.
 */
export const OrchestrationV2ThreadArcRun = Schema.Struct({
  arc: Schema.Struct({
    number: PositiveInt,
    ref: Schema.optional(TrimmedNonEmptyString),
  }),
  /** Forge numbers when this thread answers for only these Specs; absent means the whole Arc. */
  specs: Schema.optional(Schema.NonEmptyArray(PositiveInt)),
  /**
   * The lead's planned order of Spec numbers, revised at checkpoints. With `specs` it lists exactly
   * those; for a whole Arc it lists the members the lead means to take.
   */
  plan: Schema.optional(Schema.NonEmptyArray(PositiveInt)),
  /** The Spec the lead is working on; in `plan` when there is one, else in `specs`. */
  current: Schema.optional(PositiveInt),
  state: OrchestrationV2ThreadRunState,
  startedAt: IsoDateTime,
  /** The last advancing checkpoint or message from the owner; bounds the no-progress wakes. */
  progressAt: IsoDateTime,
  /** The start or the owner's last message; bounds all of the run's turns. */
  ceilingSince: IsoDateTime,
  checkpoint: Schema.optional(OrchestrationV2ThreadRunCheckpoint),
  /** The owner's message resumed a stopped run; the next wake says what that may have left. */
  resumed: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2ThreadArcRun = typeof OrchestrationV2ThreadArcRun.Type;

/**
 * An additive per-thread autonomous run for a single Forge Spec or an open-ended task without an
 * Arc. Older shipped clients ignore this optional key while continuing to decode `arcRun`.
 */
export const OrchestrationV2ThreadAutonomousRun = Schema.Struct({
  kind: Schema.Literals(["spec", "task"]),
  spec: Schema.optional(
    Schema.Struct({
      number: PositiveInt,
      ref: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  label: Schema.optional(TrimmedNonEmptyString),
  state: OrchestrationV2ThreadRunState,
  startedAt: IsoDateTime,
  progressAt: IsoDateTime,
  ceilingSince: IsoDateTime,
  checkpoint: Schema.optional(OrchestrationV2ThreadRunCheckpoint),
  resumed: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2ThreadAutonomousRun = typeof OrchestrationV2ThreadAutonomousRun.Type;

/** One consequential judgement call or assumption logged during an autonomous or Away run. */
export const OrchestrationV2ThreadDecisionInput = Schema.Struct({
  decision: TrimmedNonEmptyString,
  alternative: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
  howToReverse: TrimmedNonEmptyString,
  source: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2ThreadDecisionInput = typeof OrchestrationV2ThreadDecisionInput.Type;

export const OrchestrationV2ThreadDecisionEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  decision: TrimmedNonEmptyString,
  alternative: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
  howToReverse: TrimmedNonEmptyString,
  source: Schema.optional(TrimmedNonEmptyString),
  recordedAt: IsoDateTime,
  /** Marked on `op: "end"` so starting a subsequent run drops the ended run's entries while preserving pre-run Away entries. */
  endedRun: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2ThreadDecisionEntry = typeof OrchestrationV2ThreadDecisionEntry.Type;

/** Starts, checkpoints, logs decisions on, pauses or ends the thread's autonomous/Arc run. */
export const OrchestrationV2ThreadArcRunCommand = Schema.Struct({
  type: Schema.Literal("thread.arc-run"),
  commandId: CommandId,
  threadId: ThreadId,
  /** `away-off` exempts the thread from global Away until `away-on` or a run starts. */
  op: Schema.Literals(["start", "checkpoint", "decision", "pause", "end", "away-off", "away-on"]),
  arc: Schema.optional(OrchestrationV2ThreadArcRun.fields.arc),
  spec: Schema.optional(
    Schema.Struct({
      number: PositiveInt,
      ref: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  label: Schema.optional(TrimmedNonEmptyString),
  specs: OrchestrationV2ThreadArcRun.fields.specs,
  plan: OrchestrationV2ThreadArcRun.fields.plan,
  /** Null clears the current Spec; absent leaves it as it is. */
  current: Schema.optional(Schema.NullOr(PositiveInt)),
  phase: Schema.optional(TrimmedNonEmptyString),
  note: Schema.optional(TrimmedNonEmptyString),
  decision: Schema.optional(OrchestrationV2ThreadDecisionInput),
});
export type OrchestrationV2ThreadArcRunCommand = typeof OrchestrationV2ThreadArcRunCommand.Type;

/**
 * Wakes an active Arc or autonomous run if stored state calls for it, decided under the thread's
 * lock so it cannot race a restart continuation, a Stop or the owner's own message.
 */
export const OrchestrationV2ThreadArcRunWakeCommand = Schema.Struct({
  type: Schema.Literal("thread.arc-run.wake"),
  commandId: CommandId,
  threadId: ThreadId,
  trigger: Schema.Literals(["event", "watchdog", "startup"]),
  stall: Schema.optional(
    Schema.Struct({
      childThreadId: ThreadId,
      title: TrimmedNonEmptyString,
      lastEventSequence: NonNegativeInt,
      quietMinutes: NonNegativeInt,
      openWork: Schema.Boolean,
    }),
  ),
  answersQuestion: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2ThreadArcRunWakeCommand =
  typeof OrchestrationV2ThreadArcRunWakeCommand.Type;
