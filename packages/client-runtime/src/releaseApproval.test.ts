import { ReleaseApprovalId, type ReleaseApprovalCardSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupOpenReleaseApprovals, releaseApprovalFacts } from "./releaseApproval.ts";

const card = (approvalId: string, requestedAt: string): ReleaseApprovalCardSummary => ({
  approvalId: ReleaseApprovalId.make(approvalId),
  repository: "pechhe/yardsmith",
  candidate: "a".repeat(40),
  base: "b".repeat(40),
  summary: {
    commits: 1,
    items: [{ ref: "#1", title: "One", partialBuild: true }],
    migrations: [
      { name: "0001_add", nonAdditive: false },
      { name: "0002_drop", nonAdditive: true },
    ],
    verification: { status: "failed", detail: "pnpm test" },
    coveredByEarlierApproval: false,
  },
  requestedAt,
});

describe("groupOpenReleaseApprovals", () => {
  it("shows one entry per card, listing every live thread that asked", () => {
    const shared = card("release-approval:1", "2026-10-18T10:00:00.000Z");
    const groups = groupOpenReleaseApprovals([
      {
        id: "later",
        environmentId: "env",
        archivedAt: null,
        pendingReleaseApprovals: [{ ...shared, requestedAt: "2026-10-18T11:00:00.000Z" }],
      },
      { id: "first", environmentId: "env", archivedAt: null, pendingReleaseApprovals: [shared] },
      {
        id: "archived",
        environmentId: "env",
        archivedAt: "2026-10-18T12:00:00.000Z",
        pendingReleaseApprovals: [shared],
      },
      { id: "idle", environmentId: "env", archivedAt: null, pendingReleaseApprovals: [] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.threads.map((thread) => thread.id)).toEqual(["first", "later"]);
  });

  it("keeps the same card id in different environments apart", () => {
    const shared = card("release-approval:1", "2026-10-18T10:00:00.000Z");
    const groups = groupOpenReleaseApprovals([
      { id: "a", environmentId: "env-a", archivedAt: null, pendingReleaseApprovals: [shared] },
      { id: "b", environmentId: "env-b", archivedAt: null, pendingReleaseApprovals: [shared] },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("shows every repository a thread is waiting on", () => {
    const groups = groupOpenReleaseApprovals([
      {
        id: "lead",
        environmentId: "env",
        archivedAt: null,
        pendingReleaseApprovals: [
          card("release-approval:yardsmith", "2026-10-18T10:00:00.000Z"),
          {
            ...card("release-approval:t3code", "2026-10-18T10:05:00.000Z"),
            repository: "pechhe/t3code",
          },
        ],
      },
    ]);
    expect(groups.map((group) => group.card.repository)).toEqual([
      "pechhe/yardsmith",
      "pechhe/t3code",
    ]);
  });
});

describe("releaseApprovalFacts", () => {
  it("calls out failed verification, non-additive migrations and partial builds", () => {
    expect(releaseApprovalFacts(card("x", "t").summary)).toEqual([
      { label: "1 commit", tone: "default" },
      { label: "Verification failed: pnpm test", tone: "danger" },
      { label: "1 non-additive migration", tone: "danger" },
      { label: "1 partly built", tone: "warning" },
    ]);
  });
});
