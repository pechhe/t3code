import type { Category, CorpusCase } from "./corpusTypes.ts";

export const BASELINE_VERSION = "1";

const lines = (text: string) => text.split("\n");
const changed = (text: string, sign: "+" | "-") =>
  lines(text).filter((l) => l.startsWith(sign) && !l.startsWith(`${sign}${sign}${sign}`));
const numbers = (text: string) => new Set(text.match(/\b\d+\b/g) ?? []);

/** A context comment cites a number that a changed line removes and no changed line keeps. */
const commentNumberDrift = (evidence: string) => {
  const removed = changed(evidence, "-").join("\n");
  const added = changed(evidence, "+").join("\n");
  const removedNumbers = numbers(removed);
  const addedNumbers = numbers(added);
  return lines(evidence)
    .filter((l) => !l.startsWith("+") && !l.startsWith("-") && /\/\/|\*/.test(l))
    .some((l) => [...numbers(l)].some((n) => removedNumbers.has(n) && !addedNumbers.has(n)));
};

const EFFECT_PATTERN =
  /\b(fetch\(|writeFileSync\(|\.insert\(|\.delete\(|\.add\(|rateCache\.set\(|mkdirSync\()/;
const NAME_ADMITS_EFFECT = /(fetch|create|ensure|write|save|delete|remove|set|update|insert|send)/i;
const READ_ONLY_NAME =
  /^(?:export\s+)?(?:async\s+)?function\s+(get|is|has|format|validate|compute|to|find)[A-Z]/m;
const readOnlyNameWithEffect = (evidence: string) => {
  const name = /function\s+([A-Za-z0-9_]+)/.exec(evidence)?.[1] ?? "";
  return (
    READ_ONLY_NAME.test(evidence) && !NAME_ADMITS_EFFECT.test(name) && EFFECT_PATTERN.test(evidence)
  );
};

const GENERIC_MESSAGES =
  /["'`](?:error|failed|something went wrong|invalid input|unknown error)["'`]/i;
const shortLiteralError = (evidence: string) =>
  [...evidence.matchAll(/new \w*Error\(\s*(["'`])((?:(?!\1).)*)\1/g)].some((m) => {
    const message = m[2] ?? "";
    return !message.includes("${") && message.split(/\s+/).length <= 3;
  }) || GENERIC_MESSAGES.test(evidence);

const STRONG = /(toBe\(|toEqual\(|toStrictEqual\(|toHaveLength\(|toHaveBeenCalledTimes\()/;
const WEAK = /(toBeDefined\(|toBeTruthy\(|toBeGreaterThan\(0\)|not\.toBeNull\()/;
const assertionWeakened = (evidence: string) => {
  const removed = changed(evidence, "-");
  const added = changed(evidence, "+");
  const count = (ls: string[]) => ls.filter((l) => l.includes("expect(")).length;
  return (
    count(removed) > count(added) ||
    (removed.some((l) => STRONG.test(l)) && added.some((l) => WEAK.test(l)))
  );
};

const parameterCount = (evidence: string) => {
  const start = evidence.indexOf("(");
  if (start < 0) return 0;
  let depth = 0;
  let count = 0;
  let sawToken = false;
  for (const ch of evidence.slice(start).replaceAll("=>", "~~")) {
    if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) count++;
    else if (depth === 1 && !/\s/.test(ch)) sawToken = true;
  }
  return sawToken ? count + 1 : 0;
};

const crowded = (evidence: string) => {
  const awaits = (evidence.match(/\bawait\b/g) ?? []).length;
  const methods = (
    evidence.match(/^\s+(?:async\s+)?[a-z]\w*\(.*\)\s*(?::\s*[\w<>[\]]+\s*)?\{/gm) ?? []
  ).length;
  const params = parameterCount(evidence);
  return awaits >= 5 || methods >= 6 || params >= 6;
};

const CHECKS: Record<Category, (evidence: string) => boolean> = {
  "comment-accuracy": commentNumberDrift,
  "name-side-effect": readOnlyNameWithEffect,
  "error-actionability": shortLiteralError,
  "assertion-weakening": assertionWeakened,
  "code-smell": crowded,
};

/** Pre-registered deterministic heuristics the models must beat; they are not the production lints. */
export const baselineFlag = (c: CorpusCase): boolean => CHECKS[c.category](c.evidence);
