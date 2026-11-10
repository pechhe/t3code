import { RunId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  isQuietThreadCompletion,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  requestId: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  requestId: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  it("notifies a completion immediately and only once", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    observe(working);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies each newer completion immediately", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe(working);
    observe(completed(2));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies each attention once per stretch and still notifies the subsequent completion", () => {
    const { notify, observe } = harness();
    observe(working);
    const attention = {
      attention: "run-1:approval:a",
      requestId: "a",
      settled: false,
      completedAt: null,
    };
    observe(attention);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    observe({ ...attention });
    expect(notify).toHaveBeenCalledTimes(1);
    observe({ ...attention, attention: "run-1:approval:b", requestId: "b" });
    observe(attention);
    expect(notify).toHaveBeenCalledTimes(2);
    observe(working);
    observe(attention);
    expect(notify).toHaveBeenCalledTimes(3);
    const subagent = { ...attention, attention: "run-1:approval:", requestId: null };
    observe(subagent);
    observe(attention);
    observe(subagent);
    expect(notify).toHaveBeenCalledTimes(5);
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("does not replay a completion after attention resolves", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe({ attention: "run-1:limited", requestId: null, settled: false, completedAt: null });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("never notifies existing, archived or stopped completions, including when unarchived", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    observe(completed(2));
    observe(working);
    observe(completed(3), { ...visible, archived: true });
    observe(completed(3));
    expect(notify).not.toHaveBeenCalled();
    observe(working);
    observe(completed(4));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("forgets handled completions when a thread is removed or the gate is cleared", () => {
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(completed(1));
      reset(gate);
      gate.observe("thread", undefined, working, visible);
      gate.observe("thread", working, completed(1), visible);
      expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    }
  });

  it("consumes a quiet completion so a later shell change does not notify it", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1), { ...visible, quiet: true });
    observe(completed(1));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("createThreadNotificationGate with the server's standing", () => {
  const standing = (
    state: NonNullable<ThreadNotificationObservation["standing"]>,
    attention: string | null = null,
  ): ThreadNotificationObservation => ({
    attention,
    settled: false,
    completedAt: null,
    requestId: null,
    standing: state,
  });

  function heldHarness() {
    const notify = vi.fn();
    const holds = new Set<() => void>();
    const gate = createThreadNotificationGate<string>(notify, (fire) => {
      holds.add(fire);
      return () => holds.delete(fire);
    });
    let prior: ThreadNotificationObservation | undefined;
    const observe = (next: ThreadNotificationObservation, options = visible) => {
      gate.observe("thread", prior, next, options);
      prior = next;
    };
    const elapse = () => {
      for (const fire of Array.from(holds)) {
        holds.delete(fire);
        fire();
      }
    };
    return { notify, observe, elapse };
  }

  it("stays silent while a child finishes and notifies once when the thread has held finished", () => {
    const { notify, observe, elapse } = heldHarness();
    observe(standing("working"));
    observe(standing("waiting"));
    observe(standing("working"));
    elapse();
    expect(notify).not.toHaveBeenCalled();
    observe(standing("finished"));
    expect(notify).not.toHaveBeenCalled();
    elapse();
    observe(standing("finished"));
    elapse();
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("drops a finished notification when a wake starts inside the hold", () => {
    const { notify, observe, elapse } = heldHarness();
    observe(standing("working"));
    observe(standing("finished"));
    observe(standing("working"));
    elapse();
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies each time a thread stalls or needs you, and each new question", () => {
    const { notify, observe } = heldHarness();
    observe(standing("working"));
    observe(standing("stalled"));
    observe(standing("stalled"));
    observe(standing("working"));
    observe(standing("stalled"));
    observe(standing("needs_you", "run-1:approval"));
    observe(standing("needs_you", "run-1:approval"));
    observe(standing("needs_you", "run-1:input"));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
    ]);
  });

  it("notifies a child's question the standing cannot see", () => {
    const { notify, observe } = heldHarness();
    observe(standing("waiting"));
    observe(standing("waiting", "child:input"));
    observe(standing("waiting", "child:input"));
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("never notifies a thread first seen finished, archived or quiet", () => {
    const { notify, observe, elapse } = heldHarness();
    observe(standing("finished"));
    observe(standing("working"));
    observe(standing("finished"), { archived: false, quiet: true });
    observe(standing("working"), { archived: true, quiet: false });
    observe(standing("finished"), { archived: true, quiet: false });
    elapse();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("quiet thread completions", () => {
  const runId = RunId.make("sweep");
  const report = {
    latestRun: { runId, status: "completed" },
  };

  it("suppresses every completion notification channel for a quiet run", () => {
    expect(isQuietThreadCompletion({ ...report, readOnCompletionRunId: runId })).toBe(true);
    expect(isQuietThreadCompletion(report)).toBe(false);
  });

  it("still notifies about failures, input and later runs", () => {
    expect(
      isQuietThreadCompletion({
        ...report,
        readOnCompletionRunId: runId,
        latestRun: { runId, status: "failed" },
      }),
    ).toBe(false);
    expect(
      isQuietThreadCompletion({ ...report, readOnCompletionRunId: runId, latestRun: null }),
    ).toBe(false);
    expect(
      isQuietThreadCompletion({
        ...report,
        readOnCompletionRunId: runId,
        latestRun: { runId: RunId.make("next"), status: "completed" },
      }),
    ).toBe(false);
  });

  it("stays quiet for a run with nothing to report, such as a compaction T3 started", () => {
    expect(isQuietThreadCompletion({ ...report, latestRunSilent: true })).toBe(true);
  });

  it("stays quiet for a stopped run", () => {
    expect(isQuietThreadCompletion({ ...report, latestRunStopRequested: true })).toBe(true);
  });
});
