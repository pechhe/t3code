import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadRowStatus } from "./SidebarThreadRowStatus.logic";

const waitingOnAcceptance = (waitsOnPerson: { ref?: string; number?: number }) =>
  resolveSidebarThreadRowStatus({
    thread: {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      standing: { state: "needs_you", waitsOnPerson: { need: "acceptance", ...waitsOnPerson } },
    } as unknown as SidebarThreadSummary,
    status: "waiting",
    isUnread: false,
    isWoke: false,
    isActive: false,
    isSelected: false,
    variantAction: "settle",
    subagentActivity: null,
    resolve: m,
  }).topStatus?.label;

const rowStatus = (
  thread: object,
  status: "waiting" | "ready" = "waiting",
  lastVisitedAt?: string,
) =>
  resolveSidebarThreadRowStatus({
    thread: { hasPendingApprovals: false, hasPendingUserInput: false, ...thread } as never,
    status,
    isUnread: false,
    isWoke: false,
    isActive: false,
    isSelected: false,
    variantAction: "settle",
    subagentActivity: null,
    resolve: m,
    lastVisitedAt,
  }).topStatus;

describe("resolveSidebarThreadRowStatus wait vocabulary", () => {
  const checkWait = {
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
  };

  it("warns on a Check wait row until the owner visits it", () => {
    expect(rowStatus(checkWait)).toMatchObject({
      label: "Check wait",
      className: "text-warning-foreground",
    });
    expect(rowStatus(checkWait, "waiting", "2026-06-01T00:00:01.000Z")?.label).not.toBe(
      "Check wait",
    );
  });

  it("labels Waiting, Landing and Releasing rows in Working quietly", () => {
    const standing = (waitCategory: "waiting" | "landing") => ({
      standing: { state: "waiting", waitCategory },
    });
    expect(rowStatus(standing("waiting"))).toMatchObject({
      label: "Waiting",
      className: "text-muted-foreground",
    });
    expect(
      rowStatus({ ...standing("landing"), parkedWaits: [{ target: { kind: "landing" } }] }),
    ).toMatchObject({ label: "Landing" });
    expect(
      rowStatus({ ...standing("landing"), parkedWaits: [{ target: { kind: "production" } }] }),
    ).toMatchObject({ label: "Releasing" });
    expect(rowStatus({ ...standing("landing"), parkedWaits: [] })?.label).toBe("Landing");
  });

  it("names a triage, shaping or release need", () => {
    const needs = (waitsOnPerson: object) =>
      rowStatus({ standing: { state: "needs_you", waitsOnPerson } })?.label;
    expect(needs({ kind: "build_item", number: 3, ref: "T3-3", need: "triage" })).toBe(
      "Needs you · triage T3-3",
    );
    expect(needs({ kind: "build_item", number: 3, need: "shaping" })).toBe("Needs you · shape #3");
    expect(needs({ kind: "production", need: "release_approval" })).toBe("Needs you · release");
    expect(needs({ kind: "build_item", number: 3, ref: "T3-3", need: "unclaimed" })).toBe(
      "Needs you · start T3-3",
    );
    expect(needs({ kind: "build_item", number: 3, ref: "T3-3", need: "acceptance" })).toBe(
      "Needs you · accept T3-3",
    );
  });

  it("keeps a seen failure as a quiet Failed", () => {
    expect(
      rowStatus({ standing: { state: "finished" }, latestRun: { status: "failed" } }, "ready"),
    ).toMatchObject({ label: "Failed", className: "text-muted-foreground" });
  });
});

describe("resolveSidebarThreadRowStatus", () => {
  it("names the item a thread waits on its owner to accept", () => {
    expect(waitingOnAcceptance({ ref: "T3-789", number: 8335 })).toBe("Needs you · accept T3-789");
    expect(waitingOnAcceptance({ number: 8335 })).toBe("Needs you · accept #8335");
  });
});
