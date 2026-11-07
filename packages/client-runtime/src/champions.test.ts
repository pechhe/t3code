import {
  ChampionError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionFinding,
  type ChampionInvestigation,
  type ChampionLatestSample,
  type ChampionLearningRevision,
  type ChampionRecommendation,
  type ChampionRuntimeState,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  championCadenceMs,
  championApprovalAnswer,
  championApprovalWhen,
  championFailureMessage,
  championFindingRuntime,
  championLoadFailureMessage,
  championNeedsAttention,
  championReading,
  championReadingLabel,
  championResearchView,
  championStaleAfterMs,
  championStatus,
  CHAMPION_FINDING_STATUS_LABELS,
  learningNoteProse,
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
    expect(
      championFailureMessage(
        new ChampionError({
          reason: "unavailable",
          detail: "No model is available for the lead role.",
        }),
        "setup",
      ),
    ).toBe("No model is available for the lead role.");
    expect(championApprovalAnswer("Measure over 7 days.")).toBe("Approved: Measure over 7 days.");
    expect(championApprovalAnswer("x".repeat(500))).toHaveLength(500);
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

describe("championResearchView", () => {
  const attempt = (branchId: string, state: string, admittedAt = "2026-11-05T10:00:00.000Z") =>
    ({ id: `${branchId}-${admittedAt}`, branchId, state, admittedAt, result: null }) as never;
  const branch = (id: string) =>
    ({ id, hypothesis: `Hypothesis ${id}`, role: "researcher" }) as never;
  const investigation = (patch: Partial<ChampionInvestigation>): ChampionInvestigation =>
    ({
      investigationId: "inv",
      status: "open",
      attention: null,
      branches: [branch("a"), branch("b"), branch("c")],
      attempts: [],
      ...patch,
    }) as ChampionInvestigation;

  it("summarises running research in one line", () => {
    const view = championResearchView(
      investigation({ attempts: [attempt("a", "accepted"), attempt("b", "accepted")] }),
    );
    expect(view.summary).toBe("Researching 3 options · 2 tasks running");
    expect(view.live).toBe(true);
    expect(view.branches.map((item) => item.status)).toEqual(["Running", "Running", "Not started"]);
  });

  it("stays requested until the server confirms, not cancelled", () => {
    const view = championResearchView(
      investigation({
        status: "cancel_requested",
        attempts: [attempt("a", "completed"), attempt("b", "accepted")],
      }),
    );
    expect(view.summary).toBe("Cancel requested · 1 task not yet stopped");
    expect(view.live).toBe(true);
    expect(view.cancellable).toBe(false);
    expect(view.branches[1]?.status).toBe("Stop requested");
  });

  it("keeps a cancelled investigation live while a task can't be confirmed", () => {
    const view = championResearchView(
      investigation({ status: "cancelled", attempts: [attempt("a", "unknown")] }),
    );
    expect(view.live).toBe(true);
    expect(view.cannotConfirm).toBe(true);
  });

  it("reads each option from its latest attempt", () => {
    const view = championResearchView(
      investigation({
        status: "synthesized",
        attempts: [
          attempt("a", "failed", "2026-11-05T10:00:00.000Z"),
          attempt("a", "completed", "2026-11-05T11:00:00.000Z"),
        ],
      }),
    );
    expect(view.branches[0]?.status).toBe("Finished");
    expect(view.live).toBe(false);
    expect(view.summary).toBeNull();
  });
});

describe("championFindingRuntime", () => {
  const recommendation = (recommendationId: string, recordedAt: string) =>
    ({
      recommendationId,
      findingId: "f1",
      findingAttemptId: "attempt1",
      recordedAt,
    }) as ChampionRecommendation;
  const finding = (recommendationId: string | undefined) =>
    ({
      id: "f1",
      attemptId: "attempt1",
      decision: recommendationId === undefined ? null : { recommendationId },
    }) as ChampionFinding;
  const state = (recommendations: ReadonlyArray<ChampionRecommendation>) =>
    ({ attempts: [], investigations: [], recommendations }) as ChampionRuntimeState;

  it("finds the recommendation the decision names, not simply the newest", () => {
    const runtime = championFindingRuntime(
      finding("r2"),
      state([
        recommendation("r1", "2026-11-05T09:00:00.000Z"),
        recommendation("r2", "2026-11-05T10:00:00.000Z"),
        recommendation("r3", "2026-11-05T11:00:00.000Z"),
      ]),
    );
    expect(runtime.recommendation?.recommendationId).toBe("r2");
    expect(runtime.earlier.map((item) => item.recommendationId)).toEqual(["r1"]);
    expect(runtime.recommendationMissing).toBe(false);
  });

  it("recovers an evicted decision revision and ignores late or foreign exact responses on both clients", () => {
    const retained = recommendation("old", "2026-11-01T09:00:00.000Z");
    const recent = state(
      Array.from({ length: 20 }, (_, i) => recommendation(`new${i}`, "2026-11-05T09:00:00.000Z")),
    );
    expect(championFindingRuntime(finding("old"), recent, retained).recommendationMissing).toBe(
      false,
    );
    expect(championFindingRuntime(finding("old"), recent, retained).recommendation).toBe(retained);
    expect(
      championFindingRuntime(finding("new0"), recent, retained).recommendation?.recommendationId,
    ).toBe("new0");
    expect(championFindingRuntime(finding("another"), recent, retained).recommendationMissing).toBe(
      true,
    );
    expect(
      championFindingRuntime(finding("old"), recent, { ...retained, findingId: "foreign" })
        .recommendationMissing,
    ).toBe(true);
    expect(
      championFindingRuntime(finding("old"), recent, {
        ...retained,
        findingAttemptId: "prior-attempt",
      }).recommendationMissing,
    ).toBe(true);
  });

  it("reports a named recommendation it doesn't have, including before state loads", () => {
    expect(championFindingRuntime(finding("gone"), state([])).recommendationMissing).toBe(true);
    expect(championFindingRuntime(finding("gone"), null).recommendationMissing).toBe(true);
    expect(championFindingRuntime(finding(undefined), null).recommendationMissing).toBe(false);
  });
});

describe("learningNoteProse", () => {
  const revision = (patch: Partial<ChampionLearningRevision>): ChampionLearningRevision =>
    ({
      evidence: [
        { source: "Trial", evidence: "Refused at login.", observedAt: "2026-09-11T00:00:00.000Z" },
      ],
      attempts: [],
      applicability: "Private packages only.",
      tradeoffs: "",
      reviewAt: null,
      reviewConditions: ["Tool X adds scoped tokens"],
      versionConditions: [{ component: "Tool X", comparison: "changed", version: "1.4" }],
      isCurrent: true,
      applicabilityState: "current",
      ...patch,
    }) as ChampionLearningRevision;

  it("writes a revisit condition without promising anything watches for it", () => {
    const lines = learningNoteProse(revision({}));
    expect(lines).toContain("We'll reconsider if Tool X adds scoped tokens.");
    expect(lines).toContain("We'll reconsider if Tool X moves on from 1.4.");
    expect(lines.join(" ")).not.toMatch(/watch|monitor|automatic/i);
  });

  it("says a historical note was replaced rather than wrong", () => {
    const [first] = learningNoteProse(
      revision({ isCurrent: false, applicabilityState: "uncertain" }),
    );
    expect(first).toContain("newer note has replaced");
  });

  it("says a due note isn't false, deleted or rerun", () => {
    const [first] = learningNoteProse(revision({ applicabilityState: "uncertain" }));
    expect(first).toContain("doesn't make it wrong");
    expect(first).toContain("nothing reruns");
  });
});

describe("championApprovalWhen", () => {
  it("names the day, time and zone an approval came through", () => {
    // The zone is the viewer's own, so only the shape is fixed here.
    expect(championApprovalWhen("2026-11-07T12:00:00.000Z", "en-GB")).toMatch(
      /^\d{1,2} Nov,? \d{2}:\d{2} \S+$/,
    );
    expect(championApprovalWhen("not a date")).toBe("");
  });
});
