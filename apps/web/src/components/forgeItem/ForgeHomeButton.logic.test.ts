import type {
  ForgeHomeAcceptanceNeed,
  ForgeHomeOtherNeed,
  ForgeHomeState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildButtonCount,
  buildInboxEntries,
  buildInboxKey,
  buildInboxSelection,
  latestForgeHomeState,
  forgeStageGlyph,
} from "./ForgeHomeButton.logic";

const state = (status: ForgeHomeState["status"], count: number | null): ForgeHomeState => ({
  status,
  origin: null,
  buildUrl: null,
  home:
    count === null
      ? null
      : { needsYou: [], recentlyLanded: [], capabilities: { notes: false }, count },
  readAt: null,
});

const need = (over: Partial<ForgeHomeAcceptanceNeed> = {}): ForgeHomeAcceptanceNeed => ({
  kind: "acceptance",
  group: "accept",
  reasonLabel: "To accept",
  reasonDetail: "Live on staging and reviewed",
  since: null,
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

describe("the Forge button", () => {
  it("counts Needs you, and is plain at zero or without a connection", () => {
    expect(buildButtonCount(state("ready", 3))).toBe(3);
    expect(buildButtonCount(state("ready", 0))).toBe(0);
    expect(buildButtonCount(state("not_connected", null))).toBe(0);
    expect(buildButtonCount(state("invalid_token", null))).toBe(0);
    expect(buildButtonCount(undefined)).toBe(0);
    // Weave unreachable keeps the last count rather than hiding work.
    expect(buildButtonCount(state("unavailable", 2))).toBe(2);
  });

  it("lists Accept, then Answer, by each entry's group, keeping Weave's order in each", () => {
    const challenge = (spec: string): ForgeHomeOtherNeed => ({
      kind: "decision_challenge",
      spec: { id: spec, number: 2, title: "t", status: "in_progress" },
      url: "u",
      detail: null,
      group: "answer",
      reasonLabel: "Challenged",
      reasonDetail: "Why?",
      since: null,
    });
    const entries = buildInboxEntries({
      needsYou: [challenge("s2"), need(), challenge("s3")],
      recentlyLanded: [],
      count: 3,
      capabilities: { notes: true },
    });
    expect(entries.map(buildInboxKey)).toEqual([
      "acceptance:i",
      "decision_challenge:s2",
      "decision_challenge:s3",
    ]);
  });

  it("selects the next entry once the chosen one leaves, and the last when it was last", () => {
    const entries = buildInboxEntries({
      needsYou: [
        need({ spec: { id: "a", number: 1, title: "a", status: "landed" } }),
        need({ spec: { id: "b", number: 2, title: "b", status: "landed" } }),
      ],
      recentlyLanded: [],
      count: 2,
      capabilities: { notes: true },
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
        home: {
          needsYou: [],
          recentlyLanded: [],
          capabilities: { notes: false },
          count,
        },
      }) as ForgeHomeState;
    const decided = at("2026-10-20T20:00:01.000Z", 0);
    expect(latestForgeHomeState(decided, at("2026-10-20T20:00:00.000Z", 1))).toBe(decided);
    const later = at("2026-10-20T20:01:00.000Z", 2);
    expect(latestForgeHomeState(decided, later)).toBe(later);
    expect(buildButtonCount(latestForgeHomeState(decided, later))).toBe(2);
    expect(latestForgeHomeState(null, later)).toBe(later);
  });

  it("draws a landing's stage as Weave's glyph: Live outranks Accepted, waiting is amber Landed", () => {
    expect(forgeStageGlyph("landed")).toEqual({
      tone: "teal",
      ring: "solid",
      fill: 0.75,
      tick: false,
    });
    expect(forgeStageGlyph("waiting_deploy")).toEqual({
      tone: "amber",
      ring: "solid",
      fill: 0.75,
      tick: false,
    });
    expect(forgeStageGlyph("accepted")).toEqual({
      tone: "green",
      ring: "solid",
      fill: 1,
      tick: true,
    });
    expect(forgeStageGlyph("in_production")).toEqual({
      tone: "green",
      ring: "halo",
      fill: 1,
      tick: true,
    });
  });
});
