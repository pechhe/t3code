/**
 * Copy for Claude's resume compaction dialog, shared by the server adapter
 * (which asks the question) and the web client (which recognizes the
 * question and its "never" answer in resolved user-input activities to
 * mirror the dismissal). Both sides must agree on these strings, so they
 * live here: reword the question or the answer label in this file only.
 */
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";

export function formatClaudeResumeCompactionQuestion(input: {
  readonly ageMinutes: number;
  readonly estimatedTokens: number;
}): string {
  const ageLabel =
    input.ageMinutes >= 60
      ? `${Math.floor(input.ageMinutes / 60)}h ${input.ageMinutes % 60}m`
      : `${input.ageMinutes}m`;
  return `This session is ${ageLabel} old and uses ${input.estimatedTokens.toLocaleString("en-US")} tokens. Compact it before continuing?`;
}

const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN =
  /^This session is (?:\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.test(question);
}

/**
 * Context size below which T3 does not suggest or run a Claude compaction:
 * the stale-thread Compact chip and idle compaction. Matches Claude Code's
 * idleCompaction default of 200K.
 */
export const COMPACTION_SUGGESTION_MIN_TOKENS = 200_000;

/**
 * When the conversation's own prompt cache expires, from its latest usage. A compaction that ran
 * on another model reports that model's cache, which says nothing about the conversation's, so
 * it is skipped.
 */
export function conversationPromptCacheExpiresAt(
  usages: ReadonlyArray<{
    readonly promptCacheExpiresAt?: string | undefined;
    readonly compactedWith?: string | undefined;
    readonly updatedAt: string;
  }>,
): string | undefined {
  let latest: (typeof usages)[number] | undefined;
  for (const usage of usages) {
    if (usage.compactedWith !== undefined) continue;
    if (latest === undefined || Date.parse(usage.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = usage;
    }
  }
  return latest?.promptCacheExpiresAt;
}

export interface ClaudeCompactionModelChoice {
  /** The setting's model when it summarises; null leaves the conversation's model to. */
  readonly model: string | null;
  /** The setting's model was passed over because its window is smaller than the thread. */
  readonly windowTooSmall: boolean;
}

/**
 * Which model summarises a Claude compaction: the instance's "Compact with" model, or the
 * conversation's own (null). The server decides with this at turn start and the web client labels
 * the Compact chip with it, so the chip's promise and the turn cannot disagree.
 *
 * The conversation's model compacts while its prompt cache is warm (a read at a tenth of its input
 * price) unless the setting applies always, and whenever the cache expiry is unknown. The chosen
 * model needs a context window at least the thread's size.
 */
export function chooseClaudeCompactionModel(input: {
  readonly setting: { readonly model: string; readonly onlyWhenCold: boolean };
  readonly conversationModel: string;
  readonly usedTokens: number;
  readonly promptCacheExpiresAt: string | undefined;
  readonly nowMs: number;
  /** The chosen model's context window; undefined when the catalog does not know it. */
  readonly chosenWindowTokens: number | undefined;
}): ClaudeCompactionModelChoice {
  const keep = { model: null, windowTooSmall: false } as const;
  const chosen = input.setting.model.trim();
  if (chosen === "" || chosen === input.conversationModel) return keep;
  if (input.setting.onlyWhenCold) {
    const expiresAtMs =
      input.promptCacheExpiresAt === undefined
        ? Number.NaN
        : Date.parse(input.promptCacheExpiresAt);
    if (!Number.isFinite(expiresAtMs) || input.nowMs < expiresAtMs) return keep;
  }
  if (input.chosenWindowTokens === undefined) return keep;
  if (input.chosenWindowTokens < input.usedTokens) return { model: null, windowTooSmall: true };
  return { model: chosen, windowTooSmall: false };
}
