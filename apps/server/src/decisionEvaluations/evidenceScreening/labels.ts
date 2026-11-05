import type { ScreenCase } from "./corpusTypes.ts";
import type { Reference } from "./scoring.ts";
import rawA from "./results/labels-A.json" with { type: "json" };
import rawB from "./results/labels-B.json" with { type: "json" };

const A = rawA.labels as Readonly<Record<string, string>>;
const B = rawB.labels as Readonly<Record<string, string>>;

/** Two blind labelers decide. They must agree on a concrete label; a split or any `unsure` stays uncertain and is reported, not resolved. */
export const agreed = (a: string | undefined, b: string | undefined): Reference =>
  a !== undefined && a === b && a !== "unsure" ? a : "uncertain";
const single = (a: string | undefined): Reference =>
  a === undefined || a === "unsure" ? "uncertain" : a;

export type ReferenceFor = (c: ScreenCase) => Reference;
export const referenceViews: Readonly<Record<string, ReferenceFor>> = {
  agreed: (c) => agreed(A[c.id], B[c.id]),
  labelerA: (c) => single(A[c.id]),
  labelerB: (c) => single(B[c.id]),
};

export const hasAllLabels = (cases: ReadonlyArray<ScreenCase>): boolean =>
  cases.every((c) => A[c.id] !== undefined && B[c.id] !== undefined);

export const labelSources = { A: rawA.source, B: rawB.source };

export const labelAudit = (cases: ReadonlyArray<ScreenCase>) =>
  cases.map((c) => ({
    caseId: c.id,
    split: c.split,
    kind: c.kind,
    A: A[c.id] ?? null,
    B: B[c.id] ?? null,
    agreed: agreed(A[c.id], B[c.id]),
  }));
