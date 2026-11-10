import type { ProjectCase, WakeKind } from "./types.ts";

export const BASELINE_VERSION = "thread-housekeeping-baselines-v1";

/**
 * The frozen keyword rule from the T3-359 auto-routing pilot (`autoRouting/baseline.ts`), copied rather than imported so another pilot's
 * changes cannot move it. It reads the first message only. The rule's project names are the five that pilot used, so a chat about any
 * other project (T3 Peach, PropSmith, Splay, Homebase) can only ever be `none`.
 */
const PROJECT_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bSlipJay|landing gate|spares?|promot\w+|runner\b/i, "SlipJay"],
  [/\bYardSmith|Smith\b/i, "YardSmith"],
  [/\bWeave\b/i, "Weave"],
  [/\bLodestone|guard\b/i, "Odds and Ends"],
  [/\bdelegation guidance|advisor|skills?\b/i, ".agents"],
];

export const keywordProject = (c: ProjectCase): string => {
  const title = PROJECT_WORDS.find(([re]) => re.test(c.firstText))?.[1];
  return c.projects.find((p) => p.title === title)?.choice ?? "none";
};

/** What the agent actually did: the project the chat was moved to, or nothing. A move to a project outside the listed ones counts as `unlisted`. */
export const actualProject = (c: ProjectCase): string =>
  c.actualProjectId === null
    ? "none"
    : (c.projects.find((p) => p.key === c.actualProjectId)?.choice ?? "unlisted");

/** Wake baselines: never catch (today), the simplest rule by outcome, and by wake kind from the tuning labels. */
export const wakeNever = (): boolean => false;
export const wakeByOutcome = (c: { readonly outcome: string | null }): boolean =>
  c.outcome === "updated";

/** Catch a kind only when at least half of its agreed tuning labels, and at least three, are `nothing_new`. */
export const catchKindsFromTune = (
  tune: ReadonlyArray<{ readonly kind: WakeKind; readonly label: string }>,
): ReadonlySet<WakeKind> => {
  const kinds = new Set<WakeKind>();
  for (const kind of new Set(tune.map((t) => t.kind))) {
    const own = tune.filter(
      (t) => t.kind === kind && (t.label === "nothing_new" || t.label === "something_new"),
    );
    const nothing = own.filter((t) => t.label === "nothing_new").length;
    if (own.length >= 3 && nothing * 2 >= own.length) kinds.add(kind);
  }
  return kinds;
};
