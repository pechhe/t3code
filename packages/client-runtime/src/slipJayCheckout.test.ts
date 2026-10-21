import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  VcsStatusResult,
  VcsStatusSlipJayLanding,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSlipJayLandingTimes,
  formatSlipJayDuration,
  resolveSlipJayBaseLabel,
  resolveSlipJayCheckoutStatus,
  resolveSlipJayLandingChip,
  resolveSlipJayStageProgress,
  resolveSlipJayLandingLabel,
  resolveSlipJayQueueLabel,
  resolveSlipJayRunnerSummary,
  resolveSlipJayWorkspaceLabel,
  slipJayWorkspaceName,
} from "./slipJayCheckout.ts";

const checkoutStatus = (overrides: Partial<VcsStatusResult>): VcsStatusResult => ({
  isRepo: false,
  otherVcsKind: "jj",
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "develop",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  slipJay: { integration: "develop" },
  ...overrides,
});

const CWD = "/repo/.slipjay/workspaces/t3-29";

const changedFile = (path: string) => ({ path, insertions: 1, deletions: 0 });

describe("SlipJay checkout labels", () => {
  it("applies to a SlipJay project and leaves Git checkouts on their controls", () => {
    expect(resolveSlipJayCheckoutStatus(undefined, CWD)).toBeNull();
    expect(
      resolveSlipJayCheckoutStatus(
        checkoutStatus({ isRepo: true, otherVcsKind: undefined, slipJay: undefined }),
        CWD,
      ),
    ).toBeNull();
    expect(
      resolveSlipJayCheckoutStatus(checkoutStatus({ slipJay: undefined, refName: null }), CWD),
    ).toBeNull();
  });

  it("keeps a SlipJay project whose config names no usable bookmark", () => {
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        refName: null,
        slipJay: { integration: null, workspace: { name: "default", isIntegration: true } },
      }),
      CWD,
    )!;
    expect(resolveSlipJayWorkspaceLabel(status, false)).toBe("Integration (root)");
    expect(resolveSlipJayBaseLabel(status, false)).toBeNull();
  });

  it("names the workspace and its Issue, against its integration base and edits", () => {
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: {
          integration: "develop",
          workspace: { name: "t3-29", issueNumber: 29, isIntegration: false },
        },
        behindCount: 2,
        workingTree: {
          files: [changedFile("a.ts"), changedFile("b.ts")],
          insertions: 2,
          deletions: 0,
        },
      }),
      CWD,
    )!;
    expect(resolveSlipJayWorkspaceLabel(status, false)).toBe("t3-29 · #29");
    expect(resolveSlipJayBaseLabel(status, false)).toBe("on develop · 2 behind · 2 files");
  });

  it("omits an absent Issue and zero counts", () => {
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: {
          integration: "develop",
          workspace: { name: "t3-scratch", isIntegration: false },
        },
        workingTree: { files: [changedFile("a.ts")], insertions: 1, deletions: 0 },
      }),
      CWD,
    )!;
    expect(resolveSlipJayWorkspaceLabel(status, false)).toBe("t3-scratch");
    expect(resolveSlipJayBaseLabel(status, false)).toBe("on develop · 1 file");
  });

  it("reads the integration checkout as the root", () => {
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: { integration: "develop", workspace: { name: "default", isIntegration: true } },
      }),
      CWD,
    )!;
    expect(resolveSlipJayWorkspaceLabel(status, false)).toBe("develop (root)");
  });

  it("labels a draft for the workspace its first message allocates", () => {
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: { integration: "develop", workspace: { name: "default", isIntegration: true } },
        behindCount: 3,
        workingTree: { files: [changedFile("a.ts")], insertions: 1, deletions: 0 },
      }),
      CWD,
    )!;
    expect(resolveSlipJayWorkspaceLabel(status, true)).toBe("New workspace");
    expect(resolveSlipJayBaseLabel(status, true)).toBe("on develop");
  });

  it("shows a workspace's landing in SlipJay's stage names", () => {
    const landing = (overrides: Partial<VcsStatusSlipJayLanding>): VcsStatusSlipJayLanding => ({
      operationId: "op_a",
      status: "active",
      stage: "verifying",
      live: true,
      ...overrides,
    });
    expect(resolveSlipJayLandingLabel(landing({}))).toBe("Landing · verifying");
    expect(resolveSlipJayLandingLabel(landing({ live: false }))).toBe(
      "Landing · verifying · reconnecting",
    );
    expect(
      resolveSlipJayLandingLabel(landing({ status: "landed", commitId: "abc1234def5678" })),
    ).toBe("Landed abc1234");
    expect(
      resolveSlipJayLandingLabel(landing({ status: "failed", stage: "gate", reason: "tests" })),
    ).toBe("Land failed: gate");
    expect(resolveSlipJayLandingLabel(landing({ status: "unknown" }))).toBe("Land outcome unknown");
  });
});

