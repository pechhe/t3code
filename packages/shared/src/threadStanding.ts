import type {
  OrchestrationV2ParkedWait,
  OrchestrationV2ParkedWaitGaveUp,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadStanding,
  OrchestrationV2ThreadStandingWaitCategory,
} from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

/** How long a delegated child's live run may go without a provider event before it is stalled. */
export const THREAD_STALLED_AFTER_MS = 30 * 60 * 1000;
/** Agent-set waits longer than this surface to Active as Check wait until visited. */
export const LONG_WAIT_REVIEW_MS = 2 * 60 * 60 * 1000;
/** How long a finished thread may sit in working without a live own or child run before watchdog intervention. */
export const STUCK_WORKING_AFTER_MS = 2 * 60 * 1000;

const OWN_RUN_ACTIVE = new Set<OrchestrationV2ThreadShell["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function isLandingWait(wait: Pick<OrchestrationV2ParkedWait, "target">): boolean {
  return wait.target.kind === "landing" || wait.target.kind === "production";
}

export function isVisitedSince(
  lastVisitedAt: string | null | undefined,
  at: string | null | undefined,
): boolean {
  if (lastVisitedAt == null || at == null) return false;
  const visitedMs = Date.parse(lastVisitedAt);
  const atMs = Date.parse(at);
  return !Number.isNaN(visitedMs) && !Number.isNaN(atMs) && visitedMs >= atMs;
}

export function parkedWaitReviewFlaggedAt(wait: OrchestrationV2ParkedWait): {
  readonly flaggedAt: string;
  readonly reason: "long_wait" | "overdue";
  readonly endsAt?: string;
} | null {
  const startedMs = Date.parse(wait.startedAt);
  if (wait.target.kind === "time") {
    const atMs = Date.parse(wait.target.at);
    if (!Number.isNaN(startedMs) && !Number.isNaN(atMs) && atMs - startedMs > LONG_WAIT_REVIEW_MS) {
      return { flaggedAt: wait.startedAt, reason: "long_wait", endsAt: wait.target.at };
    }
    return null;
  }
  if (wait.overdueAt !== undefined) {
    const endsAt = wait.givesUpAt ?? wait.expectedAt;
    return {
      flaggedAt: wait.overdueAt,
      reason: "overdue",
      ...(endsAt === undefined ? {} : { endsAt }),
    };
  }
  if (wait.expectedAt !== undefined) {
    const expectedMs = Date.parse(wait.expectedAt);
    if (
      !Number.isNaN(startedMs) &&
      !Number.isNaN(expectedMs) &&
      expectedMs - startedMs > LONG_WAIT_REVIEW_MS
    ) {
      const endsAt = wait.givesUpAt ?? wait.expectedAt;
      return {
        flaggedAt: wait.startedAt,
        reason: "long_wait",
        ...(endsAt === undefined ? {} : { endsAt }),
      };
    }
  }
  return null;
}

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
      | "parkedWaitGaveUp"
    >
  > & {
    /** The `stalled` field of the app thread, which only the liveness watchdog writes. */
    readonly stalled?: OrchestrationV2ThreadStanding["stalled"];
    /** A delegated task of this thread has a result that is not yet delivered, acknowledged or disposed. */
    readonly undeliveredDelegatedResult?: boolean;
    /** A delegated thread at any depth below this one waits on an approval only the owner gives. */
    readonly descendantApprovalPending?: boolean;
    /** Delegated children of this thread whose turn has ended and that only wait now. */
    readonly waitingChildThreadIds?: ReadonlySet<string>;
    /** Subset of waitingChildThreadIds whose waits are exclusively landing/production waits. */
    readonly waitingChildLandingThreadIds?: ReadonlySet<string>;
    /** Owner's last visit timestamp, used to clear visit-acknowledged flags (Check wait, Wait gave up, Failed). */
    readonly lastVisitedAt?: string | null;
    /** Timestamp when the latest failed run ended, for unseen-failure gating. */
    readonly latestRunFailedAt?: string | null;
  };

