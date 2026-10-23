import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { NodeId, ThreadId } from "@t3tools/contracts";

import {
  notificationSubagentRefs,
  subagentFollowUpRound,
  subagentFollowUpVerb,
  subagentReturnStatus,
  subagentReturnVerb,
} from "./V2LifecycleRow.logic";

const reviewerTaskId = NodeId.make("node:delegated-task:followup-2");
const reviewerThreadId = ThreadId.make("thread:reviewer");

describe("subagent return chip refs", () => {
  it("names the round a delegated task reports, not the whole child conversation", () => {
    expect(
      notificationSubagentRefs({
        kind: "delegated_task",
        taskIds: [reviewerTaskId],
        childThreadId: reviewerThreadId,
      }),
    ).toEqual([{ subagentId: reviewerTaskId, childThreadId: reviewerThreadId }]);
  });

  it("shows one chip per named task when a batch names no child conversation", () => {
    const otherTaskId = NodeId.make("node:delegated-task:other");
    expect(
      notificationSubagentRefs({ kind: "delegated_task", taskIds: [reviewerTaskId, otherTaskId] }),
    ).toEqual([{ subagentId: reviewerTaskId }, { subagentId: otherTaskId }]);
  });

  it("keeps one chip for a batch that also names its child conversation", () => {
    expect(
      notificationSubagentRefs({
        kind: "delegated_task",
        taskIds: [reviewerTaskId, NodeId.make("node:delegated-task:other")],
        childThreadId: reviewerThreadId,
      }),
    ).toEqual([{ childThreadId: reviewerThreadId }]);
  });

  it("uses the child conversation for a background subagent", () => {
    expect(notificationSubagentRefs({ kind: "subagent", childThreadId: reviewerThreadId })).toEqual(
      [{ childThreadId: reviewerThreadId }],
    );
  });
});

const at = (minute: string) => DateTime.makeUnsafe(`2026-10-23T09:${minute}:00.000Z`);

function task(
  id: string,
  overrides: Partial<Parameters<typeof subagentFollowUpRound>[0][number]> = {},
) {
  return {
    id,
    origin: "app_owned" as const,
    childThreadId: "thread:reviewer",
    startedAt: at("00"),
    updatedAt: at("00"),
    ...overrides,
  };
}

describe("subagent return outcomes", () => {
  it.each([
    { outcome: "completed", verb: "returned", status: "completed" },
    { outcome: "failed", verb: "failed", status: "failed" },
    { outcome: "cancelled", verb: "stopped", status: "cancelled" },
    { outcome: "updated", verb: "sent an update", status: null },
    { outcome: "unknown", verb: "returned", status: null },
  ] as const)(
    "describes a $outcome return with its verb and status",
    ({ outcome, verb, status }) => {
      expect(subagentReturnVerb(outcome)).toBe(verb);
      expect(subagentReturnStatus(outcome)).toBe(status);
    },
  );
});

describe("subagent follow-up rounds", () => {
  it("keeps the assignment that started a child conversation as the card", () => {
    expect(subagentFollowUpRound([task("task:first")], "task:first")).toBeNull();
  });

  it("numbers later tasks in the same child conversation as follow-up rounds", () => {
    const rounds = [
      task("task:first", { startedAt: at("00") }),
      task("task:second", { startedAt: at("05") }),
      task("task:third", { startedAt: at("10") }),
    ];
    expect(subagentFollowUpRound(rounds, "task:first")).toBeNull();
    expect(subagentFollowUpRound(rounds, "task:second")).toBe(2);
    expect(subagentFollowUpRound(rounds, "task:third")).toBe(3);
  });

  it("counts rounds by when they started, even out of projection order", () => {
    const rounds = [
      task("task:second", { startedAt: at("05") }),
      task("task:first", { startedAt: at("00") }),
    ];
    expect(subagentFollowUpRound(rounds, "task:second")).toBe(2);
  });

  it("does not treat another conversation or a provider-native task as a follow-up", () => {
    const rounds = [
      task("task:first"),
      task("task:other-thread", { childThreadId: "thread:other" }),
      task("task:native", { origin: "provider_native" }),
      task("task:native-second", { origin: "provider_native" }),
    ];
    expect(subagentFollowUpRound(rounds, "task:other-thread")).toBeNull();
    expect(subagentFollowUpRound(rounds, "task:native-second")).toBeNull();
  });

  it("treats a task the projection does not know as no follow-up", () => {
    expect(subagentFollowUpRound([task("task:first")], "task:missing")).toBeNull();
  });
});

describe("follow-up verbs", () => {
  it.each([
    { status: "running", reviewing: true, verb: "reviewing…" },
    { status: "waiting", reviewing: false, verb: "working…" },
    { status: "pending", reviewing: false, verb: "working…" },
    { status: "completed", reviewing: true, verb: "sent" },
    { status: "failed", reviewing: true, verb: "sent" },
    { status: "cancelled", reviewing: false, verb: "sent" },
    { status: "interrupted", reviewing: false, verb: "sent" },
  ] as const)("describes a $status follow-up as $verb", ({ status, reviewing, verb }) => {
    expect(subagentFollowUpVerb(status, reviewing)).toBe(verb);
  });
});
