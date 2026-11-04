import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ChampionActivity,
  type ChampionFinding,
  type ChampionMetric,
  type ChampionSample,
  type ChampionSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  championActivityView,
  championMachineGap,
  championsNeedingAttention,
  metricChange,
  metricIsOffTarget,
  metricSeries,
  metricTargetLabel,
  metricTrend,
  metricsMatchProposal,
  mergeHistoryPages,
  modelSelectionProblem,
  orderChampions,
  parseMetricDrafts,
  emptyMetricDraft,
  metricDraftOf,
  readingFreshness,
  resolveChampionModel,
  resolveChampionSelection,
  retiredMetrics,
  safeExternalUrl,
  sparklineGeometry,
  suggestChampionModels,
  validateChampionsSearch,
} from "./champions.logic";

const ENV = EnvironmentId.make("env-a");
const OTHER_ENV = EnvironmentId.make("env-b");
const THREAD = ThreadId.make("thread-1");
const RECENT = Date.parse("2026-11-01T12:00:00.000Z");

const summary = (patch: Partial<ChampionSummary> = {}): ChampionSummary => ({
  id: "c1",
  projectId: ProjectId.make("p1"),
  name: "Performance",
  purpose: "Stay fast",
  schedule: { type: "fixed_time", timeOfDay: "06:00" },
  setupModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  routineModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "active",
  ownerThreadId: THREAD,
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: "2026-11-01T00:00:00.000Z",
  outstandingCheckId: null,
  outstandingSetupId: null,
  attention: [],
  openFindingCount: 0,
  pendingProposal: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...patch,
});

const metric = (patch: Partial<ChampionMetric> = {}): ChampionMetric => ({
  id: "open",
  name: "Open time",
  description: "",
  unit: "ms",
  source: "fixture",
  context: "",
  direction: "lower",
  minimum: null,
  maximum: 100,
  version: 2,
  seriesId: "series-2",
  reason: "because",
  ...patch,
});

let checkCounter = 0;
const sample = (patch: Partial<ChampionSample> & { readonly day: number }): ChampionSample => {
  const { day, ...rest } = patch;
  checkCounter += 1;
  const at = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return {
    metricId: "open",
    version: 2,
    unit: "ms",
    status: "measured",
    value: 50,
    observedAt: at,
    source: "fixture",
    evidence: "",
    revision: null,
    championId: "c1",
    checkId: `check-${checkCounter}`,
    seriesId: "series-2",
    collectedAt: at,
    threadId: THREAD,
    runId: RunId.make("run"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
    provenance: "agent-reported",
    ...rest,
  };
};

const finding = (patch: Partial<ChampionFinding>): ChampionFinding => ({
  id: "f1",
  metricId: null,
  seriesId: null,
  title: "Slipped",
  evidence: "",
  status: "open",
  childThreadId: null,
  workId: "w",
  attemptId: "a",
  revision: null,
  specUrl: null,
  updatedAt: "2026-10-05T00:00:00.000Z",
  ...patch,
});

const event = (patch: Partial<ChampionActivity>): ChampionActivity => ({
  id: "e1",
  championId: "c1",
  at: "2026-10-05T00:00:00.000Z",
  kind: "configuration",
  text: "",
  findingId: null,
  threadId: null,
  revision: null,
  specUrl: null,
  ...patch,
});

const provider = (patch: Partial<ServerProvider> = {}) =>
  ({ availability: "available", usage: undefined, ...patch }) as ServerProvider;

const entry = (
  instanceId: string,
  slugs: ReadonlyArray<string>,
  patch: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: true,
    installed: true,
    isAvailable: true,
    status: "ready",
    snapshot: provider(),
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
    ...patch,
  }) as unknown as ProviderInstanceEntry;

describe("validateChampionsSearch", () => {
  it("only deep-links with both a machine and a champion", () => {
    expect(validateChampionsSearch({ id: "c1" })).toEqual({});
    expect(validateChampionsSearch({ environmentId: "env-a" })).toEqual({});
    expect(validateChampionsSearch({ environmentId: "env-a", id: "c1" })).toEqual({
      environmentId: ENV,
      id: "c1",
    });
  });

  it("drops a form view that has no champion to edit", () => {
    expect(validateChampionsSearch({ view: "edit" })).toEqual({});
    expect(validateChampionsSearch({ view: "new" })).toEqual({ view: "new" });
    expect(validateChampionsSearch({ environmentId: "env-a", id: "c1", view: "metrics" })).toEqual({
      environmentId: ENV,
      id: "c1",
      view: "metrics",
    });
  });
});

