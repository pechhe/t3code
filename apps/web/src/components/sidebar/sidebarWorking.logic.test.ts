import { describe, expect, it } from "vite-plus/test";

import {
  firstLandingThread,
  isThreadNeedsYouForActiveSort,
  liftNeedsYouThreads,
} from "./sidebarWorking.logic";

const quiet = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestRun: null,
  runtime: null,
};
const thread = (id: string, change: object = {}) => ({ id, ...quiet, ...change }) as never;

describe("isThreadNeedsYouForActiveSort", () => {
  it.each([
    [{ standing: { state: "needs_you" } }, true],
    [{ standing: { state: "needs_you", waitsOnPerson: { need: "hold" } } }, false],
    [{ standing: { state: "stalled" } }, true],
    [{ standing: { state: "finished" } }, false],
    [{ hasPendingApprovals: true }, true],
    [{ pendingGuestMessageCount: 2 }, true],
    [{ pendingSubagentRequest: "approval" }, true],
    [{ parkedWaitGaveUp: { at: "2026-06-01T00:00:00.000Z" } }, true],
    [{ standing: { state: "finished" }, parkedWaitGaveUp: { at: "x" } }, false],
  ])("reads %j as %s", (change, expected) => {
    expect(isThreadNeedsYouForActiveSort(thread("a", change))).toBe(expected);
  });
});

describe("liftNeedsYouThreads", () => {
  it("lifts threads that need the owner without reordering within a tier", () => {
    const threads = [
      thread("done-1", { standing: { state: "finished" } }),
      thread("ask-1", { standing: { state: "needs_you" } }),
      thread("done-2", { standing: { state: "finished" } }),
      thread("ask-2", { hasPendingUserInput: true }),
    ];
    expect(liftNeedsYouThreads(threads).map((t: { id: string }) => t.id)).toEqual([
      "ask-1",
      "ask-2",
      "done-1",
      "done-2",
    ]);
  });
});

describe("firstLandingThread", () => {
  const running = thread("running", { standing: { state: "working" } });
  const waiting = thread("waiting", { standing: { state: "waiting", waitCategory: "waiting" } });
  const landing = thread("landing", { standing: { state: "waiting", waitCategory: "landing" } });

  it("marks the first landing row only under running or waiting rows", () => {
    expect(firstLandingThread([running, waiting, landing, landing])).toBe(landing);
    expect(firstLandingThread([landing])).toBeNull();
    expect(firstLandingThread([running, waiting])).toBeNull();
  });
});
