// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the static corpus
import type { DecisionRequest, DecisionResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import { DecisionService } from "../../decisions/DecisionService.ts";
import { summarizeCost, type UsageRow } from "../semanticLint/scoring.ts";
import { claimBaseline, decisionBaseline } from "./baseline.ts";
import type { ScreenCase } from "./corpusTypes.ts";
import type { ReferenceFor } from "./labels.ts";
import { screenClaim, screenDecision, type EngineOutcome, type Screened } from "./policy.ts";
import { buildClaimRequest, buildDecisionRequest } from "./rule.ts";
import { summarizeClaims, summarizeDecisions, type Judgement } from "./scoring.ts";

export type Engine = DecisionRequest["engine"];

export interface CallRecord {
  readonly caseId: string;
  readonly kind: ScreenCase["kind"];
  readonly engine: Engine;
  readonly outcome: EngineOutcome;
  readonly requestedModel: string | null;
  readonly resolvedModel: string | null;
  readonly adapterVersion: string | null;
  readonly digest: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: string | null;
  readonly startedAt: string;
}

const questionId = (c: ScreenCase) => (c.kind === "claim" ? "claim" : "decision");

const outcomeOf = (c: ScreenCase, result: DecisionResult): EngineOutcome => {
  const answer = result.answers.find((a) => a.id === questionId(c));
  if (answer === undefined) return { kind: "unanswered", status: "no-choice" };
  if (answer.status !== "answered") return { kind: "unanswered", status: answer.status };
  if (answer.type !== "choice") return { kind: "unanswered", status: "no-choice" };
  return { kind: "answered", choice: answer.choice, probabilities: answer.probabilities };
};

/** One admitted call per case and engine, in order, with a fixed gap under the shared limit. No retry; every failure is a record. */
export const runEvaluation = Effect.fn("EvidenceScreening.runEvaluation")(function* (
  cases: ReadonlyArray<ScreenCase>,
  engines: ReadonlyArray<Engine>,
  options: {
    readonly gapMs: number;
    readonly onRecord?: (record: CallRecord) => void;
    readonly resumed?: ReadonlyArray<CallRecord> | undefined;
  },
) {
  const service = yield* DecisionService;
  const records: CallRecord[] = [];
  for (const c of cases) {
    for (const engine of engines) {
      const earlier = options.resumed?.find((r) => r.caseId === c.id && r.engine === engine);
      if (earlier !== undefined) {
        records.push(earlier);
        continue;
      }
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const request =
        c.kind === "claim" ? buildClaimRequest(engine, c) : buildDecisionRequest(engine, c);
      const record = yield* service.decide(request).pipe(
        Effect.map((result): CallRecord => ({
          caseId: c.id,
          kind: c.kind,
          engine,
          outcome: outcomeOf(c, result),
          requestedModel: result.requestedModel,
          resolvedModel: result.resolvedModel,
          adapterVersion: result.adapterVersion,
          digest: result.digest,
          latencyMs: result.latencyMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.cost.usd,
          costStatus: result.cost.status,
          startedAt,
        })),
        Effect.catchTags({
          DecisionError: (error) =>
            Effect.succeed<CallRecord>({
              caseId: c.id,
              kind: c.kind,
              engine,
              outcome: { kind: "failed", code: error.code },
              requestedModel: null,
              resolvedModel: null,
              adapterVersion: null,
              digest: null,
              latencyMs: null,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
              costStatus: null,
              startedAt,
            }),
        }),
      );
      records.push(record);
      options.onRecord?.(record);
      yield* Effect.sleep(Duration.millis(options.gapMs));
    }
  }
  return records;
});

interface Verdict {
  readonly label: string | null;
  readonly flagged: boolean;
  readonly abstained: boolean;
}

const fromScreen = (s: Screened): Verdict => ({
  label: s.argmax,
  flagged: s.flagged,
  abstained: s.reason === "failed" || s.reason === "abstained",
});

const claimFlag = (label: string | null) => label !== "supported";
const decisionFlag = (label: string | null) => label === "settled-consequential";

/** Every system's verdict on one case. Engines are screened by the declared policy; `-argmax` is the same engine without a floor. */
const verdicts = (c: ScreenCase, records: ReadonlyArray<CallRecord>): Record<string, Verdict> => {
  const out: Record<string, Verdict> = {};
  const baselineLabel =
    c.kind === "claim"
      ? claimBaseline(c.claim, c.evidence)
      : decisionBaseline(c.passage, c.existing);
  const baseline: Verdict = {
    label: baselineLabel,
    flagged: c.kind === "claim" ? claimFlag(baselineLabel) : decisionFlag(baselineLabel),
    abstained: false,
  };
  out.baseline = baseline;
  out.screenNothing = { label: null, flagged: false, abstained: false };
  out.screenEverything = { label: null, flagged: true, abstained: false };
  for (const engine of ["jev", "luna"] as const) {
    const outcome = records.find((r) => r.caseId === c.id && r.engine === engine)?.outcome;
    if (outcome === undefined) continue;
    const screened = c.kind === "claim" ? screenClaim(outcome) : screenDecision(outcome);
    const policy = fromScreen(screened);
    out[engine] = policy;
    out[`${engine}-argmax`] = {
      label: screened.argmax,
      flagged:
        outcome.kind !== "answered"
          ? true
          : c.kind === "claim"
            ? claimFlag(screened.argmax)
            : decisionFlag(screened.argmax),
      abstained: policy.abstained,
    };
    out[`${engine}+baseline`] = {
      label: policy.label,
      flagged: policy.flagged || baseline.flagged,
      abstained: policy.abstained,
    };
  }
  return out;
};

export const evaluate = (
  cases: ReadonlyArray<ScreenCase>,
  records: ReadonlyArray<CallRecord>,
  reference: ReferenceFor,
) => {
  const perCase = new Map(cases.map((c) => [c.id, verdicts(c, records)]));
  const systems = [...new Set([...perCase.values()].flatMap((v) => Object.keys(v)))].sort();
  const summary: Record<string, { claim: unknown; decision: unknown }> = {};
  for (const system of systems) {
    const judge = (kind: ScreenCase["kind"]): Judgement[] =>
      cases
        .filter((c) => c.kind === kind && perCase.get(c.id)![system] !== undefined)
        .map((c) => ({ caseId: c.id, reference: reference(c), ...perCase.get(c.id)![system]! }));
    summary[system] = {
      claim: summarizeClaims(judge("claim")),
      decision: summarizeDecisions(judge("decision")),
    };
  }
  const cost: Record<string, unknown> = {};
  for (const engine of [...new Set(records.map((r) => r.engine))].sort()) {
    const own = records.filter((r) => r.engine === engine);
    const rows: UsageRow[] = own.flatMap((r) =>
      r.latencyMs === null
        ? []
        : [
            {
              latencyMs: r.latencyMs,
              inputTokens: r.inputTokens,
              costUsd: r.costUsd,
              costStatus: r.costStatus ?? "unknown",
            },
          ],
    );
    const failed = own.filter((r) => r.outcome.kind === "failed");
    cost[engine] = {
      ...summarizeCost(rows, own.length - rows.length),
      attempts: own.length,
      failedAttempts: failed.length,
      failureCodes: failed.map((r) => `${r.caseId}:${(r.outcome as { code: string }).code}`),
      unanswered: own.filter((r) => r.outcome.kind === "unanswered").map((r) => r.caseId),
      outputTokensKnown: own.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      requestedModels: [...new Set(own.map((r) => r.requestedModel))],
      resolvedModels: [...new Set(own.map((r) => r.resolvedModel))],
    };
  }
  return {
    summary,
    cost,
    verdicts: Object.fromEntries(perCase),
  };
};

export const corpusDigest = (cases: ReadonlyArray<ScreenCase>): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(cases)).digest("hex");
