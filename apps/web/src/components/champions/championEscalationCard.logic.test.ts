import {
  ChampionId,
  ProjectId,
  ThreadId,
  type ChampionDetail,
  type ChampionFinding,
  type ChampionMetric,
  type OrchestrationV2ThreadChampion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEscalationCardState,
  selectEscalationFinding,
  selectEscalationMetricStrip,
} from "./championEscalationCard.logic";

const metric = (overrides: Partial<ChampionMetric> = {}): ChampionMetric => ({
  id: "m-latency",
  seriesId: "s-latency",
  version: 1,
  name: "P95 latency",
  description: "",
  unit: "ms",
  source: "fixture",
  context: "",
  direction: "lower",
  minimum: null,
  maximum: 200,
  reason: "",
  required: true,
  ...overrides,
});

const finding = (overrides: Partial<ChampionFinding> = {}): ChampionFinding => ({
  id: "f-1",
  metricId: "m-latency",
  seriesId: "s-latency",
  title: "Latency breached target",
  evidence: "P95 rose to 340ms on checkout.",
  status: "open",
  revision: null,
  updatedAt: "2026-06-01T10:00:00.000Z",
  ...overrides,
});

const detail = (overrides: Partial<ChampionDetail> = {}): ChampionDetail => ({
  champion: {
    id: ChampionId.make("champ-1"),
    projectId: ProjectId.make("proj-1"),
    name: "Checkout Latency",
    purpose: "Keep checkout fast",
    charter: { instructions: "" },
    schedule: { type: "interval", everyMs: 3_600_000 },
    lifecycle: "active",
    ownerThreadId: ThreadId.make("owner-1"),
    setupThreadId: null,
    nextCheckAt: null,
    lastCheckAt: null,
    outstandingCheckId: null,
    attention: [],
    openFindingCount: 1,
    updatedAt: "2026-06-01T10:00:00.000Z",
  },
  metrics: [metric()],
  latestSamples: [
    {
      metricId: "m-latency",
      name: "P95 latency",
      version: 1,
      seriesId: "s-latency",
      unit: "ms",
      required: true,
      value: 340,
      status: "measured",
      health: "breached",
      observedAt: "2026-06-01T10:00:00.000Z",
      collectedAt: "2026-06-01T10:00:00.000Z",
      revision: null,
      staleAt: null,
    },
  ],
  findings: [finding()],
  ...overrides,
});

describe("selectEscalationFinding", () => {
  it("returns the matching finding by id or null when absent", () => {
    const d = detail();
    expect(selectEscalationFinding(d, "f-1")?.id).toBe("f-1");
    expect(selectEscalationFinding(d, "missing")).toBeNull();
    expect(selectEscalationFinding(d, null)).toBeNull();
  });
});

describe("selectEscalationMetricStrip", () => {
  it("formats metric reading, target, and baseline when present", () => {
    const f = finding();
    expect(
      selectEscalationMetricStrip(
        detail({ findings: [f], metrics: [metric({ baseline: 260 })] }),
        f,
      ),
    ).toEqual({
      name: "P95 latency",
      reading: "340 ms",
      target: "≤ 200 ms",
      baseline: "260 ms",
    });
  });

  it("returns null when the finding has no metric or sample", () => {
    expect(selectEscalationMetricStrip(detail(), finding({ metricId: null }))).toBeNull();
  });
});

describe("resolveEscalationCardState", () => {
  const baseChampion: OrchestrationV2ThreadChampion = {
    id: "champ-1",
    attention: true,
    kind: "escalation",
    name: "Checkout Latency",
    findingId: "f-1",
    severity: "decision",
    trigger: "Needs approval",
  };

  it("enables Approve proposal and Dismiss for a pending decision with a proposal", () => {
    const f = finding({
      decision: {
        id: "d-1",
        question: "Ship cache?",
        proposal: { action: "Enable Redis cache", why: "Cuts p95 in half" },
        status: "requested",
        answer: null,
        requestedAt: "2026-06-01T10:00:00.000Z",
        resolvedAt: null,
      },
    });
    expect(
      resolveEscalationCardState({ champion: baseChampion, detail: detail(), finding: f }),
    ).toEqual({
      severity: "decision",
      resolution: null,
      canApproveProposal: true,
      canDismiss: true,
      canReopen: false,
      canInvestigate: false,
    });
  });

  it("enables Investigate and Dismiss for an open incident without a proposal", () => {
    const f = finding();
    expect(
      resolveEscalationCardState({
        champion: { ...baseChampion, severity: "incident" },
        detail: detail(),
        finding: f,
      }),
    ).toEqual({
      severity: "incident",
      resolution: null,
      canApproveProposal: false,
      canDismiss: true,
      canReopen: false,
      canInvestigate: true,
    });
  });

  it("hides Investigate once the thread's conversation has started", () => {
    expect(
      resolveEscalationCardState({
        champion: { ...baseChampion, severity: "incident" },
        detail: detail(),
        finding: finding(),
        started: true,
      }).canInvestigate,
    ).toBe(false);
  });

  it("exposes dismissed state with Reopen enabled", () => {
    const f = finding({ status: "dismissed" });
    expect(
      resolveEscalationCardState({
        champion: { ...baseChampion, resolved: true },
        detail: detail(),
        finding: f,
      }),
    ).toEqual({
      severity: "decision",
      resolution: "dismissed",
      canApproveProposal: false,
      canDismiss: false,
      canReopen: true,
      canInvestigate: false,
    });
  });

  it("marks stuck escalation resolved when consecutive failures and attention clear", () => {
    expect(
      resolveEscalationCardState({
        champion: { ...baseChampion, findingId: null, severity: "stuck" },
        detail: detail({
          champion: {
            ...detail().champion,
            consecutiveCheckFailures: 0,
            attention: [],
          },
        }),
        finding: null,
      }),
    ).toEqual({
      severity: "stuck",
      resolution: "resolved",
      canApproveProposal: false,
      canDismiss: false,
      canReopen: false,
      canInvestigate: false,
    });
  });
});
