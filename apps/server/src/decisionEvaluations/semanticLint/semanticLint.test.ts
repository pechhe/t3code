import { DecisionError, type DecisionResult } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { baselineFlag } from "./baseline.ts";
import { CATEGORIES } from "./corpusTypes.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { corpusDigest, evaluate, runEvaluation } from "./harness.ts";
import { labelViews, referenceLabel } from "./labels.ts";
import { buildRequest } from "./rule.ts";
import { auc, confusion, summarize, summarizeCost, wilson, type Prediction } from "./scoring.ts";

const prediction = (
  caseId: string,
  reference: Prediction["reference"],
  flagged: boolean,
  probability?: number,
): Prediction => ({
  caseId,
  category: "x",
  reference,
  flagged,
  outcome:
    probability === undefined
      ? { kind: "failed", code: "timeout" }
      : { kind: "answered", probability },
});

it("scores uncertain references separately and counts unanswered cases as misses", () => {
  const predictions = [
    prediction("a", "defect", true, 0.9),
    prediction("b", "defect", false),
    prediction("c", "ok", true, 0.7),
    prediction("d", "ok", false, 0.1),
    prediction("e", "uncertain", true, 0.8),
  ];
  expect(confusion(predictions)).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1 });
  const summary = summarize(predictions);
  expect(summary.failed).toBe(1);
  expect(summary.misses).toEqual(["b"]);
  expect(summary.falseAlarms).toEqual(["c"]);
  expect(summary.uncertainFlagged).toBe(1);
  expect(summary.flaggedPerTrueDefect).toBe(3);
  expect(auc(predictions)).toBe(1);
});

it("keeps intervals honest for tiny samples", () => {
  expect(wilson(0, 0).value).toBeNull();
  const all = wilson(5, 5);
  expect(all.value).toBe(1);
  expect(all.low).toBeLessThan(0.6);
});

it("never turns unknown cost into a number", () => {
  const known = { latencyMs: 100, inputTokens: 10, costUsd: 0.1, costStatus: "estimated" };
  const unknown = { latencyMs: 300, inputTokens: null, costUsd: null, costStatus: "unknown" };
  const summary = summarizeCost([known, unknown]);
  expect(summary.costUsd).toBeNull();
  expect(summary.inputTokens).toBeNull();
  expect(summary.costKnownCalls).toBe(1);
  expect(summary.latencyMs.max).toBe(300);
});

it("keeps the corpus separated, stratified and bounded", () => {
  const all = [...TUNE_CASES, ...HELDOUT_CASES];
  expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  expect(new Set(all.map((c) => c.evidence)).size).toBe(all.length);
  expect(HELDOUT_CASES.length).toBeGreaterThanOrEqual(20);
  expect(HELDOUT_CASES.length).toBeLessThanOrEqual(40);
  for (const category of CATEGORIES) {
    for (const set of [TUNE_CASES, HELDOUT_CASES]) {
      const own = set.filter((c) => c.category === category);
      expect(own.some((c) => c.authorLabel === "defect")).toBe(true);
      expect(own.some((c) => c.stratum === "tricky-negative")).toBe(true);
    }
  }
  for (const c of HELDOUT_CASES) expect(c.split).toBe("heldout");
  expect(corpusDigest(HELDOUT_CASES)).not.toBe(corpusDigest(TUNE_CASES));
  for (const c of all) {
    expect(c.evidence).not.toMatch(/(?:sk-|AKIA|api[_-]?key\s*[:=]\s*["'][^"']{8})/i);
  }
});

it("gives every case a valid request without leaking the author's label", () => {
  for (const c of [...TUNE_CASES, ...HELDOUT_CASES]) {
    const request = buildRequest("jev", c);
    const text = JSON.stringify(request);
    expect(text).not.toContain(c.authorNote);
    expect(request.questions).toHaveLength(1);
    expect(referenceLabel(c.id.startsWith("t-") ? c.id : "t-comment-1")).toBeDefined();
  }
});

it("shows what static baselines can and cannot see", () => {
  const byId = (id: string) => [...TUNE_CASES, ...HELDOUT_CASES].find((c) => c.id === id)!;
  expect(baselineFlag(byId("h-comment-1"))).toBe(true);
  expect(baselineFlag(byId("h-comment-5"))).toBe(false);
  expect(baselineFlag(byId("h-comment-2"))).toBe(false);
  expect(baselineFlag(byId("h-assert-3"))).toBe(true);
  expect(baselineFlag(byId("h-assert-6"))).toBe(true);
  expect(baselineFlag(byId("h-assert-4"))).toBe(false);
  expect(baselineFlag(byId("h-error-3"))).toBe(true);
  expect(baselineFlag(byId("h-error-4"))).toBe(false);
  expect(baselineFlag(byId("h-smell-5"))).toBe(true);
});

const answer = (probability: number): DecisionResult => ({
  engine: "jev",
  requestedModel: "m",
  resolvedModel: null,
  adapterVersion: "v",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 5,
  usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
  cost: { usd: 0.001, status: "estimated", pricingSource: "p", inputUsdPerMillion: 1 },
  answers: [{ id: "defect", status: "answered", type: "predicate", probability }],
});

it.effect("records one attempt per case and engine, keeping failures and non-answers visible", () =>
  Effect.gen(function* () {
    const cases = HELDOUT_CASES.slice(0, 3);
    const calls: string[] = [];
    const service = Layer.succeed(DecisionService, {
      decide: (input: unknown) => {
        const request = input as ReturnType<typeof buildRequest>;
        calls.push(request.engine);
        if (calls.length === 1) return Effect.fail(new DecisionError({ code: "rate-limited" }));
        if (calls.length === 2)
          return Effect.succeed({
            ...answer(0),
            answers: [{ id: "defect", status: "unknown" as const }],
          });
        return Effect.succeed(answer(0.9));
      },
    });
    const fiber = yield* runEvaluation(cases, ["jev", "luna"], { gapMs: 1500 }).pipe(
      Effect.provide(service),
      Effect.forkChild,
    );
    yield* TestClock.adjust(1500 * 6);
    const records = yield* Fiber.join(fiber);
    expect(records).toHaveLength(6);
    expect(calls).toHaveLength(6);
    expect(records[0]!.outcome).toEqual({ kind: "failed", code: "rate-limited" });
    expect(records[1]!.outcome).toEqual({ kind: "unanswered", status: "unknown" });
    const results = evaluate(cases, records, () => "defect");
    expect(results.systems["jev"]!.failed).toBe(1);
    expect(results.systems["luna"]!.unanswered).toBe(1);
    expect(results.systems["jev"]!.confusion.fn).toBe(1);
    expect(results.cost["jev"]!.calls).toBe(2);
    expect(results.cost["jev"]!.unobservedAttempts).toBe(1);
    expect(results.cost["jev"]!.costUsd).toBeNull();
    expect(results.cost["jev"]!.inputTokens).toBeNull();
    expect(results.cost["jev"]!.knownCostUsd).toBeCloseTo(0.002);
  }),
);

it("never invents a reference label for cases a view does not cover", () => {
  const held = HELDOUT_CASES[0]!.id;
  for (const [name, view] of Object.entries(labelViews)) {
    expect(["defect", "ok", "uncertain"]).toContain(view(held));
    if (name !== "adjudicated")
      expect(() => view(TUNE_CASES[0]!.id)).toThrow(/No held-out label/);
  }
});
