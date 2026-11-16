import type { OrchestrationV2ThreadShell, OrchestrationV2ThreadStanding } from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

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
      | "parkedWaits"
      | "ownerWait"
    >
  > & {
    /** The `stalled` field of the app thread, which only the stalled reactor writes. */
    readonly stalled?: OrchestrationV2ThreadStanding["stalled"];
    /** A delegated task of this thread has a result that is not yet delivered, acknowledged or disposed. */
    readonly undeliveredDelegatedResult?: boolean;
    /** A delegated thread at any depth below this one waits on an approval only the owner gives. */
    readonly descendantApprovalPending?: boolean;
    /** Delegated children of this thread whose turn has ended and that only wait now. */
    readonly waitingChildThreadIds?: ReadonlySet<string>;
  };

/**
 * The one rule for where a thread stands, evaluated in this order: needs_you, working, stalled,
 * working on its own background work, waiting, finished. Working is the thread's own turn, subagents and awaited work; waiting is a
 * thread whose turn has ended and that waits only on things outside itself.
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
  if (input.ownerWait !== undefined) {
    return { state: "needs_you", question: input.ownerWait.question };
  }
  const acceptance = (input.parkedWaits ?? []).find(
    (wait) => wait.target.kind === "build_item" && wait.waitsOnPerson?.need === "acceptance",
  );
  if (acceptance !== undefined && acceptance.target.kind === "build_item") {
    return {
      state: "needs_you",
      waitsOnPerson: {
        kind: "build_item",
        number: acceptance.target.number,
        ...(acceptance.waitsOnPerson?.ref === undefined
          ? {}
          : { ref: acceptance.waitsOnPerson.ref }),
        title: acceptance.waitsOnPerson?.title ?? acceptance.title,
        need: "acceptance",
      },
    };
  }
  const blocked = input.blockedOnThreadWait === true;
  if ((ownRunActive && !blocked) || input.undeliveredDelegatedResult === true) {
    return { state: "working" };
  }
  if (input.stalled !== undefined) return { state: "stalled", stalled: input.stalled };
  const waitingChildren = input.waitingChildThreadIds ?? new Set<string>();
  const childWaits = (task: NonNullable<ThreadStandingInput["pendingBackgroundTasks"]>[number]) =>
    task.kind === "subagent" &&
    task.childThreadId !== undefined &&
    waitingChildren.has(task.childThreadId);
  const tasks = input.pendingBackgroundTasks ?? [];
  // A turn blocked in `t3_thread_wait` is still the thread's own turn.
  if (blocked || tasks.some((task) => backgroundWorkHoldsCompletion([task]) && !childWaits(task))) {
    return { state: "working" };
  }
  if ((input.parkedWaits?.length ?? 0) > 0 || tasks.some(childWaits)) return { state: "waiting" };
  return { state: "finished" };
}
