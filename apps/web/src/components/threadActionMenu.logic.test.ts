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
      "export-transcript",
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
    expect(copy?.children?.map((item) => item.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread",
    ]);
  });

  it("offers Link Forge item only for a project connected to Weave, and only to operators", () => {
    expect(ids(baseState)).not.toContain("link-build-item");
    expect(ids({ ...baseState, canLinkForgeItem: true })).toContain("link-build-item");
    const readOnly = buildThreadActionMenuItems({
      ...baseState,
      canLinkForgeItem: true,
      canOperate: false,
    }).find((item) => item.id === "link-build-item");
    expect(readOnly?.disabled).toBe(true);
  });

  it("offers transcript export to a read-only client, since reading a transcript is a read", () => {
    expect(ids(baseState)).toContain("export-transcript");
    const readOnly = buildThreadActionMenuItems({ ...baseState, canOperate: false }).find(
      (item) => item.id === "export-transcript",
    );
    expect(readOnly?.disabled ?? false).toBe(false);
  });

  it("offers each linked environment, disabled with its reason when it cannot take the thread", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      handoffTargets: [
        { environmentId: "environment-box", label: "Box", reason: null },
        {
          environmentId: "environment-vps",
          label: "VPS",
          reason: "No project with this repository",
        },
      ],
    });
    const continueOn = items.find((item) => item.id === "continue-on");
    expect(continueOn?.children).toEqual([
      { id: "continue-on:environment-box", label: "Box", disabled: false },
      {
        id: "continue-on:environment-vps",
        label: "VPS (No project with this repository)",
        disabled: true,
      },
    ]);
    // A thread that cannot move offers nothing, and a running thread cannot move.
    expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "continue-on")).toBe(
      false,
    );
    // With nowhere linked that answers, the entry says so instead of disappearing.
    expect(
      buildThreadActionMenuItems({ ...baseState, handoffTargets: [] }).find(
        (item) => item.id === "continue-on",
      ),
    ).toMatchObject({ label: "Continue on… (no linked environment answered)", disabled: true });
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isRunning: true,
        handoffTargets: [{ environmentId: "environment-box", label: "Box", reason: null }],
      }).find((item) => item.id === "continue-on")?.disabled,
    ).toBe(true);
    // A connection that cannot change threads cannot move one either.
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        handoffTargets: [{ environmentId: "environment-box", label: "Box", reason: null }],
      }).find((item) => item.id === "continue-on")?.disabled,
    ).toBe(true);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
