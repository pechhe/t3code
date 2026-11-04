import { expect, it } from "@effect/vitest";

import {
  resolveFreshTarget,
  type BoundedDecisionEngine,
  type Decision,
  type Observation,
  type ObservedElement,
} from "./decisionEngine.ts";
import {
  grade,
  runDecisionJourney,
  type BrowserDriver,
  type JourneyDefinition,
} from "./journeyRunner.ts";

const element = (name: string, locator: string): ObservedElement => ({
  index: "e1",
  locator,
  role: "button",
  name,
  operations: ["CLICK"],
});
const page = (url: string, name = "Go", locator = "aria-ref=1"): Observation => ({
  url,
  title: "t",
  text: "",
  elements: [element(name, locator)],
});

const journey: JourneyDefinition = {
  id: "j",
  category: "navigation",
  goal: "g",
  expected: "done",
  startPath: "/",
  fieldValues: {},
};

const scripted = (decisions: readonly Decision[]): BoundedDecisionEngine => {
  let next = 0;
  return {
    id: "scripted",
    requestedModel: "m",
    decide: async () => ({
      decision: decisions[Math.min(next++, decisions.length - 1)]!,
      confidence: 1,
      resolvedModel: "m-1",
      latencyMs: 1,
      usage: {
        inputTokens: 10,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: 0.5,
        costStatus: "estimated",
        requests: 1,
      },
      requestDigest: "d",
      adapterVersion: "a",
    }),
  };
};

const driverOver = (observe: () => Observation, log: string[]): BrowserDriver => ({
  observe: async () => observe(),
  click: async (target) => void log.push(`click ${target.locator}`),
  type: async () => void log.push("type"),
  select: async () => void log.push("select"),
  scrollDown: async () => void log.push("scroll"),
  settle: async () => undefined,
});

const options = { maxSteps: 6, maxStaleRetries: 1 };

it("executes a fresh choice with the current locator, then stops on DONE", async () => {
  const log: string[] = [];
  let snapshots = 0;
  const attempt = await runDecisionJourney(
    scripted([{ operation: "CLICK", target: "e1" }, { operation: "DONE" }]),
    driverOver(() => page("http://x/", "Go", `aria-ref=${++snapshots}`), log),
    journey,
    options,
  );
  expect(attempt.status).toBe("claimed-done");
  expect(log).toEqual(["click aria-ref=2"]);
  expect(attempt.usage).toMatchObject({ inputTokens: 20, costUsd: 1, requests: 2, unreported: 0 });
});

it("rejects a choice whose page changed before execution and executes nothing", async () => {
  const log: string[] = [];
  let calls = 0;
  const attempt = await runDecisionJourney(
    scripted([{ operation: "CLICK", target: "e1" }]),
    driverOver(() => page("http://x/", ++calls % 2 === 1 ? "Go" : "Stop"), log),
    journey,
    options,
  );
  expect(log).toEqual([]);
  expect(attempt.staleRejections).toBeGreaterThan(0);
  expect(attempt.status).toBe("error");
});

it("stops without acting once the caller cancels", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  const engine = scripted([{ operation: "CLICK", target: "e1" }]);
  const aborting: BoundedDecisionEngine = {
    ...engine,
    decide: async (request, signal) => {
      controller.abort();
      return engine.decide(request, signal);
    },
  };
  const attempt = await runDecisionJourney(
    aborting,
    driverOver(() => page("http://x/"), log),
    journey,
    {
      ...options,
      signal: controller.signal,
    },
  );
  expect(attempt.status).toBe("cancelled");
  expect(attempt.steps).toBeLessThanOrEqual(1);
  expect(log).toEqual([]);
});

it("ends in error after repeated engine refusals", async () => {
  const failing: BoundedDecisionEngine = {
    id: "f",
    requestedModel: "m",
    decide: async () => {
      throw new Error("Decision service failed: rate-limited; no action executed.");
    },
  };
  const attempt = await runDecisionJourney(
    failing,
    driverOver(() => page("http://x/"), []),
    journey,
    options,
  );
  expect(attempt.status).toBe("error");
  expect(attempt.refusals).toBe(3);
});

it("grades by independent fixture outcome, not by the claim", () => {
  const claimedDone = { status: "claimed-done" } as never;
  expect(grade(claimedDone, journey, { completed: true, forbiddenEffect: false })).toMatchObject({
    verifiedSuccess: true,
    falseCompletion: false,
  });
  expect(grade(claimedDone, journey, { completed: false, forbiddenEffect: false })).toMatchObject({
    verifiedSuccess: false,
    falseCompletion: true,
  });
  expect(grade(claimedDone, journey, { completed: true, forbiddenEffect: true })).toMatchObject({
    verifiedSuccess: false,
    falseCompletion: true,
  });
  const blocked = { ...journey, expected: "blocked" as const };
  expect(
    grade({ status: "claimed-blocked" } as never, blocked, {
      completed: false,
      forbiddenEffect: false,
    }).verifiedSuccess,
  ).toBe(true);
  expect(
    grade(claimedDone, blocked, { completed: false, forbiddenEffect: false }).falseCompletion,
  ).toBe(true);
});

it("records a cancelled attempt as cancelled even when the decision was DONE", async () => {
  const controller = new AbortController();
  const engine = scripted([{ operation: "DONE" }]);
  const aborting: BoundedDecisionEngine = {
    ...engine,
    decide: async (request, signal) => {
      controller.abort();
      return engine.decide(request, signal);
    },
  };
  const attempt = await runDecisionJourney(
    aborting,
    driverOver(() => page("http://x/"), []),
    journey,
    {
      ...options,
      signal: controller.signal,
    },
  );
  expect(attempt.status).toBe("cancelled");
});

it("rejects a select choice whose option index now means a different option", async () => {
  const withOptions = (labels: string[]): Observation => ({
    url: "http://x/",
    title: "t",
    text: "",
    elements: [
      {
        index: "e1",
        locator: "aria-ref=1",
        role: "combobox",
        name: "Plan",
        operations: ["SELECT"],
        options: labels.map((label, position) => ({ index: `e1_${position + 1}`, label })),
      },
    ],
  });
  const decision = { operation: "SELECT", target: "e1_2" } as const;
  expect(
    resolveFreshTarget(decision, withOptions(["Free", "Team"]), withOptions(["Free", "Team"])),
  ).toBeDefined();
  expect(
    resolveFreshTarget(
      decision,
      withOptions(["Free", "Team"]),
      withOptions(["Free", "Enterprise"]),
    ),
  ).toBeUndefined();
});
