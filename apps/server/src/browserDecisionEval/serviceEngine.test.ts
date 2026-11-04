import { expect, it } from "@effect/vitest";
import type { DecisionResult } from "@t3tools/contracts";

import { EngineRefusal, type Observation } from "./decisionEngine.ts";
import { buildDecisionRequest, makeServiceEngine, type DecisionClient } from "./serviceEngine.ts";

const observation: Observation = {
  url: "http://localhost:3100/",
  title: "Page",
  text: "Welcome",
  elements: [
    { index: "e1", locator: "aria-ref=a", role: "link", name: "Pricing", operations: ["CLICK"] },
    { index: "e2", locator: "aria-ref=b", role: "button", name: "Go", operations: ["CLICK"] },
    {
      index: "e3",
      locator: "aria-ref=c",
      role: "textbox",
      name: "Email",
      operations: ["TYPE_TEXT"],
    },
  ],
};

const choice = (id: string, picked: string, labels: readonly string[]) => ({
  id,
  status: "answered" as const,
  type: "choice" as const,
  choice: picked,
  selectedChoiceProbability: 0.9,
  probabilities: Object.fromEntries(
    labels.map((label) => [label, label === picked ? 0.9 : 0.1 / (labels.length - 1)]),
  ),
});

const result = (answers: DecisionResult["answers"]): DecisionResult => ({
  engine: "jev",
  requestedModel: "jev-1.14.0",
  resolvedModel: "jev-1.14.0",
  adapterVersion: "t3-decisions-v1",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 12,
  usage: { inputTokens: 100, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null },
  cost: { usd: 0.0001, status: "estimated", pricingSource: "x", inputUsdPerMillion: 0.042 },
  answers,
});

const operations = ["CLICK", "TYPE_TEXT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"];

it("asks the operation and every multi-target operation in one batch, never exposing locators", () => {
  const { request, targetQuestions } = buildDecisionRequest("luna", {
    goal: "Open pricing",
    observation,
    history: [],
  });
  expect(request.engine).toBe("luna");
  expect(request.questions.map((question) => question.id)).toEqual(["operation", "click_target"]);
  expect(targetQuestions.map((question) => question.operation)).toEqual(["CLICK"]);
  expect(JSON.stringify(request)).not.toContain("aria-ref");
});

it("resolves a lone valid target locally and passes the engine's pick otherwise", async () => {
  const click: DecisionClient = async () =>
    result([choice("operation", "CLICK", operations), choice("click_target", "e2", ["e1", "e2"])]);
  const decided = await makeServiceEngine("jev", click).decide({
    goal: "g",
    observation,
    history: [],
  });
  expect(decided.decision).toEqual({ operation: "CLICK", target: "e2" });
  expect(decided.usage).toMatchObject({ inputTokens: 100, outputTokens: null, costUsd: 0.0001 });

  const type: DecisionClient = async () => result([choice("operation", "TYPE_TEXT", operations)]);
  const typed = await makeServiceEngine("jev", type).decide({
    goal: "g",
    observation,
    history: [],
  });
  expect(typed.decision).toEqual({ operation: "TYPE_TEXT", target: "e3" });
});

it("refuses refused, unanswered, non-offered and failed answers instead of acting", async () => {
  const decide = (client: DecisionClient) =>
    makeServiceEngine("jev", client).decide({ goal: "g", observation, history: [] });
  await expect(
    decide(async () => result([{ id: "operation", status: "refusal" }])),
  ).rejects.toBeInstanceOf(EngineRefusal);
  await expect(decide(async () => result([]))).rejects.toBeInstanceOf(EngineRefusal);
  await expect(
    decide(async () => result([choice("operation", "SELECT", [...operations, "SELECT"])])),
  ).rejects.toBeInstanceOf(EngineRefusal);
  await expect(
    decide(async () =>
      result([
        choice("operation", "CLICK", operations),
        choice("click_target", "e9", ["e1", "e2", "e9"]),
      ]),
    ),
  ).rejects.toBeInstanceOf(EngineRefusal);
  await expect(
    decide(async () => {
      throw Object.assign(new Error("x"), { code: "rate-limited" });
    }),
  ).rejects.toThrow(/rate-limited/);
});