describe("resolveChampionSelection", () => {
  const entries = [
    { environmentId: ENV, champion: summary() },
    { environmentId: OTHER_ENV, champion: summary({ id: "c2" }) },
  ];

  it("never falls back to the same id on another machine", () => {
    expect(
      resolveChampionSelection(
        entries,
        { environmentId: OTHER_ENV, id: "c1" },
        { openFirst: true },
      ),
    ).toEqual({ kind: "missing", environmentId: OTHER_ENV, id: "c1" });
  });

  it("opens the first champion only when the layout has room for it", () => {
    expect(resolveChampionSelection(entries, {}, { openFirst: false })).toEqual({ kind: "none" });
    expect(resolveChampionSelection(entries, {}, { openFirst: true })).toEqual({
      kind: "found",
      entry: entries[0],
    });
  });
});

describe("orderChampions", () => {
  it("keeps a retired champion out of attention counts whatever it last reported", () => {
    const retired = summary({ lifecycle: "retired", attention: ["Something"] });
    expect(championsNeedingAttention([{ environmentId: ENV, champion: retired }])).toBe(0);
  });

  it("orders what needs someone first and retired last", () => {
    const ordered = orderChampions(
      [
        { environmentId: ENV, champion: summary({ id: "r", lifecycle: "retired" }) },
        { environmentId: ENV, champion: summary({ id: "h" }) },
        { environmentId: ENV, champion: summary({ id: "p", pendingProposal: true }) },
      ],
      RECENT,
    );
    expect(ordered.map((item) => item.champion.id)).toEqual(["p", "h", "r"]);
  });
});

describe("readingFreshness", () => {
  const measured = {
    kind: "measured",
    value: 50,
    observedAt: "2026-10-01T00:00:00.000Z",
    health: "healthy",
  } as const;

  it("words a paused or out-of-date reading as a point in time", () => {
    expect(readingFreshness(measured, "paused")?.prefix).toBe("As of");
    expect(readingFreshness({ ...measured, health: "stale" }, "active")?.prefix).toBe("As of");
    expect(readingFreshness(measured, "active")?.prefix).toBe("");
  });

  it("says when a check failed to measure, and claims no time without one", () => {
    const checked = {
      kind: "unmeasured",
      status: "error",
      observedAt: measured.observedAt,
    } as const;
    expect(readingFreshness(checked, "active")?.prefix).toBe("Checked");
    expect(readingFreshness({ kind: "not-yet" }, "active")).toBeNull();
  });
});

describe("metricTrend", () => {
  const values = (...items: ReadonlyArray<number | null>) =>
    items.map((value, index) =>
      value === null
        ? sample({ day: index + 1, status: "unknown", value: null })
        : sample({ day: index + 1, value }),
    );

  it("judges a change by the metric's better direction", () => {
    expect(metricTrend(metric(), values(100, 100, 100, 50))).toEqual({
      direction: "down",
      judgement: "better",
    });
    expect(metricTrend(metric({ direction: "higher" }), values(100, 100, 100, 50))).toEqual({
      direction: "down",
      judgement: "worse",
    });
  });

  it("makes no judgement for a metric with no better direction", () => {
    expect(metricTrend(metric({ direction: "observe" }), values(100, 100, 100, 50))).toEqual({
      direction: "down",
      judgement: null,
    });
  });

  it("claims nothing without enough readings or when the latest is unknown", () => {
    expect(metricTrend(metric(), values(100, 100, 50))).toBeNull();
    expect(metricTrend(metric(), values(100, 100, 100, 50, null))).toBeNull();
  });

  it("does not build a trend across a series boundary", () => {
    const old = [1, 2, 3].map((day) => sample({ day, seriesId: "series-1", value: 500 }));
    expect(metricTrend(metric(), [...old, sample({ day: 4, value: 50 })])).toBeNull();
  });
});

describe("metricSeries", () => {
  it("keeps incompatible series apart and the current one first", () => {
    const current = metric();
    const views = metricSeries(
      current,
      [
        metric({ version: 1, seriesId: "series-1", unit: "s" }),
        metric({ version: 2, seriesId: "series-2" }),
      ],
      [sample({ day: 1, seriesId: "series-1", unit: "s", value: 1 }), sample({ day: 2, value: 2 })],
    );
    expect(views.map((view) => view.seriesId)).toEqual(["series-2", "series-1"]);
    expect(views.map((view) => view.samples.map((item) => item.value))).toEqual([[2], [1]]);
  });

  it("still shows readings whose definition is older than the loaded history", () => {
    const views = metricSeries(metric(), [], [sample({ day: 1, seriesId: "gone" })]);
    expect(views.find((view) => view.seriesId === "gone")?.definitions).toEqual([]);
  });
});

