import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Room kept for the summariser's own instructions and the summary it writes. */
const COMPACTION_RESERVE_TOKENS = 12_000;
/** Deliberately pessimistic for prose and code alike, so a long transcript cannot overflow. */
const BYTES_PER_TOKEN = 3;
const MIN_BUDGET_BYTES = 8_000;
const MAX_ITEM_CHARS = 6_000;
const MAX_COMMAND_OUTPUT_CHARS = 1_500;

export const DEFAULT_COMPACTION_WINDOW_TOKENS = 100_000;
/**
 * The summary has to travel inside a context handoff, whose whole payload is capped in bytes
 * (`DEFAULT_HANDOFF_TOKEN_CAP` counts one byte per token), together with the coverage line and
 * the next user message still to come, so the prompt asks for a short summary and this bounds a
 * long answer well inside that cap.
 */
export const COMPACTION_SUMMARY_MAX_BYTES = 8_000;

function limitText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}\n[rest of this item omitted]`;
}

function renderItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `User:\n${limitText(item.text, MAX_ITEM_CHARS)}`;
    case "assistant_message":
      return limitText(item.text, MAX_ITEM_CHARS).length === 0
        ? null
        : `Assistant:\n${limitText(item.text, MAX_ITEM_CHARS)}`;
    case "proposed_plan":
      return `Assistant plan:\n${limitText(item.markdown, MAX_ITEM_CHARS)}`;
    case "command_execution":
      return [
        `Command: ${limitText(item.input, 400)}`,
        `Exit code: ${item.exitCode ?? "unknown"}`,
        limitText(item.output ?? "", MAX_COMMAND_OUTPUT_CHARS),
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    case "file_change":
      return `File change: ${item.fileName}`;
    case "error":
      return `Error: ${limitText(item.failure.message, 1_000)}`;
    case "run_interrupt_result":
      return `Run stopped: ${limitText(item.message, 1_000)}`;
    case "compaction":
      return "[Context was compacted here; everything before this line is no longer in the conversation.]";
    case "handoff":
      return `[Conversation context was handed over here]\n${limitText(item.summary ?? "", 2_000)}`;
    default:
      return null;
  }
}

/**
 * The conversation a summariser reads, oldest first, trimmed to fit the summariser's window.
 * The most recent items matter most for continuing the work, and the first user message carries
 * the original request, so those survive first and older middle items drop out.
 */
export function renderCompactionTranscript(input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The summarising model's context window, in tokens. */
  readonly windowTokens: number;
}): { readonly text: string; readonly omittedItems: number } {
  const budgetBytes = Math.max(
    MIN_BUDGET_BYTES,
    (input.windowTokens - COMPACTION_RESERVE_TOKENS) * BYTES_PER_TOKEN,
  );
  const rendered = input.items.flatMap((item) => {
    const text = renderItem(item);
    return text === null ? [] : [{ text, bytes: Buffer.byteLength(text) + 2 }];
  });
  if (rendered.length === 0) return { text: "", omittedItems: 0 };

  const firstUser = rendered.findIndex((entry) => entry.text.startsWith("User:"));
  const kept = new Set<number>();
  let usedBytes = 0;
  if (firstUser !== -1) {
    kept.add(firstUser);
    usedBytes += rendered[firstUser]!.bytes;
  }
  for (let index = rendered.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const entry = rendered[index]!;
    if (usedBytes + entry.bytes > budgetBytes) continue;
    kept.add(index);
    usedBytes += entry.bytes;
  }
  const keptIndexes = [...kept].sort((left, right) => left - right);
  const omittedItems = rendered.length - keptIndexes.length;
  const head =
    omittedItems === 0
      ? []
      : [
          `[${omittedItems} items between the start of the conversation and the material below were dropped as too large to include.]`,
        ];
  return {
    text: [...head, ...keptIndexes.map((index) => rendered[index]!.text)].join("\n\n"),
    omittedItems,
  };
}

const TRUNCATION_MARKER = "\n\n[summary truncated]";

/**
 * A summary the conversation can carry: whole enough to keep, short enough to fit its handoff.
 * The limits that matter are byte counts and the summary may be in any script, so this cuts on
 * UTF-8 bytes, never in the middle of a character, and keeps the marker inside the limit.
 */
export function clampCompactionSummary(summary: string, maxBytes: number): string {
  const trimmed = summary.trim();
  if (Buffer.byteLength(trimmed) <= maxBytes) return trimmed;
  const room = maxBytes - Buffer.byteLength(TRUNCATION_MARKER);
  if (room <= 0) return TRUNCATION_MARKER.trim();
  // `toString` replaces a character cut in half with U+FFFD, which this drops below.
  const sliced = Buffer.from(trimmed, "utf8").subarray(0, room).toString("utf8");
  const wholeCharacters = sliced.replace(/\uFFFD+$/u, "");
  const breakAt = Math.max(wholeCharacters.lastIndexOf("\n\n"), wholeCharacters.lastIndexOf("\n"));
  const kept = (breakAt > room / 2 ? wholeCharacters.slice(0, breakAt) : wholeCharacters).trimEnd();
  return `${kept}${TRUNCATION_MARKER}`;
}
