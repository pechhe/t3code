import type { ClaimLabel, DecisionLabel } from "./corpusTypes.ts";

/** Frozen before any held-out case existed (`results/freeze.json` records the digest). Deterministic, label-blind, written from the tuning cases and the author's general knowledge of report wording. */
export const BASELINE_VERSION = "evidence-consistency-v1";

const NOUN =
  "(?:focused tests?|tests?|test files?|cases?|calls?|attempts?|files?|failures?|checks?)";
const COUNT_CLAIM = new RegExp(`\\b(\\d[\\d,]*)\\s+(?:held-out\\s+|tune\\s+)?(${NOUN})\\b`, "gi");
const FAILURE =
  /\b(?:FAIL(?:ED)?\b|[1-9]\d*\s+failed|exit(?: status| code)?[: ]+[1-9]\d*|nonzero_exit|ELIFECYCLE|✗|✘|AssertionError|Error:)/;
const PASS_EVIDENCE =
  /(?:\b\d+\s+passed\b|\ball tests passed\b|exit(?: status| code)?[: ]+0\b|\b0\s+failed\b|✓)/i;
const PASS_CLAIM = /\b(?:pass(?:es|ed)?|green|clean|succe(?:ss|eded|ssful))\b/i;
const TRUNCATED = /(?:\[(?:output )?truncated|\.\.\.\s*\(\d+ more|…\s*$|\(cut\)|\.\.\.\s*$)/im;
const INSTALL_CLAIM = /\b(?:installed|deployed|running in|live in)\b/i;
const NOT_INSTALLED = /\b(?:not installed|not deployed|no install|not yet installed)\b/i;
const SHA = /\b[0-9a-f]{7,40}\b/g;
const NOT_RUN_CAVEAT = /\b(?:not run|were not run|skipped|did not run|no tests? (?:were )?run)\b/i;

const countsOf = (text: string): Map<string, Set<number>> => {
  const found = new Map<string, Set<number>>();
  for (const m of text.matchAll(COUNT_CLAIM)) {
    const noun = m[2]!
      .toLowerCase()
      .replace(/s$/, "")
      .replace(/^focused /, "");
    const set = found.get(noun) ?? new Set<number>();
    set.add(Number(m[1]!.replace(/,/g, "")));
    found.set(noun, set);
  }
  return found;
};

/** Checks only what text can show without understanding it: counts, failure markers, revisions, install state, truncation. */
export const claimBaseline = (claim: string, evidence: string): ClaimLabel => {
  let contradicted = false;
  let verified = 0;
  let unchecked = 0;

  const claimed = countsOf(claim);
  const shown = countsOf(evidence);
  for (const [noun, values] of claimed) {
    const seen = shown.get(noun);
    if (seen === undefined) unchecked += 1;
    else if ([...values].every((v) => !seen.has(v))) contradicted = true;
    else verified += 1;
  }

  if (PASS_CLAIM.test(claim)) {
    if (FAILURE.test(evidence)) contradicted = true;
    else if (PASS_EVIDENCE.test(evidence) && !NOT_RUN_CAVEAT.test(evidence)) verified += 1;
    else unchecked += 1;
  }

  const claimShas = new Set(claim.match(SHA) ?? []);
  const evidenceShas = new Set(evidence.match(SHA) ?? []);
  if (claimShas.size > 0 && evidenceShas.size > 0) {
    const sameRevision = [...claimShas].some((a) =>
      [...evidenceShas].some((b) => a.startsWith(b) || b.startsWith(a)),
    );
    if (sameRevision) verified += 1;
    else contradicted = true;
  }

  if (INSTALL_CLAIM.test(claim)) {
    if (NOT_INSTALLED.test(evidence)) contradicted = true;
    else if (!INSTALL_CLAIM.test(evidence)) unchecked += 1;
  }

  if (contradicted) return "contradicted";
  if (unchecked > 0 || TRUNCATED.test(evidence) || verified === 0) return "insufficient";
  return "supported";
};

const STOP = new Set(
  "a an the of to in on for and or is are be it that this with as by at from not no we our its was were will".split(
    " ",
  ),
);
const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
export const overlap = (a: string, b: string): number => {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both += 1;
  return both / Math.min(x.size, y.size);
};

const TENTATIVE =
  /\b(?:maybe|might|could|consider|proposal|propos(?:e|ed|al)|suggest(?:ed|ion)?|perhaps|options?|if we|should we|recommend(?:ed|ation)?|would need|worth|next step|if pursued|not yet|to be decided|open question)\b|\?/i;
const SETTLED =
  /\b(?:decid(?:ed|es)|decision|we will|must|never|always|only (?:route|way)|from now on|policy|retain|chose|chosen|instead of|required|is the only|stays?|governs?)\b/i;
const CONSEQUENCE =
  /\b(?:permission|security|secret|credential|auth\w*|token|data|migration|delet\w+|release|production|deploy\w*|public|contract|schema|privacy|land\w*|publish\w*|review\w*|accept\w*|origin|process\w*|kill|users?|break\w*|compat\w*|owner|approval|gate)\b/i;

/** Duplicate when most of the passage's content words already appear in one existing decision. */
export const DUPLICATE_OVERLAP = 0.75;

export const decisionBaseline = (
  passage: string,
  existing: ReadonlyArray<string>,
): DecisionLabel => {
  if (existing.some((e) => overlap(passage, e) >= DUPLICATE_OVERLAP)) return "duplicate";
  if (TENTATIVE.test(passage) && !/\bdecid(?:ed|es)\b/i.test(passage)) return "tentative";
  if (SETTLED.test(passage) && CONSEQUENCE.test(passage)) return "settled-consequential";
  return "routine";
};

/** Trivial references: never screen anything (today's behaviour) and screen everything (the full-review workload). */
export const flagNothing = (): "supported" => "supported";
