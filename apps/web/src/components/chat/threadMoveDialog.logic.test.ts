import { describe, expect, it } from "vite-plus/test";

import { threadMoveDialogCopy } from "./threadMoveDialog.logic";

const base = {
  sourceLabel: "peach-box",
  target: { environmentId: "environment:mac", label: "Henry's Mac" },
  running: false,
};

describe("threadMoveDialogCopy", () => {
  it("offers the move once the target says it can take the thread", () => {
    const copy = threadMoveDialogCopy({
      ...base,
      options: [{ environmentId: "environment:mac", label: "Henry's Mac", reason: null }],
    });
    expect(copy.title).toBe("Move this thread to Henry's Mac?");
    expect(copy.canMove).toBe(true);
  });

  it("waits for the answer before offering the move", () => {
    const copy = threadMoveDialogCopy({ ...base, options: undefined });
    expect(copy).toMatchObject({ canMove: false, description: "Checking Henry's Mac…" });
  });

  it("says why the target refuses", () => {
    const copy = threadMoveDialogCopy({
      ...base,
      options: [
        {
          environmentId: "environment:mac",
          label: "Henry's Mac",
          reason: "The link to Henry's Mac is read-only; a moved thread needs full access there.",
        },
      ],
    });
    expect(copy.canMove).toBe(false);
    expect(copy.title).toBe("Can't move this thread to Henry's Mac");
    expect(copy.description).toContain("needs full access");
  });

  it("says how to link a machine that is not linked", () => {
    const copy = threadMoveDialogCopy({
      ...base,
      options: [{ environmentId: "environment:other", label: "Other", reason: null }],
    });
    expect(copy.canMove).toBe(false);
    expect(copy.description).toContain("isn't linked to peach-box");
    expect(copy.description).toContain("Settings → Connections");
  });

  it("does not move a thread mid-turn", () => {
    const copy = threadMoveDialogCopy({
      ...base,
      running: true,
      options: [{ environmentId: "environment:mac", label: "Henry's Mac", reason: null }],
    });
    expect(copy.canMove).toBe(false);
  });

  it("reports a failed check", () => {
    expect(threadMoveDialogCopy({ ...base, options: "failed" }).canMove).toBe(false);
  });
});
