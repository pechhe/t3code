// @effect-diagnostics nodeBuiltinImport:off - reads pool bodies through git at the retained run's commit
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DecisionError, type DecisionRequest, type DecisionResult } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { lexicalScores, tokenize } from "./baseline.ts";
import { CANDIDATES_PER_CASE, orderedCandidates, POOL_BY_ID } from "./caseBuilder.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { armContext, armSelections, DOWNSTREAM } from "./downstream.ts";
import { corpusDigest, evaluate, runEvaluation } from "./harness.ts";
import { agree, ALL_CASES, hasAllLabels, labelSources, labelViews, primaryView } from "./labels.ts";
import { runDigests, scorerDigests } from "./provenance.ts";
import { buildRequest, THRESHOLD, TOKEN_BUDGET, TOP_K } from "./rule.ts";
import { averagePrecision, ranked, select, summarizeRule, type CaseView } from "./scoring.ts";
import firstHeldout from "./results/first-run/heldout.json" with { type: "json" };
import heldoutResults from "./results/heldout.json" with { type: "json" };
import tuneResults from "./results/tune.json" with { type: "json" };

it("keeps tuning and held-out cases apart, bounded and stratified", () => {
  expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
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
  expect(corpusDigest(HELDOUT_CASES)).not.toBe(corpusDigest(TUNE_CASES));
});

it("keeps governing instructions and requested skills outside ranking, and every candidate real", () => {
  for (const c of ALL_CASES) {
    expect(c.candidates).toHaveLength(CANDIDATES_PER_CASE);
    expect(new Set(c.candidates).size).toBe(c.candidates.length);
    for (const id of [...c.mandatory, ...c.requested]) {
      expect(c.candidates).not.toContain(id);
      expect(POOL_BY_ID.has(id)).toBe(true);
    }
    for (const id of c.candidates) expect(POOL_BY_ID.has(id)).toBe(true);
  }
  expect(ALL_CASES.some((c) => c.requested.length > 0)).toBe(true);
});

