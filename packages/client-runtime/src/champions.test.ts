import {
  ChampionError,
  ProjectId,
  ThreadId,
  type ChampionFinding,
  type ChampionLatestSample,
  type ChampionLearningRevision,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  championCadenceMs,
  championApprovalAnswer,
  championApprovalWhen,
  championFailureMessage,
  championLoadFailureMessage,
  championNeedsAttention,
  championReading,
  championReadingLabel,
  championReadingNote,
  formatChampionCommand,
  championStaleAfterMs,
  championStatus,
  learningNoteProse,
  pendingChampionDecision,
  visibleChampions,
} from "./champions.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const FUTURE = "2026-11-02T12:00:00.000Z";
const PAST = "2026-11-01T11:00:00.000Z";

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
  charter: { instructions: "" },
  lifecycle: "active",
  ownerThreadId: ThreadId.make("t1"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: PAST,
  outstandingCheckId: null,
  outstandingSetupId: null,
  attention: [],
  openFindingCount: 0,
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
  });
});

describe("visibleChampions", () => {
  const live = summary({ id: "live" });
  const retired = summary({ id: "retired", lifecycle: "retired" });
  const ids = (items: ReadonlyArray<ChampionSummary>) => items.map((item) => item.id);
  const identity = (item: ChampionSummary) => item;

  it("hides retired champions unless revealed or selected", () => {
    const all = [live, retired];
    expect(ids(visibleChampions(all, identity, { showRetired: false }))).toEqual(["live"]);
    expect(ids(visibleChampions(all, identity, { showRetired: true }))).toEqual([
      "live",
      "retired",
    ]);
    expect(
      ids(
        visibleChampions(all, identity, {
          showRetired: false,
          isSelected: (item) => item.id === "retired",
        }),
      ),
    ).toEqual(["live", "retired"]);
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
    expect(
      championReadingLabel(championReading(metric, [sample({ seriesId: "old" })], NOW), "ms"),
    ).toBe("Not measured since it changed");
  });

  it("says when a value has no target or comes from an earlier definition, and never calls either unknown", () => {
    const note = (health: ChampionLatestSample["health"], staleAt = FUTURE) =>
      championReadingNote(championReading(metric, [sample({ health, staleAt })], NOW));
    expect(note("untargeted")).toBe("No target");
    expect(note("outdated")).toBe("Earlier definition");
    expect(note("healthy")).toBeNull();
    expect(note("untargeted", PAST)).toBeNull();
    expect(
      championStatus(summary({ latestSamples: [sample({ health: "untargeted" })] }), NOW),
    ).toBe("untargeted");
    expect(
      championStatus(
        summary({ latestSamples: [sample(), sample({ metricId: "b", health: "untargeted" })] }),
        NOW,
      ),
    ).toBe("healthy");
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

describe("collected metric commands", () => {
  it("sets apart an argument a shell would split", () => {
    expect(formatChampionCommand(["sh", "-c", "echo it's $HOME", "--", "x"])).toBe(
      "sh -c\n  echo it's $HOME\n-- x",
    );
    expect(formatChampionCommand(["cut", "-d", " ", "-f3"])).toBe('cut -d\n  " "\n-f3');
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
