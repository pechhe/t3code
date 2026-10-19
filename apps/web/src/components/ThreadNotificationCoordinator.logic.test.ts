import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";

import { resolveThreadNotificationKind } from "./ThreadNotificationCoordinator.logic";

describe("thread notification decisions", () => {
  const runId = RunId.make("sweep");
  const completion = {
    attention: null,
    priorAttention: null,
    completion: 20,
    priorCompletion: 10,
    latestRun: { runId, status: "completed" },
  };

  it("suppresses every completion notification channel for a quiet run", () => {
    expect(
      resolveThreadNotificationKind({ ...completion, readOnCompletionRunId: runId }),
    ).toBeNull();
    expect(resolveThreadNotificationKind(completion)).toBe("completion");
  });

  it("still notifies about failures, input, and later runs", () => {
    expect(
      resolveThreadNotificationKind({
        ...completion,
        readOnCompletionRunId: runId,
        attention: "sweep:failed",
        latestRun: { runId, status: "failed" },
      }),
    ).toBe("input");
    expect(
      resolveThreadNotificationKind({
        ...completion,
        readOnCompletionRunId: runId,
        attention: "sweep:input",
      }),
    ).toBe("input");
    expect(
      resolveThreadNotificationKind({
        ...completion,
        readOnCompletionRunId: runId,
        latestRun: { runId: RunId.make("next"), status: "completed" },
      }),
    ).toBe("completion");
  });

  it("consumes the quiet completion so subsequent shell changes do not notify", () => {
    expect(resolveThreadNotificationKind({ ...completion, priorCompletion: 20 })).toBeNull();
  });
});
