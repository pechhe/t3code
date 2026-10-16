import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  VcsStatusResult,
  VcsStatusSlipJayLanding,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSlipJayBaseLabel,
  resolveSlipJayCheckoutStatus,
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
    expect(resolveSlipJayRunnerSummary(overview({}))?.label).toBe("SlipJay · idle");
    expect(
      resolveSlipJayRunnerSummary(
        overview({
          serial: [operation({ status: "running" }), operation({ operationId: "op_b" })],
          deploy: [operation({ operationId: "op_c", kind: "deploy" })],
        }),
      )?.label,
    ).toBe("SlipJay · 1 running · 2 queued");
    expect(resolveSlipJayRunnerSummary(overview({ paused: true }))?.tone).toBe("attention");
  });

  it("names a thread's workspace after its directory", () => {
    expect(slipJayWorkspaceName("/Users/h/.slipjay/workspaces/t3-one/")).toBe("t3-one");
    expect(slipJayWorkspaceName(null)).toBeNull();
  });
});
