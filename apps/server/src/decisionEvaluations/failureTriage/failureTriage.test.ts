import { DecisionError, type DecisionResult } from "@t3tools/contracts";
import { amendedManifest } from "../retainedRunIdentity.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { baselineLabel } from "./baseline.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { TRIAGE_LABELS } from "./corpusTypes.ts";
import { corpusDigest, evaluate, runEvaluation } from "./harness.ts";
import { adjudicate, labelViews, supportedLabel } from "./labels.ts";
import { buildRequest } from "./rule.ts";
import { runDigests, scorerDigests } from "./provenance.ts";
import { argmax, summarize, type Prediction } from "./scoring.ts";
import firstHeldout from "./results/first-run/heldout.json" with { type: "json" };
import heldoutResults from "./results/heldout.json" with { type: "json" };
import tuneResults from "./results/tune.json" with { type: "json" };

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
  for (const c of TUNE_CASES) expect(c.split).toBe("tune");
  for (const stratum of ["authentic", "reconstructed", "synthetic"] as const)
    expect(HELDOUT_CASES.some((c) => c.stratum === stratum)).toBe(true);
  for (const label of TRIAGE_LABELS) {
    expect(HELDOUT_CASES.some((c) => supportedLabel(c.id) === label)).toBe(true);
  }
  expect(corpusDigest(HELDOUT_CASES)).not.toBe(corpusDigest(TUNE_CASES));
});

