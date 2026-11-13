import { describe, expect, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, type ThreadId } from "@t3tools/contracts";

import { deriveThreadStanding, type ThreadStandingInput } from "./threadStanding.ts";

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
const watch = {
  id: "w1",
  title: "Build #7",
  startedAt: "2026-11-10T09:00:00.000Z",
  target: { kind: "build_item" as const, number: 7, until: "unblocked" as const },
};
const watchTask = { taskId: "thread-watch:w1", kind: "monitor" as const, awaited: true as const };
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
    ["a live delegated task", { pendingBackgroundTasks: [subagent] }, { state: "waiting" }],
    [
      "a run blocked on a thread wait",
      { status: "running", activeRunId: run, blockedOnThreadWait: true },
      { state: "waiting" },
    ],
    [
      "an unawaited command alone",
      { pendingBackgroundTasks: [{ taskId: "dev", kind: "command" as const }] },
      { state: "finished" },
    ],
    [
      "a stalled child while the thread only waits",
      { pendingBackgroundTasks: [subagent], stalled },
      { state: "stalled", stalled },
    ],
    [
      "a stalled child behind a blocked run",
      { status: "running", activeRunId: run, blockedOnThreadWait: true, stalled },
      { state: "stalled", stalled },
    ],
    [
      "a run that works on while a child is stalled",
      { status: "running", activeRunId: run, stalled },
      { state: "working" },
    ],
    [
      "an approval pending on a delegated thread below",
      { descendantApprovalPending: true },
      { state: "needs_you" },
    ],
    [
      "an approval below a run that is still working",
      { status: "running", activeRunId: run, descendantApprovalPending: true },
      { state: "needs_you" },
    ],
    [
      "an approval below over a stalled mark",
      { descendantApprovalPending: true, stalled },
      { state: "needs_you" },
    ],
    ["a pending approval", { pendingRuntimeRequest: request("command") }, { state: "needs_you" }],
    [
      "a pending question",
      { pendingRuntimeRequest: request("user_input") },
      { state: "needs_you" },
    ],
    [
      "a credential refresh alone",
      { pendingRuntimeRequest: request("auth_refresh") },
      { state: "finished" },
    ],
    ["a guest message", { pendingGuestMessageCount: 1 }, { state: "needs_you" }],
    [
      "a plan to review once its run settles",
      { interactionMode: "plan", hasActionableProposedPlan: true },
      { state: "needs_you" },
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
    ["a failed run", { status: "failed" }, { state: "needs_you" }],
    [
      "a question over a running run",
      { status: "running", activeRunId: run, pendingRuntimeRequest: request("command") },
      { state: "needs_you" },
    ],
    ["a failure over a stalled mark", { status: "failed", stalled }, { state: "needs_you" }],
    [
      "a delegated result over a stalled mark",
      { undeliveredDelegatedResult: true, stalled },
      { state: "working" },
    ],
    [
      "a Forge item held for the owner as the only wait",
      {
        pendingBackgroundTasks: [watchTask],
        threadWatches: [
          { ...watch, waitsOnPerson: { need: "acceptance", ref: "T3-9", title: "Ship it" } },
        ],
      },
      {
        state: "needs_you",
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
      "a persisted Forge hold does not ask the owner to act",
      {
        pendingBackgroundTasks: [watchTask],
        threadWatches: [{ ...watch, waitsOnPerson: { need: "hold" } }],
      },
      { state: "waiting" },
    ],
    [
      "a Forge watch with no verdict",
      { pendingBackgroundTasks: [watchTask], threadWatches: [watch] },
      { state: "waiting" },
    ],
    [
      "a Forge wait beside a machine wait",
      {
        pendingBackgroundTasks: [watchTask, subagent],
        threadWatches: [{ ...watch, waitsOnPerson: { need: "hold" } }],
      },
      { state: "waiting" },
    ],
    [
      "a Forge wait beside a blocked run",
      {
        status: "running",
        activeRunId: run,
        blockedOnThreadWait: true,
        pendingBackgroundTasks: [watchTask],
        threadWatches: [{ ...watch, waitsOnPerson: { need: "hold" } }],
      },
      { state: "waiting" },
    ],
  ] as ReadonlyArray<readonly [string, Partial<ThreadStandingInput>, unknown]>)(
    "reports %s",
    (_name, overrides, expected) => {
      expect(deriveThreadStanding({ ...base, ...overrides })).toEqual(expected);
    },
  );
});
