import { DecisionError, type DecisionAnswer, type DecisionRequest } from "@t3tools/contracts";
import * as Decision from "effect/ai/Decision";
import * as Predicate from "effect/Predicate";

export const ADAPTER_VERSION = "t3-decisions-v1";
export const engines = {
  jev: {
    model: "jev-1.14.0",
    url: "https://api.typesafe.ai/v1/systemone",
    price: 0.042,
    pricingSource: "https://docs.typesafe.ai/models",
  },
  luna: {
    model: "gpt-6-luna",
    url: "https://api.openai.com/v1/decisions",
    price: 0.1,
    pricingSource: "https://developers.openai.com/api/docs/guides/decisions",
  },
} as const;

export function encodeRequest(input: DecisionRequest) {
  const questions = input.questions.map((q) => {
    const decision =
      q.type === "predicate"
        ? Decision.probability({ instructions: q.instructions })
        : q.type === "choice"
          ? Decision.classify({
              instructions: q.instructions,
              criteria: Object.fromEntries(q.choices.map((c) => [c.label, c.description])),
            })
          : Decision.rate({ instructions: q.instructions, criteria: q.levels });
    switch (decision._tag) {
      case "Probability":
        return {
          name: q.id,
          type: input.engine === "jev" ? "noul" : "predicate",
          instructions: decision.instructions,
        };
      case "Classify":
        return input.engine === "jev"
          ? {
              name: q.id,
              type: "choice",
              instructions: decision.instructions,
              criteria: decision.criteria,
            }
          : {
              name: q.id,
              type: "choice",
              instructions: decision.instructions,
              choices: Object.entries(decision.criteria).map(([value, description]) => ({
                value,
                description,
              })),
            };
      case "Rate":
        return input.engine === "jev"
          ? {
              name: q.id,
              type: "score",
              instructions: decision.instructions,
              criteria: decision.criteria.map((l) => l.description),
            }
          : {
              name: q.id,
              type: "score",
              instructions: decision.instructions,
              levels: decision.criteria,
            };
    }
  });
  return input.engine === "jev"
    ? {
        model: engines.jev.model,
        state: input.evidence,
        questions: Object.fromEntries(questions.map(({ name, ...q }) => [name, q])),
      }
    : {
        model: engines.luna.model,
        input: typeof input.evidence === "string" ? input.evidence : JSON.stringify(input.evidence),
        questions,
        prompt_cache_options: { mode: "explicit" },
      };
}
const invalid = (): never => {
  throw new DecisionError({ code: "invalid-provider-response" });
};
const record = (v: unknown): Record<string, unknown> =>
  Predicate.isObject(v) && !Array.isArray(v) ? (v as Record<string, unknown>) : invalid();
const unit = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : invalid();
const tokenCount = (v: unknown): number | null =>
  v === undefined || v === null
    ? null
    : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
      ? v
      : invalid();
function exact(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((k) => !expected.includes(k))
  )
    invalid();
}

// JSON.parse discards duplicate object keys, including Jev question IDs.
export function parseProviderJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g);
  for (const token of tokens) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else if (
      token[0].startsWith('"') &&
      text
        .slice(token.index + token[0].length)
        .trimStart()
        .startsWith(":")
    ) {
      const key: string = JSON.parse(token[0]);
      const keys = stack.at(-1);
      if (keys?.has(key)) invalid();
      keys?.add(key);
    }
  }
  return value;
}

