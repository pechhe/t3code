import { assert, describe, it } from "@effect/vitest";

import {
  classifyFinding,
  escalationShells,
  planEscalation,
  stuckState,
  type EscalationDocument,
  type EscalationFinding,
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

describe("classifyFinding", () => {
  it("names the severity, the trigger and whether the thread is over", () => {
    assert.deepEqual(classifyFinding(finding(), false), {
      severity: "incident",
      trigger: "New finding",
      resolved: false,
    });
    assert.equal(classifyFinding(finding(), true).trigger, "Confirmed journey failure");
    assert.equal(classifyFinding(finding({ metricId: "m" }), false).trigger, "Metric regressed");
    assert.deepEqual(classifyFinding(finding({ decision: requested }), false), {
      severity: "decision",
      trigger: "Decision requested",
      resolved: false,
    });
    assert.deepEqual(classifyFinding(finding({ repairAttention: "Stuck" }), false), {
      severity: "stuck",
      trigger: "Repair needs attention",
      resolved: false,
    });
  });

  it("resolves on verified or dismissed, and on a metric finding's answered decision", () => {
    assert.isTrue(classifyFinding(finding({ status: "verified" }), false).resolved);
    assert.isTrue(classifyFinding(finding({ status: "dismissed" }), false).resolved);
    const answered = { status: "resolved", id: "d1" } as const;
    assert.isTrue(classifyFinding(finding({ metricId: "m", decision: answered }), false).resolved);
    assert.isFalse(classifyFinding(finding({ decision: answered }), false).resolved);
    assert.isFalse(
      classifyFinding(finding({ metricId: "m", decision: answered, repairAttention: "x" }), false)
        .resolved,
    );
  });
});

describe("stuckState", () => {
  it("stays quiet for two failures, then names the third or a folder error", () => {
    assert.isFalse(stuckState({ attention: [], consecutiveCheckFailures: 2 }).stuck);
    assert.deepEqual(stuckState({ attention: [], consecutiveCheckFailures: 3 }), {
      stuck: true,
      trigger: "Failed 3 checks in a row",
    });
    assert.deepEqual(stuckState({ attention: ["Not saved to agent-config: no access"] }), {
      stuck: true,
      trigger: "Folder error blocking save",
    });
  });
});

describe("a retired Champion", () => {
  it("is never stuck, so its stuck thread is resolved and settles on retirement", () => {
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

  it("escalates a new qualitative finding but not a first-reading or chronic metric finding", () => {
    const before = doc([]);
    assert.deepEqual(planEscalation(before, doc([finding()])), [
      { target: { kind: "finding", findingId: "f1" }, action: "ensure" },
    ]);
    assert.deepEqual(planEscalation(before, doc([finding({ metricId: "m" })])), []);
    const chronic = doc([finding({ metricId: "m" })]);
    assert.deepEqual(planEscalation(chronic, chronic), []);
  });

  it("escalates a metric that leaves its target, but not a first reading or a chronic breach", () => {
    const metric = finding({ id: "m1", metricId: "m", seriesId: "s1" });
    const reading = (health: string) => doc([], { latestSamples: [{ seriesId: "s1", health }] });
    assert.deepEqual(planEscalation(reading("healthy"), doc([metric])), [
      { target: { kind: "finding", findingId: "m1" }, action: "ensure" },
    ]);
    assert.deepEqual(planEscalation(doc([]), doc([metric])), []);
    assert.deepEqual(planEscalation(reading("breached"), doc([metric])), []);
    assert.deepEqual(planEscalation(reading("unknown"), doc([metric])), []);
    // A dismissed metric finding that opens again after a healthy reading is a fresh regression.
    const dismissed = doc([{ ...metric, status: "dismissed" }], {
      latestSamples: [{ seriesId: "s1", health: "healthy" }],
    });
    assert.deepEqual(planEscalation(dismissed, doc([metric])), [
      { target: { kind: "finding", findingId: "m1" }, action: "ensure" },
    ]);
    // Still open from an earlier check: not new.
    const open = doc([metric], { latestSamples: [{ seriesId: "s1", health: "healthy" }] });
    assert.deepEqual(planEscalation(open, doc([metric])), []);
  });

  it("settles open finding threads when the Champion retires and its findings are dismissed", () => {
    const before = doc([
      withThread({}),
      withThread({ id: "f2", escalationThreadId: "thread-2", decision: requested }),
    ]);
    const after = doc(
      before.findings.map((f) => ({ ...f, status: "dismissed" as const })),
      { lifecycle: "retired" },
    );
    assert.deepEqual(planEscalation(before, after), [
      { target: { kind: "finding", findingId: "f1" }, action: "settle" },
      { target: { kind: "finding", findingId: "f2" }, action: "settle" },
    ]);
  });

  it("escalates a decision request once, and settles when it is answered", () => {
    const open = doc([withThread({ metricId: "m" })]);
    const asked = doc([withThread({ metricId: "m", decision: requested })]);
    assert.deepEqual(planEscalation(open, asked), [
      { target: { kind: "finding", findingId: "f1" }, action: "ensure" },
    ]);
    assert.deepEqual(planEscalation(asked, asked), []);
    const answered = doc([
      withThread({ metricId: "m", decision: { status: "resolved", id: "d1" } }),
    ]);
    assert.deepEqual(planEscalation(asked, answered), [
      { target: { kind: "finding", findingId: "f1" }, action: "settle" },
    ]);
  });

  it("escalates a repair that needs attention and a verified finding that regresses", () => {
    const working = doc([withThread({ metricId: "m", status: "working" })]);
    assert.lengthOf(
      planEscalation(
        working,
        doc([withThread({ metricId: "m", status: "working", repairAttention: "x" })]),
      ),
      1,
    );
    const verified = doc([withThread({ metricId: "m", status: "verified" })]);
    assert.deepEqual(
      planEscalation(verified, doc([withThread({ metricId: "m", status: "open" })])).map(
        (s) => s.action,
      ),
      ["ensure"],
    );
    // A dismissed chronic metric finding that breaches again is not a fresh incident.
    assert.deepEqual(
      planEscalation(
        doc([withThread({ metricId: "m", status: "dismissed" })]),
        doc([withThread({ metricId: "m", status: "open" })]),
      ),
      [],
    );
    // Unless the user reopened it.
    assert.lengthOf(
      planEscalation(
        doc([withThread({ metricId: "m", status: "dismissed" })]),
        doc([withThread({ metricId: "m", status: "open" })]),
        new Set(["f1"]),
      ),
      1,
    );
  });

  it("settles a finding that is dismissed or verified", () => {
    assert.deepEqual(
      planEscalation(doc([withThread({})]), doc([withThread({ status: "dismissed" })])),
      [{ target: { kind: "finding", findingId: "f1" }, action: "settle" }],
    );
  });

  it("escalates the third failed check and a folder error once, and settles on recovery", () => {
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
    assert.lengthOf(
      planEscalation(at(0), at(0, { attention: ["Not saved to agent-config: denied"] })),
      1,
    );
  });
});

describe("escalationShells", () => {
  it("describes each escalation thread of a Champion", () => {
    const shells = escalationShells(
      doc([finding({ escalationThreadId: "t-f", decision: requested })], {
        consecutiveCheckFailures: 3,
        stuckEscalationThreadId: "t-s",
      }),
    );
    assert.deepEqual(shells.get("t-f"), {
      findingId: "f1",
      severity: "decision",
      trigger: "Decision requested",
      resolved: false,
    });
    assert.deepEqual(shells.get("t-s"), {
      findingId: null,
      severity: "stuck",
      trigger: "Failed 3 checks in a row",
      resolved: false,
    });
  });
});