describe("retiredMetrics", () => {
  it("keeps the newest definition of a metric that left the accepted set", () => {
    const left = retiredMetrics(
      [metric()],
      [metric(), metric({ id: "gone", version: 1 }), metric({ id: "gone", version: 3 })],
    );
    expect(left.map((item) => [item.id, item.version])).toEqual([["gone", 3]]);
  });
});

describe("targets", () => {
  it("does not flag an observe-only metric however its bounds were set", () => {
    expect(metricIsOffTarget(metric({ direction: "observe" }), 1000)).toBe(false);
    expect(metricTargetLabel(metric({ direction: "observe" }))).toBe("Observed only");
  });

  it("flags either bound, matching the server's breach rule", () => {
    const ranged = metric({ direction: "range", minimum: 10, maximum: 20 });
    expect(metricIsOffTarget(ranged, 5)).toBe(true);
    expect(metricIsOffTarget(ranged, 25)).toBe(true);
    expect(metricIsOffTarget(ranged, 15)).toBe(false);
  });
});

describe("sparklineGeometry", () => {
  it("breaks the line at a missing reading rather than drawing to zero", () => {
    const { segments } = sparklineGeometry([1, 2, null, 3, 4], 100, 30);
    expect(segments).toHaveLength(2);
  });

  it("marks no end point when the latest reading is missing", () => {
    expect(sparklineGeometry([1, 2, null], 100, 30).end).toBeNull();
    expect(sparklineGeometry([1, 2], 100, 30).end).not.toBeNull();
  });

  it("draws nothing without readings", () => {
    expect(sparklineGeometry([null, null], 100, 30)).toEqual({ segments: [], end: null });
  });
});

describe("mergeHistoryPages", () => {
  it("drops the repeats overlapping pages can carry", () => {
    const shared = sample({ day: 1 });
    const merged = mergeHistoryPages([
      {
        findings: [finding({ id: "old" })],
        definitions: [metric()],
        activity: [event({ id: "a" })],
        samples: [shared],
      },
      {
        findings: [finding({ id: "old" })],
        definitions: [metric()],
        activity: [event({ id: "a" })],
        samples: [shared],
      },
    ]);
    expect([
      merged.findings.length,
      merged.definitions.length,
      merged.activity.length,
      merged.samples.length,
    ]).toEqual([1, 1, 1, 1]);
  });
});

describe("championActivityView", () => {
  it("attaches a finding's events to it and keeps routine checks quiet", () => {
    const view = championActivityView(
      [finding({ id: "f1" })],
      [
        event({ id: "a", kind: "finding-opened", findingId: "f1" }),
        event({ id: "b", kind: "check-started" }),
        event({ id: "c", kind: "check-reported" }),
        event({ id: "d", kind: "metrics-accepted" }),
      ],
    );
    expect(view.quiet.map((item) => item.id)).toEqual(["c"]);
    expect(view.entries).toHaveLength(2);
    const first = view.entries[0];
    if (first?.kind !== "finding") throw new Error("expected the open finding first");
    expect(first.events.map((item) => item.id)).toEqual(["a"]);
  });

  it("puts open findings above newer closed ones and events", () => {
    const view = championActivityView(
      [
        finding({ id: "old-open", updatedAt: "2026-10-01T00:00:00.000Z" }),
        finding({ id: "new-done", status: "verified", updatedAt: "2026-10-09T00:00:00.000Z" }),
      ],
      [event({ id: "newest", at: "2026-10-10T00:00:00.000Z", kind: "lifecycle" })],
    );
    expect(
      view.entries.map((item) => (item.kind === "finding" ? item.finding.id : item.event.id)),
    ).toEqual(["old-open", "newest", "new-done"]);
  });

  it("puts a decision waiting on someone above every other finding", () => {
    const view = championActivityView(
      [
        finding({ id: "newer-open", updatedAt: "2026-10-09T00:00:00.000Z" }),
        finding({
          id: "asks",
          updatedAt: "2026-10-01T00:00:00.000Z",
          decision: {
            id: "d1",
            question: "Which?",
            status: "requested",
            answer: null,
            requestedAt: "2026-10-01T00:00:00.000Z",
            resolvedAt: null,
          },
        }),
      ],
      [],
    );
    const first = view.entries[0];
    expect(first?.kind === "finding" && first.finding.id).toBe("asks");
  });

  it("keeps archived findings read-only and lets the current copy win", () => {
    const view = championActivityView(
      [finding({ id: "both", title: "Current" })],
      [event({ id: "a", kind: "finding-verified", findingId: "old" })],
      [
        finding({ id: "both", title: "Paged" }),
        finding({ id: "old", status: "verified", updatedAt: "2026-09-01T00:00:00.000Z" }),
      ],
    );
    const findings = view.entries.flatMap((item) => (item.kind === "finding" ? [item] : []));
    expect(findings.map((item) => [item.finding.id, item.archived])).toEqual([
      ["both", false],
      ["old", true],
    ]);
    expect(findings[0]?.finding.title).toBe("Current");
    expect(findings[1]?.events.map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps an event whose finding is unknown instead of losing it", () => {
    const view = championActivityView([], [event({ id: "x", kind: "dismiss", findingId: "gone" })]);
    expect(view.entries).toHaveLength(1);
  });
});

describe("safeExternalUrl", () => {
  it("refuses anything that isn't a web link", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl("https://example.com/spec")).toBe("https://example.com/spec");
  });
});