describe("SlipJay runner", () => {
  const operation = (overrides: Partial<SlipJayRunnerOperation>): SlipJayRunnerOperation => ({
    operationId: "op_a",
    kind: "landing",
    repo: "pechhe/t3code",
    status: "queued",
    stage: "queued",
    submittedBy: "host:t3-one",
    ...overrides,
  });
  const overview = (overrides: Partial<SlipJayRunnerOverview>): SlipJayRunnerOverview => ({
    connected: true,
    paused: false,
    serial: [],
    deploy: [],
    deploys: [],
    ...overrides,
  });

  it("says how many wait ahead of a queued operation, and nothing once it runs", () => {
    expect(resolveSlipJayQueueLabel(operation({ position: 1 }))).toBe("Queued · next");
    expect(resolveSlipJayQueueLabel(operation({ position: 3 }))).toBe("Queued · 2 ahead");
    expect(resolveSlipJayQueueLabel(operation({ status: "running", position: 1 }))).toBeNull();
  });

  it("summarises the lanes, and hides a runner this environment never reached", () => {
    expect(resolveSlipJayRunnerSummary(overview({ connected: false }))).toBeNull();
    expect(resolveSlipJayRunnerSummary(overview({}))?.label).toBe("idle");
    expect(
      resolveSlipJayRunnerSummary(
        overview({
          serial: [operation({ status: "running" }), operation({ operationId: "op_b" })],
          deploy: [operation({ operationId: "op_c", kind: "deploy" })],
        }),
      )?.label,
    ).toBe("1 running · 2 queued");
    expect(resolveSlipJayRunnerSummary(overview({ paused: true }))?.tone).toBe("attention");
  });

  it("names the running operation and counts the rest, leaving out one shown on its own", () => {
    const lanes = overview({
      serial: [
        operation({ operationId: "op_mine", status: "running" }),
        operation({ operationId: "op_b" }),
      ],
      deploy: [operation({ operationId: "op_c", kind: "deploy", status: "running" })],
    });
    expect(resolveSlipJayRunnerSummary(lanes)).toMatchObject({
      lead: { operationId: "op_mine" },
      others: 2,
    });
    expect(resolveSlipJayRunnerSummary(lanes, "op_mine")).toMatchObject({
      label: "1 running · 1 queued",
      lead: { operationId: "op_c" },
      others: 1,
    });
    expect(
      resolveSlipJayRunnerSummary(overview({ serial: [operation({ operationId: "op_b" })] })),
    ).toMatchObject({ lead: null, others: 1 });
  });

  it("names a thread's workspace after its directory", () => {
    expect(slipJayWorkspaceName("/Users/h/.slipjay/workspaces/t3-one/")).toBe("t3-one");
    expect(slipJayWorkspaceName(null)).toBeNull();
  });
});

