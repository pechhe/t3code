import { isLeafSubagentThread } from "@t3tools/contracts";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Notification,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ServerCommand,
  OrchestrationV2WatchTarget,
  ForgeWorkItemSummary,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import {
  delegatedTaskProgress,
  delegatedTaskProgressTurnItems,
} from "@t3tools/provider-core/server/subagentProjection";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as DateTime from "effect/DateTime";

import { runOutcome } from "./RestartBackgroundNote.ts";

const QUOTE_LENGTH = 4000;

export type WatchedThreadState = Parameters<typeof delegatedTaskProgress>[0] & {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "archivedAt" | "deletedAt">;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
};

export type ThreadWatchDecision =
  | { readonly kind: "archived" }
  | {
      readonly kind: "needs-input";
      /** Oldest first. */
      readonly requests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
    }
  | { readonly kind: "failed" | "stopped" | "finished"; readonly resultRun: OrchestrationV2Run };

/**
 * Why `watcher` cannot start a watch on `watchedThreadId`, if it cannot. A subagent reports to its
 * parent thread, which owns what it waits on.
 */
export function threadWatchRefusal(
  watcher: Pick<
    OrchestrationV2AppThread,
    "id" | "lineage" | "agentTask" | "archivedAt" | "settledOverride" | "settledAt" | "deletedAt"
  >,
  watchedThreadId?: string,
): string | undefined {
  if (watcher.deletedAt !== null) return `Thread ${watcher.id} is deleted.`;
  if (watchedThreadId === watcher.id) return "A thread cannot watch itself.";
  if (isLeafSubagentThread(watcher)) {
    return `Thread ${watcher.id} is a subagent; its parent thread watches targets.`;
  }
  if (
    watcher.archivedAt !== null ||
    watcher.settledOverride === "settled" ||
    watcher.settledAt !== null
  ) {
    return `Thread ${watcher.id} is settled or archived and cannot watch targets. Unsettle it first.`;
  }
  return undefined;
}

/** What `decideThreadWatch` reads of the watched thread, shared by the reactor and the orchestrator. */
export const watchedThreadRecords = {
  fields: ["runs", "messages", "subagents", "providerThreads", "turnItems", "runtimeRequests"],
  filter: { messageRoles: ["user"], ...delegatedTaskProgressTurnItems },
} as const;

/** Tool calls and credential refreshes wait on the provider or T3 Code, not on a person. */
const waitsOnPerson = (request: OrchestrationV2RuntimeRequest) =>
  request.status === "pending" &&
  request.kind !== "dynamic_tool_call" &&
  request.kind !== "auth_refresh";

/**
 * A run is over once it has one of these statuses; any other, including one the contract may add
 * later, is still unfinished, so a watch never wakes early.
 */
const RUN_ENDED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/** The first outcome that applies, in precedence order, or none while the thread still works. */
export function decideThreadWatch(state: WatchedThreadState): ThreadWatchDecision | undefined {
  if (state.thread.archivedAt !== null || state.thread.deletedAt !== null) {
    return { kind: "archived" };
  }
  const requests = state.runtimeRequests
    .filter(waitsOnPerson)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    );
  if (requests.length > 0) return { kind: "needs-input", requests };
  // The watch promises the thread's work, so no run of it may be unfinished: `delegatedTaskProgress`
  // leaves out a monitor run and a run a held queue has not started, either of which would otherwise
  // report an older run's result while the thread still works.
  if (state.runs.some((entry) => !RUN_ENDED.has(entry.status))) return undefined;
  const progress = delegatedTaskProgress(state);
  if (progress.state !== "result_available" || progress.resultRun === undefined) return undefined;
  const status = runOutcome(progress.resultRun);
  return {
    kind: status === "completed" ? "finished" : status === "failed" ? "failed" : "stopped",
    resultRun: progress.resultRun,
  };
}

/**
 * Wakes from a fired watch on `watchedThreadId` still queued behind the watcher's active run. They
 * go stale once the watcher unwatches or reads the result, so both cancel them.
 */
export function queuedThreadWatchWakes(
  watcher: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  },
  target: string | OrchestrationV2WatchTarget,
): ReadonlyArray<OrchestrationV2Run> {
  const wakeMessageIds = new Set(
    watcher.messages
      .filter((message) =>
        typeof target === "string" || target.kind === "thread"
          ? message.notification?.source.kind === "thread" &&
            message.notification.source.threadId ===
              (typeof target === "string" ? target : target.threadId)
          : target.kind === "landing"
            ? message.notification?.source.kind === "landing" &&
              message.notification.source.operationId === target.operationId
            : message.notification?.source.kind === "build_item" &&
              message.notification.source.number === target.number &&
              message.notification.source.until === target.until,
      )
      .map((message) => message.id),
  );
  return watcher.runs.filter(
    (run) => run.status === "queued" && wakeMessageIds.has(run.userMessageId),
  );
}

