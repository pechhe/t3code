import { DecisionError, type DecisionRequest, type DecisionResult } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { headerLine, parseAttemptLog, recordLine } from "./attemptLog.ts";
import { applyConstraints, currentDefault, keywordRule } from "./baseline.ts";
import { extractConstraints } from "./constraints.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { DECISIONS, type AutoCase } from "./corpusTypes.ts";
import { corpusDigest, evaluate, runEvaluation } from "./harness.ts";
import { TASKS, scoreAnswer } from "./downstream.ts";
import { agreed, hasAllLabels, outcomeTier, primaryView } from "./labels.ts";
import { POLICY, routeDecision, settleThreadRoute, type EngineOutcome } from "./policy.ts";
import { buildRequest } from "./rule.ts";
import { runDigests } from "./provenance.ts";
import downstreamResults from "./results/downstream.json" with { type: "json" };
import heldoutResults from "./results/heldout.json" with { type: "json" };
import tuneResults from "./results/tune.json" with { type: "json" };
import { direction, summarize } from "./scoring.ts";

const all = [...TUNE_CASES, ...HELDOUT_CASES];
const byId = (id: string) => all.find((c) => c.id === id)!;

it("keeps tuning and held-out cases apart, bounded and stratified", () => {
  expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  expect(HELDOUT_CASES.length).toBeGreaterThanOrEqual(20);
  expect(HELDOUT_CASES.length).toBeLessThanOrEqual(40);
  const tuneFamilies = new Set(TUNE_CASES.map((c) => c.family));
  for (const c of HELDOUT_CASES) {
    expect(c.split).toBe("heldout");
    expect(tuneFamilies.has(c.family)).toBe(false);
  }
  for (const tag of ["risky", "ambiguous", "explicit", "chat"] as const)
    expect(HELDOUT_CASES.some((c) => c.tags.includes(tag))).toBe(true);
  expect(HELDOUT_CASES.some((c) => c.stratum === "authentic")).toBe(true);
  expect(HELDOUT_CASES.some((c) => c.project === "NoProject")).toBe(true);
});

it("recovers exactly the explicit constraints each case declares, and none from a mere mention", () => {
  for (const c of all) expect(extractConstraints(c.task), c.id).toEqual(c.explicit);
  expect(
    extractConstraints("Allow tasks in projects like Weave inside the YardSmith checkout."),
  ).toEqual({});
});

it("shows an engine the request text only", () => {
  for (const c of all)
    for (const d of DECISIONS) {
      const request = buildRequest("jev", d, c);
      expect(request.evidence).toEqual({ request: c.task });
      const serialized = JSON.stringify(request);
      expect(serialized).not.toContain(c.id);
      expect(request.questions).toHaveLength(1);
    }
});

const answered = (probabilities: Record<string, number>): EngineOutcome => ({
  kind: "answered",
  choice: "x",
  probabilities,
});

it("lets an explicit constraint win over a confident classifier, for engines and baselines alike", () => {
  const c = byId("h-explicit-model");
  const engine = answered({ routine: 0.99, demanding: 0.01 });
  const routed = routeDecision(c, "mainModel", engine);
  expect(routed).toMatchObject({
    value: "demanding",
    source: "constraint",
    engineChoice: "routine",
  });
  const project = byId("h-explicit-project");
  expect(routeDecision(project, "project", answered({ T3Peach: 1 })).value).toBe("SlipJay");
  expect(applyConstraints(project, keywordRule(project)).final.project).toBe("SlipJay");
  expect(
    applyConstraints(byId("h-explicit-lead"), currentDefault(byId("h-explicit-lead"))).final
      .workflow,
  ).toBe("lead");
});

it("falls back to current behaviour, towards more capability for a tier, when an engine fails, abstains or is unsure", () => {
  const c = byId("h-away");
  expect(routeDecision(c, "subagentTier", { kind: "failed", code: "timeout" })).toMatchObject({
    value: "demanding",
    source: "fallback",
  });
  expect(routeDecision(c, "subagentTier", { kind: "unanswered", status: "refusal" }).value).toBe(
    "demanding",
  );
  expect(
    routeDecision(
      c,
      "subagentTier",
      answered({ routine: POLICY.routineFloor - 0.01, demanding: 0.2, unknown: 0.1 }),
    ).value,
  ).toBe("demanding");
  expect(
    routeDecision(c, "subagentTier", answered({ routine: POLICY.routineFloor, demanding: 0.1 }))
      .value,
  ).toBe("routine");
  expect(
    routeDecision(c, "workflow", answered({ chat: 0.4, solo: 0.35, lead: 0.25 })),
  ).toMatchObject({ value: "solo", source: "fallback" });
  expect(routeDecision(c, "workflow", answered({ lead: 0.5, unknown: 0.5 })).source).toBe(
    "fallback",
  );
  expect(routeDecision(c, "workflow", answered({ chat: 0.9, solo: 0.1 }))).toMatchObject({
    value: "chat",
    source: "engine",
  });
  expect(routeDecision(c, "project", answered({ unknown: 0.9, T3Peach: 0.1 })).value).toBe(
    c.startedIn,
  );
});

