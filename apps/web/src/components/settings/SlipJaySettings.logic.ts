import type {
  SlipJayLandingCheck,
  SlipJayProcessLevel,
  SlipJayRunnerOperation,
  VcsSlipJayPolicyOutcome,
  VcsSlipJayProjectSettings,
} from "@t3tools/contracts";

/** The runner location of a runner on this machine, as SlipJay's runner listens by default. */
export const LOCAL_RUNNER_LOCATION = "http://127.0.0.1:7787";

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (word: string) =>
  PLAIN_WORD.test(word)
    ? word
    : word.includes("\n")
      ? // A line holds one check, so a line break in an argument is written as `\n` in `$'…'`.
        `$'${word.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`
      : `'${word.replaceAll("'", `'\\''`)}'`;

/** One landing check as a shell line: `cd <dir> && ` for its directory, a trailing ` &` when concurrent. */
export function formatLandingCheck(check: SlipJayLandingCheck): string {
  const command = [check.executable, ...check.args].map(quote).join(" ");
  return `${check.cwd ? `cd ${quote(check.cwd)} && ` : ""}${command}${check.concurrent ? " &" : ""}`;
}

interface ShellWord {
  readonly text: string;
  /** Quoted words are always arguments, never `&&`, `&` or a pipe. */
  readonly quoted: boolean;
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'" };

/** Splits a line into words, honouring `'…'`, `"…"`, `$'…'` and backslash escapes. */
function shellWords(line: string): ShellWord[] | string {
  const words: ShellWord[] = [];
  let word: string | null = null;
  let quoted = false;
  let quoteChar: "'" | '"' | "$'" | null = null;
  const append = (text: string) => {
    word = (word ?? "") + text;
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quoteChar === "'") {
      if (char === "'") quoteChar = null;
      else append(char);
    } else if (quoteChar === "$'") {
      if (char === "'") quoteChar = null;
      else if (char === "\\" && index + 1 < line.length) {
        const next = line[++index]!;
        append(ANSI_ESCAPES[next] ?? `\\${next}`);
      } else append(char);
    } else if (quoteChar === '"') {
      if (char === '"') quoteChar = null;
      else if (char === "\\" && index + 1 < line.length) append(line[++index]!);
      else append(char);
    } else if (char === "$" && line[index + 1] === "'") {
      quoteChar = "$'";
      quoted = true;
      index += 1;
      append("");
    } else if (char === "'" || char === '"') {
      quoteChar = char;
      quoted = true;
      append("");
    } else if (char === "\\" && index + 1 < line.length) {
      quoted = true;
      append(line[++index]!);
    } else if (/\s/.test(char)) {
      if (word !== null) words.push({ text: word, quoted });
      word = null;
      quoted = false;
    } else {
      append(char);
    }
  }
  if (quoteChar !== null) return "has an unclosed quote";
  if (word !== null) words.push({ text: word, quoted });
  return words;
}

const SHELL_OPERATORS = new Set(["|", ";", "&&", "||", "&"]);

/**
 * The landing checks a textarea holds, one per non-empty line, or the first line's problem.
 * A line left exactly as `formatLandingCheck` wrote one of `current` keeps that check whole,
 * with the settings a line cannot show.
 */
export function parseLandingChecks(
  text: string,
  current: ReadonlyArray<SlipJayLandingCheck> = [],
): { readonly checks: SlipJayLandingCheck[] } | { readonly error: string } {
  const unchanged = new Map(current.map((check) => [formatLandingCheck(check), check]));
  const checks: SlipJayLandingCheck[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const kept = unchanged.get(line);
    if (kept !== undefined) {
      checks.push(kept);
      continue;
    }
    const parsed = shellWords(line);
    if (typeof parsed === "string") return { error: `Line ${index + 1} ${parsed}.` };
    let words = parsed;
    let cwd: string | undefined;
    if (words[0]?.text === "cd" && !words[0].quoted) {
      if (words.length < 4 || words[2]!.text !== "&&" || words[2]!.quoted)
        return { error: `Line ${index + 1}: write a directory as \`cd <dir> && <command>\`.` };
      cwd = words[1]!.text;
      words = words.slice(3);
    }
    const last = words.at(-1);
    const concurrent = last?.text === "&" && !last.quoted;
    if (concurrent) words = words.slice(0, -1);
    if (words.some((word) => !word.quoted && SHELL_OPERATORS.has(word.text)))
      return {
        error: `Line ${index + 1}: each line is one command run without a shell, so pipes and \`;\` don't work.`,
      };
    const [executable, ...args] = words.map((word) => word.text);
    if (executable === undefined || executable.trim() === "")
      return { error: `Line ${index + 1} has no command.` };
    checks.push({
      executable,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      ...(concurrent ? { concurrent: true } : {}),
    });
  }
  return { checks };
}