export function decodeResponse(input: DecisionRequest, raw: unknown) {
  const body = record(raw);
  const entries: Array<[string, unknown]> =
    input.engine === "jev"
      ? Object.entries(record(body.answers))
      : Array.isArray(body.answers)
        ? body.answers.map((a) => {
            const answer = record(a);
            return [typeof answer.name === "string" ? answer.name : invalid(), answer];
          })
        : invalid();
  exact(
    entries.map(([name]) => name),
    input.questions.map((q) => q.id),
  );
  const answers: DecisionAnswer[] = input.questions.map((q) => {
    const a = record(entries.find(([id]) => id === q.id)![1]);
    // Only OpenAI documents a refusal answer; Jev has no refusal/unknown wire variant.
    if (input.engine === "luna" && a.type === "refusal") return { id: q.id, status: "refusal" };
    if (q.type === "predicate") {
      if (a.type !== (input.engine === "jev" ? "noul" : "predicate")) invalid();
      return {
        id: q.id,
        status: "answered",
        type: "predicate",
        probability: unit(input.engine === "jev" ? a.noul : a.probability),
      };
    }
    if (a.type !== q.type) invalid();
    const labels =
      q.type === "choice" ? q.choices.map((c) => c.label) : q.levels.map((_, i) => String(i));
    const pairs: Array<[string, number]> =
      input.engine === "jev"
        ? Object.entries(record(a.probabilities)).map(([k, v]) => [k, unit(v)])
        : Array.isArray(a.probabilities)
          ? a.probabilities.map((p) => {
              const item = record(p);
              const key =
                q.type === "choice"
                  ? typeof item.value === "string"
                    ? item.value
                    : invalid()
                  : typeof item.value === "number" && Number.isInteger(item.value)
                    ? String(item.value)
                    : invalid();
              if (
                q.type === "score" &&
                item.label !== undefined &&
                item.label !== q.levels[Number(key)]?.label
              )
                invalid();
              return [key, unit(item.probability)];
            })
          : invalid();
    exact(
      pairs.map(([k]) => k),
      labels,
    );
    const sum = pairs.reduce((s, [, p]) => s + p, 0);
    if (sum === 0 || Math.abs(sum - 1) > labels.length * 0.005 + 1e-6) invalid();
    const probabilities = Object.fromEntries(pairs);
    const confidence =
      a.confidence === undefined || a.confidence === null ? {} : { confidence: unit(a.confidence) };
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !labels.includes(a.choice)) invalid();
      return {
        id: q.id,
        status: "answered",
        type: "choice",
        choice: a.choice as string,
        selectedChoiceProbability: probabilities[a.choice as string]!,
        probabilities,
        ...confidence,
      };
    }
    if (input.engine === "jev" && a.legend !== undefined) {
      const legend = record(a.legend);
      exact(Object.keys(legend), labels);
      if (q.levels.some((level, index) => legend[String(index)] !== level.description)) invalid();
    }
    if (
      typeof a.score !== "number" ||
      !Number.isFinite(a.score) ||
      a.score < 0 ||
      a.score > q.levels.length - 1
    )
      invalid();
    return {
      id: q.id,
      status: "answered",
      type: "score",
      score: a.score as number,
      minimum: 0,
      maximum: q.levels.length - 1,
      levels: q.levels,
      probabilities,
      ...confidence,
    };
  });
  const usage = body.usage === undefined || body.usage === null ? {} : record(body.usage);
  const details =
    usage.input_tokens_details === undefined || usage.input_tokens_details === null
      ? {}
      : record(usage.input_tokens_details);
  const counts = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cachedInputTokens: input.engine === "luna" ? tokenCount(details.cached_tokens) : null,
    cacheWriteTokens: input.engine === "luna" ? tokenCount(details.cache_write_tokens) : null,
  };
  if (
    counts.inputTokens !== null &&
    (counts.cachedInputTokens ?? 0) + (counts.cacheWriteTokens ?? 0) > counts.inputTokens
  )
    invalid();
  const cachedUnknown =
    input.engine === "luna" &&
    (counts.cachedInputTokens === null || counts.cacheWriteTokens === null);
  const cacheWriteUnknown =
    input.engine === "luna" && (counts.cacheWriteTokens === null || counts.cacheWriteTokens > 0);
  const engine = engines[input.engine];
  return {
    answers,
    resolvedModel:
      body.model === undefined
        ? null
        : typeof body.model === "string" && body.model.length <= 128
          ? body.model
          : invalid(),
    usage: counts,
    cost: {
      usd:
        counts.inputTokens === null || cacheWriteUnknown
          ? null
          : (counts.inputTokens * engine.price) / 1_000_000,
      status:
        counts.inputTokens === null || cacheWriteUnknown
          ? ("unknown" as const)
          : cachedUnknown || (counts.cachedInputTokens ?? 0) > 0
            ? ("upper-bound" as const)
            : ("estimated" as const),
      pricingSource: engine.pricingSource,
      inputUsdPerMillion: engine.price,
    },
  };
}
