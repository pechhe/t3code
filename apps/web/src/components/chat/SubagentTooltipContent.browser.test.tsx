import { ProviderInstanceId, type AgentExecutionBoundary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { SubagentTooltipContent } from "./SubagentTooltipContent";

const text = async (
  boundary?: AgentExecutionBoundary,
  timing?: { startedAt?: string; elapsed?: string; totalTokens: number },
  status: "running" | "interrupted" = "running",
  pausedByParentStop?: true,
) => {
  await using screen = await render(
    <SubagentTooltipContent
      title="Fixture writer"
      model="claude-test"
      providerInstanceId={ProviderInstanceId.make("claudeAgent")}
      origin="app_owned"
      status={status}
      pausedByParentStop={pausedByParentStop}
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
  return screen.container.textContent ?? "";
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
    startedAt: "2026-09-16T12:00:00Z",
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

it("shows paused when interrupted by a parent Stop and interrupted otherwise", async () => {
  expect(await text(undefined, undefined, "interrupted", true)).toContain("Paused");
  const plain = await text(undefined, undefined, "interrupted");
  expect(plain).toContain("interrupted");
  expect(plain).not.toContain("Paused");
});
