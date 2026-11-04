import type { Label } from "./corpusTypes.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import raw from "./results/heldout-labels.json" with { type: "json" };

type Labels = Readonly<Record<string, Label>>;
const A = raw.A as Labels;
const B = raw.B as Labels;

/** Two blind labelers decide; the author's label only breaks a split between them; a three-way split is uncertain. */
export const adjudicate = (author: Label, a: Label, b: Label): Label =>
  a === b ? a : author === a || author === b ? author : "uncertain";

export const referenceLabel = (id: string): Label => {
  const tune = TUNE_CASES.find((c) => c.id === id);
  if (tune) return tune.authorLabel;
  const held = HELDOUT_CASES.find((c) => c.id === id);
  const a = A[id];
  const b = B[id];
  if (held === undefined || a === undefined || b === undefined)
    throw new Error(`No reference label for ${id}`);
  return adjudicate(held.authorLabel, a, b);
};

export const labelAudit = () =>
  HELDOUT_CASES.map((c) => ({
    id: c.id,
    author: c.authorLabel,
    A: A[c.id]!,
    B: B[c.id]!,
    final: referenceLabel(c.id),
  }));

const heldoutLabel = (labels: Labels) => (id: string) => {
  const label = labels[id];
  if (label === undefined) throw new Error(`No held-out label for ${id}`);
  return label;
};

/** Alternative reference views over the held-out cases only; the adjudicated view is the primary one. */
export const labelViews: Readonly<Record<string, (id: string) => Label>> = {
  adjudicated: referenceLabel,
  agreementOnly: (id) => {
    const a = heldoutLabel(A)(id);
    return a === heldoutLabel(B)(id) ? a : "uncertain";
  },
  labelerA: heldoutLabel(A),
  labelerB: heldoutLabel(B),
};
