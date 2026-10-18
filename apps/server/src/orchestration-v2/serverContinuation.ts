import type { OrchestrationV2Run } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

import { neverStarted } from "./RestartBackgroundNote.ts";

export const UNATTENDED_CONTINUATION_MESSAGE_PREFIX = "message:unattended-continuation:";

/** Server continuations in a row without the owner; past this, T3 stops continuing on its own. */
export const MAX_CONTINUATION_CHAIN = 3;

/** A run T3 started on its own to keep a thread going, after a restart or while unattended. */
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
    .filter((run) => run.id === source.id || (!neverStarted(run) && !runRanAfter(run, source)))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : 1));
  let length = 0;
  for (const run of ran) {
    if (!isServerContinuationRun(run)) break;
    length += 1;
  }
  return length;
}
