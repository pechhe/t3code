import type { AutoCase, ProjectKey, Workflow } from "./corpusTypes.ts";

export interface Constraints {
  readonly project?: ProjectKey;
  readonly model?: "opus" | "sonnet";
  readonly workflow?: Workflow;
}

const PROJECT_NAMES: ReadonlyArray<readonly [RegExp, ProjectKey]> = [
  [/\bT3 ?Peach\b/i, "T3Peach"],
  [/\bYardSmith\b/i, "YardSmith"],
  [/\bWeave\b/i, "Weave"],
  [/\bPropSmith\b/i, "PropSmith"],
  [/\bSlipJay\b/i, "SlipJay"],
  [/\bSplay\b/i, "Splay"],
  [/\bHomebase\b/i, "Homebase"],
];

/**
 * What the user stated outright. Deterministic and applied before any classifier, which can neither override nor outvote it.
 * Frozen before the held-out run; only phrasings of an instruction count, never a mere mention of a name.
 */
export const extractConstraints = (task: string): Constraints => {
  const out: { project?: ProjectKey; model?: "opus" | "sonnet"; workflow?: Workflow } = {};
  const model = /\buse (opus|sonnet)\b/i.exec(task);
  if (model) out.model = model[1]!.toLowerCase() as "opus" | "sonnet";
  for (const [pattern, key] of PROJECT_NAMES) {
    const re = new RegExp(
      `(?:^|[.!?]\\s+)(?:in|for|on)\\s+(?:the\\s+)?${pattern.source}\\s*[,:]`,
      "i",
    );
    if (re.test(task)) {
      out.project = key;
      break;
    }
  }
  if (/\b(don'?t change anything|just (talk|chat|discuss)\b)/i.test(task)) out.workflow = "chat";
  else if (/\b(don'?t write a spec|no spec|just do it)\b/i.test(task)) out.workflow = "solo";
  else if (/\b(run|do) this as a lead\b/i.test(task)) out.workflow = "lead";
  else if (/\bshape this\b/i.test(task)) out.workflow = "shape";
  return out;
};

export const constraintsOf = (c: AutoCase): Constraints => extractConstraints(c.task);
