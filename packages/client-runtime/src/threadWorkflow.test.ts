import { describe, expect, it } from "vite-plus/test";

import {
  threadWorkflowChipLabel,
  visibleThreadWorkflow,
  withWorkflowKind,
  withWorkflowUnattended,
} from "./threadWorkflow.ts";

describe("visibleThreadWorkflow", () => {
  it("shows nothing for unset or worker workflows", () => {
    expect(visibleThreadWorkflow(undefined)).toBeNull();
    expect(visibleThreadWorkflow(null)).toBeNull();
    expect(visibleThreadWorkflow({ kind: "worker", unattended: true })).toBeNull();
  });

  it("keeps the kind and unattended stance otherwise", () => {
    expect(visibleThreadWorkflow({ kind: "shape", unattended: true })).toEqual({
      kind: "shape",
      unattended: true,
    });
  });
});

describe("threadWorkflowChipLabel", () => {
  it("names the unattended stance", () => {
    expect(threadWorkflowChipLabel({ kind: "lead", unattended: false })).toBe("Lead");
    expect(threadWorkflowChipLabel({ kind: "solo", unattended: true })).toBe("Solo, unattended");
  });
});

describe("workflow edits", () => {
  it("keeps the unattended stance when the kind changes", () => {
    expect(withWorkflowKind({ kind: "lead", unattended: true }, "chat")).toEqual({
      kind: "chat",
      unattended: true,
    });
  });

  it("starts attended when set from nothing", () => {
    expect(withWorkflowKind(null, "solo")).toEqual({ kind: "solo", unattended: false });
  });

  it("toggles unattended without changing the kind", () => {
    expect(withWorkflowUnattended({ kind: "shape", unattended: false }, true)).toEqual({
      kind: "shape",
      unattended: true,
    });
  });
});