it("shows the models only evidence: no label, family, stratum or retrospective cause", () => {
  for (const c of all) {
    const text = JSON.stringify(buildRequest("jev", c));
    expect(text).not.toContain(c.id);
    expect(text).not.toContain(c.family);
    expect(text).not.toContain(c.resolvedCause.basis);
    expect(text).not.toMatch(/resolvedCause|authorSupported|stratum/);
    expect(text).not.toMatch(
      /(?:sk-[A-Za-z0-9]{10}|AKIA[A-Z0-9]{8}|api[_-]?key\s*[:=]\s*["'][^"']{8})/i,
    );
    expect(buildRequest("luna", c).questions).toHaveLength(1);
  }
});

it("resolves annotator splits by agreement, then the author, then marks uncertainty", () => {
  expect(adjudicate("unknown", "regression", "regression")).toBe("regression");
  expect(adjudicate("fixture", "fixture", "environment")).toBe("fixture");
  expect(adjudicate("unknown", "fixture", "environment")).toBe("uncertain");
  const held = HELDOUT_CASES[0]!.id;
  for (const view of Object.values(labelViews))
    expect([...TRIAGE_LABELS, "uncertain"]).toContain(view(held));
  expect(() => labelViews["labelerA"]!(TUNE_CASES[0]!.id)).toThrow(/No held-out label/);
});

it("keeps the exit/signature baseline mechanical: it follows signatures into the traps", () => {
  expect(baselineLabel(byId("h-syn-regression-oom"))).toBe("environment");
  expect(baselineLabel(byId("h-syn-flake-registered-different-error"))).toBe("known-flake");
  expect(baselineLabel(byId("h-syn-regression-typecheck"))).toBe("regression");
  expect(baselineLabel(byId("h-syn-regression-assertion"))).toBe("regression");
  expect(baselineLabel(byId("h-syn-unknown-bare-exit"))).toBe("unknown");
  for (const c of all.filter((x) => x.stratum === "authentic")) {
    expect(baselineLabel(c)).toBe("unknown");
  }
});

it("takes the label from the probabilities and falls to unknown on an exact tie", () => {
  expect(
    argmax({ regression: 0.2, fixture: 0.5, environment: 0.2, "known-flake": 0, unknown: 0.1 }),
  ).toEqual({
    label: "fixture",
    tie: false,
  });
  expect(
    argmax({ regression: 0.4, fixture: 0.4, environment: 0.1, "known-flake": 0, unknown: 0.1 }),
  ).toEqual({
    label: "unknown",
    tie: true,
  });
});

const prediction = (
  caseId: string,
  supported: Prediction["supported"],
  resolved: Prediction["resolved"],
  predicted: Prediction["predicted"],
): Prediction => ({ caseId, stratum: "synthetic", supported, resolved, predicted, tie: false });

it("counts dismissal of regressions and unresolved causes as dangerous, and keeps disputed cases in the denominator", () => {
  const summary = summarize([
    prediction("a", "regression", "regression", "known-flake"),
    prediction("b", "unknown", "unknown", "environment"),
    prediction("c", "uncertain", "regression", "environment"),
    prediction("d", "regression", "regression", "fixture"),
    prediction("e", "known-flake", "known-flake", "known-flake"),
    prediction("f", "unknown", "unknown", "unknown"),
  ]);
  expect(summary.dangerousStrict.cases).toEqual(["a", "c"]);
  expect(summary.dangerousStrict.denominator).toBe(3);
  expect(summary.dangerousWide.cases).toEqual(["a", "b", "c"]);
  expect(summary.dangerousWide.denominator).toBe(5);
  expect(summary.unsafeDiversion.cases).toEqual(["a", "b", "c", "d"]);
  expect(summary.supportedUncertain).toBe(1);
  expect(summary.accuracy.denominator).toBe(5);
  expect(summary.falseFlake.cases).toEqual(["a"]);
});

it("does not credit a missing decision as a correct abstention", () => {
  const summary = summarize([
    prediction("a", "unknown", "unknown", null),
    prediction("b", "unknown", "unknown", "unknown"),
    prediction("c", "fixture", "fixture", "unknown"),
  ]);
  expect(summary.noDecision).toBe(1);
  expect(summary.explicitUnknown).toBe(2);
  expect(summary.accuracy.numerator).toBe(1);
  expect(summary.appropriateAbstention.numerator).toBe(1);
  expect(summary.appropriateAbstention.denominator).toBe(2);
  expect(summary.overAbstention.numerator).toBe(1);
});

const answer = (probabilities: Record<string, number>, choice = "unknown"): DecisionResult => ({
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
  answers: [
    {
      id: "cause",
      status: "answered",
      type: "choice",
      choice,
      selectedChoiceProbability: probabilities[choice] ?? 0,
      probabilities,
    },
  ],
});

it.effect(
  "records one attempt per case and engine, keeps failures visible and failed spend unknown",
  () =>
    Effect.gen(function* () {
      const cases = HELDOUT_CASES.slice(0, 3);
      let calls = 0;
      const service = Layer.succeed(DecisionService, {
        decide: () => {
          calls++;
          if (calls === 1) return Effect.fail(new DecisionError({ code: "rate-limited" }));
          if (calls === 2)
            return Effect.succeed({
              ...answer({}),
              answers: [{ id: "cause", status: "refusal" as const }],
            });
          return Effect.succeed(
            answer(
              { regression: 0.1, fixture: 0, environment: 0.7, "known-flake": 0, unknown: 0.2 },
              "regression",
            ),
          );
        },
      });
      const fiber = yield* runEvaluation(cases, ["jev", "luna"], { gapMs: 1500 }).pipe(
        Effect.provide(service),
        Effect.forkChild,
      );
      yield* TestClock.adjust(1500 * 6);
      const records = yield* Fiber.join(fiber);
      expect(records).toHaveLength(6);
      expect(records[0]!.outcome).toEqual({ kind: "failed", code: "rate-limited" });
      expect(records[1]!.outcome).toEqual({ kind: "unanswered", status: "refusal" });
      const results = evaluate(cases, records, () => "unknown");
      expect(results.systems["jev"]!.noDecision).toBe(1);
      expect(results.systems["luna"]!.noDecision).toBe(1);
      expect(results.systems["jev"]!.explicitUnknown).toBe(0);
      expect(results.predictions["jev"]![2]!.predicted).toBe("environment");
      expect(results.cost["jev"]!.failedAttempts).toBe(1);
      expect(results.cost["jev"]!.unobservedAttempts).toBe(1);
      expect(results.cost["jev"]!.costUsd).toBeNull();
      expect(results.cost["jev"]!.choiceDisagreesWithArgmax).toBe(2);
      expect(results.systems["alwaysUnknown"]!.explicitUnknown).toBe(3);
    }),
);

it("keeps retained results tied to the code and corpus that produced them and reproducible from their records", () => {
  for (const [retained, cases] of [
    [heldoutResults, HELDOUT_CASES],
    [tuneResults, TUNE_CASES],
  ] as const) {
    expect(retained.corpusDigest).toBe(corpusDigest(cases));
    expect(amendedManifest(retained.run.files)).toEqual(runDigests());
    expect(retained.scorer.files).toEqual(scorerDigests());
    const again = evaluate(cases, retained.records as never, supportedLabel);
    expect(JSON.parse(JSON.stringify(again.systems))).toEqual(retained.systems);
    expect(JSON.parse(JSON.stringify(again.cost))).toEqual(retained.cost);
  }
});

it("keeps the superseded first run reproducible from its records, without claiming the current code made it", () => {
  expect(firstHeldout.corpusDigest).toBe(corpusDigest(HELDOUT_CASES));
  const again = evaluate(HELDOUT_CASES, firstHeldout.records as never, supportedLabel);
  expect(JSON.parse(JSON.stringify(again.systems))).toEqual(firstHeldout.systems);
});
