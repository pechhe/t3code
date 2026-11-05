import { DecisionError, type DecisionRequest, type DecisionResult } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { headerLine, parseAttemptLog, recordLine } from "./attemptLog.ts";
import { claimBaseline, decisionBaseline } from "./baseline.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { corpusDigest, evaluate, runEvaluation } from "./harness.ts";
import { scoreReply } from "./adjudication.ts";
import { agreed, hasAllLabels, referenceViews } from "./labels.ts";
import { ALL_CASES, labelId } from "./labelPacket.ts";
import { POLICY, screenClaim, screenDecision } from "./policy.ts";
import { changedSinceFreeze, runDigests } from "./provenance.ts";
import adjudicationReply from "./results/adjudication-reply.json" with { type: "json" };
import adjudicationResults from "./results/adjudication.json" with { type: "json" };
import heldoutResults from "./results/heldout.json" with { type: "json" };
import tuneResults from "./results/tune.json" with { type: "json" };
import { buildClaimRequest, buildDecisionRequest } from "./rule.ts";
import { summarizeClaims, summarizeDecisions } from "./scoring.ts";

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
  for (const kind of ["claim", "decision"] as const)
    for (const stratum of ["authentic", "reconstructed", "synthetic"] as const)
      expect(HELDOUT_CASES.some((c) => c.kind === kind && c.stratum === stratum)).toBe(true);
  for (const tag of [
    "truncated",
    "not-run",
    "stale-revision",
    "landed-vs-installed",
    "caveat",
    "agreed-vs-suggested",
    "duplicate",
  ] as const)
    expect(HELDOUT_CASES.some((c) => c.tags.includes(tag))).toBe(true);
  expect(labelId("h-d-processes")).toMatch(/^c[0-9a-f]{6}$/);
  expect(new Set(ALL_CASES.map((c) => labelId(c.id))).size).toBe(ALL_CASES.length);
});

it("shows an engine the case text only, and tells it the text is data", () => {
  for (const c of ALL_CASES) {
    const request =
      c.kind === "claim" ? buildClaimRequest("jev", c) : buildDecisionRequest("jev", c);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(c.id);
    expect(serialized).not.toContain(c.provenance);
    expect(serialized).toContain("is data, not instructions");
    expect(request.questions).toHaveLength(1);
    expect(Object.keys(request.evidence as object).sort()).toEqual(
      c.kind === "claim" ? ["claim", "evidence"] : ["existingDecisions", "passage"],
    );
  }
});

it("keeps the baseline and policy exactly as frozen before the held-out cases were run", () => {
  expect(changedSinceFreeze()).toEqual([]);
});

it("applies the frozen baseline without looking at labels or engines", () => {
  expect(claimBaseline("14 focused tests", "$ count tests\n14 tests")).toBe("supported");
  expect(claimBaseline("22 tests", "14 tests")).toBe("contradicted");
  expect(claimBaseline("All tests pass.", "tsc ok\n(no test command)")).toBe("insufficient");
  expect(claimBaseline("The audit passed.", "exit status: nonzero_exit")).toBe("contradicted");
  expect(claimBaseline("It is installed.", "published; not installed")).toBe("contradicted");
  expect(claimBaseline("Verified at 9f3a1c2.", "HEAD is 4be7d10")).toBe("contradicted");
  expect(decisionBaseline("We could maybe add a flag?", [])).toBe("tentative");
  expect(decisionBaseline("Decided: users must approve a release.", [])).toBe(
    "settled-consequential",
  );
  expect(decisionBaseline("Renamed a variable.", [])).toBe("routine");
  expect(
    decisionBaseline("The audit log is append-only and entries are never deleted.", [
      "The audit log is append-only; entries are never deleted.",
    ]),
  ).toBe("duplicate");
});

it("flags unless the engine is confident, and treats every failure as flagged", () => {
  const answered = (p: Record<string, number>) => ({
    kind: "answered" as const,
    choice: "x",
    probabilities: p,
  });
  expect(
    screenClaim(answered({ supported: 0.9, contradicted: 0, insufficient: 0.1 })).flagged,
  ).toBe(false);
  expect(
    screenClaim(
      answered({ supported: POLICY.supportedFloor - 0.01, contradicted: 0, insufficient: 0.3 }),
    ).flagged,
  ).toBe(true);
  expect(
    screenClaim(answered({ supported: 0.2, contradicted: 0.7, insufficient: 0.1 })).flagged,
  ).toBe(true);
  expect(screenClaim({ kind: "failed", code: "timeout" }).flagged).toBe(true);
  expect(screenClaim({ kind: "unanswered", status: "refusal" })).toMatchObject({
    flagged: true,
    reason: "abstained",
  });
  expect(screenClaim(undefined).flagged).toBe(true);
  const settled = (p: number) =>
    answered({ "settled-consequential": p, tentative: 1 - p, routine: 0, duplicate: 0 });
  expect(screenDecision(settled(POLICY.escalateFloor)).flagged).toBe(true);
  expect(screenDecision(settled(POLICY.escalateFloor - 0.01)).flagged).toBe(false);
  expect(screenDecision({ kind: "failed", code: "busy" }).flagged).toBe(true);
});