/** What a person is asked, from the request's own turn item. */
export function requestPrompt(
  request: OrchestrationV2RuntimeRequest,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): string | undefined {
  for (const item of turnItems) {
    if (item.type === "user_input_request" && item.requestId === request.id) {
      return item.questions.map((question) => question.question).join("\n");
    }
    if (item.type === "approval_request" && item.requestId === request.id) {
      return item.prompt ?? item.title ?? undefined;
    }
  }
  return undefined;
}

const LABEL: Record<ThreadWatchDecision["kind"], string> = {
  archived: "Archived or deleted",
  "needs-input": "Needs input",
  failed: "Failed",
  stopped: "Stopped",
  finished: "Finished",
};

const OUTCOME: Record<ThreadWatchDecision["kind"], OrchestrationV2Notification["outcome"]> = {
  archived: "cancelled",
  "needs-input": "updated",
  failed: "failed",
  stopped: "cancelled",
  finished: "completed",
};

const WORK_NAME_LENGTH = 200;

/** A name the watched agent gave its work, shown as code so it cannot read as T3 Code's words. */
function workName(name: string): string {
  const line = name.replaceAll("`", "'").replaceAll(/\s+/g, " ").trim();
  return `\`${line.length > WORK_NAME_LENGTH ? `${line.slice(0, WORK_NAME_LENGTH)}…` : line}\``;
}

function quote(text: string, threadId: string): string {
  const trimmed = text.trim();
  const cut = trimmed.length > QUOTE_LENGTH;
  const shown = cut ? `${trimmed.slice(0, QUOTE_LENGTH)}…` : trimmed;
  const lines = shown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return cut
    ? `${lines}\n\nThis was cut short. Read the rest with t3_thread_read using threadId ${threadId}.`
    : lines;
}

/**
 * The wake reports T3 Code's own facts, and quotes the watched thread only as that thread's words,
 * so a watched agent cannot pose as T3 Code to its watcher.
 */