/**
 * One precedence rule for thread standing: blocking requests, active run, unseen failure, stalled,
 * undelivered/awaited work, owner/person/review/gave-up waits, healthy waits (landing vs waiting), finished.
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

  if (needsAnswer) {
    return { state: "needs_you", reason: request.kind === "user_input" ? "input" : "approval" };
  }
  if ((input.pendingReleaseApprovals?.length ?? 0) > 0) {
    return { state: "needs_you", reason: "release" };
  }
  if ((input.pendingGuestMessageCount ?? 0) > 0) {
    return { state: "needs_you", reason: "guest" };
  }
  if (input.descendantApprovalPending === true) {
    return { state: "needs_you", reason: "approval" };
  }
  if (planReady) {
    return { state: "needs_you", reason: "plan_ready" };
  }

  const blocked = input.blockedOnThreadWait === true;
  if (ownRunActive && !blocked) {
    return { state: "working" };
  }

  if (input.status === "failed" && !isVisitedSince(input.lastVisitedAt, input.latestRunFailedAt)) {
    return { state: "needs_you", reason: "failed" };
  }

  if (input.stalled !== undefined) {
    return { state: "stalled", reason: "stalled", stalled: input.stalled };
  }

  if (input.undeliveredDelegatedResult === true) {
    return { state: "working" };
  }

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

  if (input.ownerWait !== undefined) {
    return { state: "needs_you", reason: "question", question: input.ownerWait.question };
  }

  const ownWaits = input.parkedWaits ?? [];
  const personWait = ownWaits.find(
    (wait) =>
      wait.waitsOnPerson !== undefined &&
      wait.waitsOnPerson.need !== "hold" &&
      (wait.target.kind === "build_item" ||
        (wait.target.kind === "production" && wait.waitsOnPerson.need === "release_approval")),
  );
  if (personWait !== undefined && personWait.waitsOnPerson !== undefined) {
    if (personWait.target.kind === "build_item") {
      const need = personWait.waitsOnPerson.need;
      return {
        state: "needs_you",
        reason: need === "acceptance" ? "acceptance" : "wait_target_blocked",
        waitsOnPerson: {
          kind: "build_item",
          number: personWait.target.number,
          ...(personWait.waitsOnPerson.ref === undefined
            ? {}
            : { ref: personWait.waitsOnPerson.ref }),
          title: personWait.waitsOnPerson.title ?? personWait.title,
          need,
        },
      };
    }
    if (
      personWait.target.kind === "production" &&
      personWait.waitsOnPerson.need === "release_approval"
    ) {
      return {
        state: "needs_you",
        reason: "release",
        waitsOnPerson: {
          kind: "production",
          ...(personWait.waitsOnPerson.ref === undefined
            ? {}
            : { ref: personWait.waitsOnPerson.ref }),
          title: personWait.waitsOnPerson.title ?? personWait.title,
          need: "release_approval",
        },
      };
    }
  }

  const gaveUp: OrchestrationV2ParkedWaitGaveUp | undefined = input.parkedWaitGaveUp;
  if (gaveUp !== undefined && !isVisitedSince(input.lastVisitedAt, gaveUp.at)) {
    return { state: "needs_you", reason: "wait_gave_up" };
  }

  for (const wait of ownWaits) {
    const flag = parkedWaitReviewFlaggedAt(wait);
    if (flag !== null && !isVisitedSince(input.lastVisitedAt, flag.flaggedAt)) {
      return {
        state: "needs_you",
        reason: "check_wait",
        waitReview: {
          waitId: wait.id,
          title: wait.title,
          kind: wait.target.kind,
          startedAt: wait.startedAt,
          flaggedAt: flag.flaggedAt,
          ...(flag.endsAt === undefined ? {} : { endsAt: flag.endsAt }),
          reason: flag.reason,
        },
      };
    }
  }

  const waitingChildTasks = tasks.filter(childWaits);
  if (ownWaits.length > 0 || waitingChildTasks.length > 0) {
    const landingChildren = input.waitingChildLandingThreadIds ?? new Set<string>();
    const allOwnLanding = ownWaits.every(isLandingWait);
    const allChildLanding = waitingChildTasks.every(
      (task) =>
        task.kind === "subagent" &&
        task.childThreadId !== undefined &&
        landingChildren.has(task.childThreadId),
    );
    const waitCategory: OrchestrationV2ThreadStandingWaitCategory =
      allOwnLanding && allChildLanding ? "landing" : "waiting";
    return { state: "waiting", waitCategory };
  }

  return { state: "finished" };
}