it("keeps an established thread's route unless the user states a change", () => {
  const first = currentDefault(byId("h-away"));
  const proposed = {
    ...first,
    workflow: "chat" as const,
    mainModel: "routine" as const,
    project: "NoProject" as const,
  };
  expect(settleThreadRoute(first, proposed, "also add a test for it")).toEqual(first);
  expect(
    settleThreadRoute(first, proposed, "In SlipJay, check the runner. Use Sonnet."),
  ).toMatchObject({ project: "SlipJay", mainModel: "routine" });
  expect(settleThreadRoute(undefined, proposed, "anything")).toEqual(proposed);
});

it("separates under-served from over-served routing and prices tier mistakes in stated units", () => {
  expect(direction("subagentTier", "routine", "demanding")).toBe("under");
  expect(direction("subagentTier", "demanding", "routine")).toBe("over");
  expect(direction("workflow", "solo", "lead")).toBe("under");
  expect(direction("workflow", "lead", "chat")).toBe("over");
  expect(direction("workflow", "shape", "solo")).toBe("lateral");
  const c = byId("h-away");
  const judged = [
    {
      caseId: "a",
      decision: "subagentTier" as const,
      reference: "demanding",
      constrained: false,
      routed: { value: "routine", source: "engine" as const, engineChoice: null, reason: "" },
    },
    {
      caseId: "b",
      decision: "subagentTier" as const,
      reference: "routine",
      constrained: false,
      routed: { value: "demanding", source: "engine" as const, engineChoice: null, reason: "" },
    },
    {
      caseId: "c",
      decision: "subagentTier" as const,
      reference: "uncertain",
      constrained: false,
      routed: { value: "routine", source: "engine" as const, engineChoice: null, reason: "" },
    },
  ];
  const s = summarize("subagentTier", judged);
  expect(c.id).toBeTruthy();
  expect(s.scored).toBe(2);
  expect(s.uncertainReference).toBe(1);
  expect(s.under).toEqual(["a"]);
  expect(s.over).toEqual(["b"]);
  expect(s.relativeCost!["demanding=4x"]).toBe(1 + 0.5 + 4 + 4);
});

it("accepts a label only where two labelers agree on a concrete one", () => {
  expect(agreed("solo", "solo")).toBe("solo");
  expect(agreed("solo", "lead")).toBe("uncertain");
  expect(agreed("unknown", "unknown")).toBe("uncertain");
  expect(agreed(undefined, "solo")).toBe("uncertain");
  expect(hasAllLabels(all)).toBe(true);
  expect(outcomeTier("h-fork-docs")).toBe("routine");
  expect(outcomeTier("h-away")).toBe("demanding");
  expect(outcomeTier("h-chat-concept")).toBe("uncertain");
});

const result = (decision: string, probabilities: Record<string, number>): DecisionResult => ({
  engine: "jev",
  requestedModel: "m",
  resolvedModel: "m",
  adapterVersion: "a",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 5,
  usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
  cost: { usd: 0.001, status: "estimated", pricingSource: "p", inputUsdPerMillion: 1 },
  answers: [
    {
      id: decision,
      status: "answered",
      type: "choice",
      choice: "x",
      selectedChoiceProbability: 0.5,
      probabilities,
    },
  ],
});

