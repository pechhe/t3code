import { assert, describe, it } from "@effect/vitest";

import {
  CASE_WORKSPACE_RULE,
  classifyFinding,
  escalationShells,
  formatEscalationBrief,
  planEscalation,
  stuckState,
  type EscalationDocument,
  type EscalationFinding,
  type EscalationStep,
} from "./championEscalation.ts";

const finding = (overrides: Partial<EscalationFinding> = {}): EscalationFinding => ({
  id: "f1",
  title: "Slow page",
  metricId: null,
  status: "open",
  ...overrides,
});
const doc = (
  findings: ReadonlyArray<EscalationFinding>,
  champion: Partial<EscalationDocument["champion"]> = {},
): EscalationDocument => ({ champion: { attention: [], ...champion }, findings });
const requested = { status: "requested", id: "d1" } as const;
/** A Champion whose previous document records a finished readings run. */
const ran = (findings: ReadonlyArray<EscalationFinding> = []) =>
  doc(findings, { lastCheckAt: "2026-11-25T10:00:00.000Z" });
const ensure = (
  findingId: string,
  extra: { fresh?: boolean; start?: boolean } = {},
): EscalationStep => ({
  target: { kind: "finding", findingId },
  action: "ensure",
  fresh: extra.fresh ?? false,
  start: extra.start ?? false,
});

describe("classifyFinding", () => {
  it("names the trigger, the alarm and whether the case is over", () => {
    assert.deepEqual(classifyFinding(finding(), false), {
      severity: "incident",
      trigger: "New finding",
      resolved: false,
    });
    assert.equal(classifyFinding(finding(), true).trigger, "Confirmed journey failure");
    assert.equal(
      classifyFinding(finding({ metricId: "m" }), false).trigger,
      "Metric outside target",
    );
    assert.equal(
      classifyFinding(finding({ id: "c:goal" }), false).trigger,
      "Goal score below target",
    );
    assert.deepEqual(classifyFinding(finding({ metricId: "m", alarm: true }), false), {
      severity: "incident",
      trigger: "Alarm reached",
      resolved: false,
      alarm: true,
    });
    assert.deepEqual(classifyFinding(finding({ decision: requested }), false), {
      severity: "decision",
      trigger: "Decision requested",
      resolved: false,
    });
  });

  it("resolves only when the finding is verified or dismissed", () => {
    assert.isTrue(classifyFinding(finding({ status: "verified" }), false).resolved);
    assert.isTrue(classifyFinding(finding({ status: "dismissed" }), false).resolved);
    const answered = { status: "resolved", id: "d1" } as const;
    assert.isFalse(classifyFinding(finding({ metricId: "m", decision: answered }), false).resolved);
  });
});

describe("stuckState", () => {
  it("keeps one streak per rhythm: three failures in either is stuck", () => {
    assert.isFalse(stuckState({ attention: [], consecutiveCheckFailures: 2 }).stuck);
    assert.deepEqual(stuckState({ attention: [], consecutiveCheckFailures: 3 }), {
      stuck: true,
      trigger: "Failed 3 readings runs in a row",
    });
    // Three failed reviews are stuck even while readings succeed.
    assert.deepEqual(
      stuckState({ attention: [], consecutiveCheckFailures: 0, consecutiveReviewFailures: 3 }),
      { stuck: true, trigger: "Failed 3 goal reviews in a row" },
    );
    assert.deepEqual(stuckState({ attention: ["Not saved to agent-config: no access"] }), {
      stuck: true,
      trigger: "Folder error blocking save",
    });
    assert.deepEqual(stuckState({ attention: [], consecutiveCheckFailures: 0 }), {
      stuck: false,
      trigger: "No longer stuck",
    });
  });

  it("is never stuck once retired, so its stuck case settles on retirement", () => {
    const active = doc([], { consecutiveCheckFailures: 4, stuckEscalationThreadId: "t" });
    const retired = doc([], {
      consecutiveCheckFailures: 4,
      stuckEscalationThreadId: "t",
      lifecycle: "retired",
    });
    assert.isTrue(escalationShells(retired).get("t")!.resolved);
    assert.deepEqual(planEscalation(active, retired), [
      { target: { kind: "stuck" }, action: "settle" },
    ]);
  });
});