export interface SlipJayPolicyDraft {
  readonly spares: number;
  readonly process: SlipJayProcessLevel;
  readonly checksText: string;
}

export const policyDraft = (settings: VcsSlipJayProjectSettings): SlipJayPolicyDraft => ({
  spares: settings.spares,
  process: settings.process,
  checksText: settings.requiredLandingVerification.map(formatLandingCheck).join("\n"),
});

const sameChecks = (
  left: ReadonlyArray<SlipJayLandingCheck>,
  right: ReadonlyArray<SlipJayLandingCheck>,
) =>
  left.length === right.length &&
  left.every((check, index) => formatLandingCheck(check) === formatLandingCheck(right[index]!));

/** Only the fields the draft changed, or the problem that stops it being saved. */
export function policyPatch(
  settings: VcsSlipJayProjectSettings,
  draft: SlipJayPolicyDraft,
):
  | {
      readonly patch: {
        spares?: number;
        process?: SlipJayProcessLevel;
        requiredLandingVerification?: SlipJayLandingCheck[];
      };
    }
  | { readonly error: string } {
  const parsed = parseLandingChecks(draft.checksText, settings.requiredLandingVerification);
  if ("error" in parsed) return parsed;
  return {
    patch: {
      ...(draft.spares === settings.spares ? {} : { spares: draft.spares }),
      ...(draft.process === settings.process ? {} : { process: draft.process }),
      ...(sameChecks(parsed.checks, settings.requiredLandingVerification)
        ? {}
        : { requiredLandingVerification: parsed.checks }),
    },
  };
}

/**
 * Where a save stands, from the runner's view of its operation; none until the runner has it,
 * and after it leaves the queue while SlipJay finishes.
 */
export function describePolicyProgress(operation: SlipJayRunnerOperation | undefined): string {
  if (operation === undefined) return "Waiting for the runner to land it…";
  if (operation.stage === "paused") return "Queued: the runner is paused for every machine.";
  if (operation.status === "queued")
    return operation.position === undefined || operation.position <= 1
      ? "Queued: the runner takes it next."
      : `Queued: ${operation.position - 1} ahead of it in the runner.`;
  return `Landing: ${operation.stage}…`;
}

/** What a save's outcome means to the person who made it. */
export function describePolicyOutcome(result: VcsSlipJayPolicyOutcome): {
  readonly tone: "success" | "error" | "warning";
  readonly message: string;
} {
  switch (result.phase) {
    case "landed":
      return { tone: "success", message: "Landed. Every machine and agent now uses it." };
    case "already-applied":
      return { tone: "success", message: "Already in force; nothing to land." };
    case "refused":
      return { tone: "error", message: `Not saved: ${result.reason ?? "SlipJay refused it."}` };
    case "rejected":
      return {
        tone: "error",
        message: `The runner did not land it, so nothing changed: ${result.reason ?? "no reason given."}`,
      };
    case "failed-after-integration":
      return {
        tone: "warning",
        message:
          `Integrated, but publishing has not finished; the runner retries it. ${result.reason ?? ""}`.trim(),
      };
    case "uncertain":
      return {
        tone: "warning",
        message:
          `Its outcome is not known yet; save again to follow it. ${result.reason ?? ""}`.trim(),
      };
  }
}
