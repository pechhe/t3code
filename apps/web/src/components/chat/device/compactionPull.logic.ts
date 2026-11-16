export interface CompactionPull {
  readonly fromTokens: number;
  readonly toTokens: number;
}

export interface CompactionPullState {
  readonly threadKey: string;
  readonly usedTokens: number;
  readonly compactionCount: number;
  /** A fall in context use that no completed compaction has yet accounted for. */
  readonly drop: CompactionPull | null;
}

/**
 * Decides when the context bar plays a compaction: once the thread's context use has fallen and
 * a compaction has completed, whichever the client hears of first. Another thread's numbers
 * never count as a fall, and a fall forgotten once context grows again cannot play late.
 */
export function advanceCompactionPull(
  previous: CompactionPullState | null,
  input: {
    readonly threadKey: string;
    readonly usedTokens: number;
    readonly compactionCount: number;
  },
): { readonly state: CompactionPullState; readonly pull: CompactionPull | null } {
  if (previous === null || previous.threadKey !== input.threadKey)
    return { state: { ...input, drop: null }, pull: null };
  const drop =
    input.usedTokens < previous.usedTokens
      ? { fromTokens: previous.drop?.fromTokens ?? previous.usedTokens, toTokens: input.usedTokens }
      : input.usedTokens > previous.usedTokens
        ? null
        : previous.drop;
  const compacted = input.compactionCount > previous.compactionCount;
  if (compacted && drop !== null) return { state: { ...input, drop: null }, pull: drop };
  // A compaction heard of before its fall stays uncounted until the fall arrives.
  return { state: { ...input, compactionCount: previous.compactionCount, drop }, pull: null };
}
