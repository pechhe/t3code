export interface CompactAtBounds {
  readonly min: number;
  readonly max: number;
}

/** The compact-at point moves in steps of this many tokens, so a drag lands on round numbers. */
const STEP_TOKENS = 1_000;

const roundToStep = (tokens: number) => Math.round(tokens / STEP_TOKENS) * STEP_TOKENS;

const clampToBounds = (tokens: number, bounds: CompactAtBounds) =>
  Math.min(bounds.max, Math.max(bounds.min, tokens));

/**
 * Where the compact line sits and whether it is still waiting on the provider. The thread's own
 * point wins, held to what the provider accepts, since the provider applies it clamped; differing
 * from what the provider last applied means it has not picked it up yet. A provider that reports
 * no point (Codex on its built-in default) still gets a line to drag, at the top of its range and
 * marked `unreported`, since where it really compacts is unknown.
 */
export function resolveCompactLine(input: {
  readonly threadCompactAt: number | null | undefined;
  readonly appliedThreshold: number | null | undefined;
  readonly bounds: CompactAtBounds | null;
}): { readonly position: number | null; readonly pending: boolean; readonly unreported: boolean } {
  const { threadCompactAt, appliedThreshold, bounds } = input;
  if (threadCompactAt != null) {
    const position = bounds === null ? threadCompactAt : clampToBounds(threadCompactAt, bounds);
    return { position, pending: position !== appliedThreshold, unreported: false };
  }
  if (appliedThreshold != null)
    return { position: appliedThreshold, pending: false, unreported: false };
  return { position: bounds?.max ?? null, pending: false, unreported: bounds !== null };
}

/** The compact-at value under the pointer, rounded to a step and kept inside the provider's range. */
export function compactAtFromPointer(input: {
  /** Pointer distance from the track's left edge, in pixels. */
  readonly offsetX: number;
  readonly trackWidth: number;
  readonly maxTokens: number;
  readonly bounds: CompactAtBounds;
}): number {
  const { offsetX, trackWidth, maxTokens, bounds } = input;
  if (trackWidth <= 0) return bounds.min;
  const share = Math.min(1, Math.max(0, offsetX / trackWidth));
  return clampToBounds(roundToStep(share * maxTokens), bounds);
}

/** One arrow-key step from `current`: 1% of the window, 5% with shift. */
export function nudgeCompactAt(input: {
  readonly current: number;
  readonly direction: 1 | -1;
  readonly large: boolean;
  readonly maxTokens: number;
  readonly bounds: CompactAtBounds;
}): number {
  const { current, direction, large, maxTokens, bounds } = input;
  const step = Math.max(STEP_TOKENS, roundToStep(maxTokens * (large ? 0.05 : 0.01)));
  return clampToBounds(roundToStep(current + direction * step), bounds);
}

/** A second tap on the line this soon after the first counts as a double-tap. */
const DOUBLE_TAP_MS = 350;

export const isDoubleTap = (previousTapAt: number | null, now: number) =>
  previousTapAt !== null && now - previousTapAt <= DOUBLE_TAP_MS;
