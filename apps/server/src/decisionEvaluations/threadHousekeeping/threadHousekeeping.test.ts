import { DecisionRequest } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { headerLine, parseAttemptLog, recordLine } from "./attemptLog.ts";
import { catchKindsFromTune } from "./baseline.ts";
import { evaluate, type CallRecord } from "./harness.ts";
import { agreed, agreedLabels, type LabelFile } from "./labels.ts";
import { POLICY, caughtWake, routeProject, type EngineOutcome } from "./policy.ts";
import { casesDigest } from "./record.ts";
import cases from "./results/cases.json" with { type: "json" };
import heldoutResults from "./results/heldout.json" with { type: "json" };
import labelsA from "./results/labels-A.json" with { type: "json" };
import labelsB from "./results/labels-B.json" with { type: "json" };
import tuneResults from "./results/tune.json" with { type: "json" };
import { buildProjectRequest, buildWakeRequest } from "./rule.ts";
import { summarizeCost, summarizeProject, summarizeWake, wilson } from "./scoring.ts";
import type { Engine, ProjectCase, ProjectPublic, WakeCase, WakePublic } from "./types.ts";

const decodeRequest = Schema.decodeUnknownSync(DecisionRequest);

const answered = (probabilities: Record<string, number>): EngineOutcome => {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { kind: "answered", choice, probabilities };
};

it("counts a label only when both labelers agree on a concrete answer", () => {
  expect(agreed("p1", "p1")).toBe("p1");
  expect(agreed("p1", "p2")).toBe("uncertain");
  expect(agreed("unknown", "unknown")).toBe("uncertain");
  expect(agreed("none", undefined)).toBe("uncertain");
  expect(
    agreedLabels({ source: {}, labels: { a: "none" } }, { source: {}, labels: { a: "none" } }, [
      "a",
    ]),
  ).toEqual({ a: "none" });
});

it("moves a chat only above the floor and never on a tie, unknown or failure", () => {
  expect(routeProject(answered({ p1: 0.7, none: 0.3 }))).toEqual({ value: "p1", answered: true });
  expect(routeProject(answered({ p1: 0.55, none: 0.45 })).answered).toBe(false);
  expect(routeProject(answered({ p1: 0.5, p2: 0.5 })).value).toBe("abstain");
  expect(routeProject(answered({ unknown: 0.9, p1: 0.1 })).value).toBe("abstain");
  expect(routeProject(answered({ none: 0.9, p1: 0.1 }))).toEqual({
    value: "none",
    answered: false,
  });
  expect(routeProject({ kind: "failed", code: "unavailable" }).value).toBe("abstain");
  expect(routeProject(undefined).value).toBe("abstain");
});

it("catches a wake only when nothing_new clears the declared floor, and a different floor changes it", () => {
  const o = answered({ nothing_new: 0.85, something_new: 0.15 });
  expect(caughtWake(o)).toBe(true);
  expect(caughtWake(o, 0.9)).toBe(false);
  expect(caughtWake(answered({ nothing_new: 0.7, something_new: 0.3 }))).toBe(false);
  expect(caughtWake(answered({ something_new: 0.95, nothing_new: 0.05 }))).toBe(false);
  expect(caughtWake({ kind: "unanswered", status: "refusal" })).toBe(false);
});

it("scores project routing with the wrong-move rate and both sides of 'none of these'", () => {
  const s = summarizeProject([
    { caseId: "a", label: "p1", pred: "p1", moved: true },
    { caseId: "b", label: "p1", pred: "p2", moved: true },
    { caseId: "c", label: "none", pred: "none", moved: false },
    { caseId: "d", label: "p3", pred: "none", moved: false },
  ]);
  expect(s.matched).toMatchObject({ numerator: 2, denominator: 4 });
  expect(s.wrongWhenMoved).toMatchObject({ numerator: 1, denominator: 2 });
  expect(s.noneRecall).toMatchObject({ numerator: 1, denominator: 1 });
  expect(s.nonePrecision).toMatchObject({ numerator: 1, denominator: 2 });
  expect(s.wrongCases).toEqual(["b", "d"]);
});

it("scores wake catching as recall, false catches and precision", () => {
  const s = summarizeWake([
    { caseId: "a", label: "nothing_new", caught: true },
    { caseId: "b", label: "nothing_new", caught: false },
    { caseId: "c", label: "something_new", caught: true },
    { caseId: "d", label: "something_new", caught: false },
  ]);
  expect(s.recall).toMatchObject({ numerator: 1, denominator: 2 });
  expect(s.falseCatch).toMatchObject({ numerator: 1, denominator: 2 });
  expect(s.precision).toMatchObject({ numerator: 1, denominator: 2 });
  expect(s.wronglyCaught).toEqual(["c"]);
  expect(wilson(0, 0).value).toBeNull();
});

