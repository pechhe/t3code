import type { OrchestrationV2ThreadShell, OrchestrationV2ThreadStanding } from "@t3tools/contracts";

import {
  backgroundWorkHoldsCompletion,
  threadWatchTaskId,
} from "./orchestrationV2PendingBackgroundWork.ts";

/** How long a delegated child's live run may go without a provider event before it is stalled. */
export const THREAD_STALLED_AFTER_MS = 30 * 60 * 1000;

const OWN_RUN_ACTIVE = new Set<OrchestrationV2ThreadShell["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export type ThreadStandingInput = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "activeRunId"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "pendingRuntimeRequest"
> &
  Partial<
    Pick<
      OrchestrationV2ThreadShell,
      | "blockedOnThreadWait"
      | "pendingReleaseApprovals"
      | "pendingGuestMessageCount"
      | "lastErrorClass"
      | "pendingBackgroundTasks"
      | "threadWatches"
    >
  > & {
    /** The `stalled` field of the app thread, which only the stalled reactor writes. */
    readonly stalled?: OrchestrationV2ThreadStanding["stalled"];
    /** A delegated task of this thread has a result that is not yet delivered, acknowledged or disposed. */
    readonly undeliveredDelegatedResult?: boolean;
    /** A delegated thread at any depth below this one waits on an approval only the owner gives. */
    readonly descendantApprovalPending?: boolean;
  };

/**
 * The one rule for where a thread stands, evaluated in this order: needs_you, working, stalled,
 * needs_you (every wait is on a person), waiting, finished.
 */
export function deriveThreadStanding(input: ThreadStandingInput): OrchestrationV2ThreadStanding {
  const ownRunActive = OWN_RUN_ACTIVE.has(input.status) || input.activeRunId !== null;
  const request = input.pendingRuntimeRequest;
  const needsAnswer = request !== null && request.kind !== "auth_refresh";
  const planReady =
    input.interactionMode === "plan" &&
    input.hasActionableProposedPlan &&
    !ownRunActive &&
    request?.kind !== "user_input";
  if (
    needsAnswer ||
    (input.pendingReleaseApprovals?.length ?? 0) > 0 ||
    (input.pendingGuestMessageCount ?? 0) > 0 ||
    input.descendantApprovalPending === true ||
    planReady ||
    input.status === "failed"
  ) {
    return { state: "needs_you" };
  }
  const blocked = input.blockedOnThreadWait === true;
  if ((ownRunActive && !blocked) || input.undeliveredDelegatedResult === true) {
    return { state: "working" };
  }
  if (input.stalled !== undefined) return { state: "stalled", stalled: input.stalled };

  const waits = (input.pendingBackgroundTasks ?? []).filter((task) =>
    backgroundWorkHoldsCompletion([task]),
  );
  if (!blocked && waits.length === 0) return { state: "finished" };

  if (!blocked) {
    const people = waits.flatMap((task) => {
      const watch = (input.threadWatches ?? []).find(
        (candidate) => threadWatchTaskId(candidate.id) === task.taskId,
      );
      return watch?.waitsOnPerson !== undefined && watch.target.kind === "build_item"
        ? [
            {
              number: watch.target.number,
              ...(watch.waitsOnPerson.ref === undefined ? {} : { ref: watch.waitsOnPerson.ref }),
              title: watch.waitsOnPerson.title ?? watch.title,
              need: watch.waitsOnPerson.need,
            },
          ]
        : [];
    });
    const first = people[0];
    if (first !== undefined && people.length === waits.length) {
      return { state: "needs_you", waitsOnPerson: { kind: "build_item", ...first } };
    }
  }
  return { state: "waiting" };
}
