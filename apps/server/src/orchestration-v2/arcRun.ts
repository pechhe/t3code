import type {
  OrchestrationV2AppThread,
  OrchestrationV2Notification,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadArcRun,
  OrchestrationV2ThreadAutonomousRun,
  OrchestrationV2ThreadDecisionEntry,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { neverStarted } from "./RestartBackgroundNote.ts";
import {
  ARC_RUN_WAKE_MESSAGE_PREFIX,
  UNATTENDED_CONTINUATION_MESSAGE_PREFIX,
} from "./serverContinuation.ts";

/**
 * Wakes without an advancing checkpoint. A tool call cannot count as progress, because the wake's
 * own instruction to re-read state guarantees one.
 */
export const ARC_RUN_NO_PROGRESS_CAP = 5;
/** Turns since the start or the owner's last message, however busy the checkpoints look. */
export const ARC_RUN_TURN_CEILING = 200;

export const ARC_RUN_WATCHDOG_MINUTES = 30;
/** A child with nothing open that has been silent this long is worth telling its lead about. */
export const ARC_RUN_STALL_IDLE_MINUTES = 30;
/** An open command or tool can be silent for hours and still be healthy. */
export const ARC_RUN_STALL_OPEN_WORK_MINUTES = 6 * 60;

export const HARD_STOP_BOUNDARY =
  "Production deploys or migrations, real spending, external messages to third parties or customers, destructive data operations, or credentials/permissions only the owner can grant";

/** Answers an autonomous or Arc lead's own question: true whether or not the owner is at his desk. */
export const ARC_RUN_ANSWER =
  `This thread is running autonomously, so you decide reversible choices yourself from the evidence, testing and the governing intent — including UI/UX look-and-feel on develop, previews or behind gates. Log each consequential assumption or decision with t3_thread_update (action arc_run, op decision). Hold only what is truly hard to reverse (${HARD_STOP_BOUNDARY}) with a watch on the owner, and carry on with all other work.`;

/** Answers a question while global Away is on. */
export const AWAY_ANSWER =
  `The owner is away and this thread is unattended, so nobody will answer questions. Decide reversible choices yourself from the evidence, testing and the governing intent — including UI/UX look-and-feel on develop, previews or behind gates. Log each consequential assumption or decision with t3_thread_update (action arc_run, op decision). Hold only what is truly hard to reverse (${HARD_STOP_BOUNDARY}) as an owner wait, and carry on with all other work.`;

/** Continuation prompt when a non-run thread stops mid-work while global Away is on. */
export const AWAY_CONTINUE_PROMPT =
  `This thread is unattended while the owner is away. Continue the remaining work: decide reversible choices yourself by judgement or testing, log consequential assumptions or decisions with t3_thread_update (action arc_run, op decision), and start an autonomous run (op start) if multi-step work remains. End with a '🟢 Status: Done' line (listing the decisions and assumptions made) once finished, or record an owner watch if only hard-to-reverse holds (${HARD_STOP_BOUNDARY}) remain.`;

const AUTONOMOUS_AUTHORITY_NOTE =
  `Unattended authority: decide reversible choices yourself from evidence, testing and governing intent — including UI/UX look-and-feel on develop, previews or behind gates (show screenshots in your report). Hold only hard-to-reverse actions (${HARD_STOP_BOUNDARY}). Log each consequential assumption or decision with t3_thread_update (action arc_run, op decision) and surface the full list in your closing report. Do not stop until the work is finished (call op end) or only hard-to-reverse holds remain.`;

const AWAY_TURN_NOTE =
  `Global Away is on: the owner is away and this thread is unattended. Decide reversible choices yourself from evidence, testing and governing intent — including UI/UX look-and-feel on develop, previews or behind gates (show screenshots in your report). Hold only hard-to-reverse actions (${HARD_STOP_BOUNDARY}) using watch {kind: "owner"}. Log consequential assumptions or decisions with t3_thread_update (action arc_run, op decision) and surface them in your closing report. If multi-step work remains, start an autonomous run with t3_thread_update (action arc_run, op start) and call op end when finished; otherwise finish with a '🟢 Status: Done' line.`;

export type AnyThreadRun = OrchestrationV2ThreadArcRun | OrchestrationV2ThreadAutonomousRun;

export type ArcRunTrigger = "event" | "watchdog" | "startup";

export type ArcRunWakeDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "failed-run" }
  | { readonly kind: "no-next-trigger" }
  | { readonly kind: "attention"; readonly reason: "no-progress" | "ceiling" };