it("keeps spend unknown when any call reported none, and sums it when all did", () => {
  const row = (costUsd: number | null) => ({
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 1,
    costUsd,
  });
  expect(summarizeCost([row(0.001), row(0.002)], 0).costUsd).toBeCloseTo(0.003);
  expect(summarizeCost([row(0.001), row(null)], 0).costUsd).toBeNull();
  expect(summarizeCost([row(0.001)], 1).costUsd).toBeNull();
});

it("catches a wake kind by tuning labels only with enough agreed examples", () => {
  const t = (kind: "timed" | "command", label: string) => ({ kind, label });
  const caught = catchKindsFromTune([
    t("timed", "nothing_new"),
    t("timed", "nothing_new"),
    t("timed", "something_new"),
    t("command", "nothing_new"),
    t("command", "uncertain"),
  ]);
  expect([...caught]).toEqual(["timed"]);
});

const projectCase: ProjectCase = {
  caseId: "pr-1",
  machine: "mac",
  kind: "project",
  stratum: "moved",
  actualProjectId: "secret-actual-id",
  firstText: "Fix the flaky landing gate",
  asks: [{ turn: 1, evidence: [{ role: "user", n: 1, text: "Fix the flaky landing gate" }] }],
  projects: [
    {
      key: "secret-actual-id",
      choice: "p1",
      title: "SlipJay",
      root: "slipjay",
      recent: ["Land a change"],
    },
    { key: "k2", choice: "p2", title: "Weave", root: "weave", recent: [] },
  ],
};
const wakeCase: WakeCase = {
  caseId: "wk-1",
  machine: "mac",
  kind: "wake",
  wakeKind: "command",
  source: "background_command",
  outcome: "completed",
  threadTitle: "Build",
  prior: [{ role: "assistant", text: "Waiting for the build." }],
  wake: { summary: "Command finished", detail: "" },
};

it("shows an engine only the conversation, the projects and the wake, in a request the service accepts", () => {
  const p = buildProjectRequest("jev", projectCase, 0);
  expect(() => decodeRequest(p)).not.toThrow();
  const sent = JSON.stringify(p);
  expect(sent).not.toContain("secret-actual-id");
  expect(sent).not.toContain("moved");
  expect(p.questions[0]).toMatchObject({
    choices: expect.arrayContaining([{ label: "none", description: expect.any(String) }]),
  });
  const w = buildWakeRequest("luna", wakeCase);
  expect(() => decodeRequest(w)).not.toThrow();
  expect(JSON.stringify(w)).not.toContain("wk-1");
});

const projectsPublic: ProjectPublic[] = [
  {
    caseId: "pr-1",
    machine: "mac",
    split: "heldout",
    stratum: "moved",
    asks: 2,
    keyword: "p1",
    agent: "p1",
    digest: "x",
  },
  {
    caseId: "pr-2",
    machine: "mac",
    split: "heldout",
    stratum: "stayed",
    asks: 1,
    keyword: "none",
    agent: "none",
    digest: "y",
  },
];
const wakesPublic: WakePublic[] = [
  {
    caseId: "wk-1",
    machine: "mac",
    split: "heldout",
    wakeKind: "command",
    source: null,
    outcome: "updated",
    digest: "a",
  },
  {
    caseId: "wk-2",
    machine: "mac",
    split: "heldout",
    wakeKind: "command",
    source: null,
    outcome: "completed",
    digest: "b",
  },
];
const rec = (
  caseId: string,
  chore: "project" | "wake",
  ask: number,
  probabilities: Record<string, number>,
): CallRecord => ({
  caseId,
  chore,
  ask,
  engine: "jev",
  outcome: answered(probabilities),
  requestedModel: "jev",
  resolvedModel: "jev",
  adapterVersion: "v",
  digest: "d",
  latencyMs: 100,
  inputTokens: 10,
  outputTokens: 1,
  costUsd: 0.001,
  costStatus: "estimated",
  startedAt: "2026-11-10T00:00:00Z",
});

