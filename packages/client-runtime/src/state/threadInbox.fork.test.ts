import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { championNeedsInbox } from "./championInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

it("lists a champion's thread only when the thread itself waits on someone", () => {
  const ordinary = thread("champion", true);
  const quiet = { ...ordinary, champion: { id: "quality", attention: false } };
  expect(championNeedsInbox(quiet)).toBe(false);
  // Champion attention and failed checks belong on the Champion page, not the thread list.
  expect(championNeedsInbox({ ...quiet, champion: { id: "quality", attention: true } })).toBe(
    false,
  );
  const failedRun = {
    runId: RunId.make("failed"),
    status: "failed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  };
  const failed = { ...quiet, latestRun: failedRun };
  expect(championNeedsInbox(failed)).toBe(false);
  expect(championNeedsInbox({ ...quiet, hasPendingApprovals: true })).toBe(true);
  expect(championNeedsInbox({ ...quiet, pendingSubagentRequest: "user_input" })).toBe(true);
  expect(championNeedsInbox(ordinary)).toBe(true);
  const kind = (value: "owner" | "setup" | "escalation" | undefined) => ({
    ...quiet,
    champion: { id: "quality", attention: false, kind: value },
  });
  expect(championNeedsInbox(kind("escalation"))).toBe(true);
  expect(championNeedsInbox(kind("owner"))).toBe(false);
  expect(championNeedsInbox(kind("setup"))).toBe(false);
  expect(championNeedsInbox(kind(undefined))).toBe(false);
});
