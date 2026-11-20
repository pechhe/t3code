import { describe, expect, it } from "vite-plus/test";
import { agentExecutionBoundaryLabel } from "./subagentDisplay.js";

describe("agentExecutionBoundaryLabel", () => {
  it("names each enforced boundary without calling trusted host access a sandbox", () => {
    expect(agentExecutionBoundaryLabel("read-only")).toBe("Read-only");
    expect(agentExecutionBoundaryLabel("workspace-sandbox")).toBe("Workspace sandbox");
    expect(agentExecutionBoundaryLabel("trusted-host-access")).toBe("Trusted host access");
  });
});
