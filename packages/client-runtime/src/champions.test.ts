import {
  ChampionError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionFinding,
  type ChampionLatestSample,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  championCadenceMs,
  championFailureMessage,
  championLoadFailureMessage,
  championNeedsAttention,
  championReading,
  championReadingLabel,
  championStaleAfterMs,
  championStatus,
  CHAMPION_FINDING_STATUS_LABELS,
  pendingChampionDecision,
} from "./champions.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const FUTURE = "2026-11-02T12:00:00.000Z";
const PAST = "2026-11-01T11:00:00.000Z";
const selection = { instanceId: ProviderInstanceId.make("claude"), model: "m" };

const sample = (patch: Partial<ChampionLatestSample> = {}): ChampionLatestSample => ({
  metricId: "open",
  name: "Open",
  version: 1,
  seriesId: "series",
  unit: "ms",
  required: true,
  value: 40,
  status: "measured",
  health: "healthy",
  observedAt: PAST,
  collectedAt: PAST,
  revision: null,
  staleAt: FUTURE,
  ...patch,
});

const summary = (patch: Partial<ChampionSummary> = {}): ChampionSummary => ({
  id: "c1",
  projectId: ProjectId.make("p1"),
  name: "Performance",
  purpose: "Stay fast",
  schedule: { type: "fixed_time", timeOfDay: "06:00" },
  setupModelSelection: selection,
  routineModelSelection: selection,
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "active",
  ownerThreadId: ThreadId.make("t1"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: PAST,
  outstandingCheckId: null,
  outstandingSetupId: null,
  attention: [],
  openFindingCount: 0,
  pendingProposal: false,
  latestSamples: [sample()],
  updatedAt: PAST,
  ...patch,
});

const metric = { id: "open", seriesId: "series", unit: "ms" };

describe("championStatus", () => {
  it("is healthy only when every required reading is healthy", () => {
    expect(championStatus(summary(), NOW)).toBe("healthy");
    expect(
      championStatus(
        summary({ latestSamples: [sample(), sample({ metricId: "b", health: "unknown" })] }),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("lets an optional metric be missing without withdrawing healthy", () => {
    const optional = sample({ metricId: "b", required: false, health: "unknown", value: null });
    expect(championStatus(summary({ latestSamples: [sample(), optional] }), NOW)).toBe("healthy");
  });

  it("does not call a champion healthy on nothing", () => {
    expect(championStatus(summary({ latestSamples: [], lastCheckAt: null }), NOW)).toBe(
      "unmeasured",
    );
    expect(championStatus(summary({ latestSamples: [] }), NOW)).toBe("unknown");
    expect(championStatus(summary({ latestSamples: undefined }), NOW)).toBe("unknown");
    expect(
      championStatus(
        summary({ latestSamples: [sample({ required: false, health: "unknown" })] }),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("expires a reading at staleAt without waiting for the server to refresh", () => {
    const expired = summary({ latestSamples: [sample({ staleAt: PAST })] });
    expect(championStatus(expired, NOW)).toBe("stale");
  });

  it("does not accept a healthy reading that has no expiry", () => {
    expect(championStatus(summary({ latestSamples: [sample({ staleAt: null })] }), NOW)).toBe(
      "unknown",
    );
  });

  it("reports a breach ahead of other missing evidence", () => {
    const samples = [sample({ health: "breached" }), sample({ metricId: "b", health: "unknown" })];
    expect(championStatus(summary({ latestSamples: samples }), NOW)).toBe("off-target");
  });

  it("puts what someone must act on above what the readings say", () => {
    expect(championStatus(summary({ pendingProposal: true }), NOW)).toBe("review");
    expect(championStatus(summary({ attention: ["Look"] }), NOW)).toBe("attention");
    expect(championStatus(summary({ lifecycle: "paused" }), NOW)).toBe("paused");
    expect(championStatus(summary({ openFindingCount: 1 }), NOW)).toBe("working");
  });
});

describe("championNeedsAttention", () => {
  it("does not count a retired champion or a first setup still running", () => {
    expect(championNeedsAttention(summary({ lifecycle: "retired", attention: ["x"] }))).toBe(false);
    expect(
      championNeedsAttention(
        summary({ lastCheckAt: null, outstandingSetupId: "s", attention: ["x"] }),
      ),
    ).toBe(false);
    expect(championNeedsAttention(summary({ attention: ["x"] }))).toBe(true);
    expect(championNeedsAttention(summary({ pendingProposal: true }))).toBe(true);
  });
});

describe("championReading", () => {
  it("shows unknown as unknown, never zero", () => {
    const reading = championReading(
      metric,
      [sample({ status: "unknown", value: null, health: "unknown" })],
      NOW,
    );
    expect(championReadingLabel(reading, "ms")).toBe("Unknown");
  });

  it("does not present another series' value as this metric's", () => {
    expect(championReading(metric, [sample({ seriesId: "old" })], NOW).kind).toBe("not-yet");
    expect(championReading(metric, [sample({ unit: "s" })], NOW).kind).toBe("not-yet");
  });

  it("separates never measured from a server that sent nothing", () => {
    const placeholder = sample({
      value: null,
      status: "unknown",
      observedAt: null,
      collectedAt: null,
    });
    expect(championReading(metric, [placeholder], NOW).kind).toBe("not-yet");
    expect(championReading(metric, undefined, NOW).kind).toBe("unavailable");
  });

  it("keeps a stale value visible and marks it stale", () => {
    const reading = championReading(metric, [sample({ staleAt: PAST })], NOW);
    expect(reading).toMatchObject({ kind: "measured", value: 40, health: "stale" });
  });
});

describe("cadence", () => {
  it("uses the longest gap the schedule allows", () => {
    expect(championCadenceMs({ type: "interval", everyMs: 60_000 })).toBe(60_000);
    expect(championCadenceMs({ type: "fixed_time", timeOfDay: "06:00" })).toBe(86_400_000);
    expect(
      championCadenceMs({ type: "fixed_time", timeOfDay: "06:00", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe(3 * 86_400_000);
  });

  it("prefers a metric's own window over twice the cadence", () => {
    const schedule = { type: "interval", everyMs: 1000 } as const;
    expect(championStaleAfterMs({}, schedule)).toBe(2000);
    expect(championStaleAfterMs({ staleAfterMs: 5 }, schedule)).toBe(5);
  });
});

describe("failure messages", () => {
  it("asks for an update only when the server has no handler", () => {
    expect(championLoadFailureMessage(Cause.die("Unknown request tag"))).toContain("updating");
  });

  it("names a permission failure as one", () => {
    expect(
      championLoadFailureMessage(Cause.fail(new ChampionError({ reason: "unauthorized" }))),
    ).toContain("isn't allowed");
  });

  it("passes a transport message through", () => {
    expect(championLoadFailureMessage(Cause.fail(new Error("Connection lost")))).toBe(
      "Connection lost",
    );
  });

  it("explains a conflict by what was attempted", () => {
    const conflict = new ChampionError({ reason: "conflict" });
    expect(championFailureMessage(conflict, "cancel-setup")).toContain("still starting");
    expect(championFailureMessage(conflict, "decision")).toContain("decision");
  });
});

describe("findings", () => {
  const finding = (patch: Partial<ChampionFinding>) =>
    ({ status: "open", decision: null, ...patch }) as ChampionFinding;

  it("does not word a handoff as delivery", () => {
    expect(CHAMPION_FINDING_STATUS_LABELS.handed_back).toBe("Ready to integrate");
  });

  it("only treats a requested decision as pending", () => {
    const decision = {
      id: "d",
      question: "q",
      answer: null,
      requestedAt: PAST,
      resolvedAt: null,
    };
    expect(
      pendingChampionDecision(finding({ decision: { ...decision, status: "requested" } }))?.id,
    ).toBe("d");
    expect(
      pendingChampionDecision(finding({ decision: { ...decision, status: "resolved" } })),
    ).toBeNull();
    expect(pendingChampionDecision(finding({}))).toBeNull();
  });
});
