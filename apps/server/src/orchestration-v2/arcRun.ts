import type {
  OrchestrationV2AppThread,
  OrchestrationV2Notification,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadArcRun,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

import { neverStarted } from "./RestartBackgroundNote.ts";
import { ARC_RUN_WAKE_MESSAGE_PREFIX } from "./serverContinuation.ts";

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

/** Answers an Arc lead's own question: true whether or not the owner is at his desk. */
export const ARC_RUN_ANSWER =
  "This thread is running an Arc, so you decide this yourself from the evidence and the Arc's authority. When you are unsure about a consequential choice, consult the advisor role, then decide. Record anything that truly needs the owner (acceptance, promotion, spending, permission widening, an irreversible choice) as a Forge hold with a watch on it, and carry on with all other work.";

/** How long a Forge watch must stay unreadable before an Arc run stops counting it as a wait. */
export const ARC_RUN_UNREADABLE_WATCH_MS = 60 * 60 * 1000;

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

export interface ArcRunState {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

export const isDelegatedTaskDone = (status: OrchestrationV2Subagent["status"]) =>
  TASK_DONE.has(status);

/** Stopped or out of budget: nothing but the owner's message may start a turn. */
export const isArcRunHeld = (arcRun: OrchestrationV2ThreadArcRun | undefined) =>
  arcRun?.state === "paused" || arcRun?.state === "attention";

/** The parent whose Arc run a Spec lead answers to, if it might have one. */
export function arcLeadThreadId(
  thread: Pick<OrchestrationV2AppThread, "agentTask" | "lineage">,
): OrchestrationV2AppThread["id"] | undefined {
  return thread.agentTask?.role === "lead" && thread.lineage.parentThreadId !== null
    ? thread.lineage.parentThreadId
    : undefined;
}

/** A fixed-choice dialog, such as Claude's resume prompt, has no answer but the owner's. */
export const needsOwnerAnswer = (
  questions: ReadonlyArray<{ readonly allowCustomAnswer?: boolean | undefined }>,
) => questions.some((question) => question.allowCustomAnswer === false);

/** Idle compaction serves the provider's cache: it neither continues a thread nor counts as a turn. */
export function isCompactionRun(run: Pick<OrchestrationV2Run, "userMessageId">): boolean {
  return run.userMessageId.startsWith("idle-compact:");
}

const ranSince = (run: OrchestrationV2Run, since: string) =>
  !neverStarted(run) && DateTime.toEpochMillis(run.requestedAt) >= Date.parse(since);

export function arcRunNoProgressWakes(
  runs: ReadonlyArray<OrchestrationV2Run>,
  arcRun: Pick<OrchestrationV2ThreadArcRun, "progressAt">,
): number {
  return runs.filter(
    (run) =>
      run.userMessageId.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX) && ranSince(run, arcRun.progressAt),
  ).length;
}

export function arcRunTurns(
  runs: ReadonlyArray<OrchestrationV2Run>,
  arcRun: Pick<OrchestrationV2ThreadArcRun, "ceilingSince">,
): number {
  return runs.filter((run) => !isCompactionRun(run) && ranSince(run, arcRun.ceilingSince)).length;
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
export function arcRunHasNextTrigger(state: ArcRunState): boolean {
  const { thread, runs } = state;
  if (runs.some((run) => LIVE_RUN.has(run.status))) return true;
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
      threadWatches: thread.threadWatches,
    }).length > 0
  );
}

/**
 * Whether an active run needs its lead now. Failed and otherwise ended runs wait for the watchdog,
 * whose interval is what keeps a broken provider from burning the cap in seconds.
 */
export function decideArcRunWake(
  state: ArcRunState,
  trigger: ArcRunTrigger,
): ArcRunWakeDecision | undefined {
  const arcRun = state.thread.arcRun;
  if (arcRun === undefined || arcRun.state !== "active") return undefined;
  const latest = latestArcRunTurn(state.runs);
  if (latest === undefined) return undefined;
  // The ceiling bounds busy runs too: a lead that always has a task out still spends turns.
  if (arcRunTurns(state.runs, arcRun) >= ARC_RUN_TURN_CEILING) {
    return { kind: "attention", reason: "ceiling" };
  }
  if (arcRunHasNextTrigger(state)) return undefined;
  let kind: "continue" | "failed-run" | "no-next-trigger";
  if (latest.status === "completed") kind = "continue";
  else if (trigger === "event") return undefined;
  else kind = latest.status === "failed" ? "failed-run" : "no-next-trigger";
  if (arcRunNoProgressWakes(state.runs, arcRun) >= ARC_RUN_NO_PROGRESS_CAP) {
    return { kind: "attention", reason: "no-progress" };
  }
  return { kind };
}

