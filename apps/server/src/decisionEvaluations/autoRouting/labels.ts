import type { AutoCase, Decision } from "./corpusTypes.ts";
import type { ReferenceFor } from "./harness.ts";
import rawA from "./results/labels-A.json" with { type: "json" };
import rawB from "./results/labels-B.json" with { type: "json" };
import outcomes from "./results/outcomes.json" with { type: "json" };

type PerCase = Readonly<Partial<Record<Decision, string>>>;
const A = rawA.labels as Readonly<Record<string, PerCase>>;
const B = rawB.labels as Readonly<Record<string, PerCase>>;

/** Two blind labelers decide. They must agree on a concrete label; a split or any `unknown` stays uncertain and is reported, not resolved. */
export const agreed = (a: string | undefined, b: string | undefined): string =>
  a !== undefined && a === b && a !== "unknown" ? a : "uncertain";

const single = (a: string | undefined): string =>
  a === undefined || a === "unknown" ? "uncertain" : a;

interface Outcome {
  files: number;
  added: number;
  deleted: number;
  areas: number;
}
const OUTCOMES = outcomes as unknown as Record<string, Outcome>;

/** Real change size as a second, label-free view of tier difficulty: wide or large landed changes are demanding, small local ones are routine. */
export const outcomeTier = (id: string): string => {
  const o = OUTCOMES[id];
  if (o === undefined) return "uncertain";
  const size = o.added + o.deleted;
  if (o.files >= 10 || o.areas >= 6 || size >= 400) return "demanding";
  if (o.files <= 4 && size <= 150 && o.areas <= 3) return "routine";
  return "uncertain";
};

export const referenceViews: Readonly<
  Record<string, (cases: ReadonlyArray<AutoCase>) => ReferenceFor>
> = {
  agreed: () => (c, d) => agreed(A[c.id]?.[d], B[c.id]?.[d]),
  labelerA: () => (c, d) => single(A[c.id]?.[d]),
  labelerB: () => (c, d) => single(B[c.id]?.[d]),
  /** Objective evidence only: the repository the change landed in, and the landed change's size for tiers; nothing for the workflow. */
  objective: () => (c, d) =>
    d === "project"
      ? c.source !== undefined
        ? (c.project ?? "uncertain")
        : "uncertain"
      : d === "subagentTier" || d === "mainModel"
        ? outcomeTier(c.id)
        : "uncertain",
};

export const primaryView = referenceViews.agreed!([]);

export const hasAllLabels = (cases: ReadonlyArray<AutoCase>): boolean =>
  cases.every((c) =>
    (["project", "workflow", "mainModel", "subagentTier"] as const).every(
      (d) => A[c.id]?.[d] !== undefined && B[c.id]?.[d] !== undefined,
    ),
  );

export const labelSources = { A: rawA.source, B: rawB.source };

export const labelAudit = (cases: ReadonlyArray<AutoCase>) =>
  cases.map((c) => ({
    caseId: c.id,
    split: c.split,
    ...Object.fromEntries(
      (["project", "workflow", "mainModel", "subagentTier"] as const).map((d) => [
        d,
        {
          A: A[c.id]?.[d] ?? null,
          B: B[c.id]?.[d] ?? null,
          agreed: agreed(A[c.id]?.[d], B[c.id]?.[d]),
        },
      ]),
    ),
  }));