it("shows rankers only the task, the names of what is already included and the candidates", () => {
  for (const c of ALL_CASES) {
    const request = buildRequest("jev", c);
    const text = JSON.stringify(request);
    expect(text).not.toContain(c.id);
    expect(text).not.toMatch(/authorNeeded|stratum|changedFiles|"split"/);
    expect(text).not.toMatch(
      /(?:sk-[A-Za-z0-9]{10}|AKIA[A-Z0-9]{8}|api[_-]?key\s*[:=]\s*["'][^"']{8})/i,
    );
    expect(request.questions).toHaveLength(c.candidates.length);
    expect(request.questions.every((q) => q.type === "predicate")).toBe(true);
    const evidence = request.evidence as {
      alreadyIncluded: string[];
      candidates: Array<{ title: string }>;
    };
    for (const id of [...c.mandatory, ...c.requested]) {
      expect(evidence.alreadyIncluded).toContain(POOL_BY_ID.get(id)!.title);
      expect(evidence.candidates.map((x) => x.title)).not.toContain(POOL_BY_ID.get(id)!.title);
    }
    expect(buildRequest("luna", c).questions).toEqual(request.questions);
  }
});

it("shows candidates in a fixed shuffled order with opaque references", () => {
  const c = HELDOUT_CASES[0]!;
  const first = orderedCandidates(c);
  expect(orderedCandidates(c)).toEqual(first);
  expect(first.map((o) => o.ref)).toEqual(
    Array.from({ length: 16 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`),
  );
  expect(first.map((o) => o.id)).not.toEqual([...c.candidates]);
});

it("keeps the lexical baseline mechanical and complete", () => {
  expect(tokenize("Fixing the DecisionService retries")).toEqual([
    "fix",
    "decision",
    "service",
    "retri",
  ]);
  for (const c of ALL_CASES) {
    const a = lexicalScores(c);
    expect(lexicalScores(c)).toEqual(a);
    expect(Object.keys(a)).toHaveLength(c.candidates.length);
    expect(Object.values(a).every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  }
});

const view = (
  scores: Array<[string, number | null, "needed" | "helpful" | "unneeded" | "uncertain", number?]>,
): CaseView => ({
  caseId: "c",
  stratum: "synthetic",
  fixedTokens: 100,
  candidates: scores.map(([ref, score, reference, tokens], i) => ({
    id: `id${i}`,
    ref,
    tokens: tokens ?? 10,
    reference,
    score,
  })),
});

it("selects by rank with ties in shown order, never selects unscored candidates, and respects the declared rules", () => {
  expect(TOP_K).toBe(5);
  expect(THRESHOLD).toBe(0.5);
  expect(TOKEN_BUDGET).toBe(6000);
  const v = view([
    ["c01", 0.9, "needed"],
    ["c02", 0.9, "unneeded"],
    ["c03", null, "needed"],
    ["c04", 0.4, "helpful"],
    ["c05", 0.5, "unneeded"],
    ["c06", 0.3, "unneeded"],
    ["c07", 0.2, "unneeded"],
    ["c08", 0.1, "unneeded"],
  ]);
  expect(ranked(v.candidates).map((c) => c.ref)).toEqual([
    "c01",
    "c02",
    "c05",
    "c04",
    "c06",
    "c07",
    "c08",
    "c03",
  ]);
  expect([...select(v, "topK")]).toEqual(["id0", "id1", "id4", "id3", "id5"]);
  expect([...select(v, "threshold")].sort()).toEqual(["id0", "id1", "id4"]);
  expect(select(v, "none").size).toBe(0);
  expect(select(v, "all").size).toBe(8);
  const big = view([
    ["c01", 0.9, "needed", 5000],
    ["c02", 0.8, "needed", 2000],
    ["c03", 0.7, "needed", 900],
  ]);
  expect([...select(big, "budget")]).toEqual(["id0", "id2"]);
});

it("counts a dropped needed candidate as a critical omission, keeps fixed context in the volume, and earns nothing for unscored hits", () => {
  const v = view([
    ["c01", 0.9, "needed"],
    ["c02", 0.1, "needed"],
    ["c03", 0.8, "uncertain"],
    ["c04", 0.7, "unneeded"],
    ["c05", 0.6, "unneeded"],
    ["c06", 0.5, "unneeded"],
  ]);
  const s = summarizeRule([v], "topK");
  expect(s.neededItems).toBe(2);
  expect(s.neededRetained).toBe(1);
  expect(s.criticalOmissionIds).toEqual(["c"]);
  expect(s.included.uncertain).toBe(1);
  expect(s.meanIncludedTokens).toBe(100 + 50);
  expect(s.tokenSavingFraction).toBeCloseTo(1 - 150 / 160);
  const failed = view([
    ["c01", null, "needed"],
    ["c02", null, "unneeded"],
  ]);
  expect(averagePrecision(failed)).toBe(0);
  expect(summarizeRule([failed], "topK").neededRetained).toBe(0);
  const none = summarizeRule(
    [
      view([
        ["c01", 0.9, "unneeded"],
        ["c02", 0.8, "unneeded"],
      ]),
    ],
    "topK",
  );
  expect(none.casesWithNeeded).toBe(0);
  expect(none.meanIncludedWhenNoneNeeded).toBe(2);
});

it("agrees only when both labelers do, with no author tie-break and unknown kept uncertain", () => {
  expect(agree("needed", "needed")).toBe("needed");
  expect(agree("unneeded", "unneeded")).toBe("unneeded");
  expect(agree("needed", "helpful")).toBe("helpful");
  expect(agree("needed", "unneeded")).toBe("uncertain");
  expect(agree("helpful", "unneeded")).toBe("uncertain");
  expect(agree("unknown", "needed")).toBe("uncertain");
  expect(agree(undefined, "needed")).toBe("uncertain");
});

it("holds labels for every candidate of every case, captured against exactly this corpus", () => {
  expect(hasAllLabels(ALL_CASES)).toBe(true);
  expect(labelSources.A.corpusDigest).toBe(corpusDigest(ALL_CASES));
  expect(labelSources.B.corpusDigest).toBe(corpusDigest(ALL_CASES));
  expect(labelSources.A.model).not.toBe(labelSources.B.model);
  const c = HELDOUT_CASES[0]!;
  for (const [name, v] of Object.entries(labelViews))
    for (const { id } of orderedCandidates(c))
      expect(["needed", "helpful", "unneeded", "uncertain"], name).toContain(v(c, id));
});

const answerAll = (scores: Record<string, number>): DecisionResult => ({
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
  answers: Object.entries(scores).map(([id, probability]) => ({
    id,
    status: "answered" as const,
    type: "predicate" as const,
    probability,
  })),
});

it.effect(
  "records one attempt per case and engine, keeps failures visible and failed spend unknown",
  () =>
    Effect.gen(function* () {
      const cases = HELDOUT_CASES.slice(0, 2);
      let calls = 0;
      const service = Layer.succeed(DecisionService, {
        decide: (input: unknown) => {
          const request = input as DecisionRequest;
          calls++;
          if (calls === 1) return Effect.fail(new DecisionError({ code: "rate-limited" }));
          const scores = Object.fromEntries(
            request.questions.map((q, i) => [q.id, i === 0 ? 0.9 : 0.1]),
          );
          if (calls === 2) delete scores[request.questions[1]!.id];
          return Effect.succeed(answerAll(scores));
        },
      });
      const fiber = yield* runEvaluation(cases, ["jev", "luna"], { gapMs: 1500 }).pipe(
        Effect.provide(service),
        Effect.forkChild,
      );
      yield* TestClock.adjust(1500 * 4);
      const records = yield* Fiber.join(fiber);
      expect(records).toHaveLength(4);
      expect(records[0]!.outcome).toEqual({ kind: "failed", code: "rate-limited" });
      expect(records[0]!.estimatedInputTokens).toBeGreaterThan(0);
      const second = records[1]!;
      expect(second.engine).toBe("luna");
      expect(second.outcome.kind === "answered" && second.outcome.unanswered).toBe(1);
      const results = evaluate(cases, records, primaryView);
      const cost = results.cost["jev"] as {
        failedAttempts: number;
        unobservedAttempts: number;
        costUsd: number | null;
        unansweredQuestions: number;
      };
      expect(cost.failedAttempts).toBe(1);
      expect(cost.unobservedAttempts).toBe(1);
      expect(cost.costUsd).toBeNull();
      expect((results.cost["luna"] as { unansweredQuestions: number }).unansweredQuestions).toBe(1);
      expect(results.systems["jev"]!.rules.topK.neededRetained).toBeLessThanOrEqual(
        results.systems["jev"]!.rules.topK.neededItems,
      );
      expect(results.systems["lexical"]!.rules.threshold).toBeNull();
      expect(results.systems["jev"]!.rules.threshold).not.toBeNull();
    }),
);

/**
 * The runs were made before the upstream merge that moved DecisionService from Crypto to Digest and gave this entry point the matching layer
 * (same SHA-256 canonical-JSON digest, same requests). Nothing else that decides what was asked may differ.
 */
const KNOWN_FOUNDATION_DRIFT = [
  "apps/server/src/decisionEvaluations/contextRanking/run.ts",
  "apps/server/src/decisions/DecisionService.ts",
  "pnpm-lock.yaml",
];

it("keeps retained results tied to the code, labels and corpus that produced them and reproducible from their records", () => {
  for (const [retained, cases] of [
    [heldoutResults, HELDOUT_CASES],
    [tuneResults, TUNE_CASES],
  ] as const) {
    expect(retained.corpusDigest).toBe(corpusDigest(cases));
    expect(retained.corpusDigestAll).toBe(corpusDigest(ALL_CASES));
    const now = runDigests();
    const drifted = Object.keys({ ...retained.run.files, ...now }).filter(
      (f) => (retained.run.files as Record<string, string>)[f] !== now[f as keyof typeof now],
    );
    expect(drifted.sort()).toEqual(KNOWN_FOUNDATION_DRIFT);
    expect(retained.scorer.files).toEqual(scorerDigests());
    expect(retained.declared).toEqual({
      topK: TOP_K,
      threshold: THRESHOLD,
      tokenBudgetEstimate: TOKEN_BUDGET,
    });
    const again = evaluate(cases, retained.records as never, primaryView);
    expect(JSON.parse(JSON.stringify(again.systems))).toEqual(retained.systems);
    expect(JSON.parse(JSON.stringify(again.cost))).toEqual(retained.cost);
  }
});

it("keeps the superseded first run reproducible from its records, without claiming the current code made it", () => {
  expect(firstHeldout.corpusDigest).toBe(corpusDigest(HELDOUT_CASES));
  const again = evaluate(HELDOUT_CASES, firstHeldout.records as never, primaryView);
  expect(JSON.parse(JSON.stringify(again.systems))).toEqual(firstHeldout.systems);
});

it("records the failed call of the final held-out run and keeps its spend unknown", () => {
  const failed = heldoutResults.records.filter((r) => r.outcome.kind === "failed");
  expect(failed.map((r) => [r.caseId, r.engine])).toEqual([["h-dev-pairing", "luna"]]);
  expect(heldoutResults.cost.luna.costUsd).toBeNull();
  expect(heldoutResults.cost.luna.unobservedAttempts).toBe(1);
});

it("fixes the downstream check on held-out cases whose rubrics were written before the run", () => {
  expect(DOWNSTREAM.length).toBeGreaterThanOrEqual(4);
  for (const d of DOWNSTREAM) {
    expect(HELDOUT_CASES.some((c) => c.id === d.caseId)).toBe(true);
    expect(d.rubric.length).toBeGreaterThanOrEqual(2);
  }
});

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "../../../../..");

/** Reads a repository file as it stood at the commit a retained run measured. */
const readAt =
  (head: string) =>
  (path: string): string => {
    const relative = NodePath.relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
    // Skill bodies may resolve outside the repository, where only the working tree has them.
    if (relative.startsWith("..")) return NodeFS.readFileSync(path, "utf8");
    const result = NodeChildProcess.spawnSync("git", ["show", `${head}:${relative}`], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`git show ${head}:${relative} failed`);
    return result.stdout.toString("utf8");
  };

it("hands every downstream arm the governing and requested context whole, outside ranking", () => {
  const read = readAt(heldoutResults.run.checkout.head);
  for (const d of DOWNSTREAM) {
    const c = HELDOUT_CASES.find((x) => x.id === d.caseId)!;
    const selections = armSelections(heldoutResults as never, c);
    for (const arm of ["all", "lexical", "jev"] as const) {
      const text = armContext(c, selections[arm], arm, read);
      for (const id of [...c.mandatory, ...c.requested])
        expect(text).toContain(`### ${POOL_BY_ID.get(id)!.title}`);
    }
  }
});
