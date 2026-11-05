// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - writes the packet the blind labelers read
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { PROJECTS } from "./corpusTypes.ts";
import { PROJECT_DESCRIPTIONS, TIER_DEFINITIONS, WORKFLOW_DEFINITIONS } from "./definitions.ts";

/** Labelers see the request text and the definitions only: no starting project, outcome, baseline or engine output. */
export const packet = (): string => {
  const cases = [...TUNE_CASES, ...HELDOUT_CASES];
  return [
    "Label each request on four separate decisions. Answer only from the request text and the definitions. Use `unknown` whenever the request does not support a confident label; do not guess.",
    "",
    "PROJECT (one of): " + PROJECTS.join(", ") + ", unknown",
    ...PROJECTS.map((p) => `- ${p}: ${PROJECT_DESCRIPTIONS[p]}`),
    "",
    "WORKFLOW (one of): chat, solo, shape, lead, unknown",
    ...Object.entries(WORKFLOW_DEFINITIONS).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "MAIN MODEL difficulty for the model that talks with the user (routine, demanding, unknown) and SUBAGENT TIER for a worker doing the implementation alone (routine, demanding, unknown):",
    ...Object.entries(TIER_DEFINITIONS).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "REQUESTS:",
    ...cases.map((c) => `${c.id}: ${c.task}`),
  ].join("\n");
};
if (import.meta.main) console.log(packet());