describe("planEscalation", () => {
  const withThread = (overrides: Partial<EscalationFinding>) =>
    finding({ escalationThreadId: "thread-1", ...overrides });

  it("opens exactly one case for a qualitative finding, a regression, a breach after lastCheckAt, a goal finding and an alarm", () => {
    assert.deepEqual(planEscalation(doc([]), doc([finding()])), [ensure("f1")]);
    const metric = finding({ id: "m1", metricId: "m" });
    // A first-reading or chronic breach once a readings run has finished.
    assert.deepEqual(planEscalation(ran(), ran([metric])), [ensure("m1")]);
    // A regression: a settled finding that reopens.
    assert.deepEqual(planEscalation(ran([{ ...metric, status: "verified" }]), ran([metric])), [
      ensure("m1", { fresh: true }),
    ]);
    assert.deepEqual(planEscalation(doc([]), doc([finding({ id: "c:goal" })])), [ensure("c:goal")]);
    // An alarm starts at once, even on the first-ever readings run.
    assert.deepEqual(planEscalation(doc([]), doc([{ ...metric, alarm: true }])), [
      ensure("m1", { start: true }),
    ]);
  });

  it("opens none for a finding still open on a later run or on a Champion's first-ever readings run", () => {
    const metric = finding({ id: "m1", metricId: "m" });
    assert.deepEqual(planEscalation(doc([]), doc([metric])), []);
    assert.deepEqual(planEscalation(ran([metric]), ran([metric])), []);
    assert.deepEqual(planEscalation(ran([finding()]), ran([finding()])), []);
  });

  it("upgrades an open finding that reaches its alarm, starting its case", () => {
    const open = withThread({ metricId: "m" });
    assert.deepEqual(planEscalation(ran([open]), ran([{ ...open, alarm: true }])), [
      ensure("f1", { start: true }),
    ]);
    // Already an alarm: nothing new.
    assert.deepEqual(
      planEscalation(ran([{ ...open, alarm: true }]), ran([{ ...open, alarm: true }])),
      [],
    );
  });

  it("forces a case for a finding a person reopened or an upgrade left without one", () => {
    const open = finding({ metricId: "m" });
    assert.deepEqual(planEscalation(ran([open]), ran([open]), new Set(["f1"])), [
      ensure("f1", { fresh: true }),
    ]);
  });

  it("settles a case when its finding is dismissed or verified, as on retirement", () => {
    const before = doc([withThread({}), withThread({ id: "f2", escalationThreadId: "thread-2" })]);
    const after = doc(
      before.findings.map((f) => ({ ...f, status: "dismissed" as const })),
      { lifecycle: "retired" },
    );
    assert.deepEqual(planEscalation(before, after), [
      { target: { kind: "finding", findingId: "f1" }, action: "settle" },
      { target: { kind: "finding", findingId: "f2" }, action: "settle" },
    ]);
  });

  it("opens the stuck case once and settles it on recovery", () => {
    const at = (n: number, extra: Partial<EscalationDocument["champion"]> = {}) =>
      doc([], { consecutiveCheckFailures: n, ...extra });
    assert.deepEqual(planEscalation(at(1), at(2)), []);
    assert.deepEqual(planEscalation(at(2), at(3)), [
      { target: { kind: "stuck" }, action: "ensure" },
    ]);
    assert.deepEqual(planEscalation(at(3), at(4)), []);
    assert.deepEqual(
      planEscalation(
        at(4, { stuckEscalationThreadId: "t" }),
        at(0, { stuckEscalationThreadId: "t" }),
      ),
      [{ target: { kind: "stuck" }, action: "settle" }],
    );
  });
});

describe("escalationShells", () => {
  it("describes each case of a Champion, flagging an alarm", () => {
    const shells = escalationShells(
      doc([finding({ escalationThreadId: "t-f", metricId: "m", alarm: true })], {
        consecutiveCheckFailures: 3,
        stuckEscalationThreadId: "t-s",
      }),
    );
    assert.deepEqual(shells.get("t-f"), {
      findingId: "f1",
      severity: "incident",
      trigger: "Alarm reached",
      resolved: false,
      alarm: true,
    });
    assert.deepEqual(shells.get("t-s"), {
      findingId: null,
      severity: "stuck",
      trigger: "Failed 3 readings runs in a row",
      resolved: false,
    });
  });
});

describe("formatEscalationBrief", () => {
  it("carries the readings history, the latest score, the times, the alarm, the owner thread and the workspace rule", () => {
    const brief = formatEscalationBrief({
      champion: { id: "c1", name: "Production Health", purpose: "Keep production up" },
      shell: {
        findingId: "c1:metric:s1",
        severity: "incident",
        trigger: "Alarm reached",
        resolved: false,
        alarm: true,
      },
      finding: {
        id: "c1:metric:s1",
        title: "Errors reached their alarm",
        evidence: "Errors read 40.",
        status: "open",
        alarm: true,
        firstSeenAt: "2026-11-25T09:00:00.000Z",
        lastConfirmedAt: "2026-11-25T10:00:00.000Z",
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      attention: [],
      ownerThreadId: "owner-1",
      repository: "pechhe/t3code",
      readings: [
        { at: "2026-11-25T10:00:00.000Z", value: 40, status: "measured", unit: "errors" },
        { at: "2026-11-25T09:00:00.000Z", value: null, status: "error", unit: "errors" },
      ],
      goalScore: {
        score: 5,
        target: 7,
        reasons: "Error budget burnt.",
        change: "Down from 6.",
        at: "2026-11-24T06:00:00.000Z",
      },
    });
    for (const part of [
      "- 2026-11-25T10:00:00.000Z 40 errors",
      "- 2026-11-25T09:00:00.000Z error",
      "Latest goal score: 5/10 (target 7)",
      "Why not higher: Error budget burnt.",
      "First seen 2026-11-25T09:00:00.000Z; last confirmed 2026-11-25T10:00:00.000Z.",
      "(open, ALARM)",
      "This is an alarm",
      "thread owner-1",
      CASE_WORKSPACE_RULE,
      "Its goal: Keep production up",
    ])
      assert.include(brief, part);
  });
});
