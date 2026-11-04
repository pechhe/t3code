import { describe, expect, it } from "@effect/vitest";

import { budgetLandingTests, type LandingTest } from "../../test-landing.ts";
import { applyMutation, mutationsOf, sampleMutations } from "./mutate.ts";
import {
  baselineSelection,
  measure,
  oracleSelection,
  randomSelection,
  semanticSelection,
  type BudgetInput,
} from "./select.ts";

const test = (name: string, directory = "pkg"): LandingTest => ({
  directory,
  file: `${directory}/${name}.test.ts`,
});
const far = Array.from({ length: 30 }, (_, i) => `far${String(i + 1).padStart(2, "0")}`);
const names = ["changed", "importer", "named", "beside", ...far];
const candidates = names.map((n) => test(n));
const durations = Object.fromEntries(candidates.map((t, i) => [t.file, i < 4 ? 3 : 4]));
const change = { changed: ["pkg/changed.test.ts", "pkg/named.ts"], deleted: [] };
const gate = (budget: number) =>
  budgetLandingTests(candidates, change.changed, durations, budget, {
    imports: (file) => (file === "pkg/importer.test.ts" ? ["pkg/named"] : []),
  });

const input = (budget: number): BudgetInput => {
  const all = gate(Number.POSITIVE_INFINITY);
  return {
    candidates,
    gateOrder: all.selected,
    mandatory: all.mandatory,
    durations,
    budgetSeconds: budget,
  };
};

describe("test selection arms", () => {
  it("baseline reproduces the gate's budgeted selection at every budget", () => {
    for (const budget of [6, 9, 12, 20, 60]) {
      const expected = gate(budget);
      const actual = baselineSelection(input(budget));
      expect(actual.selected.map((t) => t.file)).toEqual(expected.selected.map((t) => t.file));
      expect(actual.deferred.map((t) => t.file)).toEqual(expected.deferred.map((t) => t.file));
    }
  });

  it("never reorders or defers the mandatory ranks, whatever the scores say", () => {
    const scores = new Map(candidates.map((t) => [t.file, 0]));
    const selection = semanticSelection(input(0), scores);
    const mandatory = gate(Number.POSITIVE_INFINITY).selected.slice(0, input(0).mandatory);
    expect(selection.selected).toEqual(mandatory);
  });

  it("promotes a relevant deferred test ahead of cheaper irrelevant ones", () => {
    const base = baselineSelection(input(12));
    expect(base.deferred.map((t) => t.file)).toContain("pkg/far30.test.ts");
    const scores = new Map<string, number | undefined>([
      ["pkg/far30.test.ts", 0.95],
      ["pkg/far01.test.ts", 0.1],
    ]);
    const semantic = semanticSelection(input(12), scores);
    expect(semantic.selected.map((t) => t.file)).toContain("pkg/far30.test.ts");
    const failing = new Set(["pkg/far30.test.ts"]);
    expect(measure(base, input(12), failing, new Set()).missed).toEqual(["pkg/far30.test.ts"]);
    expect(measure(semantic, input(12), failing, new Set()).missed).toEqual([]);
  });

  it("treats an abstention as neutral, ordering it between relevant and irrelevant", () => {
    const scores = new Map<string, number | undefined>([
      ["pkg/far01.test.ts", 0.1],
      ["pkg/far02.test.ts", undefined],
      ["pkg/far03.test.ts", 0.9],
    ]);
    const order = semanticSelection(input(1000), scores).selected.map((t) => t.file);
    const at = (name: string) => order.indexOf(`pkg/${name}.test.ts`);
    expect(at("far03")).toBeLessThan(at("far02"));
    expect(at("far02")).toBeLessThan(at("far01"));
  });

  it("oracle upper-bounds and a seeded random control is reproducible", () => {
    const failing = new Set(["pkg/far30.test.ts"]);
    expect(measure(oracleSelection(input(12), failing), input(12), failing, new Set()).caught).toBe(
      1,
    );
    const a = randomSelection(input(12), 7).selected.map((t) => t.file);
    expect(randomSelection(input(12), 7).selected.map((t) => t.file)).toEqual(a);
  });
});

describe("label honesty", () => {
  it("counts only verified-green tests as spent on passing and reports the rest as unknown", () => {
    const failing = new Set(["pkg/far30.test.ts"]);
    const passing = new Set(["pkg/far01.test.ts", "pkg/far02.test.ts"]);
    const metrics = measure(baselineSelection(input(1000)), input(1000), failing, passing);
    expect(metrics.spentOnPassing).toBe(2);
    expect(metrics.spentOnUnknown).toBe(metrics.optionalSelected - 3);
  });
});

describe("mutation", () => {
  const source = [
    "export const a = (x: number) => {",
    "  if (x === 3 && x > 1) return true;",
    "  return false;",
    "};",
  ].join("\n");
  it("proposes only syntactically valid single-line changes and applies them reversibly", () => {
    const all = mutationsOf("a.ts", source);
    expect(all.length).toBeGreaterThan(2);
    const mutation = all.find((m) => m.operator === "strict-equality")!;
    const mutated = applyMutation(source, mutation);
    expect(mutated).toContain("x !== 3");
    expect(() => applyMutation(mutated, mutation)).toThrow();
  });
  it("samples reproducibly from a seed", () => {
    const all = mutationsOf("a.ts", source);
    expect(sampleMutations(all, 2, 5)).toEqual(sampleMutations(all, 2, 5));
  });
});
