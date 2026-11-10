import type { OrchestrationV2Run } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

import { neverStarted } from "./RestartBackgroundNote.ts";

export const UNATTENDED_CONTINUATION_MESSAGE_PREFIX = "message:unattended-continuation:";
export const ARC_RUN_WAKE_MESSAGE_PREFIX = "message:arc-run-wake:";
/** A task's continuation after its parent's Stop: it resumes the thread like its owner's message. */
export const PAUSED_TASK_RESUME_MESSAGE_PREFIX = "message:paused-task-resume:";

/** Server continuations in a row without the owner; past this, T3 stops continuing on its own. */
export const MAX_CONTINUATION_CHAIN = 3;

// Only continuations in quick succession count as a loop; a slow chain is a thread still working.
const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;

/** A run T3 started on its own to keep a thread going, after a restart or while Away. */
export function isServerContinuationRun(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId" | "userMessageId">,
): boolean {
  return (
    run.restartContinuationOfRunId !== undefined ||
    run.userMessageId.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX)
  );
}

/**
 * Restart and unattended continuations share one count, so the two together cannot keep a
 * thread going longer than either alone.
 */
export function serverContinuationChainLength(
  runs: ReadonlyArray<OrchestrationV2Run>,
  source: OrchestrationV2Run,
): number {
  const ran = runs
    // A continuation cut before it started consumed no turn, so it cannot be part of a restart loop.
    .filter(
      (run) =>
        run.startedAt !== null &&
        (run.id === source.id || (!neverStarted(run) && !runRanAfter(run, source))),
    )
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : 1));
  let length = 0;
  for (const run of ran) {
    if (!isServerContinuationRun(run)) break;
    length += 1;
  }
  return length;
}

/**
 * Whether T3 stopped keeping a run going because restarts restarted it too often in a row.
 * Used both where the loop stops and where its result is reported, so they cannot disagree.
 */
export function serverContinuationCapReached(
  runs: ReadonlyArray<OrchestrationV2Run>,
  source: OrchestrationV2Run,
): boolean {
  const loopWindowStart =
    DateTime.toEpochMillis(source.completedAt ?? source.requestedAt) - CONTINUATION_LOOP_WINDOW_MS;
  const loopRuns = runs.filter((run) => DateTime.toEpochMillis(run.requestedAt) >= loopWindowStart);
  return (
    loopRuns.some((run) => run.id === source.id) &&
    serverContinuationChainLength(loopRuns, source) >= MAX_CONTINUATION_CHAIN
  );
}
