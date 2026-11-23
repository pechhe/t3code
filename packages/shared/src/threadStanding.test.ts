import { describe, expect, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, type ThreadId } from "@t3tools/contracts";

import {
  deriveThreadStanding,
  isLandingWait,
  parkedWaitReviewFlaggedAt,
  type ThreadStandingInput,
} from "./threadStanding.ts";

const base: ThreadStandingInput = {
  status: "completed",
  activeRunId: null,
  interactionMode: "default",
  hasActionableProposedPlan: false,
  pendingRuntimeRequest: null,
};
const run = RunId.make("run:standing");
const child = "thread-child" as ThreadId;
const stalled = { childThreadId: child, title: "Quiet", since: "2026-11-10T10:00:00.000Z" };
const subagent = { taskId: "task-1", kind: "subagent" as const };
const childSubagent = { taskId: "task-2", kind: "subagent" as const, childThreadId: child };
const wait = {
  id: "w1",
  title: "Build #7",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "build_item" as const, number: 7, until: "unblocked" as const },
};
const shortTimeWait = {
  id: "w2",
  title: "check back",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "time" as const, at: "2026-11-10T10:30:00.000Z" },
};
const longTimeWait = {
  id: "w3",
  title: "check call drop telemetry",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "time" as const, at: "2026-11-10T15:00:00.000Z" },
};
const landingWait = {
  id: "w4",
  title: "pechhe/yardsmith",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "landing" as const, operationId: "op_123" },
  landingStage: "verifying",
};
const productionWait = {
  id: "w5",
  title: "Commit abc1234",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "production" as const, commitId: "abc1234" },
};
const ownerWait = { question: "Which option?", startedAt: "2026-11-10T09:30:00.000Z" };
const request = (kind: "command" | "user_input" | "auth_refresh") =>
  ({
    id: RuntimeRequestId.make("request-1"),
    kind,
    createdAt: "2026-11-10T09:00:00.000Z",
  }) as never;

