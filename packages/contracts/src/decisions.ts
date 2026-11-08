import * as Schema from "effect/Schema";

export const DECISION_LIMITS = {
  inputBytes: 128 * 1024,
  questions: 32,
  choices: 64,
  responseBytes: 1024 * 1024,
  deadlineMs: 20_000,
  /** About half of what the provider answered without refusal on 8 Nov 2026 (T3-465): 256 at once, 36,000 a minute. */
  concurrent: 128,
  perMinute: 18_000,
  /** How long a call over either limit waits for room before it fails. */
  admissionWaitMs: 5_000,
} as const;
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const option = Schema.Struct({ label: id, description: text });
export const DecisionQuestion = Schema.Union([
  Schema.Struct({ id, type: Schema.Literal("predicate"), instructions: text }),
  Schema.Struct({
    id,
    type: Schema.Literal("choice"),
    instructions: text,
    choices: Schema.Array(option).check(Schema.isMinLength(2), Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    id,
    type: Schema.Literal("score"),
    instructions: text,
    levels: Schema.Array(option).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  }),
]);
export type DecisionQuestion = typeof DecisionQuestion.Type;
export const DecisionRequest = Schema.Struct({
  engine: Schema.Literals(["jev", "luna"]),
  rule: Schema.Struct({ id: text, version: text }),
  evidence: Schema.Union([Schema.String, Schema.JsonObject, Schema.Array(Schema.Json)]),
  questions: Schema.Array(DecisionQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DecisionRequest = typeof DecisionRequest.Type;
const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const DecisionAnswer = Schema.Union([
  Schema.Struct({ id, status: Schema.Literals(["unknown", "refusal"]) }),
  Schema.Struct({
    id,
    status: Schema.Literal("answered"),
    type: Schema.Literal("predicate"),
    probability,
  }),
  Schema.Struct({
    id,
    status: Schema.Literal("answered"),
    type: Schema.Literal("choice"),
    choice: id,
    selectedChoiceProbability: probability,
    probabilities: Schema.Record(Schema.String, probability),
    confidence: Schema.optional(probability),
  }),
  Schema.Struct({
    id,
    status: Schema.Literal("answered"),
    type: Schema.Literal("score"),
    score: Schema.Finite,
    minimum: Schema.Int,
    maximum: Schema.Int,
    levels: Schema.Array(option),
    probabilities: Schema.Record(Schema.String, probability),
    confidence: Schema.optional(probability),
  }),
]);
export type DecisionAnswer = typeof DecisionAnswer.Type;
export const DecisionFailureCode = Schema.Literals([
  "invalid-input",
  "unavailable",
  "invalid-provider-response",
  "transport-error",
  "cancelled",
  "timeout",
  "busy",
  "rate-limited",
]);
export class DecisionError extends Schema.TaggedError<DecisionError>()("DecisionError", {
  code: DecisionFailureCode,
}) {
  override get message() {
    return `Decision request failed: ${this.code}.`;
  }
}
const count = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
export const DecisionResult = Schema.Struct({
  engine: DecisionRequest.fields.engine,
  requestedModel: Schema.String,
  resolvedModel: Schema.NullOr(Schema.String),
  adapterVersion: Schema.String,
  rule: DecisionRequest.fields.rule,
  digest: Schema.String,
  digestVersion: Schema.Literal("sha256-canonical-json-v1"),
  latencyMs: Schema.Number,
  usage: Schema.Struct({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count,
    cacheWriteTokens: count,
  }),
  cost: Schema.Struct({
    usd: Schema.NullOr(Schema.Number),
    status: Schema.Literals(["estimated", "upper-bound", "unknown"]),
    pricingSource: Schema.String,
    inputUsdPerMillion: Schema.Number,
  }),
  answers: Schema.Array(DecisionAnswer),
});
export type DecisionResult = typeof DecisionResult.Type;