export function threadWatchWake(input: {
  readonly watch: { readonly threadId: ThreadId };
  readonly title: string;
  readonly decision: ThreadWatchDecision;
  /** The result, error or oldest request, in the watched thread's own words. */
  readonly detail: string | undefined;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { decision, watch } = input;
  const link = `[${input.title.replaceAll("]", "\\]")}](t3-thread://v1/${watch.threadId})`;
  const said = (intro: string) =>
    input.detail === undefined || input.detail.trim().length === 0
      ? ""
      : `\n\n${intro}\n\n${quote(input.detail, watch.threadId)}`;
  const body = (() => {
    switch (decision.kind) {
      case "archived":
        return `Thread ${link} was archived or deleted before it finished.`;
      case "needs-input": {
        const count = decision.requests.length;
        return `Thread ${link} is waiting for a person: it has ${count === 1 ? "1 pending request" : `${count} pending requests`}. Read and answer one with t3_pending_request_read and t3_pending_request_respond using threadId ${watch.threadId}, or ask the user.${said(`Its oldest request, in that thread's own words:`)}`;
      }
      case "failed":
        return `Thread ${link} failed.${said("Its error:")}`;
      case "stopped": {
        const work = decision.resultRun.stoppedBackgroundWork ?? [];
        const cut =
          work.length === 0
            ? ""
            : ` Its background work was stopped with it: ${work.map(workName).join(", ")}.`;
        return `Thread ${link} was stopped before it finished.${cut}${said("Its last message, in that thread's own words:")}`;
      }
      case "finished":
        return `Thread ${link} has finished.${said("Its final message, in that thread's own words:")}`;
    }
  })();
  const label = reportLabel(input.title);
  return {
    text: `${body}\n\nT3 Code has stopped watching it. Call watch with a thread target to be woken again.`,
    notification: {
      source: { kind: "thread", threadId: watch.threadId },
      outcome: OUTCOME[decision.kind],
      summary: label === undefined ? LABEL[decision.kind] : `${LABEL[decision.kind]}: ${label}`,
    },
  };
}

/** Equality includes the Build condition: an item can be watched for both milestones. */
export function watchTargetsEqual(
  left: OrchestrationV2WatchTarget,
  right: OrchestrationV2WatchTarget,
): boolean {
  switch (left.kind) {
    case "thread":
      return right.kind === "thread" && left.threadId === right.threadId;
    case "landing":
      return right.kind === "landing" && left.operationId === right.operationId;
    case "build_item":
      return (
        right.kind === "build_item" && left.number === right.number && left.until === right.until
      );
  }
}

export function decideBuildWatch(
  target: Extract<OrchestrationV2WatchTarget, { readonly kind: "build_item" }>,
  item: ForgeWorkItemSummary,
): "unblocked" | "closed" | "dropped" | undefined {
  if (item.status === "dropped") return "dropped";
  if (target.until === "closed") {
    return item.status === "landed" || item.status === "accepted" ? "closed" : undefined;
  }
  return item.holds.length === 0 && item.waits.length === 0 ? "unblocked" : undefined;
}

export function buildWatchWake(input: {
  readonly target: Extract<OrchestrationV2WatchTarget, { readonly kind: "build_item" }>;
  readonly ref?: string | undefined;
  readonly title: string;
  readonly url: string;
  readonly condition: "unblocked" | "closed" | "dropped";
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { target, condition } = input;
  const label = input.ref ?? `#${target.number}`;
  const met =
    condition === "dropped"
      ? "was Dropped"
      : condition === "unblocked"
        ? "is unblocked: all waits and holds are clear"
        : "is closed (Landed or Accepted)";
  return {
    text: `Build ${label} ${workName(input.title)} ${met}. ${input.url}\n\nT3 Code has stopped watching it. Call watch again to be woken again.`,
    notification: {
      source: { kind: "build_item", number: target.number, until: target.until },
      outcome: condition === "dropped" ? "cancelled" : "completed",
      summary: `Build ${label}: ${condition}`,
    },
  };
}

type LandingWakeInput = NonNullable<
  Extract<OrchestrationV2ServerCommand, { readonly type: "thread.thread-watch.fire" }>["landing"]
>;

const LANDING_REASON_LENGTH = 1000;

const LANDING_LABEL: Record<LandingWakeInput["outcome"], string> = {
  landed: "landed",
  failed: "failed",
  cancelled: "was cancelled",
  declined: "was declined",
  unknown: "ended without a recorded outcome",
};

const LANDING_OUTCOME: Record<LandingWakeInput["outcome"], OrchestrationV2Notification["outcome"]> =
  {
    landed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    declined: "cancelled",
    unknown: "unknown",
  };

/** The wake reports SlipJay's recorded facts; the failure reason is quoted as runner text. */
export function landingWatchWake(landing: LandingWakeInput): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const label = landing.spec === undefined ? landing.repository : `Build #${landing.spec}`;
  const lines = [
    `The landing of ${label} in ${landing.repository} (operation ${landing.operationId}) ${LANDING_LABEL[landing.outcome]}${
      landing.outcome === "failed" || landing.outcome === "unknown" ? ` at ${landing.stage}` : ""
    }.`,
  ];
  if (landing.commitId !== undefined) lines.push(`Published commit: ${landing.commitId}.`);
  if (landing.reason !== undefined) {
    const reason = landing.reason.trim();
    const shown =
      reason.length > LANDING_REASON_LENGTH ? `${reason.slice(0, LANDING_REASON_LENGTH)}…` : reason;
    lines.push("", "SlipJay's recorded reason:", ...shown.split("\n").map((line) => `> ${line}`));
  }
  lines.push(
    "",
    landing.outcome === "failed"
      ? `Read the runner log with \`slipjay runner log ${landing.operationId}\`; \`slipjay repair ${landing.operationId}\` starts a repair of this failed operation. T3 Code has stopped watching this landing.`
      : "T3 Code has stopped watching this landing. If you already saw this result, there is nothing more to do.",
  );
  return {
    text: lines.join("\n"),
    notification: {
      source: { kind: "landing", operationId: landing.operationId },
      outcome: LANDING_OUTCOME[landing.outcome],
      summary: `Landing of ${label}: ${landing.outcome}`,
    },
  };
}

const SLIPJAY_LAND_COMMAND = /\bslipjay\s+land\b/;

/**
 * Whether the thread's own `slipjay land` already hands, or will hand, it this landing's verdict:
 * a command of a run still going that is landing, or one whose output names the operation.
 */
export function landingVerdictReachesRun(
  state: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
  operationId: string,
): boolean {
  const active = new Set(
    state.runs.filter((run) => !RUN_ENDED.has(run.status)).map((run) => run.id),
  );
  return state.turnItems.some(
    (item) =>
      item.type === "command_execution" &&
      item.runId !== null &&
      active.has(item.runId) &&
      (item.output?.includes(operationId) === true ||
        ((item.status === "pending" || item.status === "running" || item.status === "waiting") &&
          SLIPJAY_LAND_COMMAND.test(item.input))),
  );
}
