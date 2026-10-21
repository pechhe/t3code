import {
  type VcsRef,
  type VcsStatusResult,
  type VcsStatusSlipJayLanding,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSlipJayCheckoutStatus } from "@t3tools/client-runtime/slipjay-checkout";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveLocalCheckoutBranchMismatch,
  isSlipJayLandRefusal,
  resolveSlipJayLandAvailability,
  resolveSlipJayLandToast,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

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

describe("SlipJay land", () => {
  it("offers Land only in a started thread's own workspace, and not mid-landing", () => {
    const workspaceStatus = (landing?: VcsStatusSlipJayLanding) =>
      resolveSlipJayCheckoutStatus(
        checkoutStatus({
          slipJay: {
            integration: "develop",
            workspace: { name: "t3-24", isIntegration: false },
            ...(landing === undefined ? {} : { landing }),
          },
        }),
        CWD,
      )!;
    const root = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: { integration: "develop", workspace: { name: "default", isIntegration: true } },
      }),
      CWD,
    )!;
    expect(resolveSlipJayLandAvailability(workspaceStatus(), false)).toBe("available");
    expect(resolveSlipJayLandAvailability(workspaceStatus(), true)).toBeNull();
    expect(resolveSlipJayLandAvailability(root, false)).toBeNull();
    expect(
      resolveSlipJayLandAvailability(
        workspaceStatus({ operationId: "op_a", status: "active", stage: "verifying", live: true }),
        false,
      ),
    ).toBe("landing");
    expect(
      resolveSlipJayLandAvailability(
        workspaceStatus({ operationId: "op_a", status: "failed", stage: "gate", live: true }),
        false,
      ),
    ).toBe("available");
  });

  it("tells a refused land from a lost connection to a running one", () => {
    expect(isSlipJayLandRefusal({ _tag: "SlipJayCommandError", detail: "not a workspace" })).toBe(
      true,
    );
    expect(isSlipJayLandRefusal({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(isSlipJayLandRefusal({ _tag: "EnvironmentRpcUnavailableError" })).toBe(false);
    expect(isSlipJayLandRefusal(new Error("socket closed"))).toBe(false);
  });

  it("reports a land in SlipJay's own words", () => {
    expect(
      resolveSlipJayLandToast({
        landed: false,
        verdict: "failed",
        operationId: "op_a",
        commitId: null,
        messages: ["[runner r] failed at verifying: tests failed"],
      }),
    ).toEqual({
      type: "error",
      title: "Land failed",
      description: "[runner r] failed at verifying: tests failed",
    });
    // Following an older commit reports that commit as landed, not this workspace's change.
    expect(
      resolveSlipJayLandToast({
        landed: false,
        verdict: "landed",
        operationId: "op_a",
        commitId: "abc1234def",
        messages: [
          "[runner r] followed an older commit (abc); land again to publish your current commit",
        ],
      }),
    ).toMatchObject({ type: "error", title: "Not landed" });
    expect(
      resolveSlipJayLandToast({
        landed: true,
        verdict: "landed",
        operationId: "op_a",
        commitId: "abc1234def",
        messages: ["Kept landed workspace t3-24: in use by a live process: pid 1 (node)"],
      }),
    ).toEqual({
      type: "success",
      title: "Landed abc1234",
      description: "Kept landed workspace t3-24: in use by a live process: pid 1 (node)",
    });
  });

  it("carries the workspace's landing from its status", () => {
    const landing: VcsStatusSlipJayLanding = {
      operationId: "op_a",
      status: "active",
      stage: "queued",
      live: true,
    };
    const status = resolveSlipJayCheckoutStatus(
      checkoutStatus({
        slipJay: {
          integration: "develop",
          workspace: { name: "t3-29", isIntegration: false },
          landing,
        },
      }),
      CWD,
    )!;
    expect(status.landing).toEqual(landing);
    expect(status.cwd).toBe(CWD);
  });
});

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarPrBranch", () => {
  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("keeps a server thread in worktree mode while its worktree is still being created", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
        preparingWorktree: true,
      }),
    ).toBe("worktree");
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
      }),
    ).toBe("local");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "new-branch",
        normalizedQuery: "new branch",
        createBranchItemValue: null,
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });
});

describe("sanitizeNewRefName", () => {
  it("collapses a run of whitespace into a single dash", () => {
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
  });

  it("replaces tabs, which git rejects just like spaces", () => {
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
    expect(sanitizeNewRefName("new\u2009branch")).toBe("new\u2009branch");
  });

  it("does not collapse dashes the user typed", () => {
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });
});
