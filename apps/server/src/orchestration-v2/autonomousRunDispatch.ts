import {
  type CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadArcRun,
  type OrchestrationV2ThreadAutonomousRun,
  type OrchestrationV2ThreadDecisionEntry,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import {
  activeRunOf,
  appendDecisionLogEntry,
  arcRunAttentionMessage,
  arcRunClaimsSpec,
  arcRunScopesOverlap,
  arcRunStallMessage,
  arcRunWakeMessage,
  decideArcRunWake,
  isArcRunHeld,
  isArcRunObject,
  latestArcRunTurn,
  trimDecisionField,
} from "./arcRun.ts";
import { ARC_RUN_WAKE_MESSAGE_PREFIX } from "./serverContinuation.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionStoreV2Error,
  ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";
import type { EffectOutboxError } from "./EffectOutbox.ts";

export interface AutonomousRunDispatchDeps<
  TEffects,
  TDispatchError,
  TProjectionError,
  TMessageError,
> {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly isDelegatedTaskThread: (thread: OrchestrationV2AppThread) => boolean;
  readonly makeDispatchError: (input: {
    readonly commandId: CommandId;
    readonly commandType: OrchestrationV2ServerCommand["type"];
    readonly cause: string;
  }) => TDispatchError;
  readonly makeProjectionError: (input: {
    readonly threadId: ThreadId;
    readonly cause: unknown;
  }) => TProjectionError;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<
    { readonly thread: OrchestrationV2AppThread; readonly runs: ReadonlyArray<OrchestrationV2Run> },
    TDispatchError | TProjectionError | ProjectionStoreV2Error
  >;
  readonly emitThreadMetadata: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
    event: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly occurredAt: DateTime.Utc;
      readonly payload: OrchestrationV2AppThread;
    },
  ) => Effect.Effect<unknown, TDispatchError>;
  readonly cancelQueuedRun: (
    command: {
      readonly type: "queued-run.cancel";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly runId: RunId;
    },
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, TDispatchError | TProjectionError | ProjectionStoreV2Error>;
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<TEffects>>,
  ) => Effect.Effect<unknown, TMessageError>;
  readonly childAwaitsRestartContinuation: (
    runs: ReadonlyArray<OrchestrationV2Run>,
    latest: OrchestrationV2Run,
  ) => Effect.Effect<boolean, EffectOutboxError>;
}

const cancelQueuedRunWakes = Effect.fn("AutonomousRunDispatch.cancelQueuedRunWakes")(function* <
  TEffects,
  TDispatchError,
  TProjectionError,
  TMessageError,
>(
  deps: Pick<
    AutonomousRunDispatchDeps<TEffects, TDispatchError, TProjectionError, TMessageError>,
    "cancelQueuedRun"
  >,
  command: { readonly commandId: CommandId; readonly threadId: ThreadId },
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  for (const run of runs) {
    if (run.status !== "queued" || !run.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX)) {
      continue;
    }
    yield* deps.cancelQueuedRun(
      {
        type: "queued-run.cancel",
        commandId: command.commandId,
        threadId: command.threadId,
        runId: run.id,
      },
      events,
    );
  }
});

