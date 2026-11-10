import type {
  OrchestrationV2AppThread,
  OrchestrationV2Notification,
  OrchestrationV2ParkedWait,
  OrchestrationV2ParkedWaitTarget,
} from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

import { watchTargetsEqual } from "./threadWatch.ts";

const NOTE_LENGTH = 4000;

const RUN_ENDED = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

/** What woke the thread, while the turn the wake started has not finished. */
export function liveParkedWaitWoke(
  woke: OrchestrationV2AppThread["parkedWaitWoke"],
  latestRun: { readonly id: string; readonly status: string } | null,
): OrchestrationV2AppThread["parkedWaitWoke"] {
  if (woke === undefined || latestRun === null) return undefined;
  if (woke.runId !== undefined && woke.runId !== latestRun.id) return undefined;
  return RUN_ENDED.has(latestRun.status) ? undefined : woke;
}
const LAST_KNOWN_LENGTH = 1000;

export function parkedWaitTargetsEqual(
  left: OrchestrationV2ParkedWaitTarget,
  right: OrchestrationV2ParkedWaitTarget,
): boolean {
  switch (left.kind) {
    case "production":
      return (
        right.kind === "production" &&
        left.commitId === right.commitId &&
        left.projectId === right.projectId
      );
    case "time":
      return right.kind === "time" && Date.parse(left.at) === Date.parse(right.at);
    default:
      return right.kind !== "production" && right.kind !== "time" && watchTargetsEqual(left, right);
  }
}

/** When the wait must wake on its own: its time, or when it gives up. Undefined: never by time. */
export function parkedWaitDueAt(wait: OrchestrationV2ParkedWait): number | undefined {
  if (wait.target.kind === "time") return Date.parse(wait.target.at);
  return wait.givesUpAt === undefined ? undefined : Date.parse(wait.givesUpAt);
}

const TIME_TITLE_LENGTH = 60;

/** A commit's short id, as clients name it. */
const shortCommit = (commitId: string) => commitId.slice(0, 7);

/**
 * A wait's subject, which clients set in their own sentence: "Wakes when {title} reaches
 * Production", "Wakes {time} to {title}". A time wait takes its note's first words.
 */
export function parkedWaitTitle(
  target: OrchestrationV2ParkedWaitTarget,
  note: string | undefined,
): string | undefined {
  switch (target.kind) {
    case "production":
      return `commit ${shortCommit(target.commitId)}`;
    case "time": {
      const line = (note ?? "")
        .trim()
        .split("\n")[0]!
        .trim()
        .replace(/[.:;!]+$/, "");
      if (line.length === 0) return "check back";
      const cut =
        line.length <= TIME_TITLE_LENGTH
          ? line
          : `${line.slice(0, line.lastIndexOf(" ", TIME_TITLE_LENGTH) > 0 ? line.lastIndexOf(" ", TIME_TITLE_LENGTH) : TIME_TITLE_LENGTH)}…`;
      // "Wakes 9:00 to check the nightly", but an acronym keeps its capital.
      return /^[A-Z][a-z]/.test(cut) ? `${cut[0]!.toLowerCase()}${cut.slice(1)}` : cut;
    }
    default:
      return undefined;
  }
}

/** The thread's own note, quoted so it reads as the agent's words, not T3 Code's. */
export function withParkedNote(
  given: { readonly text: string; readonly notification: OrchestrationV2Notification },
  note: string | undefined,
  parked: "woke" | "gave_up",
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const wake = { ...given, notification: { ...given.notification, parked } };
  const trimmed = note?.trim() ?? "";
  if (trimmed.length === 0) return wake;
  const shown = trimmed.length > NOTE_LENGTH ? `${trimmed.slice(0, NOTE_LENGTH)}…` : trimmed;
  return {
    ...wake,
    text: `${wake.text}\n\nYour note to yourself when you parked:\n\n${shown
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}`,
  };
}

export function productionWake(input: {
  readonly title: string;
  readonly commitId: string;
  readonly repository: string;
  readonly servedCommitId: string;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const served =
    input.servedCommitId === input.commitId
      ? "serves it"
      : `serves ${input.servedCommitId}, which includes it`;
  return {
    text: `Commit ${input.commitId} has reached Production in ${input.repository}: Production ${served}.\n\nT3 Code has stopped waiting for it.`,
    notification: {
      source: { kind: "system" },
      outcome: "completed",
      summary:
        input.title === `commit ${shortCommit(input.commitId)}`
          ? `${input.title} reached Production`
          : `${input.title} reached Production · commit ${shortCommit(input.commitId)}`,
    },
  };
}

export function timeWake(input: { readonly title: string; readonly at: string }): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  return {
    text: `It is ${input.at}, the time this thread was parked until.`,
    notification: {
      source: { kind: "system" },
      outcome: "completed",
      summary: `Woke to ${input.title}`,
    },
  };
}

/** The source a gave-up wake keeps, so it groups with the target's own wakes. */
function gaveUpSource(
  target: OrchestrationV2ParkedWaitTarget,
): OrchestrationV2Notification["source"] {
  switch (target.kind) {
    case "thread":
      return { kind: "thread", threadId: target.threadId };
    case "landing":
      return { kind: "landing", operationId: target.operationId };
    case "build_item":
      return { kind: "build_item", number: target.number, until: target.until };
    default:
      return { kind: "system" };
  }
}

export function gaveUpWake(
  wait: OrchestrationV2ParkedWait,
  lastKnown: string | undefined,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const known = lastKnown?.trim() ?? "";
  const shown = known.length > LAST_KNOWN_LENGTH ? `${known.slice(0, LAST_KNOWN_LENGTH)}…` : known;
  const expected = wait.expectedAt === undefined ? "" : ` You expected it by ${wait.expectedAt}.`;
  return {
    text: `T3 Code gave up waiting for ${wait.title}: it had not happened by ${wait.givesUpAt ?? "its give-up time"}.${expected}\n\n${
      shown.length === 0
        ? "T3 Code learnt nothing more about it while waiting."
        : `What T3 Code last knew: ${shown}`
    }\n\nCheck it yourself, then park again or carry on.`,
    notification: {
      source: gaveUpSource(wait.target),
      outcome: "unknown",
      summary: `Gave up waiting for ${wait.title}`,
    },
  };
}

export function withParkedWaits(
  thread: OrchestrationV2AppThread,
  remaining: ReadonlyArray<OrchestrationV2ParkedWait>,
  gaveUp?: OrchestrationV2AppThread["parkedWaitGaveUp"] | null,
): OrchestrationV2AppThread {
  const { parkedWaits: _waits, parkedWaitGaveUp: previous, ...rest } = thread;
  const kept = gaveUp === undefined ? previous : gaveUp === null ? undefined : gaveUp;
  return {
    ...rest,
    ...(remaining.length === 0 ? {} : { parkedWaits: remaining }),
    ...(kept === undefined ? {} : { parkedWaitGaveUp: kept }),
  };
}

/**
 * Threads holding a held or parked wait; each select reads its partial index.
 */
export const threadsWithWaits = (sql: SqlClient.SqlClient) =>
  sql<{ thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
      INDEXED BY orchestration_v2_projection_threads_watching_idx
    WHERE deleted_at IS NULL
      AND json_array_length(payload_json, '$.threadWatches') > 0
    UNION
    SELECT thread_id FROM orchestration_v2_projection_threads
      INDEXED BY orchestration_v2_projection_threads_parked_idx
    WHERE deleted_at IS NULL
      AND json_array_length(payload_json, '$.parkedWaits') > 0`;
