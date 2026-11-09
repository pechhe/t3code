import * as Schema from "effect/Schema";

import { DecisionRequest, DecisionResult } from "./decisions.ts";

export const DecisionProvider = Schema.Literals(["jev", "openai", "openrouter"]);
export type DecisionProvider = typeof DecisionProvider.Type;

export const DECISION_PROVIDERS = DecisionProvider.literals;
export const DEFAULT_DECISION_PROVIDER: DecisionProvider = "jev";
export const DEFAULT_OPENROUTER_DECISION_MODEL = "~typesafe/jev-latest";

export const DECISION_PROVIDER_LABELS: Readonly<Record<DecisionProvider, string>> = {
  jev: "Jev (TypeSafe)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export const DecisionOpenRouterModel = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9~][A-Za-z0-9._~:/-]{0,127}$/),
);

/** A decision request without an engine: the environment's setting decides which provider answers. */
export const DecisionRoutingRequest = Schema.Struct({
  rule: DecisionRequest.fields.rule,
  evidence: DecisionRequest.fields.evidence,
  questions: DecisionRequest.fields.questions,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type DecisionRoutingRequest = typeof DecisionRoutingRequest.Type;

export const DecisionRoutingFailureCode = Schema.Literals([
  "invalid-input",
  "engine-not-accepted",
  "key-missing",
  "key-unreadable",
  "key-rejected",
  "credits-exhausted",
  "rate-limited",
  "timeout",
  "unreachable",
  "invalid-provider-response",
  "busy",
  "cancelled",
]);
export type DecisionRoutingFailureCode = typeof DecisionRoutingFailureCode.Type;

const FAILURE_CAUSE: Readonly<Record<DecisionRoutingFailureCode, string>> = {
  "invalid-input": "the request was not valid",
  "engine-not-accepted":
    "the Decisions setting now decides the provider, so a request must not name an engine",
  "key-missing": "no API key is set",
  "key-unreadable": "the saved key reference could not be read",
  "key-rejected": "the key was rejected, so check that it is current",
  "credits-exhausted": "the account is out of credits",
  "rate-limited": "it is rate limiting this account",
  timeout: "it did not answer in time",
  unreachable: "the server could not reach it",
  "invalid-provider-response": "it returned an answer that does not match the request",
  busy: "this server has too many decisions in flight",
  cancelled: "the request was cancelled",
};

/** A failure that names the provider and the likely cause, so a user knows whether to fix a key or switch. */
export class DecisionRoutingError extends Schema.TaggedError<DecisionRoutingError>()(
  "DecisionRoutingError",
  { provider: DecisionProvider, code: DecisionRoutingFailureCode },
) {
  override get message() {
    return `Decisions through ${DECISION_PROVIDER_LABELS[this.provider]} failed: ${FAILURE_CAUSE[this.code]}.`;
  }
}

const { engine: _engine, ...routedResultFields } = DecisionResult.fields;
export const DecisionRoutedResult = Schema.Struct({
  ...routedResultFields,
  provider: DecisionProvider,
  cost: Schema.Struct({
    ...DecisionResult.fields.cost.fields,
    status: Schema.Literals(["estimated", "upper-bound", "unknown", "reported"]),
    inputUsdPerMillion: Schema.NullOr(Schema.Number),
  }),
});
export type DecisionRoutedResult = typeof DecisionRoutedResult.Type;

/** Where an environment's key for a provider comes from; never the key itself. */
export const DecisionKeySource = Schema.Literals([
  "setting",
  "reference",
  "server-environment",
  "bitwarden",
  "none",
]);
export type DecisionKeySource = typeof DecisionKeySource.Type;

export const DecisionKeyStatus = Schema.Struct({
  source: DecisionKeySource,
  last4: Schema.NullOr(Schema.String),
});
export type DecisionKeyStatus = typeof DecisionKeyStatus.Type;

export const DecisionStatus = Schema.Struct({
  provider: DecisionProvider,
  model: Schema.String,
  keys: Schema.Struct({
    jev: DecisionKeyStatus,
    openai: DecisionKeyStatus,
    openrouter: DecisionKeyStatus,
  }),
});
export type DecisionStatus = typeof DecisionStatus.Type;

export const DecisionTestResult = Schema.Struct({
  provider: DecisionProvider,
  model: Schema.String,
  ok: Schema.Boolean,
  failure: Schema.optionalKey(DecisionRoutingFailureCode),
  latencyMs: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
  inputTokens: Schema.NullOr(Schema.Int),
});
export type DecisionTestResult = typeof DecisionTestResult.Type;
