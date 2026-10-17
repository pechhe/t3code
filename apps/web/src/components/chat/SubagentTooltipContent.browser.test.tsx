import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderInstanceId, type AgentExecutionBoundary } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SubagentTooltipContent } from "./SubagentTooltipContent";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const text = async (boundary?: AgentExecutionBoundary) => {
  await act(async () => {
    root.render(
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
  return container.textContent ?? "";
};

it("names a managed task's enforced execution boundary", async () => {
  expect(await text("trusted-host-access")).toContain("Trusted host access");
  expect(await text("workspace-sandbox")).toContain("Workspace sandbox");
  expect(await text("read-only")).toContain("Read-only");
});

it("claims no boundary for a task without boundary evidence", async () => {
  const rendered = await text();
  expect(rendered).not.toContain("Execution");
  expect(rendered).not.toContain("sandbox");
});
