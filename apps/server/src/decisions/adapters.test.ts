import { expect, it } from "@effect/vitest";
import { DecisionError } from "@t3tools/contracts";
import { decodeResponse, encodeRequest, parseProviderJson } from "./adapters.ts";
import responses from "./responses.test-fixture.json" with { type: "json" };

import { request } from "./decisions.testkit.ts";
const lunaAnswers = responses[1]!.answers as Array<Record<string, unknown>>;
it.each(["jev", "luna"] as const)("preserves actual mixed %s response semantics", (engine) => {
  const result = decodeResponse(request(engine), responses[engine === "jev" ? 0 : 1]);
  expect(result.answers).toHaveLength(3);
  expect(result.answers[0]).toMatchObject({ probability: engine === "jev" ? 0.64 : 0 });
  expect(result.answers[1]).toMatchObject({
    choice: "export",
    selectedChoiceProbability: 1,
    confidence: 1,
  });
  expect(result.answers[2]).toMatchObject({
    score: engine === "jev" ? 1.01 : 0.98,
    minimum: 0,
    maximum: 2,
  });
  expect(result.cost.status).toBe("estimated");
});
it("maps OpenAI probability to predicate and Jev to noul", () => {
  expect(encodeRequest(request("luna"))).toMatchObject({
    model: "gpt-6-luna",
    questions: [{ name: "workaround", type: "predicate" }, {}, {}],
  });
  expect(encodeRequest(request())).toMatchObject({
    model: "jev-1.14.0",
    questions: { workaround: { type: "noul" } },
  });
});
it.each([
  { answers: [] },
  { answers: [...lunaAnswers, { type: "predicate", name: "extra", probability: 1 }] },
  { answers: [lunaAnswers[0], lunaAnswers[0], lunaAnswers[2]] },
  { answers: [{ type: "predicate", name: "workaround", probability: 2 }, ...lunaAnswers.slice(1)] },
  { answers: [lunaAnswers[0], { ...lunaAnswers[1], choice: "guessed" }, lunaAnswers[2]] },
  { answers: [lunaAnswers[0], lunaAnswers[1], { ...lunaAnswers[2], score: NaN }] },
  { answers: [lunaAnswers[0], lunaAnswers[1], { ...lunaAnswers[2], confidence: -1 }] },
  {
    answers: [
      lunaAnswers[0],
      lunaAnswers[1],
      { ...lunaAnswers[2], probabilities: [{ value: 0, probability: 1 }] },
    ],
  },
])("invalidates the whole batch for malformed correspondence or domains", (response) => {
  expect(() => decodeResponse(request("luna"), response)).toThrow(DecisionError);
});
it("retains a valid per-question refusal and unknown usage", () => {
  const result = decodeResponse(request("luna"), {
    answers: [{ type: "refusal", name: "workaround" }, ...lunaAnswers.slice(1)],
  });
  expect(result.answers[0]).toEqual({ id: "workaround", status: "refusal" });
  expect(result.usage.inputTokens).toBeNull();
  expect(result.cost).toMatchObject({ usd: null, status: "unknown" });
});
it("does not guess token aliases or cache write prices", () => {
  const base = { answers: lunaAnswers };
  expect(
    decodeResponse(request("luna"), { ...base, usage: { prompt_tokens: 20 } }).usage.inputTokens,
  ).toBeNull();
  expect(
    decodeResponse(request("luna"), { ...base, usage: { input_tokens: 20 } }).cost.status,
  ).toBe("unknown");
  expect(
    decodeResponse(request("luna"), {
      ...base,
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      },
    }).cost.status,
  ).toBe("upper-bound");
});
it("rejects duplicate JSON object keys even when escaped", () => {
  expect(() => parseProviderJson('{"answers":{"x":{},"\\u0078":{}}}')).toThrow(DecisionError);
  expect(parseProviderJson('{"x":[{"x":1},{"x":2}],"y":"a:b"}')).toEqual({
    x: [{ x: 1 }, { x: 2 }],
    y: "a:b",
  });
});
