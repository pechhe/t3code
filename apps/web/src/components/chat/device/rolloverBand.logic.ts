export interface RolloverBandThresholds {
  readonly soft: number;
  readonly hard: number;
}

export type RolloverBandPart = "soft" | "hard" | "band";

/** Thresholds move in steps of this many tokens, so a drag lands on round numbers. */
const STEP_TOKENS = 1_000;

/** The narrowest band, as a share of the context window, so the two edges never meet. */
const MIN_GAP_SHARE = 0.02;

const round = (tokens: number) => Math.round(tokens / STEP_TOKENS) * STEP_TOKENS;

/**
 * Where a dragged rollover band lands: an edge moves alone and stops short of the other,
 * the whole band keeps its width, and both stay inside the context window.
 */
export function dragRolloverBand(input: {
  readonly start: RolloverBandThresholds;
  readonly part: RolloverBandPart;
  readonly deltaTokens: number;
  readonly maxTokens: number;
}): RolloverBandThresholds {
  const { start, part, maxTokens } = input;
  const gap = Math.max(STEP_TOKENS, round(maxTokens * MIN_GAP_SHARE));
  const delta = round(input.deltaTokens);
  if (part === "band") {
    const width = start.hard - start.soft;
    const soft = Math.min(Math.max(STEP_TOKENS, start.soft + delta), maxTokens - width);
    return { soft, hard: soft + width };
  }
  if (part === "soft") {
    return {
      soft: Math.min(Math.max(STEP_TOKENS, start.soft + delta), start.hard - gap),
      hard: start.hard,
    };
  }
  return {
    soft: start.soft,
    hard: Math.max(Math.min(maxTokens, start.hard + delta), start.soft + gap),
  };
}
