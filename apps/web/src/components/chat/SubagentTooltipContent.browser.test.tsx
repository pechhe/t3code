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
const text = async (
  boundary?: AgentExecutionBoundary,
  timing?: { startedAt?: string; elapsed?: string; totalTokens: number },
) => {
  await act(async () => {
    root.render(
      <SubagentTooltipContent
        title="Fixture writer"
        model="claude-test"
        providerInstanceId={ProviderInstanceId.make("claudeAgent")}
        origin="app_owned"
        status="running"
        {...timing}
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

it("shows when the agent started, how long it ran and its token use together", async () => {
  const rendered = await text(undefined, {
    startedAt: new Date().toISOString(),
    elapsed: "4m 48s",
    totalTokens: 149_000,
  });
  expect(rendered).toMatch(/Started .+ · 4m 48s · 149K tokens/);
});

it("keeps token use when the start time is unknown", async () => {
  const rendered = await text(undefined, { totalTokens: 149_000 });
  expect(rendered).toContain("149K tokens");
  expect(rendered).not.toContain("Started");
});
