import type {
  OrchestrationV2AppThread,
  OrchestrationV2Notification,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadWatch,
  OrchestrationV2TurnItem,
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
    "id" | "lineage" | "archivedAt" | "settledOverride" | "settledAt" | "deletedAt"
  >,
  watchedThreadId: string,
): string | undefined {
  if (watcher.deletedAt !== null) return `Thread ${watcher.id} is deleted.`;
  if (watchedThreadId === watcher.id) return "A thread cannot watch itself.";
  if (watcher.lineage.relationshipToParent === "subagent") {
    return `Thread ${watcher.id} is a subagent; its parent thread watches threads.`;
  }
  if (
    watcher.archivedAt !== null ||
    watcher.settledOverride === "settled" ||
    watcher.settledAt !== null
  ) {
    return `Thread ${watcher.id} is settled or archived and cannot watch threads. Unsettle it first.`;
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
  const progress = delegatedTaskProgress(state);
  if (progress.state !== "result_available" || progress.resultRun === undefined) return undefined;
  const status = runOutcome(progress.resultRun);
  return {
    kind: status === "completed" ? "finished" : status === "failed" ? "failed" : "stopped",
    resultRun: progress.resultRun,
  };
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
  readonly watch: Pick<OrchestrationV2ThreadWatch, "threadId">;
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
      case "stopped":
        return `Thread ${link} was stopped before it finished.${said("Its last message, in that thread's own words:")}`;
      case "finished":
        return `Thread ${link} has finished.${said("Its final message, in that thread's own words:")}`;
    }
  })();
  const label = reportLabel(input.title);
  return {
    text: `${body}\n\nT3 Code has stopped watching it. Call watch_thread to be woken again.`,
    notification: {
      source: { kind: "thread", threadId: watch.threadId },
      outcome: OUTCOME[decision.kind],
      summary: label === undefined ? LABEL[decision.kind] : `${LABEL[decision.kind]}: ${label}`,
    },
  };
}
