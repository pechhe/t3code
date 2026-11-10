import { expect, it } from "@effect/vitest";
import cases from "./corpus/cases.json" with { type: "json" };
import { corpusDigest, referenceOf, strataOf, type CaseRecord } from "./corpus.ts";
import { flaggedByModel, readBurden, summarizeSystem } from "./harness.ts";
import heldout from "./results/heldout-jev.json" with { type: "json" };

const all = cases as unknown as CaseRecord[];
const record = (over: Partial<CaseRecord>): CaseRecord => ({
  id: "x",
  split: "heldout",
  repo: "t3code",
  commit: "0".repeat(40),
  origin: "clean-candidate",
  record: "",
  needsFiles: false,
  truncated: false,
  digest: "",
  labels: ["clean", "clean"],
  ...over,
});

it("a sampled commit is clean only when both blind labelers say so, and a defect keeps its record", () => {
  expect(referenceOf(record({ labels: ["clean", "clean"] }))).toBe("ok");
  expect(referenceOf(record({ labels: ["clean", "unsure"] }))).toBe("uncertain");
  expect(referenceOf(record({ labels: ["defect", "defect"] }))).toBe("uncertain");
  expect(referenceOf(record({ origin: "defect", labels: ["clean", "clean"] }))).toBe("defect");
  expect(strataOf(record({ origin: "defect", needsFiles: true }))).toBe("needs-files");
  expect(strataOf(record({ origin: "defect", needsFiles: false }))).toBe("diff-only");
});

it("scores split cases out, counts a failed call as a miss and reports strata apart", () => {
  const cs = [
    record({ id: "d1", origin: "defect", needsFiles: false }),
    record({ id: "d2", origin: "defect", needsFiles: true }),
    record({ id: "c1" }),
    record({ id: "c2" }),
    record({ id: "u1", labels: ["clean", "unsure"] }),
  ];
  const flags: Record<string, boolean> = { d1: true, d2: false, c1: true, c2: false, u1: true };
  const r = summarizeSystem(cs, (c) => ({
    flagged: flags[c.id] === true,
    outcome:
      c.id === "d2" ? { kind: "failed", code: "timeout" } : { kind: "answered", probability: 1 },
  }));
  expect([r.caught, r.defects, r.falseAlarms, r.clean, r.cases]).toEqual([1, 2, 1, 2, 4]);
  expect(r.recallByStratum).toMatchObject({
    "diff-only": { caught: 1, total: 1 },
    "needs-files": { caught: 0, total: 1 },
  });
  expect(r.failed).toBe(1);
  expect(r.flaggedPerDefect.value).toBe(2);
  const after = summarizeSystem(
    cs,
    (c) => ({ flagged: flags[c.id] === true, outcome: { kind: "answered", probability: 1 } }),
    new Set(["c1"]),
  );
  expect([after.falseAlarms, after.clean]).toEqual([0, 1]);
});

it("the reading burden is undefined without a caught defect and bracketed by its bootstrap otherwise", () => {
  const row = (reference: "defect" | "ok", flagged: boolean) => ({
    caseId: "x",
    reference,
    stratum: "clean" as const,
    flagged,
  });
  expect(readBurden([row("defect", false), row("ok", true)]).value).toBeNull();
  const some = [row("defect", true), row("defect", true), row("ok", true), row("ok", false)];
  const b = readBurden(some);
  expect(b.value).toBe(1.5);
  expect(b.low).toBeLessThanOrEqual(1.5);
  expect(b.high).toBeGreaterThanOrEqual(1.5);
});

it("the stored Jev summary still follows from its recorded calls", () => {
  const own = new Map(heldout.records.map((r) => [r.caseId, r.outcome]));
  const held = all.filter((c) => c.split === "heldout");
  const again = summarizeSystem(held, (c) => {
    const outcome = (own.get(c.id) ?? { kind: "failed", code: "not-run" }) as Parameters<
      typeof flaggedByModel
    >[0];
    return { flagged: flaggedByModel(outcome), outcome };
  });
  expect([again.caught, again.defects, again.falseAlarms, again.clean]).toEqual([
    heldout.systems.jev.caught,
    heldout.systems.jev.defects,
    heldout.systems.jev.falseAlarms,
    heldout.systems.jev.clean,
  ]);
  expect(heldout.corpusDigest).toBe(corpusDigest(held));
  expect(held.filter((c) => referenceOf(c) === "defect").length).toBeGreaterThanOrEqual(30);
  expect(held.filter((c) => referenceOf(c) === "ok").length).toBeGreaterThanOrEqual(30);
});
