import { describe, expect, it } from "vite-plus/test";

import { visibleThreadWorkflow, withWorkflowKind } from "./threadWorkflow.ts";

describe("visibleThreadWorkflow", () => {
  it("shows nothing for unset or worker workflows", () => {
    expect(visibleThreadWorkflow(undefined)).toBeNull();
    expect(visibleThreadWorkflow(null)).toBeNull();
    expect(visibleThreadWorkflow({ kind: "worker", unattended: false })).toBeNull();
  });

  it("shows the kind, not an older thread's own stance", () => {
    expect(visibleThreadWorkflow({ kind: "shape", unattended: true })).toEqual({ kind: "shape" });
  });
});

describe("withWorkflowKind", () => {
  it("sets the kind with no per-thread stance", () => {
    expect(withWorkflowKind("solo")).toEqual({ kind: "solo", unattended: false });
  });
});