const LIVE_RUN: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const TASK_DONE: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const OWED_DELIVERY = new Set(["pending", "claimed"]);

const DONE_STATUS_LINE = /(?:^|\r?\n)\s*🟢\s*Status:\s*Done\b/;

export interface ArcRunState {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

export const isDelegatedTaskDone = (status: OrchestrationV2Subagent["status"]) =>
  TASK_DONE.has(status);

export const isArcRunObject = (
  run: AnyThreadRun | undefined,
): run is OrchestrationV2ThreadArcRun => run !== undefined && "arc" in run;

export const activeRunOf = (
  thread: Pick<OrchestrationV2AppThread, "arcRun" | "autonomousRun">,
): AnyThreadRun | undefined => thread.arcRun ?? thread.autonomousRun;

export const hasActiveRun = (
  thread: Pick<OrchestrationV2AppThread, "arcRun" | "autonomousRun">,
): boolean => activeRunOf(thread)?.state === "active";

/** Stopped or out of budget: only the owner's message or the thread's own parked wait starts a turn. */
export const isArcRunHeld = (run: AnyThreadRun | undefined) =>
  run?.state === "paused" || run?.state === "attention";

export const isThreadRunHeld = (
  thread: Pick<OrchestrationV2AppThread, "arcRun" | "autonomousRun">,
): boolean => isArcRunHeld(thread.arcRun) || isArcRunHeld(thread.autonomousRun);

export function withoutThreadRun(thread: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const { arcRun: _arcRun, autonomousRun: _autonomousRun, ...rest } = thread;
  return rest;
}

/** True when a completed assistant reply contains the canonical `🟢 Status: Done` status line. */
export const hasDoneStatusMarker = (text: string | undefined): boolean =>
  text !== undefined && DONE_STATUS_LINE.test(text);

/** Away covers every top-level thread and standalone Spec lead (not read-only or writing helpers). */
export const isAwayEligibleThread = (
  thread: { readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "parentThreadId">; readonly agentTask?: OrchestrationV2AppThread["agentTask"] | undefined },
): boolean =>
  (thread.lineage.parentThreadId === null && thread.agentTask === undefined) ||
  thread.agentTask?.role === "lead";

/** Away covers every eligible thread that is live, unsettled and not snoozed. */
export function isCoveredByAway(thread: OrchestrationV2AppThread, now: DateTime.Utc): boolean {
  return (
    isAwayEligibleThread(thread) &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    !(thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  );
}

/** Two runs may share an Arc only when each answers for its own named Specs. */
export const arcRunScopesOverlap = (
  left: ReadonlyArray<number> | undefined,
  right: ReadonlyArray<number> | undefined,
) => left === undefined || right === undefined || left.some((number) => right.includes(number));

/** The parent whose Arc or autonomous run a Spec lead answers to, if it might have one. */
export function arcLeadThreadId(thread: {
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "parentThreadId">;
  readonly agentTask?: OrchestrationV2AppThread["agentTask"] | undefined;
}): OrchestrationV2AppThread["id"] | undefined {
  return thread.agentTask?.role === "lead" && thread.lineage.parentThreadId !== null
    ? thread.lineage.parentThreadId
    : undefined;
}

/** A fixed-choice dialog, such as Claude's resume prompt, has no answer but the owner's. */
export const needsOwnerAnswer = (
  questions: ReadonlyArray<{ readonly allowCustomAnswer?: boolean | undefined }>,
) => questions.some((question) => question.allowCustomAnswer === false);

export const isExclusiveRunStartCommand = (command: OrchestrationV2ServerCommand): boolean =>
  command.type === "thread.arc-run" && command.op === "start";

/** Idle compaction serves the provider's cache: it neither continues a thread nor counts as a turn. */
function isCompactionRun(run: Pick<OrchestrationV2Run, "userMessageId">): boolean {
  return run.userMessageId.startsWith("idle-compact:");
}

const ranSince = (run: OrchestrationV2Run, since: string) =>
  !neverStarted(run) && DateTime.toEpochMillis(run.requestedAt) >= Date.parse(since);

function arcRunNoProgressWakes(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runState: Pick<AnyThreadRun, "progressAt">,
): number {
  return runs.filter(
    (run) =>
      run.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX) && ranSince(run, runState.progressAt),
  ).length;
}

function arcRunTurns(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runState: Pick<AnyThreadRun, "ceilingSince">,
): number {
  return runs.filter((run) => !isCompactionRun(run) && ranSince(run, runState.ceilingSince)).length;
}

export function latestArcRunTurn(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  return runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      !neverStarted(run) &&
      !isCompactionRun(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

/** Whether something already promises to bring this thread back, so a wake would only make it poll. */
function arcRunHasNextTrigger(state: ArcRunState): boolean {
  const { thread, runs } = state;
  if (runs.some((run) => LIVE_RUN.has(run.status))) return true;
  // The owner's answer brings back a lead waiting on its owner.
  if ((thread.parkedWaits?.length ?? 0) > 0 || thread.ownerWait !== undefined) return true;
  if (
    state.subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        (!TASK_DONE.has(task.status) ||
          (task.completionDelivery !== undefined &&
            OWED_DELIVERY.has(task.completionDelivery.state))),
    )
  )
    return true;
  return (
    derivePendingBackgroundWork({
      latestRun: latestArcRunTurn(runs),
      runs,
      providerThreads: state.providerThreads,
      turnItems: state.turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
      pullRequests: thread.pullRequests,
    }).length > 0
  );
}

/**
 * Whether an active Arc or autonomous run needs its lead now. Failed and otherwise ended runs wait
 * for the watchdog, whose interval keeps a broken provider from burning the cap in seconds.
 */
export function decideArcRunWake(
  state: ArcRunState,
  trigger: ArcRunTrigger,
): ArcRunWakeDecision | undefined {
  const runState = activeRunOf(state.thread);
  if (runState === undefined || runState.state !== "active") return undefined;
  const latest = latestArcRunTurn(state.runs);
  if (latest === undefined) return undefined;
  // The ceiling bounds busy runs too: a lead that always has a task out still spends turns.
  if (arcRunTurns(state.runs, runState) >= ARC_RUN_TURN_CEILING) {
    return { kind: "attention", reason: "ceiling" };
  }
  if (arcRunHasNextTrigger(state)) return undefined;
  let kind: "continue" | "failed-run" | "no-next-trigger";
  if (latest.status === "completed") kind = "continue";
  else if (trigger === "event") return undefined;
  else kind = latest.status === "failed" ? "failed-run" : "no-next-trigger";
  if (arcRunNoProgressWakes(state.runs, runState) >= ARC_RUN_NO_PROGRESS_CAP) {
    return { kind: "attention", reason: "no-progress" };
  }
  return { kind };
}

const CONDITION: Record<Exclude<ArcRunWakeDecision["kind"], "attention">, string> = {
  continue: "your last turn ended with nothing set to bring you back",
  "failed-run": "your last turn failed and nothing is set to bring you back",
  "no-next-trigger": "your last turn stopped and nothing is set to bring you back",
};

function runLabel(run: AnyThreadRun): string {
  if (isArcRunObject(run)) {
    return run.arc.ref ?? `#${run.arc.number}`;
  }
  if (run.kind === "spec" && run.spec !== undefined) {
    return run.spec.ref ?? `#${run.spec.number}`;
  }
  return run.label ?? "this task";
}

function checkpointLine(run: AnyThreadRun): string {
  const checkpoint = run.checkpoint;
  if (checkpoint === undefined) return "You have recorded no checkpoint yet.";
  return `Your last checkpoint: ${checkpoint.phase}${checkpoint.note === undefined ? "" : ` (${checkpoint.note})`}.`;
}

function arcRunRole(arcRun: OrchestrationV2ThreadArcRun): string {
  const label = runLabel(arcRun);
  return arcRun.specs === undefined
    ? `You are the Arc lead for ${label}, responsible for its combined outcome.`
    : `You lead Specs ${arcRun.specs.map((number) => `#${number}`).join(", ")} within Arc ${label}, responsible for delivering those and not the rest of the Arc.`;
}

export function describeArcRun(arcRun: OrchestrationV2ThreadArcRun): string {
  const plan =
    arcRun.plan === undefined
      ? "No plan is recorded. Record the intended Spec order with t3_thread_update action arc_run."
      : `Your plan, in order: ${arcRun.plan.map((number) => `#${number}`).join(" → ")}.`;
  const current =
    arcRun.current === undefined
      ? "No current Spec is recorded."
      : `Your current Spec: #${arcRun.current}.`;
  return `${arcRunRole(arcRun)} ${plan} ${current} ${checkpointLine(arcRun)}`;
}

export function describeAutonomousRun(run: OrchestrationV2ThreadAutonomousRun): string {
  const label = runLabel(run);
  const role =
    run.kind === "spec"
      ? `You are running Spec ${label} autonomously, responsible for completing its outcome.`
      : `You are running "${label}" autonomously, responsible for completing its outcome.`;
  return `${role} ${checkpointLine(run)}`;
}

export function describeAnyRun(run: AnyThreadRun): string {
  return isArcRunObject(run) ? describeArcRun(run) : describeAutonomousRun(run);
}

/**
 * The turn-start unattended / autonomous-run note injected on ordinary turns whenever either
 * global Away is on or the thread holds an active Arc or autonomous run.
 */
export function describeUnattendedTurnNote(input: {
  readonly thread: {
    readonly arcRun?: OrchestrationV2ThreadArcRun | undefined;
    readonly autonomousRun?: OrchestrationV2ThreadAutonomousRun | undefined;
    readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "parentThreadId">;
    readonly agentTask?: OrchestrationV2AppThread["agentTask"] | undefined;
  };
  readonly away: boolean;
  readonly skipForWake?: boolean;
  readonly reportsToParentRun?: boolean;
}): string {
  if (input.skipForWake === true) return "";
  const run = activeRunOf(input.thread);
  if (run !== undefined) {
    const summary = describeAnyRun(run);
    return run.state === "active" ? `${summary}\n\n${AUTONOMOUS_AUTHORITY_NOTE}` : summary;
  }
  if (input.away && input.reportsToParentRun !== true && isAwayEligibleThread(input.thread)) {
    return AWAY_TURN_NOTE;
  }
  return "";
}

export function formatDecisionLog(
  decisions: ReadonlyArray<OrchestrationV2ThreadDecisionEntry> | undefined,
): string {
  if (decisions === undefined || decisions.length === 0) return "";
  const lines = decisions.map((entry, index) => {
    const src = entry.source === undefined ? "" : `[${entry.source}] `;
    return `${index + 1}. ${src}${entry.decision} — Alternative: ${entry.alternative}. Why: ${entry.why}. How to reverse: ${entry.howToReverse}.`;
  });
  return `Recorded decisions and assumptions (surface every item in your final report for the owner to review):\n${lines.join("\n")}`;
}

const YIELD_RULE =
  "Before this turn ends, one of these must hold: work is running; a delegated task or watch will wake you; every remaining item is a hard-to-reverse owner hold with a watch on it; or the outcome is complete and you have called t3_thread_update action arc_run with op end. A final report alone does not end the run. Record each step with op checkpoint and each consequential decision/assumption with op decision.";

export function arcRunWakeMessage(input: {
  readonly arcRun: AnyThreadRun;
  readonly decision: Exclude<ArcRunWakeDecision, { readonly kind: "attention" }>;
  readonly answersQuestion: boolean;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { arcRun } = input;
  const label = runLabel(arcRun);
  const isArc = isArcRunObject(arcRun);
  const resumed = arcRun.resumed
    ? " The owner resumed this run after stopping it, so some delegated results may be missing and earlier work may have been stopped. If his message only asked a question, answer it and pause the run with op pause."
    : "";
  const reread = isArc
    ? arcRun.specs === undefined
      ? "the Arc and its member Specs from Forge"
      : "those Specs and the Arc's direction from Forge"
    : arcRun.kind === "spec"
      ? `Spec ${label} from Forge`
      : "the current workspace and task state";
  const body = `${describeAnyRun(arcRun)} T3 resumed this thread because ${CONDITION[input.decision.kind]}.${resumed} Re-read ${reread}, reconcile what is actually delivered and who owns what before dispatching anything, decide within your authority and continue. ${YIELD_RULE}`;
  const text = input.answersQuestion ? `${ARC_RUN_ANSWER}\n\n${body}` : body;
  const prefix = isArc ? `Arc ${label}` : `Run ${label}`;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${prefix}: continuing the work`,
      detail: text,
    },
  };
}

export function arcRunStallMessage(input: {
  readonly arcRun: AnyThreadRun;
  readonly stall: {
    readonly childThreadId: string;
    readonly title: string;
    readonly quietMinutes: number;
    readonly openWork: boolean;
  };
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { stall } = input;
  const label = runLabel(input.arcRun);
  const prefix = isArcRunObject(input.arcRun) ? `Arc ${label}` : `Run ${label}`;
  const text = `${describeAnyRun(input.arcRun)} Your delegated task "${stall.title}" (thread ${stall.childThreadId}) has been silent for ${stall.quietMinutes} minutes${stall.openWork ? " with a command or tool still open, which can be legitimate" : " with nothing open"}. T3 has changed nothing. Read that thread, then decide: leave it, send it a correction, or cancel and replace it. ${YIELD_RULE}`;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${prefix}: "${stall.title}" looks stalled`,
      detail: text,
    },
  };
}

export function arcRunAttentionMessage(input: {
  readonly arcRun: AnyThreadRun;
  readonly reason: "no-progress" | "ceiling";
  readonly decisionLog?: ReadonlyArray<OrchestrationV2ThreadDecisionEntry> | undefined;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const label = runLabel(input.arcRun);
  const prefix = isArcRunObject(input.arcRun) ? `Arc ${label}` : `Run ${label}`;
  const why =
    input.reason === "ceiling"
      ? `this run has reached its limit of ${ARC_RUN_TURN_CEILING} turns without a message from the owner`
      : `T3 woke you ${ARC_RUN_NO_PROGRESS_CAP} times with no checkpoint advancing to a new phase or current Spec`;
  const decisions = formatDecisionLog(input.decisionLog);
  const decisionSuffix = decisions === "" ? "" : `\n\n${decisions}`;
  const text = `${describeAnyRun(input.arcRun)} T3 has stopped waking this thread for ${prefix} because ${why}. This is your last turn until the owner replies. Start no new work. Tell him plainly what is done, what is stuck and what you need from him, then end your turn.${decisionSuffix}`;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${prefix} needs attention`,
      detail: text,
    },
  };
}

/**
 * Pure hook called from Orchestrator's message.dispatch: determines whether a held run holds this
 * message, whether a parked wait resumes it, and any run metadata updates + queued wake run IDs to
 * cancel. Extracted beside Orchestrator.ts so upstream edits stay minimal.
 */
export function evaluateRunOnMessageDispatch(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly command: {
    readonly creationSource: string;
    readonly notification?: { readonly parked?: unknown } | undefined;
    readonly idleCompaction?: unknown | undefined;
    readonly messageId: string;
  };
  readonly sentByUserFromClient: boolean;
  readonly startsOrQueuesRun: boolean;
  readonly resumesThread: boolean;
  readonly now: DateTime.Utc;
}): {
  readonly parkedWakeResumesRun: boolean;
  readonly runHoldsMessage: boolean;
  readonly cancelWakeRunIds: ReadonlyArray<RunId>;
  readonly updatedThread?: OrchestrationV2AppThread;
} {
  const run = activeRunOf(input.thread);
  const held = isArcRunHeld(run);
  const parkedWakeResumesRun =
    held &&
    input.command.creationSource === "server" &&
    input.command.notification?.parked !== undefined;
  const runHoldsMessage =
    held &&
    !input.resumesThread &&
    !parkedWakeResumesRun &&
    input.command.idleCompaction === undefined &&
    !input.command.messageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX);

  if (run === undefined || !input.startsOrQueuesRun) {
    return { parkedWakeResumesRun, runHoldsMessage, cancelWakeRunIds: [] };
  }

  const queuedWakeIds = input.runs
    .filter((r) => r.status === "queued" && r.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX))
    .map((r) => r.id);

  if (input.sentByUserFromClient) {
    const nowIso = DateTime.formatIso(input.now);
    const resumedRun = {
      ...run,
      state: "active" as const,
      progressAt: nowIso,
      ceilingSince: nowIso,
      ...(run.state === "paused" ? { resumed: true as const } : {}),
    };
    const updatedThread: OrchestrationV2AppThread = isArcRunObject(run)
      ? { ...input.thread, arcRun: resumedRun as OrchestrationV2ThreadArcRun }
      : { ...input.thread, autonomousRun: resumedRun as OrchestrationV2ThreadAutonomousRun };
    return {
      parkedWakeResumesRun,
      runHoldsMessage,
      cancelWakeRunIds: queuedWakeIds,
      updatedThread,
    };
  }

  if (parkedWakeResumesRun) {
    const resumedRun = { ...run, state: "active" as const };
    const updatedThread: OrchestrationV2AppThread = isArcRunObject(run)
      ? { ...input.thread, arcRun: resumedRun as OrchestrationV2ThreadArcRun }
      : { ...input.thread, autonomousRun: resumedRun as OrchestrationV2ThreadAutonomousRun };
    return {
      parkedWakeResumesRun,
      runHoldsMessage,
      cancelWakeRunIds: [],
      updatedThread,
    };
  }

  return { parkedWakeResumesRun, runHoldsMessage, cancelWakeRunIds: [] };
}

/**
 * Pure hook called from Orchestrator's holdStoppedThread: pauses an active Arc or autonomous run
 * and identifies any queued wake runs to cancel.
 */
export function evaluateRunOnStop(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly now: DateTime.Utc;
}): {
  readonly cancelWakeRunIds: ReadonlyArray<RunId>;
  readonly updatedThread?: OrchestrationV2AppThread;
} {
  const run = activeRunOf(input.thread);
  if (run === undefined) return { cancelWakeRunIds: [] };
  const cancelWakeRunIds = input.runs
    .filter((r) => r.status === "queued" && r.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX))
    .map((r) => r.id);
  const { resumed: _resumed, ...rest } = run;
  const pausedRun = { ...rest, state: "paused" as const };
  const updatedThread: OrchestrationV2AppThread = isArcRunObject(run)
    ? {
        ...input.thread,
        arcRun: pausedRun as OrchestrationV2ThreadArcRun,
        updatedAt: input.now,
      }
    : {
        ...input.thread,
        autonomousRun: pausedRun as OrchestrationV2ThreadAutonomousRun,
        updatedAt: input.now,
      };
  return { cancelWakeRunIds, updatedThread };
}

export const MAX_DECISION_LOG_ENTRIES = 100;
export const MAX_DECISION_FIELD_CHARS = 1_000;

export function trimDecisionField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_DECISION_FIELD_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_DECISION_FIELD_CHARS - 1)}…`;
}

export function appendDecisionLogEntry(
  existing: ReadonlyArray<OrchestrationV2ThreadDecisionEntry> | undefined,
  entry: OrchestrationV2ThreadDecisionEntry,
): ReadonlyArray<OrchestrationV2ThreadDecisionEntry> {
  const next = [...(existing ?? []), entry];
  return next.length <= MAX_DECISION_LOG_ENTRIES
    ? next
    : next.slice(next.length - MAX_DECISION_LOG_ENTRIES);
}

/** Whether an Arc run claims a specific Spec via its explicit specs, plan, or current pointer. */
export function arcRunClaimsSpec(
  arcRun: Pick<OrchestrationV2ThreadArcRun, "specs" | "plan" | "current"> | undefined,
  specNumber: number,
): boolean {
  if (arcRun === undefined) return false;
  if (arcRun.specs?.includes(specNumber)) return true;
  if (arcRun.plan?.includes(specNumber)) return true;
  return arcRun.current === specNumber;
}

/** Thin hook called by ProviderTurnStartService to compute the turn-start unattended/run note. */
export const resolveUnattendedTurnNote = Effect.fnUntraced(function* <E1, E2>(input: {
  readonly thread: {
    readonly arcRun?: OrchestrationV2ThreadArcRun | undefined;
    readonly autonomousRun?: OrchestrationV2ThreadAutonomousRun | undefined;
    readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "parentThreadId">;
    readonly agentTask?: OrchestrationV2AppThread["agentTask"] | undefined;
  };
  readonly slashCommand: boolean;
  readonly goalCommand: boolean;
  readonly messageId: string;
  readonly getAway: Effect.Effect<boolean, E1>;
  readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E2>;
}) {
  if (input.slashCommand) return "";
  const away = yield* input.getAway;
  const parentLeadId = away ? arcLeadThreadId(input.thread) : undefined;
  const reportsToParentRun =
    parentLeadId === undefined
      ? false
      : yield* input.getThread(parentLeadId).pipe(
          Effect.map((parent) => activeRunOf(parent) !== undefined),
          Effect.orElseSucceed(() => false),
        );
  return describeUnattendedTurnNote({
    thread: input.thread,
    away,
    skipForWake:
      input.goalCommand ||
      input.messageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX) ||
      input.messageId.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX),
    reportsToParentRun,
  });
});