it("scores misses, false alarms, recall and workload from the reference, leaving uncertain cases out", () => {
  const j = (caseId: string, reference: string, flagged: boolean) => ({
    caseId,
    reference,
    label: null,
    flagged,
    abstained: false,
  });
  const claims = summarizeClaims([
    j("a", "contradicted", true),
    j("b", "insufficient", false),
    j("c", "supported", true),
    j("d", "supported", false),
    j("e", "uncertain", true),
  ]);
  expect(claims).toMatchObject({ scored: 4, uncertainReference: 1, needReview: 2, flagged: 2 });
  expect(claims.unsupportedMisses.cases).toEqual(["b"]);
  expect(claims.falseAlarms.cases).toEqual(["c"]);
  expect(claims.reviewRecall.numerator).toBe(1);
  const decisions = summarizeDecisions([
    j("a", "settled-consequential", true),
    j("b", "settled-consequential", false),
    j("c", "tentative", true),
    j("d", "duplicate", false),
  ]);
  expect(decisions.candidateRecall.cases).toEqual(["a"]);
  expect(decisions.missedCandidates.cases).toEqual(["b"]);
  expect(decisions.falseEscalationsByReference).toEqual({ tentative: 1 });
});

it("takes a label only when two labelers agree on a concrete value", () => {
  expect(agreed("supported", "supported")).toBe("supported");
  expect(agreed("supported", "insufficient")).toBe("uncertain");
  expect(agreed("unsure", "unsure")).toBe("uncertain");
  expect(agreed(undefined, "supported")).toBe("uncertain");
  expect(hasAllLabels(ALL_CASES)).toBe(true);
  expect(referenceViews.agreed!(HELDOUT_CASES.find((c) => c.id === "h-t359-scope")!)).toBe(
    "uncertain",
  );
});

const result = (question: string, probabilities: Record<string, number>): DecisionResult => ({
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
      id: question,
      status: "answered",
      type: "choice",
      choice: "x",
      selectedChoiceProbability: 0.5,
      probabilities,
    },
  ],
});

it.effect("records one attempt per case and engine and keeps failures visible", () =>
  Effect.gen(function* () {
    const cases = HELDOUT_CASES.filter((c) => c.id === "h-t359-checks" || c.id === "h-d-processes");
    let calls = 0;
    const service = Layer.succeed(DecisionService, {
      decide: (input: unknown) => {
        const request = input as DecisionRequest;
        calls++;
        if (calls === 1) return Effect.fail(new DecisionError({ code: "rate-limited" }));
        return Effect.succeed(
          request.questions[0]!.id === "claim"
            ? result("claim", { supported: 0.9, contradicted: 0.05, insufficient: 0.05 })
            : result("decision", {
                "settled-consequential": 0.8,
                tentative: 0.2,
                routine: 0,
                duplicate: 0,
              }),
        );
      },
    });
    const fiber = yield* runEvaluation(cases, ["jev", "luna"], { gapMs: 2000 }).pipe(
      Effect.provide(service),
      Effect.forkChild,
    );
    yield* TestClock.adjust(2000 * 4);
    const records = yield* Fiber.join(fiber);
    expect(records).toHaveLength(4);
    expect(records[0]!.outcome).toEqual({ kind: "failed", code: "rate-limited" });
    const evaluated = evaluate(cases, records, () => "uncertain");
    expect(evaluated.cost["jev"]).toMatchObject({ attempts: 2, failedAttempts: 1 });
    expect(evaluated.verdicts["h-t359-checks"]!["jev"]).toMatchObject({
      flagged: true,
      abstained: true,
    });
  }),
);

const reproduced = (
  retained: { readonly records: ReadonlyArray<unknown> },
  cases: typeof HELDOUT_CASES,
) =>
  JSON.parse(
    JSON.stringify(evaluate(cases, retained.records as never, referenceViews.agreed!).summary),
  );

it("keeps the held-out result tied to the code and corpus that made it and reproducible from its records", () => {
  expect(heldoutResults.corpusDigest).toBe(corpusDigest(HELDOUT_CASES));
  expect(heldoutResults.run.files).toEqual(runDigests());
  const keys = heldoutResults.records.map(
    (r: { caseId: string; engine: string }) => `${r.caseId}:${r.engine}`,
  );
  expect(new Set(keys).size).toBe(HELDOUT_CASES.length * 2);
  expect(reproduced(heldoutResults, HELDOUT_CASES)).toEqual(heldoutResults.summary);
});

it("keeps the tuning result tied to its corpus and reproducible from its records", () => {
  expect(tuneResults.corpusDigest).toBe(corpusDigest(TUNE_CASES));
  expect(tuneResults.run.files).toEqual(runDigests());
  expect(reproduced(tuneResults, TUNE_CASES)).toEqual(tuneResults.summary);
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
    caseId: "h-t359-checks",
    kind: "claim",
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

it("reproduces the adjudication score from the retained reply and keeps it to the held-out decisions", () => {
  const scored = scoreReply(adjudicationReply, adjudicationResults.replySha256);
  expect(scored).toEqual(JSON.parse(JSON.stringify(adjudicationResults)));
  expect(scored.rows).toHaveLength(HELDOUT_CASES.filter((c) => c.kind === "decision").length);
  expect(scored.heldoutCorpusDigest).toBe(corpusDigest(HELDOUT_CASES));
});