export const dispatchAutonomousRun = Effect.fn("orchestrationV2.dispatch.arcRun")(function* <
  TEffects,
  TDispatchError,
  TProjectionError,
  TMessageError,
>(
  deps: AutonomousRunDispatchDeps<TEffects, TDispatchError, TProjectionError, TMessageError>,
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.arc-run" }>,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
) {
  const refuse = (cause: string): Effect.Effect<never, TDispatchError> =>
    Effect.fail(
      deps.makeDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      }),
    );
  const { thread, runs } = yield* deps.getProjectionWithPendingEvents(command.threadId, events);
  if (thread.deletedAt !== null) return yield* refuse(`Thread ${command.threadId} is deleted.`);
  if (deps.isDelegatedTaskThread(thread)) {
    return yield* refuse("A delegated task cannot run an Arc: its parent owns the outcome.");
  }
  const now = yield* DateTime.now;
  const nowIso = DateTime.formatIso(now);

  // Append-only decision/assumption logging works on any active run or top-level Away thread.
  if (command.op === "decision") {
    if (command.decision === undefined) {
      return yield* refuse("A decision log entry requires decision details.");
    }
    const existing = thread.decisionLog ?? [];
    if (existing.some((entry) => entry.id === command.commandId)) return;
    const entry: OrchestrationV2ThreadDecisionEntry = {
      id: command.commandId,
      decision: trimDecisionField(command.decision.decision),
      alternative: trimDecisionField(command.decision.alternative),
      why: trimDecisionField(command.decision.why),
      howToReverse: trimDecisionField(command.decision.howToReverse),
      ...(command.decision.source === undefined
        ? {}
        : { source: trimDecisionField(command.decision.source) }),
      recordedAt: nowIso,
    };
    yield* deps.emitThreadMetadata(events, command, {
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        ...thread,
        decisionLog: appendDecisionLogEntry(existing, entry),
        updatedAt: now,
      },
    });
    return;
  }

  // The owner's per-thread switch while global Away is on; a run itself is unaffected.
  if (command.op === "away-off" || command.op === "away-on") {
    const optOut = command.op === "away-off";
    if ((thread.awayOptOut === true) === optOut) return;
    const { awayOptOut: _previous, ...withoutOptOut } = thread;
    yield* deps.emitThreadMetadata(events, command, {
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: { ...withoutOptOut, ...(optOut ? { awayOptOut: true as const } : {}), updatedAt: now },
    });
    return;
  }

  const currentArc = thread.arcRun;
  const currentAuto = thread.autonomousRun;
  const currentAny = activeRunOf(thread);

  const plan = command.plan ?? currentArc?.plan;
  const currentSpec =
    command.current === null ? undefined : (command.current ?? currentArc?.current);

  if (
    (command.op === "start" && command.arc !== undefined) ||
    (command.op === "checkpoint" && currentArc !== undefined)
  ) {
    const specs = command.op === "start" ? command.specs : currentArc?.specs;
    if (plan !== undefined && new Set(plan).size !== plan.length) {
      return yield* refuse("The Arc run plan contains a duplicate Spec. List each Spec once.");
    }
    if (
      plan !== undefined &&
      specs !== undefined &&
      (plan.length !== specs.length || specs.some((number) => !plan.includes(number)))
    ) {
      return yield* refuse(
        "The plan must contain exactly this run's named Specs, in your intended order.",
      );
    }
    const scope = plan ?? specs;
    if (currentSpec !== undefined && scope !== undefined && !scope.includes(currentSpec)) {
      return yield* refuse(
        "The current Spec must be in the run's plan, or its named Specs when no plan is recorded.",
      );
    }
  }

  let nextArc: OrchestrationV2ThreadArcRun | undefined = currentArc;
  let nextAuto: OrchestrationV2ThreadAutonomousRun | undefined = currentAuto;

  switch (command.op) {
    case "start": {
      if (thread.archivedAt !== null || thread.settledOverride === "settled") {
        return yield* refuse("A settled or archived thread cannot run an Arc. Unsettle it first.");
      }
      if (isArcRunHeld(currentAny)) {
        return yield* refuse(
          "This Arc run is stopped until the owner replies: only his message resumes it.",
        );
      }
      const targetKinds = [
        command.arc !== undefined,
        command.spec !== undefined,
        command.label !== undefined,
      ].filter(Boolean).length;
      if (targetKinds === 0) {
        return yield* refuse("Starting an Arc run names the Arc (or a spec or label).");
      }
      if (targetKinds > 1) {
        return yield* refuse("Starting a run accepts only one of arc, spec, or label.");
      }

      if (command.arc !== undefined) {
        if (currentAuto !== undefined) {
          return yield* refuse(
            "This thread already holds an autonomous run. End it first before starting an Arc run.",
          );
        }
        if (currentArc !== undefined && currentArc.arc.number !== command.arc.number) {
          return yield* refuse(
            `This thread already runs Arc ${currentArc.arc.ref ?? `#${currentArc.arc.number}`}. End it first.`,
          );
        }
        const specs = command.specs;
        if (currentArc !== undefined && String(currentArc.specs) !== String(specs)) {
          return yield* refuse(
            "This run already answers for a different scope. End it, then start again to change that.",
          );
        }
        const others = yield* deps.projectionStore
          .listArcRunThreads()
          .pipe(
            Effect.mapError((cause) =>
              deps.makeProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        const owner = others.find(
          (candidate) =>
            candidate.id !== thread.id &&
            candidate.arcRun?.arc.number === command.arc?.number &&
            arcRunScopesOverlap(candidate.arcRun?.specs, specs),
        );
        if (owner !== undefined) {
          const held = owner.arcRun?.specs?.map((number) => `#${number}`).join(", ");
          return yield* refuse(
            held === undefined
              ? `Thread ${owner.id} runs the whole of Arc #${command.arc.number}. Coordinate with it, or end its run first.`
              : `Thread ${owner.id} answers for Specs ${held} of Arc #${command.arc.number}. Name only Specs outside those; the whole Arc is refused until its run ends.`,
          );
        }
        const claimedSpecs = specs ?? plan;
        if (claimedSpecs !== undefined && claimedSpecs.length > 0) {
          const specConflict = others.find(
            (candidate) =>
              candidate.id !== thread.id &&
              candidate.autonomousRun?.kind === "spec" &&
              candidate.autonomousRun.spec !== undefined &&
              claimedSpecs.includes(candidate.autonomousRun.spec.number),
          );
          if (specConflict?.autonomousRun?.spec !== undefined) {
            return yield* refuse(
              `Thread ${specConflict.id} already runs Spec #${specConflict.autonomousRun.spec.number}. Coordinate with it, or end its run first.`,
            );
          }
        }
        const { current: _currentSpec, ...runWithoutCurrent } = currentArc ?? {};
        const planAndCurrent = {
          ...(plan === undefined ? {} : { plan }),
          ...(currentSpec === undefined ? {} : { current: currentSpec }),
        };
        nextArc = {
          ...runWithoutCurrent,
          ...planAndCurrent,
          arc: command.arc,
          ...(specs === undefined ? {} : { specs }),
          state: "active",
          startedAt: currentArc?.startedAt ?? nowIso,
          progressAt: currentArc?.progressAt ?? nowIso,
          ceilingSince: currentArc?.ceilingSince ?? nowIso,
        };
      } else if (command.spec !== undefined) {
        if (currentArc !== undefined) {
          return yield* refuse(
            `This thread already runs Arc ${currentArc.arc.ref ?? `#${currentArc.arc.number}`}. End it first.`,
          );
        }
        if (
          currentAuto !== undefined &&
          (currentAuto.kind !== "spec" || currentAuto.spec?.number !== command.spec.number)
        ) {
          return yield* refuse("This thread already holds another autonomous run. End it first.");
        }
        const others = yield* deps.projectionStore
          .listArcRunThreads()
          .pipe(
            Effect.mapError((cause) =>
              deps.makeProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        const owner = others.find(
          (candidate) =>
            candidate.id !== thread.id &&
            ((candidate.autonomousRun?.kind === "spec" &&
              candidate.autonomousRun.spec?.number === command.spec?.number) ||
              arcRunClaimsSpec(candidate.arcRun, command.spec!.number)),
        );
        if (owner !== undefined) {
          return yield* refuse(
            `Thread ${owner.id} already runs Spec #${command.spec.number}. Coordinate with it, or end its run first.`,
          );
        }
        nextAuto = {
          ...currentAuto,
          kind: "spec",
          spec: command.spec,
          state: "active",
          startedAt: currentAuto?.startedAt ?? nowIso,
          progressAt: currentAuto?.progressAt ?? nowIso,
          ceilingSince: currentAuto?.ceilingSince ?? nowIso,
        };
      } else {
        if (currentArc !== undefined) {
          return yield* refuse(
            `This thread already runs Arc ${currentArc.arc.ref ?? `#${currentArc.arc.number}`}. End it first.`,
          );
        }
        if (
          currentAuto !== undefined &&
          (currentAuto.kind !== "task" || currentAuto.label !== command.label)
        ) {
          return yield* refuse("This thread already holds another autonomous run. End it first.");
        }
        nextAuto = {
          ...currentAuto,
          kind: "task",
          ...(command.label === undefined ? {} : { label: command.label }),
          state: "active",
          startedAt: currentAuto?.startedAt ?? nowIso,
          progressAt: currentAuto?.progressAt ?? nowIso,
          ceilingSince: currentAuto?.ceilingSince ?? nowIso,
        };
      }
      break;
    }
    case "checkpoint": {
      if (currentAny === undefined) return yield* refuse("This thread has no Arc run.");
      if (command.phase === undefined) return yield* refuse("A checkpoint names its phase.");
      if (currentArc !== undefined) {
        const planAndCurrent = {
          ...(plan === undefined ? {} : { plan }),
          ...(currentSpec === undefined ? {} : { current: currentSpec }),
        };
        nextArc = {
          ...currentArc,
          ...planAndCurrent,
          progressAt:
            currentArc.checkpoint?.phase !== command.phase ||
            (currentSpec !== undefined && currentSpec !== currentArc.current)
              ? nowIso
              : currentArc.progressAt,
          checkpoint: {
            phase: command.phase,
            ...(command.note === undefined ? {} : { note: command.note }),
            at: nowIso,
          },
        };
        if (currentSpec === undefined) {
          const { current: _cleared, ...withoutCurrent } = nextArc;
          nextArc = withoutCurrent;
        }
      } else if (currentAuto !== undefined) {
        nextAuto = {
          ...currentAuto,
          progressAt:
            currentAuto.checkpoint?.phase !== command.phase ? nowIso : currentAuto.progressAt,
          checkpoint: {
            phase: command.phase,
            ...(command.note === undefined ? {} : { note: command.note }),
            at: nowIso,
          },
        };
      }
      break;
    }
    case "pause": {
      if (currentAny === undefined) return yield* refuse("This thread has no Arc run.");
      if (currentArc !== undefined) {
        const { resumed: _resumed, ...rest } = currentArc;
        nextArc = { ...rest, state: "paused" };
      } else if (currentAuto !== undefined) {
        const { resumed: _resumed, ...rest } = currentAuto;
        nextAuto = { ...rest, state: "paused" };
      }
      yield* cancelQueuedRunWakes(deps, command, events, runs);
      break;
    }
    case "end": {
      if (currentAny === undefined) return;
      nextArc = undefined;
      nextAuto = undefined;
      yield* cancelQueuedRunWakes(deps, command, events, runs);
      break;
    }
  }

  // Starting a brand-new run drops entries from any prior ended run while preserving pre-run Away
  // entries; op end marks the log as belonging to an ended run and preserves it for readback.
  const {
    arcRun: _prevArc,
    autonomousRun: _prevAuto,
    decisionLog: prevDecisionLog,
    awayOptOut: prevAwayOptOut,
    ...rest
  } = thread;
  let nextDecisionLog: ReadonlyArray<OrchestrationV2ThreadDecisionEntry> | undefined =
    prevDecisionLog;
  if (command.op === "end" && prevDecisionLog !== undefined) {
    nextDecisionLog = prevDecisionLog.map((entry) => ({ ...entry, endedRun: true as const }));
  } else if (command.op === "start" && currentAny === undefined && prevDecisionLog !== undefined) {
    const preRunEntries = prevDecisionLog.filter((entry) => entry.endedRun !== true);
    nextDecisionLog = preRunEntries.length > 0 ? preRunEntries : undefined;
  }
  yield* deps.emitThreadMetadata(events, command, {
    threadId: thread.id,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload: {
      ...rest,
      ...(nextArc === undefined ? {} : { arcRun: nextArc }),
      ...(nextAuto === undefined ? {} : { autonomousRun: nextAuto }),
      ...(nextDecisionLog === undefined ? {} : { decisionLog: nextDecisionLog }),
      // Starting a run is an explicit "on", so it clears an earlier Away opt-out.
      ...(prevAwayOptOut === true && command.op !== "start" ? { awayOptOut: true as const } : {}),
      updatedAt: now,
    },
  });
});

// The reactor only says when to look. Deciding here, under the thread's lock, is what keeps a
// wake from racing a restart continuation, a Stop or the owner's own message.
export const dispatchAutonomousRunWake = Effect.fn("orchestrationV2.dispatch.arcRunWake")(
  function* <TEffects, TDispatchError, TProjectionError, TMessageError>(
    deps: AutonomousRunDispatchDeps<TEffects, TDispatchError, TProjectionError, TMessageError>,
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.arc-run.wake" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<TEffects>>,
  ) {
    const read = <K extends ProjectionRecordField>(
      keys: ReadonlyArray<K>,
      filter: ProjectionRecordFilter,
    ) =>
      deps.projectionStore
        .getThreadRecords(command.threadId, keys, filter)
        .pipe(
          Effect.mapError((cause) =>
            deps.makeProjectionError({ threadId: command.threadId, cause }),
          ),
        );
    const state = yield* read(["runs", "subagents", "providerThreads", "turnItems"], {
      turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
      turnItemStatuses: ["pending", "running", "waiting"],
    });
    const { thread } = state;
    const run = activeRunOf(thread);
    if (run === undefined || run.state !== "active" || thread.deletedAt !== null) return;
    // A delegated child can carry an inherited run copied before the builder stopped copying it.
    // Its parent owns the outcome, so this thread gets no lead wake.
    if (deps.isDelegatedTaskThread(thread)) return;
    const now = yield* DateTime.now;
    if (
      command.trigger !== "event" &&
      thread.snoozedUntil != null &&
      DateTime.isGreaterThan(thread.snoozedUntil, now)
    ) {
      return;
    }
    const queueWake = (messageId: MessageId, wake: ReturnType<typeof arcRunWakeMessage>) =>
      deps.dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId,
          text: wake.text,
          notification: wake.notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        },
        events,
        effects,
      );
    const alreadySent = (messageId: MessageId) =>
      read(["messages"], { messageIds: [messageId] }).pipe(
        Effect.map(({ messages }) => messages.some((message) => message.id === messageId)),
      );
    if (command.stall !== undefined) {
      if (decideArcRunWake(state, command.trigger)?.kind === "attention") return;
      const messageId = MessageId.make(
        `${ARC_RUN_WAKE_MESSAGE_PREFIX}stall:${command.stall.childThreadId}:${command.stall.lastEventSequence}`,
      );
      if (yield* alreadySent(messageId)) return;
      yield* queueWake(messageId, arcRunStallMessage({ arcRun: run, stall: command.stall }));
      return;
    }
    const decision = decideArcRunWake(state, command.trigger);
    if (decision === undefined) return;
    if (decision.kind !== "attention") {
      const continuations = yield* deps.projectionStore
        .getManagedChildContinuations(thread.id)
        .pipe(Effect.mapError((cause) => deps.makeProjectionError({ threadId: thread.id, cause })));
      if (continuations.length > 0) return;
    }
    const latest = latestArcRunTurn(state.runs);
    if (latest === undefined) return;
    if (
      yield* deps
        .childAwaitsRestartContinuation(state.runs, latest)
        .pipe(
          Effect.mapError((cause) =>
            deps.makeProjectionError({ threadId: command.threadId, cause }),
          ),
        )
    ) {
      return;
    }
    const messageId = MessageId.make(`${ARC_RUN_WAKE_MESSAGE_PREFIX}${decision.kind}:${latest.id}`);
    if (yield* alreadySent(messageId)) return;
    const { resumed: _resumed, ...settled } = run;
    const updatedRun =
      decision.kind === "attention" ? { ...settled, state: "attention" as const } : settled;
    if (updatedRun.state !== run.state || run.resumed === true) {
      const payload: OrchestrationV2AppThread = isArcRunObject(run)
        ? { ...thread, arcRun: updatedRun as OrchestrationV2ThreadArcRun, updatedAt: now }
        : {
            ...thread,
            autonomousRun: updatedRun as OrchestrationV2ThreadAutonomousRun,
            updatedAt: now,
          };
      yield* deps.emitThreadMetadata(events, command, {
        threadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload,
      });
    }
    yield* queueWake(
      messageId,
      decision.kind === "attention"
        ? arcRunAttentionMessage({
            arcRun: run,
            reason: decision.reason,
            ...(thread.decisionLog === undefined ? {} : { decisionLog: thread.decisionLog }),
          })
        : arcRunWakeMessage({
            arcRun: run,
            decision,
            answersQuestion: command.answersQuestion === true,
          }),
    );
  },
);