describe("deriveThreadStanding", () => {
  it.each([
    ["a finished thread", {}, { state: "finished" }],
    ["a thread that never ran", { status: "idle" }, { state: "finished" }],
    ["a running thread", { status: "running", activeRunId: run }, { state: "working" }],
    ["a queued thread", { status: "queued" }, { state: "working" }],
    [
      "a finished run whose delegated result is not delivered",
      { undeliveredDelegatedResult: true },
      { state: "working" },
    ],
    ["a live delegated task", { pendingBackgroundTasks: [subagent] }, { state: "working" }],
    [
      "a run blocked on a thread wait",
      { status: "running", activeRunId: run, blockedOnThreadWait: true },
      { state: "working" },
    ],
    [
      "a short time wait on something outside",
      { parkedWaits: [shortTimeWait] },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a landing wait tagged with landing waitCategory",
      { parkedWaits: [landingWait] },
      { state: "waiting", waitCategory: "landing" },
    ],
    [
      "a production wait tagged with landing waitCategory",
      { parkedWaits: [productionWait] },
      { state: "waiting", waitCategory: "landing" },
    ],
    [
      "mixed landing and non-landing waits tagged waiting",
      { parkedWaits: [landingWait, shortTimeWait] },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a long (>2h) time wait surfaces Check wait until visited",
      { parkedWaits: [longTimeWait] },
      {
        state: "needs_you",
        reason: "check_wait",
        waitReview: {
          waitId: "w3",
          title: "check call drop telemetry",
          kind: "time",
          startedAt: "2026-11-10T09:00:00.000Z",
          flaggedAt: "2026-11-10T09:00:00.000Z",
          endsAt: "2026-11-10T15:00:00.000Z",
          reason: "long_wait",
        },
      },
    ],
    [
      "a long time wait returns to waiting once visited after startedAt",
      { parkedWaits: [longTimeWait], lastVisitedAt: "2026-11-10T09:05:00.000Z" },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "an overdue event wait surfaces Check wait until visited after overdueAt",
      {
        parkedWaits: [
          {
            ...wait,
            expectedAt: "2026-11-10T10:00:00.000Z",
            givesUpAt: "2026-11-10T11:00:00.000Z",
            overdueAt: "2026-11-10T10:01:00.000Z",
          },
        ],
        lastVisitedAt: "2026-11-10T09:30:00.000Z",
      },
      {
        state: "needs_you",
        reason: "check_wait",
        waitReview: {
          waitId: "w1",
          title: "Build #7",
          kind: "build_item",
          startedAt: "2026-11-10T09:00:00.000Z",
          flaggedAt: "2026-11-10T10:01:00.000Z",
          endsAt: "2026-11-10T11:00:00.000Z",
          reason: "overdue",
        },
      },
    ],
    [
      "an overdue event wait clears once visited after overdueAt",
      {
        parkedWaits: [
          {
            ...wait,
            expectedAt: "2026-11-10T10:00:00.000Z",
            givesUpAt: "2026-11-10T11:00:00.000Z",
            overdueAt: "2026-11-10T10:01:00.000Z",
          },
        ],
        lastVisitedAt: "2026-11-10T10:02:00.000Z",
      },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a delegated child that has itself ended its turn to wait",
      { pendingBackgroundTasks: [childSubagent], waitingChildThreadIds: new Set([child]) },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a delegated child waiting only on a landing",
      {
        pendingBackgroundTasks: [childSubagent],
        waitingChildThreadIds: new Set([child]),
        waitingChildLandingThreadIds: new Set([child]),
      },
      { state: "waiting", waitCategory: "landing" },
    ],
    [
      "a waiting child beside one still working",
      {
        pendingBackgroundTasks: [childSubagent, subagent],
        waitingChildThreadIds: new Set([child]),
      },
      { state: "working" },
    ],
    [
      "a wait beside the thread's own subagent",
      { parkedWaits: [shortTimeWait], pendingBackgroundTasks: [subagent] },
      { state: "working" },
    ],
    [
      "a question to the owner beside another wait",
      { ownerWait, parkedWaits: [shortTimeWait] },
      { state: "needs_you", reason: "question", question: "Which option?" },
    ],
    [
      "an active run outranks a stale ownerWait",
      { status: "running", activeRunId: run, ownerWait },
      { state: "working" },
    ],
    [
      "an unawaited command alone",
      { pendingBackgroundTasks: [{ taskId: "dev", kind: "command" as const }] },
      { state: "finished" },
    ],
    [
      "a stalled child while the thread only waits",
      { pendingBackgroundTasks: [subagent], stalled },
      { state: "stalled", reason: "stalled", stalled },
    ],
    [
      "a stalled child behind a blocked run",
      { status: "running", activeRunId: run, blockedOnThreadWait: true, stalled },
      { state: "stalled", reason: "stalled", stalled },
    ],
    [
      "a run that works on while a child is stalled",
      { status: "running", activeRunId: run, stalled },
      { state: "working" },
    ],
    [
      "a stalled mark outranks an orphaned undelivered delegated result",
      { undeliveredDelegatedResult: true, stalled },
      { state: "stalled", reason: "stalled", stalled },
    ],
    [
      "an approval pending on a delegated thread below",
      { descendantApprovalPending: true },
      { state: "needs_you", reason: "approval" },
    ],
    [
      "an approval below a run that is still working",
      { status: "running", activeRunId: run, descendantApprovalPending: true },
      { state: "needs_you", reason: "approval" },
    ],
    [
      "an approval below over a stalled mark",
      { descendantApprovalPending: true, stalled },
      { state: "needs_you", reason: "approval" },
    ],
    [
      "a pending approval",
      { pendingRuntimeRequest: request("command") },
      { state: "needs_you", reason: "approval" },
    ],
    [
      "a pending question",
      { pendingRuntimeRequest: request("user_input") },
      { state: "needs_you", reason: "input" },
    ],
    [
      "a credential refresh alone",
      { pendingRuntimeRequest: request("auth_refresh") },
      { state: "finished" },
    ],
    ["a guest message", { pendingGuestMessageCount: 1 }, { state: "needs_you", reason: "guest" }],
    [
      "a plan to review once its run settles",
      { interactionMode: "plan", hasActionableProposedPlan: true },
      { state: "needs_you", reason: "plan_ready" },
    ],
    [
      "a plan while its run still works",
      {
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        status: "running",
        activeRunId: run,
      },
      { state: "working" },
    ],
    ["an unseen failed run", { status: "failed" }, { state: "needs_you", reason: "failed" }],
    [
      "a failed run visited after failure drops to finished",
      {
        status: "failed",
        latestRunFailedAt: "2026-11-10T10:00:00.000Z",
        lastVisitedAt: "2026-11-10T10:01:00.000Z",
      },
      { state: "finished" },
    ],
    [
      "a question over a running run",
      { status: "running", activeRunId: run, pendingRuntimeRequest: request("command") },
      { state: "needs_you", reason: "approval" },
    ],
    [
      "an unseen failure over a stalled mark",
      { status: "failed", stalled },
      { state: "needs_you", reason: "failed" },
    ],
    [
      "an unseen parkedWaitGaveUp surfaces wait_gave_up",
      { parkedWaitGaveUp: { title: "Build #7", at: "2026-11-10T11:00:00.000Z" } },
      { state: "needs_you", reason: "wait_gave_up" },
    ],
    [
      "a visited parkedWaitGaveUp drops to finished",
      {
        parkedWaitGaveUp: { title: "Build #7", at: "2026-11-10T11:00:00.000Z" },
        lastVisitedAt: "2026-11-10T11:01:00.000Z",
      },
      { state: "finished" },
    ],
    [
      "a Forge item that needs the owner's acceptance beside another wait",
      {
        parkedWaits: [
          { ...wait, waitsOnPerson: { need: "acceptance", ref: "T3-9", title: "Ship it" } },
          shortTimeWait,
        ],
      },
      {
        state: "needs_you",
        reason: "acceptance",
        waitsOnPerson: {
          kind: "build_item",
          number: 7,
          ref: "T3-9",
          title: "Ship it",
          need: "acceptance",
        },
      },
    ],
    [
      "an unclaimed ready Forge item surfaces wait_target_blocked",
      {
        parkedWaits: [
          { ...wait, waitsOnPerson: { need: "unclaimed", ref: "T3-9", title: "Ready work" } },
        ],
      },
      {
        state: "needs_you",
        reason: "wait_target_blocked",
        waitsOnPerson: {
          kind: "build_item",
          number: 7,
          ref: "T3-9",
          title: "Ready work",
          need: "unclaimed",
        },
      },
    ],
    [
      "a Forge item stuck in triage surfaces wait_target_blocked",
      {
        parkedWaits: [
          { ...wait, waitsOnPerson: { need: "triage", ref: "T3-9", title: "Needs triage" } },
        ],
      },
      {
        state: "needs_you",
        reason: "wait_target_blocked",
        waitsOnPerson: {
          kind: "build_item",
          number: 7,
          ref: "T3-9",
          title: "Needs triage",
          need: "triage",
        },
      },
    ],
    [
      "a Production wait blocked on release approval surfaces release",
      {
        parkedWaits: [
          {
            ...productionWait,
            waitsOnPerson: { need: "release_approval", title: "pechhe/yardsmith" },
          },
        ],
      },
      {
        state: "needs_you",
        reason: "release",
        waitsOnPerson: {
          kind: "production",
          title: "pechhe/yardsmith",
          need: "release_approval",
        },
      },
    ],
    [
      "a persisted Forge hold does not ask the owner to act",
      { parkedWaits: [{ ...wait, waitsOnPerson: { need: "hold" } }] },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a Forge wait with no verdict",
      { parkedWaits: [wait] },
      { state: "waiting", waitCategory: "waiting" },
    ],
    [
      "a Forge wait beside a blocked run",
      {
        status: "running",
        activeRunId: run,
        blockedOnThreadWait: true,
        parkedWaits: [wait],
      },
      { state: "working" },
    ],
  ] as ReadonlyArray<readonly [string, Partial<ThreadStandingInput>, unknown]>)(
    "reports %s",
    (_name, overrides, expected) => {
      expect(deriveThreadStanding({ ...base, ...overrides })).toEqual(expected);
    },
  );

  it("classifies landing and production waits as landing waits", () => {
    expect(isLandingWait(landingWait)).toBe(true);
    expect(isLandingWait(productionWait)).toBe(true);
    expect(isLandingWait(shortTimeWait)).toBe(false);
    expect(isLandingWait(wait)).toBe(false);
  });

  it("flags event waits whose expectedAt exceeds 2 hours", () => {
    expect(
      parkedWaitReviewFlaggedAt({
        ...wait,
        expectedAt: "2026-11-10T12:00:00.000Z",
        givesUpAt: "2026-11-10T15:00:00.000Z",
      }),
    ).toEqual({
      flaggedAt: "2026-11-10T09:00:00.000Z",
      reason: "long_wait",
      endsAt: "2026-11-10T15:00:00.000Z",
    });
  });
});
