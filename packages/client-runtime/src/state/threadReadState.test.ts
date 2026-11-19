import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";

import { hasUnseenThreadCompletion, type ThreadRunSummary } from "./models.ts";

describe("shared web and mobile unread derivation", () => {
  const runId = RunId.make("quiet-sweep");
  const run: ThreadRunSummary = {
    runId,
    status: "completed",
    requestedAt: null,
    startedAt: null,
    completedAt: "2026-10-19T10:01:00.000Z",
    assistantMessageId: null,
  };
  const thread = {
    latestRun: run,
    lastVisitedAt: "2026-10-19T10:00:00.000Z",
    readOnCompletionRunId: runId,
  };

  it("reads a quiet successful completion and honours explicit mark-unread", () => {
    expect(hasUnseenThreadCompletion(thread)).toBe(false);
    expect(hasUnseenThreadCompletion({ ...thread, readOnCompletionRunId: null })).toBe(true);
  });

  it("surfaces a failed run even on a never-visited thread", () => {
    const failed = { ...run, status: "failed" as const };
    expect(hasUnseenThreadCompletion({ ...thread, latestRun: failed })).toBe(true);
    expect(hasUnseenThreadCompletion({ ...thread, latestRun: failed, lastVisitedAt: null })).toBe(
      true,
    );
  });

  it.each(["interrupted", "cancelled"] as const)("never presents a %s run as unseen", (status) => {
    expect(
      hasUnseenThreadCompletion({
        ...thread,
        readOnCompletionRunId: null,
        latestRun: { ...run, status },
      }),
    ).toBe(false);
  });

  it("does not carry quiet read state into the next run", () => {
    expect(
      hasUnseenThreadCompletion({ ...thread, latestRun: { ...run, runId: RunId.make("next") } }),
    ).toBe(true);
  });

  it("keeps ordinary visited-watermark behaviour", () => {
    expect(
      hasUnseenThreadCompletion({
        ...thread,
        readOnCompletionRunId: null,
        lastVisitedAt: run.completedAt,
      }),
    ).toBe(false);
    expect(
      hasUnseenThreadCompletion({ ...thread, readOnCompletionRunId: null, lastVisitedAt: null }),
    ).toBe(false);
  });
});