it("scores each system against the agreed label, the final turn as the headline and uncertain labels left out", () => {
  const results = evaluate(
    {
      projects: projectsPublic,
      wakes: wakesPublic,
      labels: { "pr-1": "p1", "pr-2": "uncertain", "wk-1": "nothing_new", "wk-2": "something_new" },
      tuneCatchKinds: new Set(),
    },
    [
      rec("pr-1", "project", 0, { none: 0.9, p1: 0.1 }),
      rec("pr-1", "project", 1, { p1: 0.8, none: 0.2 }),
      rec("wk-1", "wake", 0, { nothing_new: 0.9, something_new: 0.1 }),
      rec("wk-2", "wake", 0, { nothing_new: 0.85, something_new: 0.15 }),
    ],
    ["jev"],
  );
  const jev = results.project.jev!;
  expect(jev.final.matched).toMatchObject({ numerator: 1, denominator: 1 });
  expect(jev.firstAsk.matched).toMatchObject({ numerator: 0, denominator: 1 });
  expect(jev.everyAsk.matched).toMatchObject({ numerator: 1, denominator: 2 });
  expect(results.projectLabelCounts).toMatchObject({ agreed: 1, uncertain: 1 });
  const command = results.wake.command!.systems.jev!.declared;
  expect(command.recall).toMatchObject({ numerator: 1, denominator: 1 });
  expect(command.falseCatch).toMatchObject({ numerator: 1, denominator: 1 });
  expect(results.wake.command!.systems.byOutcome!.declared.caught).toBe(1);
  expect(results.wake.command!.specMark.verdict).toBe("kept");
  expect(results.wake.command!.systems.jev!.sensitivity).not.toBeNull();
});

it("resumes an attempt log only for the run that began it", () => {
  const files = { "a.ts": "1" };
  const expected = {
    split: "heldout",
    chore: "both",
    engines: ["jev"],
    casesDigest: "c",
    files,
  } as const;
  const head = headerLine({ ...expected, engines: ["jev"], checkout: {}, runtime: {} });
  const log = head + recordLine(rec("wk-1", "wake", 0, { nothing_new: 1 }));
  expect(parseAttemptLog(log, expected).records).toHaveLength(1);
  expect(() => parseAttemptLog(log, { ...expected, casesDigest: "other" })).toThrow(
    /cases changed/,
  );
  expect(() => parseAttemptLog(log, { ...expected, files: { "a.ts": "2" } })).toThrow(
    /files changed/,
  );
  expect(() => parseAttemptLog(log, { ...expected, chore: "wake" })).toThrow(/different/);
});

const A = labelsA as LabelFile;
const B = labelsB as LabelFile;
const publicProjects = cases.projects as ProjectPublic[];
const publicWakes = cases.wakes as WakePublic[];
const labels = agreedLabels(
  A,
  B,
  [...publicProjects, ...publicWakes].map((c) => c.caseId),
);
const tuneCatchKinds = catchKindsFromTune(
  publicWakes
    .filter((c) => c.split === "tune")
    .map((c) => ({ kind: c.wakeKind, label: labels[c.caseId]! })),
);

it("commits ids, digests, labels and aggregates but no thread text, and enough agreed held-out cases", () => {
  const allowed = new Set([
    "caseId",
    "machine",
    "split",
    "stratum",
    "asks",
    "keyword",
    "agent",
    "digest",
    "wakeKind",
    "source",
    "outcome",
  ]);
  for (const c of [...publicProjects, ...publicWakes]) {
    for (const key of Object.keys(c)) expect(allowed.has(key)).toBe(true);
    expect(A.labels[c.caseId]).toBeDefined();
    expect(B.labels[c.caseId]).toBeDefined();
  }
  expect(casesDigest([...publicProjects, ...publicWakes])).toBe(cases.digest);
  const agreedHeldout = (items: ReadonlyArray<{ caseId: string; split: string }>) =>
    items.filter((c) => c.split === "heldout" && labels[c.caseId] !== "uncertain").length;
  expect(agreedHeldout(publicProjects)).toBeGreaterThanOrEqual(60);
  expect(agreedHeldout(publicWakes)).toBeGreaterThanOrEqual(60);
  const tuneIds = new Set(
    publicProjects
      .concat(publicWakes as never)
      .filter((c) => c.split === "tune")
      .map((c) => c.caseId),
  );
  expect(
    publicProjects
      .concat(publicWakes as never)
      .some((c) => c.split === "heldout" && tuneIds.has(c.caseId)),
  ).toBe(false);
});

it("derives the stored held-out and tuning figures from their recorded calls, with the policy declared before them", () => {
  for (const [split, stored] of [
    ["heldout", heldoutResults],
    ["tune", tuneResults],
  ] as const) {
    const own = (c: { split: string }) => c.split === split;
    const rescored = evaluate(
      {
        projects: publicProjects.filter(own),
        wakes: publicWakes.filter(own),
        labels,
        tuneCatchKinds,
      },
      stored.records as unknown as CallRecord[],
      stored.engines as Engine[],
    );
    expect(JSON.parse(JSON.stringify(rescored.project))).toEqual(stored.project);
    expect(JSON.parse(JSON.stringify(rescored.wake))).toEqual(stored.wake);
    expect(JSON.parse(JSON.stringify(rescored.wakeOverall))).toEqual(stored.wakeOverall);
    expect(stored.policy).toEqual(JSON.parse(JSON.stringify(POLICY)));
  }
});