describe("SlipJay landing chip", () => {
  const NOW = Date.parse("2026-10-17T15:10:00.000Z");
  const landing = (overrides: Partial<VcsStatusSlipJayLanding>): VcsStatusSlipJayLanding => ({
    operationId: "op_a",
    status: "active",
    stage: "verifying",
    live: true,
    ...overrides,
  });
  const operation = (overrides: Partial<SlipJayRunnerOperation>): SlipJayRunnerOperation => ({
    operationId: "op_a",
    kind: "landing",
    repo: "pechhe/t3code",
    status: "running",
    stage: "verifying",
    submittedBy: "host:t3-one",
    submittedAt: "2026-10-17T15:08:24.000Z",
    ...overrides,
  });

  it("formats durations as seconds, then minutes and hours", () => {
    expect(formatSlipJayDuration(42_400)).toBe("42s");
    expect(formatSlipJayDuration(96_000)).toBe("1:36");
    expect(formatSlipJayDuration(3_725_000)).toBe("1:02:05");
    expect(formatSlipJayDuration(-5)).toBe("0s");
  });

  it("counts the stages a landing finished, and where it stopped", () => {
    expect(resolveSlipJayStageProgress(landing({ stage: "verifying" }))).toEqual({
      completed: 3,
      current: 3,
    });
    expect(resolveSlipJayStageProgress(landing({ status: "landed", stage: "publishing" }))).toEqual(
      {
        completed: 7,
        current: null,
      },
    );
    expect(resolveSlipJayStageProgress(landing({ stage: "queued" }))).toEqual({
      completed: 0,
      current: null,
    });
  });

  it("says where a waiting landing is in the queue and how long it has waited", () => {
    expect(
      resolveSlipJayLandingChip(
        landing({ stage: "queued" }),
        operation({ status: "queued", stage: "queued", position: 3 }),
        NOW,
      ),
    ).toEqual({
      tone: "waiting",
      label: "waiting",
      detail: "2 ahead",
      elapsed: "1:36",
      slow: false,
    });
    expect(
      resolveSlipJayLandingChip(
        landing({ stage: "queued" }),
        operation({ status: "queued", position: 1 }),
        NOW,
      ).detail,
    ).toBe("next");
  });

  it("treats a landing as running once its own stage moves on, whatever a stale overview says", () => {
    expect(
      resolveSlipJayLandingChip(
        landing({ stage: "verifying" }),
        operation({ status: "queued", stage: "queued", position: 2 }),
        NOW,
      ),
    ).toMatchObject({ tone: "running", label: "verifying", elapsed: null });
  });

  it("shows no wait time while the overview already has a queued landing running", () => {
    expect(
      resolveSlipJayLandingChip(
        landing({ stage: "queued" }),
        operation({ startedAt: "2026-10-17T15:09:45.000Z" }),
        NOW,
      ),
    ).toMatchObject({ tone: "waiting", elapsed: null });
  });

  it("counts a running landing's time from when it left the queue, not from submission", () => {
    expect(
      resolveSlipJayLandingChip(
        landing({}),
        operation({ startedAt: "2026-10-17T15:09:45.000Z" }),
        NOW,
      ).elapsed,
    ).toBe("15s");
    expect(resolveSlipJayLandingChip(landing({}), operation({}), NOW).elapsed).toBeNull();
  });

  it("estimates what is left of the running stage from the runner's median", () => {
    const running = operation({
      startedAt: "2026-10-17T15:08:30.000Z",
      stageStartedAt: "2026-10-17T15:09:00.000Z",
      stageMedianMs: 77_000,
    });
    expect(resolveSlipJayLandingChip(landing({}), running, NOW)).toEqual({
      tone: "running",
      label: "verifying",
      detail: "~17s left",
      elapsed: "1:30",
      slow: false,
    });
    expect(resolveSlipJayLandingChip(landing({}), running, NOW + 60_000)).toMatchObject({
      detail: "slower than usual",
      slow: true,
    });
    // The overview has not caught up with the landing's newer stage, so its timing is stale.
    expect(
      resolveSlipJayLandingChip(landing({ stage: "integrating" }), running, NOW).detail,
    ).toBeNull();
    expect(resolveSlipJayLandingChip(landing({ live: false }), null, NOW)).toMatchObject({
      label: "verifying · reconnecting",
      elapsed: null,
    });
  });

  it("names the outcome once the landing ends", () => {
    expect(
      resolveSlipJayLandingChip(landing({ status: "landed", commitId: "3bf779b4d356" }), null, NOW),
    ).toEqual({
      tone: "landed",
      label: "landed",
      detail: "3bf779b",
      elapsed: null,
      slow: false,
    });
    expect(resolveSlipJayLandingChip(landing({ status: "failed" }), null, NOW)).toMatchObject({
      tone: "failed",
      label: "failed at verifying",
    });
    expect(resolveSlipJayLandingChip(landing({ status: "cancelled" }), null, NOW).tone).toBe(
      "ended",
    );
  });
});

describe("SlipJay landing times", () => {
  const detail = {
    status: "landed",
    stage: "publishing",
    terminal: true,
    submittedAt: "2026-10-18T14:31:57.000Z",
    checks: [
      {
        command: "vp test",
        purpose: "gate",
        outcome: "passed",
        durationMs: 14_000,
        failingTests: [],
      },
      {
        command: "vp lint",
        purpose: "gate",
        outcome: "passed",
        durationMs: 31_000,
        failingTests: [],
      },
    ],
  };

  it("measures a finished landing to its finish and sums its checks", () => {
    expect(
      resolveSlipJayLandingTimes(
        { ...detail, finishedAt: "2026-10-18T14:34:40.000Z" },
        Date.parse("2026-10-18T15:00:00.000Z"),
      ),
    ).toEqual({ took: "2:43", checks: "45s" });
  });

  it("measures a running landing to now, counting only finished checks", () => {
    expect(
      resolveSlipJayLandingTimes(
        {
          ...detail,
          terminal: false,
          checks: [
            ...detail.checks,
            { command: "vp typecheck", purpose: "gate", outcome: "incomplete", failingTests: [] },
          ],
        },
        Date.parse("2026-10-18T14:32:57.000Z"),
      ),
    ).toEqual({ took: "1:00", checks: "45s" });
  });

  it("says nothing it was not told", () => {
    const { submittedAt: _, ...unsubmitted } = detail;
    expect(resolveSlipJayLandingTimes({ ...unsubmitted, checks: [] }, 0)).toEqual({
      took: null,
      checks: null,
    });
    // Finished, but without its finish time: not the time since submission.
    expect(resolveSlipJayLandingTimes(detail, Date.parse("2026-10-18T15:00:00.000Z")).took).toBe(
      null,
    );
    expect(resolveSlipJayLandingTimes({ ...detail, finishedAt: "not a time" }, 0).took).toBe(null);
  });
});