const CONDITION: Record<Exclude<ArcRunWakeDecision["kind"], "attention">, string> = {
  continue: "your last turn ended with nothing set to bring you back",
  "failed-run": "your last turn failed and nothing is set to bring you back",
  "no-next-trigger": "your last turn stopped and nothing is set to bring you back",
};

function arcLabel(arcRun: OrchestrationV2ThreadArcRun): string {
  return arcRun.arc.ref ?? `#${arcRun.arc.number}`;
}

function checkpointLine(arcRun: OrchestrationV2ThreadArcRun): string {
  const checkpoint = arcRun.checkpoint;
  if (checkpoint === undefined) return "You have recorded no checkpoint yet.";
  return `Your last checkpoint: ${checkpoint.phase}${checkpoint.note === undefined ? "" : ` (${checkpoint.note})`}.`;
}

const YIELD_RULE =
  "Before this turn ends, one of these must hold: work is running; a delegated task or watch will wake you; every remaining item is a Forge hold with a watch on it; or the outcome is proven and you have called t3_thread_update action arc_run with op end. A final report alone does not end the run. Record each step with op checkpoint.";

export function arcRunWakeMessage(input: {
  readonly arcRun: OrchestrationV2ThreadArcRun;
  readonly decision: Exclude<ArcRunWakeDecision, { readonly kind: "attention" }>;
  readonly answersQuestion: boolean;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { arcRun } = input;
  const label = arcLabel(arcRun);
  const resumed = arcRun.resumed
    ? " The owner resumed this run after stopping it, so some delegated results may be missing and earlier work may have been stopped. If his message only asked a question, answer it and pause the run with op pause."
    : "";
  const body = `You are the Arc lead for ${label}, responsible for its combined outcome. T3 resumed this thread because ${CONDITION[input.decision.kind]}. ${checkpointLine(arcRun)}${resumed} Re-read the Arc and its member Specs from Forge, reconcile what is actually delivered and who owns what before dispatching anything, decide within your authority and continue. ${YIELD_RULE}`;
  const text = input.answersQuestion ? `${ARC_RUN_ANSWER}\n\n${body}` : body;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `Arc ${label}: continuing the work`,
      detail: text,
    },
  };
}

export function arcRunStallMessage(input: {
  readonly arcRun: OrchestrationV2ThreadArcRun;
  readonly stall: {
    readonly childThreadId: string;
    readonly title: string;
    readonly quietMinutes: number;
    readonly openWork: boolean;
  };
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { stall } = input;
  const label = arcLabel(input.arcRun);
  const text = `You are the Arc lead for ${label}. Your delegated task "${stall.title}" (thread ${stall.childThreadId}) has been silent for ${stall.quietMinutes} minutes${stall.openWork ? " with a command or tool still open, which can be legitimate" : " with nothing open"}. T3 has changed nothing. Read that thread, then decide: leave it, send it a correction, or cancel and replace it. ${YIELD_RULE}`;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `Arc ${label}: "${stall.title}" looks stalled`,
      detail: text,
    },
  };
}

export function arcRunAttentionMessage(input: {
  readonly arcRun: OrchestrationV2ThreadArcRun;
  readonly reason: "no-progress" | "ceiling";
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const label = arcLabel(input.arcRun);
  const why =
    input.reason === "ceiling"
      ? `this run has reached its limit of ${ARC_RUN_TURN_CEILING} turns without a message from the owner`
      : `T3 woke you ${ARC_RUN_NO_PROGRESS_CAP} times with no checkpoint advancing to a new phase`;
  const text = `T3 has stopped waking this thread for Arc ${label} because ${why}. This is your last turn until the owner replies. Start no new work. Tell him plainly what is done, what is stuck and what you need from him, then end your turn.`;
  return {
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `Arc ${label} needs attention`,
      detail: text,
    },
  };
}
