import type { BuildHomeAcceptanceNeed, BuildHomeState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAcceptanceBadges,
  buildButtonCount,
  buildDecisionEnabled,
  latestBuildHomeState,
} from "./BuildHomeButton.logic";

const state = (status: BuildHomeState["status"], count: number | null): BuildHomeState => ({
  status,
  origin: null,
  buildUrl: null,
  home: count === null ? null : { needsYou: [], stuck: [], inProgress: [], count },
  readAt: null,
});

const need = (over: Partial<BuildHomeAcceptanceNeed> = {}): BuildHomeAcceptanceNeed => ({
  kind: "acceptance",
  spec: { id: "i", number: 1, title: "t", status: "landed" },
  url: "u",
  repositories: [],
  staging: "carried",
  rowsMet: 3,
  rowsTotal: 3,
  blockingFindings: 0,
  reviewSummary: null,
  tryIt: null,
  rows: [],
  card: { bodyRevision: 1, published: [], reviewRunId: "r" },
  ...over,
});

describe("the Build button", () => {
  it("counts Needs you and Stuck, and is plain at zero or without a connection", () => {
    expect(buildButtonCount(state("ready", 3))).toBe(3);
    expect(buildButtonCount(state("ready", 0))).toBe(0);
    expect(buildButtonCount(state("not_connected", null))).toBe(0);
    expect(buildButtonCount(state("invalid_token", null))).toBe(0);
    expect(buildButtonCount(undefined)).toBe(0);
    // HQ unreachable keeps the last count rather than hiding work.
    expect(buildButtonCount(state("unavailable", 2))).toBe(2);
  });

  it("enables Send back only with a note, and no decision without a card", () => {
    expect(buildDecisionEnabled(need(), "send_back", "  ")).toBe(false);
    expect(buildDecisionEnabled(need(), "send_back", "order is wrong")).toBe(true);
    expect(buildDecisionEnabled(need(), "accept", "")).toBe(true);
    expect(buildDecisionEnabled(need({ card: null }), "accept", "")).toBe(false);
  });

  it("badges Build's objective checks", () => {
    expect(buildAcceptanceBadges(need()).map((badge) => badge.label)).toEqual([
      "On staging",
      "3 of 3 rows met",
      "No blocking findings",
    ]);
    const bad = buildAcceptanceBadges(
      need({ staging: "not_carried", rowsMet: 1, blockingFindings: 2 }),
    );
    expect(bad.map((badge) => badge.good)).toEqual([false, false, false]);
    expect(buildAcceptanceBadges(need({ staging: "not_required" }))[0]).toEqual({
      label: "Staging not required",
      good: true,
    });
    expect(buildAcceptanceBadges(need({ staging: "unavailable" }))[0]).toEqual({
      label: "No staging deploy yet",
      good: false,
    });
  });

  it("shows a decision's answer until a newer read arrives, so the count never freezes", () => {
    const at = (readAt: string, count: number) =>
      ({
        status: "ready",
        origin: null,
        buildUrl: null,
        readAt,
        home: { needsYou: [], stuck: [], inProgress: [], count },
      }) as BuildHomeState;
    const decided = at("2026-10-20T20:00:01.000Z", 0);
    expect(latestBuildHomeState(decided, at("2026-10-20T20:00:00.000Z", 1))).toBe(decided);
    const later = at("2026-10-20T20:01:00.000Z", 2);
    expect(latestBuildHomeState(decided, later)).toBe(later);
    expect(buildButtonCount(latestBuildHomeState(decided, later))).toBe(2);
    expect(latestBuildHomeState(null, later)).toBe(later);
  });
});