describe("parseMetricDrafts", () => {
  const valid = {
    ...emptyMetricDraft("k1"),
    name: "Open time",
    unit: "ms",
    source: "fixture",
    maximum: "100",
  };

  it("leaves a blank target as no target, not zero", () => {
    const parsed = parseMetricDrafts([{ ...valid, maximum: "" }]);
    if (!parsed.ok) throw new Error("expected valid");
    expect(parsed.metrics[0]?.maximum).toBeNull();
    expect(parsed.metrics[0]?.minimum).toBeNull();
  });

  it("gives new metrics distinct ids and keeps an accepted metric's id", () => {
    const parsed = parseMetricDrafts([
      { ...valid, key: "a" },
      { ...valid, key: "b" },
      { ...valid, key: "c", id: "open-time" },
    ]);
    if (!parsed.ok) throw new Error("expected valid");
    expect(new Set(parsed.metrics.map((item) => item.id)).size).toBe(3);
    expect(parsed.metrics[2]?.id).toBe("open-time");
  });

  it("refuses what the server would reject, tied to the draft that caused it", () => {
    const parsed = parseMetricDrafts([{ ...valid, minimum: "9", maximum: "1" }]);
    if (parsed.ok) throw new Error("expected invalid");
    expect(parsed.errors.k1).toContain("above");
    expect(parseMetricDrafts([]).ok).toBe(false);
    expect(parseMetricDrafts([{ ...valid, unit: " " }]).ok).toBe(false);
    expect(parseMetricDrafts([{ ...valid, maximum: "abc" }]).ok).toBe(false);
  });

  it("defaults to required, with no baseline and the server's own staleness window", () => {
    const parsed = parseMetricDrafts([valid]);
    if (!parsed.ok) throw new Error("expected valid");
    expect(parsed.metrics[0]?.required).toBe(true);
    expect(parsed.metrics[0]?.baseline).toBeNull();
    expect(parsed.metrics[0]).not.toHaveProperty("staleAfterMs");
  });

  it("reads hours as milliseconds and refuses a window the server would reject", () => {
    const parsed = parseMetricDrafts([{ ...valid, baseline: "0", staleAfterHours: "1.5" }]);
    if (!parsed.ok) throw new Error("expected valid");
    expect(parsed.metrics[0]?.baseline).toBe(0);
    expect(parsed.metrics[0]?.staleAfterMs).toBe(5_400_000);
    expect(parseMetricDrafts([{ ...valid, staleAfterHours: "0" }]).ok).toBe(false);
    expect(parseMetricDrafts([{ ...valid, staleAfterHours: "-2" }]).ok).toBe(false);
    expect(parseMetricDrafts([{ ...valid, baseline: "abc" }]).ok).toBe(false);
  });

  it("round-trips an untouched proposal so accepting does not re-propose it", () => {
    const proposed = metric();
    const parsed = parseMetricDrafts([metricDraftOf(proposed)]);
    if (!parsed.ok) throw new Error("expected valid");
    expect(metricsMatchProposal(parsed.metrics, { metrics: [proposed], reason: "r" })).toBe(true);
    expect(metricsMatchProposal(parsed.metrics, null)).toBe(false);

    const explicit = metric({ required: false, baseline: 40, staleAfterMs: 7_200_000 });
    const reparsed = parseMetricDrafts([metricDraftOf(explicit)]);
    if (!reparsed.ok) throw new Error("expected valid");
    expect(metricsMatchProposal(reparsed.metrics, { metrics: [explicit], reason: "r" })).toBe(true);
  });
});

