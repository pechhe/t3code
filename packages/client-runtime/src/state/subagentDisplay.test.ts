import { describe, expect, it } from "vite-plus/test";
import { agentExecutionBoundaryLabel } from "./subagentDisplay.js";

describe("agentExecutionBoundaryLabel", () => {
  it("names each enforced boundary without calling trusted host access a sandbox", () => {
    expect(agentExecutionBoundaryLabel("read-only")).toBe("Read-only");
    expect(agentExecutionBoundaryLabel("workspace-sandbox")).toBe("Workspace sandbox");
    expect(agentExecutionBoundaryLabel("trusted-host-access")).toBe("Trusted host access");
  });
});

import { subagentDetailPreview } from "./subagentDisplay.js";

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

it.each([279, 280, 281])("preserves the preview boundary at %i characters", (length) => {
  const result = "x".repeat(length);
  expect(subagentDetailPreview({ status: "completed", result })).toBe(
    length > 280 ? "x".repeat(280) + "…" : result,
  );
});

it("normalizes Unicode whitespace and ignores a large hidden suffix", () => {
  const progress = " \u00a0Reading\tfiles\n" + "x".repeat(1_000_000);
  expect(subagentDetailPreview({ status: "running", progress })).toBe(
    "Reading files " + "x".repeat(266) + "…",
  );
  expect(
    subagentDetailPreview({ status: "completed", result: "x".repeat(280) + " \n\u2028" }),
  ).toBe("x".repeat(280));
  expect(subagentDetailPreview({ status: "completed", result: "x".repeat(279) + " \n y" })).toBe(
    "x".repeat(279) + "…",
  );
  expect(
    subagentDetailPreview({ status: "running", progress: "\uFEFF\u2029", result: " Done " }),
  ).toBe("Done");
  expect(subagentDetailPreview({ status: "failed", result: "x".repeat(279) + "😀" })).toBe(
    "x".repeat(279) + "\uD83D…",
  );
});
