import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveJujutsuCheckoutLabels } from "./jujutsuCheckout";

const status = (overrides: Partial<VcsStatusResult>): VcsStatusResult => ({
  isRepo: false,
  otherVcsKind: "jj",
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "t3peach",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...overrides,
});
const files = (count: number) => ({
  files: Array.from({ length: count }, (_, index) => ({
    path: `${index}.ts`,
    insertions: 1,
    deletions: 0,
  })),
  insertions: count,
  deletions: 0,
});

describe("resolveJujutsuCheckoutLabels", () => {
  it("leaves Git checkouts and missing repositories to the Git labels", () => {
    expect(resolveJujutsuCheckoutLabels(null)).toBeNull();
    expect(
      resolveJujutsuCheckoutLabels(status({ isRepo: true, otherVcsKind: undefined })),
    ).toBeNull();
    expect(resolveJujutsuCheckoutLabels(status({ otherVcsKind: undefined }))).toBeNull();
  });

  it("shows a SlipJay workspace with its base, changed files and landing", () => {
    const workspace = { name: "t3-43", issueNumber: 43, isIntegration: false };
    expect(
      resolveJujutsuCheckoutLabels(
        status({ slipJay: { integration: "t3peach", workspace }, workingTree: files(2) }),
      ),
    ).toEqual({ title: "t3-43 · #43", summary: "on t3peach · 2 files" });
    expect(
      resolveJujutsuCheckoutLabels(
        status({
          slipJay: {
            integration: "t3peach",
            workspace,
            landing: { operationId: "op", status: "active", stage: "verifying", live: true },
          },
        }),
      )?.summary,
    ).toBe("on t3peach · Landing · verifying");
  });

  it("shows a plain Jujutsu checkout by its changed files", () => {
    expect(resolveJujutsuCheckoutLabels(status({ refName: null, workingTree: files(1) }))).toEqual({
      title: "Jujutsu checkout",
      summary: "1 file changed",
    });
  });
});
