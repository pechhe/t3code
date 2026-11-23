import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import { sidebarRowWaitingProps } from "./sidebarRowWaiting";

describe("sidebarRowWaitingProps", () => {
  const thread = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    parkedWaits: [],
    standing: {
      state: "needs_you",
      reason: "check_wait",
      waitReview: {
        waitId: "w",
        title: "Deploy",
        kind: "time",
        startedAt: "2026-06-01T00:00:00.000Z",
        flaggedAt: "2026-06-01T00:00:00.000Z",
        reason: "overdue",
      },
    },
  } as never;
  const props = (lastVisitedAt?: string) =>
    sidebarRowWaitingProps({
      thread,
      section: "active",
      snoozeNow: "2026-06-01T01:00:00.000Z",
      messages: m,
      lastVisitedAt,
    });

  it("drops the Check wait subtitle once the thread has been visited", () => {
    expect(props().parkedSubtitle).toBe("Overdue · Deploy");
    expect(props("2026-06-01T00:30:00.000Z").parkedSubtitle).toBeNull();
  });
});
