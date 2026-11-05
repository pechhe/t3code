import { extractConstraints } from "./constraints.ts";
import type { AutoCase, Decision, ProjectKey, Tier, Workflow } from "./corpusTypes.ts";

export const BASELINE_VERSION = "auto-routing-baselines-v1";

/** A system's raw choice per decision, before the user's explicit constraints are applied. */
export type Choices = Readonly<{
  project: ProjectKey;
  workflow: Workflow;
  mainModel: Tier;
  subagentTier: Tier;
}>;

/**
 * Current behaviour: the thread stays where the user started it, work goes straight to one agent, and both the main model and the
 * delegated worker are the strongest default. It never escalates because it never goes lower.
 */
export const currentDefault = (c: AutoCase): Choices => ({
  project: c.startedIn,
  workflow: "solo",
  mainModel: "demanding",
  subagentTier: "demanding",
});

export const alwaysRoutine = (c: AutoCase): Choices => ({
  project: c.startedIn,
  workflow: "solo",
  mainModel: "routine",
  subagentTier: "routine",
});

const SENSITIVE =
  /\b(auth\w*|sign-?in|permissions?|security|sessions?|tokens?|approvals?|guards?|full access|dpop|credentials?|secrets?|migrations?|delete|read-only|isolation|concurren\w*|races?)\b/i;
const BROAD = /\b(across|every|all (?:threads|clients)|server, web|contracts|roles?)\b/i;
const PROJECT_WORDS: ReadonlyArray<readonly [RegExp, ProjectKey]> = [
  [/\bSlipJay|landing gate|spares?|promot\w+|runner\b/i, "SlipJay"],
  [/\bYardSmith|Smith\b/i, "YardSmith"],
  [/\bWeave\b/i, "Weave"],
  [/\bLodestone|guard\b/i, "OddsAndEnds"],
  [/\bdelegation guidance|advisor|skills?\b/i, "Agents"],
];

/** A frozen keyword rule over the request text: the deterministic comparison an engine must beat to be worth calling. */
export const keywordRule = (c: AutoCase): Choices => {
  const t = c.task;
  const question =
    /^(how|what|why|is|does|can|explain|should)\b/i.test(t) || t.trim().endsWith("?");
  const vague = t.length < 60 && !/`|\//.test(t);
  const workflow: Workflow = question
    ? "chat"
    : vague
      ? "shape"
      : BROAD.test(t) && t.length > 140
        ? "lead"
        : "solo";
  const demanding = SENSITIVE.test(t) || BROAD.test(t) || vague || t.length > 200;
  const tier: Tier = demanding ? "demanding" : "routine";
  const fromWord = PROJECT_WORDS.find(([re]) => re.test(t))?.[1];
  return {
    project:
      question && !fromWord && c.startedIn === "NoProject"
        ? "NoProject"
        : (fromWord ?? c.startedIn),
    workflow,
    mainModel: tier,
    subagentTier: tier,
  };
};

export const BASELINES = {
  current: currentDefault,
  keyword: keywordRule,
  routine: alwaysRoutine,
} as const;

/** The explicit constraint wins over every system, the current behaviour included: a user who names a model or project already gets it. */
export const applyConstraints = (
  c: AutoCase,
  choices: Choices,
): { final: Choices; constrained: ReadonlyArray<Decision> } => {
  const k = extractConstraints(c.task);
  const constrained: Decision[] = [];
  let final = choices;
  if (k.project) {
    final = { ...final, project: k.project };
    constrained.push("project");
  }
  if (k.workflow) {
    final = { ...final, workflow: k.workflow };
    constrained.push("workflow");
  }
  if (k.model) {
    const tier: Tier = k.model === "opus" ? "demanding" : "routine";
    final = { ...final, mainModel: tier };
    constrained.push("mainModel");
  }
  return { final, constrained };
};
