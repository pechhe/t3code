import type { BuildHomeAcceptanceNeed, BuildHomeNeed, BuildHomeState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildButtonCount,
  buildInboxEntries,
  buildInboxKey,
  buildInboxSelection,
  latestBuildHomeState,
} from "./BuildHomeButton.logic";

const state = (status: BuildHomeState["status"], count: number | null): BuildHomeState => ({
  status,
  origin: null,
  buildUrl: null,
  home:
    count === null ? null : { needsYou: [], capabilities: { answer: false, notes: false }, count },
  readAt: null,
});

const need = (over: Partial<BuildHomeAcceptanceNeed> = {}): BuildHomeAcceptanceNeed => ({
  kind: "acceptance",
  spec: { id: "i", number: 1, title: "t", status: "landed" },
  url: "u",
  repositories: [],
  checks: [],
  reviewSummary: null,
  tryIt: null,
  rows: [],
  resolvedFindings: [],
  card: { bodyRevision: 1, published: [], reviewRunId: "r" },
  ...over,
});

describe("the Build button", () => {
  it("counts Needs you, and is plain at zero or without a connection", () => {
    expect(buildButtonCount(state("ready", 3))).toBe(3);
    expect(buildButtonCount(state("ready", 0))).toBe(0);
    expect(buildButtonCount(state("not_connected", null))).toBe(0);
    expect(buildButtonCount(state("invalid_token", null))).toBe(0);
    expect(buildButtonCount(undefined)).toBe(0);
    // HQ unreachable keeps the last count rather than hiding work.
    expect(buildButtonCount(state("unavailable", 2))).toBe(2);
  });

  it("lists Specs to accept before what waits on you, keeping HQ's order in each", () => {
    const hold = (id: string, spec: string): BuildHomeNeed => ({
      kind: "hold",
      spec: { id: spec, number: 2, title: "t", status: "in_progress" },
      url: "u",
      holdId: id,
      holdKind: "decision",
      question: "Which?",
      since: null,
    });
    const entries = buildInboxEntries({
      needsYou: [hold("h1", "s2"), need(), hold("h2", "s2")],
      count: 3,
      capabilities: { answer: true, notes: true },
    });
    // Two questions on one Spec stay two entries.
    expect(entries.map(buildInboxKey)).toEqual(["acceptance:i", "hold:h1", "hold:h2"]);
  });

  it("selects the next entry once the chosen one leaves, and the last when it was last", () => {
    const entries = buildInboxEntries({
      needsYou: [
        need({ spec: { id: "a", number: 1, title: "a", status: "landed" } }),
        need({ spec: { id: "b", number: 2, title: "b", status: "landed" } }),
      ],
      count: 2,
      capabilities: { answer: true, notes: true },
    });
    expect(buildInboxSelection(entries, null)).toBe(entries[0]);
    expect(buildInboxSelection(entries, { key: "acceptance:b", index: 1 })).toBe(entries[1]);
    // "acceptance:a" was decided and left: the entry now at its place is selected.
    expect(buildInboxSelection(entries.slice(1), { key: "acceptance:a", index: 0 })).toBe(
      entries[1],
    );
    expect(buildInboxSelection(entries.slice(0, 1), { key: "acceptance:b", index: 1 })).toBe(
      entries[0],
    );
    expect(buildInboxSelection([], null)).toBeNull();
  });

  it("shows a decision's answer until a newer read arrives, so the count never freezes", () => {
    const at = (readAt: string, count: number) =>
      ({
        status: "ready",
        origin: null,
        buildUrl: null,
        readAt,
        home: { needsYou: [], capabilities: { answer: false, notes: false }, count },
      }) as BuildHomeState;
    const decided = at("2026-10-20T20:00:01.000Z", 0);
    expect(latestBuildHomeState(decided, at("2026-10-20T20:00:00.000Z", 1))).toBe(decided);
    const later = at("2026-10-20T20:01:00.000Z", 2);
    expect(latestBuildHomeState(decided, later)).toBe(later);
    expect(buildButtonCount(latestBuildHomeState(decided, later))).toBe(2);
    expect(latestBuildHomeState(null, later)).toBe(later);
  });
});