describe("metricChange", () => {
  it("matches the server's rule for what starts a new series", () => {
    const current = [metric()];
    expect(metricChange(metric({ id: "other" }), current)).toBe("new");
    expect(metricChange(metric({ name: "Renamed", maximum: 5 }), current)).toBe("same-series");
    expect(metricChange(metric({ unit: "s" }), current)).toBe("new-series");
    expect(metricChange(metric({ context: "changed" }), current)).toBe("new-series");
  });
});

describe("suggestChampionModels", () => {
  const NOW = 1_000;

  it("prefers a stronger setup and a lighter routine model when the machine has them", () => {
    const suggested = suggestChampionModels(
      [entry("claude", ["claude-sonnet-x", "claude-opus-x"])],
      NOW,
    );
    expect(suggested.setup?.model).toBe("claude-opus-x");
    expect(suggested.routine?.model).toBe("claude-sonnet-x");
  });

  it("uses the machine's own default rather than inventing a model", () => {
    const suggested = suggestChampionModels([entry("codex", ["gpt-a", "gpt-b"])], NOW);
    expect(suggested.setup).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-a",
    });
    expect(suggested.routine?.model).toBe("gpt-a");
  });

  it("offers nothing from a provider that can't run", () => {
    expect(
      suggestChampionModels([entry("claude", ["claude-opus-x"], { enabled: false })], NOW),
    ).toEqual({ setup: null, routine: null });
    expect(suggestChampionModels([], NOW)).toEqual({ setup: null, routine: null });
  });

  it("looks past an unavailable provider to one that works", () => {
    const suggested = suggestChampionModels(
      [entry("down", ["claude-opus-x"], { status: "error" }), entry("up", ["claude-opus-y"])],
      NOW,
    );
    expect(suggested.setup?.instanceId).toBe(ProviderInstanceId.make("up"));
  });
});

describe("resolveChampionModel", () => {
  const selection = { instanceId: ProviderInstanceId.make("claude"), model: "picked" };
  const suggested = { instanceId: ProviderInstanceId.make("claude"), model: "suggested" };

  it("lets a suggestion follow the machine", () => {
    expect(resolveChampionModel({ picked: null, suggested, environmentId: OTHER_ENV })).toEqual({
      selection: suggested,
      fromOtherMachine: false,
    });
  });

  it("flags an explicit pick on another machine even when the instance id matches there", () => {
    expect(
      resolveChampionModel({
        picked: { environmentId: ENV, selection },
        suggested,
        environmentId: OTHER_ENV,
      }),
    ).toEqual({ selection, fromOtherMachine: true });
  });

  it("restores a pick when its own machine is chosen again", () => {
    expect(
      resolveChampionModel({
        picked: { environmentId: ENV, selection },
        suggested,
        environmentId: ENV,
      }),
    ).toEqual({ selection, fromOtherMachine: false });
  });
});

describe("modelSelectionProblem", () => {
  const NOW = 1_000;
  const selection = { instanceId: ProviderInstanceId.make("claude"), model: "gone" };

  it("names the problem with a saved selection instead of replacing it", () => {
    expect(modelSelectionProblem(selection, [entry("claude", ["other"])], NOW)).toContain(
      "no longer lists",
    );
    expect(modelSelectionProblem(selection, [], NOW)).toContain("isn't on this machine");
    expect(modelSelectionProblem(selection, [entry("claude", ["gone"])], NOW)).toBeNull();
    expect(modelSelectionProblem(null, [], NOW)).toBe("Choose a model.");
  });
});

describe("championMachineGap", () => {
  const machine = (label: string, phase: EnvironmentConnectionPhase) => ({
    label,
    connection: { phase },
  });

  it("says a dropped connection is reconnecting, not an empty list", () => {
    expect(championMachineGap([machine("Studio", "reconnecting")])).toMatchObject({
      waiting: true,
      status: "Reconnecting…",
      title: "Reconnecting to Studio",
    });
    expect(
      championMachineGap([machine("Studio", "connecting"), machine("Laptop", "reconnecting")])
        ?.title,
    ).toBe("Reconnecting to 2 machines");
  });

  it("separates a machine that needs the person from one still trying", () => {
    expect(championMachineGap([machine("Studio", "error")])).toMatchObject({
      waiting: false,
      title: "Can't reach Studio",
    });
  });

  it("leaves connected and never-joined machines to the true empty states", () => {
    expect(
      championMachineGap([machine("Studio", "connected"), machine("Spare", "available")]),
    ).toBeNull();
    expect(championMachineGap([])).toBeNull();
  });
});
