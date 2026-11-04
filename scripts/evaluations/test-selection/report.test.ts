import { describe, expect, it } from "@effect/vitest";

import { buildRequest, CHUNK } from "./prompt.ts";
import { scoresFrom, separation, summarise, evaluate } from "./report.ts";
import { splitFiles } from "./split.ts";
import { mergeControls } from "./verify-controls.ts";
import type { CallRecord, CaseFile } from "./run.ts";

const files = Array.from({ length: 12 }, (_, i) => `pkg/t${String(i).padStart(2, "0")}.test.ts`);
const testCase: CaseFile = {
  id: "c1",
  kind: "seeded",
  changed: ["pkg/m.ts"],
  hunk: "-a\n+b",
  candidates: files.map((file) => ({ directory: "pkg", file })),
  failing: ["pkg/t11.test.ts"],
  verifiedPassing: files.filter((f) => f !== "pkg/t11.test.ts" && f !== "pkg/t10.test.ts"),
};
const durations = Object.fromEntries(files.map((f) => [f, 4]));
const records = (scoreFor: (file: string) => number | undefined): CallRecord[] => [
  {
    caseId: "c1",
    engine: "jev",
    rule: "v1",
    chunk: 0,
    questions: 12,
    wallMs: 1,
    answers: files.map((file) => ({
      file,
      status: scoreFor(file) === undefined ? "refusal" : "answered",
      ...(scoreFor(file) === undefined ? {} : { probability: scoreFor(file)! }),
    })),
  },
];

describe("request building", () => {
  it("asks one uniquely identified predicate per test and stays inside the service's question bound", () => {
    const items = files.map((file) => ({ file, rank: 2, seconds: 3 }));
    const request = buildRequest("luna", "v1", { files: ["pkg/m.ts"], diff: "-a\n+b" }, items);
    expect(request.questions.length).toBeLessThanOrEqual(CHUNK);
    expect(new Set(request.questions.map((q) => q.id)).size).toBe(items.length);
    expect(request.questions.every((q) => q.type === "predicate")).toBe(true);
    expect(JSON.parse(request.evidence).tests).toHaveLength(items.length);
  });
});

describe("report", () => {
  it("reads an abstention as unscored, never as relevance", () => {
    const scores = scoresFrom(
      records((f) => (f === "pkg/t11.test.ts" ? undefined : 0.2)),
      "c1",
      "jev",
    );
    expect(scores.get("pkg/t11.test.ts")).toBeUndefined();
    expect(scores.get("pkg/t00.test.ts")).toBe(0.2);
  });

  it("measures ranking quality only over scored candidates and counts abstentions", () => {
    const good = separation(
      [testCase],
      [{ rule: "v1", records: records((f) => (f === "pkg/t11.test.ts" ? 0.9 : 0.1)) }],
      durations,
    );
    expect(good.find((r) => r.arm === "jev-v1")?.auc).toBe(1);
    const abstained = separation(
      [testCase],
      [{ rule: "v1", records: records((f) => (f === "pkg/t11.test.ts" ? undefined : 0.1)) }],
      durations,
    );
    expect(abstained.find((r) => r.arm === "jev-v1")).toMatchObject({ auc: null, abstained: 1 });
  });

  it("leaves unknown outcomes out of the pairwise ranking", () => {
    const only = separation(
      [testCase],
      [
        {
          rule: "v1",
          records: records((f) =>
            f === "pkg/t11.test.ts" ? 0.9 : f === "pkg/t10.test.ts" ? 0.99 : 0.1,
          ),
        },
      ],
      durations,
    );
    // t10 is unknown (neither failing nor verified green): it must not count as a passing loss.
    expect(only.find((r) => r.arm === "jev-v1")?.auc).toBe(1);
  });

  it("shows a semantic arm catching a failure the gate's order defers once the budget binds", () => {
    const rows = evaluate(
      [testCase],
      [{ rule: "v1", records: records((f) => (f === "pkg/t11.test.ts" ? 0.9 : 0.1)) }],
      durations,
    );
    const at = (arm: string, budget: number) =>
      rows.find((r) => r.arm === arm && r.budget === budget)!;
    expect(at("baseline", 10).metrics.missed).toEqual(["pkg/t11.test.ts"]);
    expect(at("jev-v1", 10).metrics.missed).toEqual([]);
    expect(at("oracle", 10).metrics.missed).toEqual([]);
    expect(summarise(rows).find((r) => r.arm === "baseline" && r.budget === 10)?.missed).toBe(1);
  });
});

describe("split", () => {
  it("assigns whole files by hash alone and keeps hub files held out", () => {
    const names = [
      "a/x.ts",
      "a/y.ts",
      "a/z.ts",
      "b/AgentRoleResolver.ts",
      "b/q.ts",
      "b/r.ts",
      "b/s.ts",
    ];
    const assign = splitFiles(names);
    expect(assign("b/AgentRoleResolver.ts")).toBe("heldout");
    expect(names.map(assign)).toEqual(names.map(splitFiles(names.toReversed())));
    expect(names.filter((n) => assign(n) === "tuning").length).toBeGreaterThan(0);
  });
});

describe("retained controls", () => {
  it("adds later verification to earlier evidence instead of replacing it", () => {
    const earlier = {
      requested: ["a.test.ts"],
      results: { "a.test.ts": { status: "passed", seconds: 1 } },
      exitCodes: { "apps/server": 0 },
      wallSeconds: 10,
    };
    const merged = mergeControls(earlier, {
      requested: ["b.test.ts"],
      results: { "b.test.ts": { status: "passed", seconds: 2 } },
      exitCodes: { "packages/shared": 0 },
      wallSeconds: 5,
    });
    expect(merged.requested).toEqual(["a.test.ts", "b.test.ts"]);
    expect(Object.keys(merged.results)).toEqual(["a.test.ts", "b.test.ts"]);
    expect(merged.exitCodes).toEqual({ "apps/server": 0, "packages/shared": 0 });
    expect(mergeControls(undefined, earlier)).toEqual(earlier);
  });
});
