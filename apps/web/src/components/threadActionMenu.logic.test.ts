import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("preserves local actions and restores mutations after a grant", () => {
    const denied = buildThreadActionMenuItems({ ...baseState, canOperate: false, branch: "main" });
    expect(denied.filter((item) => !item.disabled).map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "mark-read",
      "mark-unread",
      "copy-thread-id",
      "copy",
      "project-settings",
    ]);
    const allowed = buildThreadActionMenuItems({ ...baseState, canOperate: true });
    expect(allowed.every((item) => !item.disabled)).toBe(true);
  });

  it("copies the thread id from the top level, not the Copy submenu", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.map((item) => item.id)).toContain("copy-thread-id");
    const copy = items.find((item) => item.id === "copy");
    expect(copy?.children?.map((item) => item.id)).toEqual(["copy-path", "copy-branch"]);
  });

  it("offers Link Build item only for a project connected to HQ, and only to operators", () => {
    expect(ids(baseState)).not.toContain("link-build-item");
    expect(ids({ ...baseState, canLinkBuildItem: true })).toContain("link-build-item");
    const readOnly = buildThreadActionMenuItems({
      ...baseState,
      canLinkBuildItem: true,
      canOperate: false,
    }).find((item) => item.id === "link-build-item");
    expect(readOnly?.disabled).toBe(true);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
