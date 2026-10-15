import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { ProviderInstanceId, type AgentExecutionBoundary } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SubagentTooltipContent } from "./SubagentTooltipContent";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const text = (boundary?: AgentExecutionBoundary) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <SubagentTooltipContent
        title="Fixture writer"
        model="claude-test"
        providerInstanceId={ProviderInstanceId.make("claudeAgent")}
        origin="app_owned"
        status="running"
        childThread={{
          branch: null,
          worktreePath: null,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-test",
          },
          ...(boundary ? { agentTask: { executionBoundary: boundary } as never } : {}),
        }}
      />,
    );
  });
  return JSON.stringify(renderer!.toJSON());
};

it("names a managed task's enforced execution boundary", () => {
  expect(text("trusted-host-access")).toContain("Trusted host access");
  expect(text("workspace-sandbox")).toContain("Workspace sandbox");
  expect(text("read-only")).toContain("Read-only");
});

it("claims no boundary for a task without boundary evidence", () => {
  const rendered = text();
  expect(rendered).not.toContain("Execution");
  expect(rendered).not.toContain("sandbox");
});