it.effect("records one attempt per case, decision and engine and keeps failures visible", () =>
  Effect.gen(function* () {
    const cases = [byId("h-away")];
    let calls = 0;
    const service = Layer.succeed(DecisionService, {
      decide: (input: unknown) => {
        const request = input as DecisionRequest;
        calls++;
        if (calls === 1) return Effect.fail(new DecisionError({ code: "rate-limited" }));
        return Effect.succeed(result(request.questions[0]!.id, { routine: 0.8, demanding: 0.2 }));
      },
    });
    const fiber = yield* runEvaluation(cases, ["jev", "luna"], { gapMs: 2000 }).pipe(
      Effect.provide(service),
      Effect.forkChild,
    );
    yield* TestClock.adjust(2000 * 8);
    const records = yield* Fiber.join(fiber);
    expect(records).toHaveLength(8);
    expect(records[0]!.outcome).toEqual({ kind: "failed", code: "rate-limited" });
    expect(records.map((r) => r.decision)).toEqual([
      "project",
      "project",
      "workflow",
      "workflow",
      "mainModel",
      "mainModel",
      "subagentTier",
      "subagentTier",
    ]);
    const evaluated = evaluate(cases, records, () => "uncertain");
    expect(evaluated.cost["jev"]).toMatchObject({ attempts: 4, failedAttempts: 1 });
    expect(evaluated.overrideAttempts.every((o) => o.violations.length === 0)).toBe(true);
  }),
);

it("pins the corpus identity", () => {
  expect(corpusDigest(all)).toMatch(/^[0-9a-f]{64}$/);
  expect(corpusDigest(HELDOUT_CASES)).not.toBe(corpusDigest(TUNE_CASES));
});

const reproduced = (
  retained: { readonly records: ReadonlyArray<unknown> },
  cases: ReadonlyArray<AutoCase>,
) => JSON.parse(JSON.stringify(evaluate(cases, retained.records as never, primaryView).summary));

it("keeps the held-out result tied to the code and corpus that made it and reproducible from its records", () => {
  expect(heldoutResults.corpusDigest).toBe(corpusDigest(HELDOUT_CASES));
  expect(heldoutResults.run.files).toEqual(runDigests());
  const keys = heldoutResults.records.map(
    (r: { caseId: string; decision: string; engine: string }) =>
      `${r.caseId}:${r.decision}:${r.engine}`,
  );
  expect(new Set(keys).size).toBe(HELDOUT_CASES.length * DECISIONS.length * 2);
  expect(keys).toHaveLength(256);
  expect(reproduced(heldoutResults, HELDOUT_CASES)).toEqual(heldoutResults.summary);
  for (const o of heldoutResults.overrideAttempts) expect(o.violations).toEqual([]);
});

it("keeps the tuning result tied to its corpus and reproducible from its records", () => {
  expect(tuneResults.corpusDigest).toBe(corpusDigest(TUNE_CASES));
  expect(reproduced(tuneResults, TUNE_CASES)).toEqual(tuneResults.summary);
});

it("scores the retained downstream answers with the checks fixed beforehand", () => {
  const total = (tier: string) =>
    downstreamResults.runs
      .filter((r) => r.tier === tier)
      .reduce(
        (n, r) =>
          n +
          scoreAnswer(
            TASKS.find((t) => t.id === r.taskId)!,
            r.answer,
          ).passed.length,
        0,
      );
  expect(downstreamResults.runs).toHaveLength(TASKS.length * 2);
  expect(total("routine")).toBe(36);
  expect(total("demanding")).toBe(35);
});

it("resumes an attempt log only for the run that began it", () => {
  const files = runDigests();
  const expected = {
    split: "heldout",
    engines: ["jev", "luna"] as const,
    corpusDigest: corpusDigest(HELDOUT_CASES),
    files,
  };
  const record = {
    caseId: "h-away",
    decision: "project",
    engine: "jev",
    outcome: { kind: "failed", code: "timeout" },
    requestedModel: null,
    resolvedModel: null,
    adapterVersion: null,
    digest: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costStatus: null,
    startedAt: "t",
  } as const;
  const text =
    headerLine({ ...expected, checkout: { head: "x" }, runtime: { node: "v" } }) +
    recordLine(record);
  expect(parseAttemptLog(text, expected).records).toEqual([record]);
  expect(() => parseAttemptLog(text, { ...expected, corpusDigest: "changed" })).toThrow(
    /corpus changed/,
  );
  expect(() =>
    parseAttemptLog(text, { ...expected, files: { ...files, "x/run.ts": "changed" } }),
  ).toThrow(/run files changed/);
  expect(() => parseAttemptLog(text, { ...expected, split: "tune" })).toThrow(/different split/);
  expect(() => parseAttemptLog(recordLine(record), expected)).toThrow(/no identity header/);
  expect(() => parseAttemptLog("", expected)).toThrow(/empty/);
});
