// Changes closer together than this are one event, such as a toast animating in.
const BURST_GAP_MS = 150;

export type FrameTime = { readonly timestampMs: number; readonly changed: boolean };

type Burst = { readonly firstMs: number; readonly lastMs: number; readonly size: number };

function burstsOf(changesMs: ReadonlyArray<number>): ReadonlyArray<Burst> {
  const bursts: Array<{ firstMs: number; lastMs: number; size: number }> = [];
  for (const timestampMs of changesMs) {
    const burst = bursts.at(-1);
    if (burst && timestampMs - burst.lastMs <= BURST_GAP_MS) {
      burst.lastMs = timestampMs;
      burst.size += 1;
    } else bursts.push({ firstMs: timestampMs, lastMs: timestampMs, size: 1 });
  }
  return bursts;
}

/**
 * Picks `count` frame times in `[startMs, endMs]`. Evenly spaced frames miss anything
 * shorter than the gap between them, so the start and end of each burst of screen change
 * are taken first, largest bursts first, and the remaining slots go where the picks are
 * furthest apart. Without changes this is plain even spacing.
 */
export function pickFrameTimes(input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly count: number;
  /** Ascending timestamps of frames that differ from the one before. */
  readonly changesMs: ReadonlyArray<number>;
}): Array<FrameTime> {
  const { startMs, endMs, count } = input;
  const grid = Array.from({ length: count }, (_, i) =>
    count === 1 ? startMs : startMs + (i * (endMs - startMs)) / (count - 1),
  );
  const bursts = burstsOf(
    input.changesMs.filter((timestampMs) => timestampMs > startMs && timestampMs < endMs),
  );
  if (count < 3 || bursts.length === 0)
    return grid.map((timestampMs) => ({ timestampMs, changed: false }));

  const picks: Array<FrameTime> = [
    { timestampMs: startMs, changed: false },
    { timestampMs: endMs, changed: false },
  ];
  const distanceToPicks = (timestampMs: number) =>
    Math.min(...picks.map((pick) => Math.abs(pick.timestampMs - timestampMs)));
  const byImportance = bursts.toSorted((a, b) => b.size - a.size || a.firstMs - b.firstMs);
  for (const burst of byImportance) {
    for (const timestampMs of new Set([burst.firstMs, burst.lastMs])) {
      if (picks.length < count && distanceToPicks(timestampMs) >= 1)
        picks.push({ timestampMs, changed: true });
    }
  }
  while (picks.length < count) {
    const next = grid.reduce((best, candidate) =>
      distanceToPicks(candidate) > distanceToPicks(best) ? candidate : best,
    );
    picks.push({ timestampMs: next, changed: false });
  }
  return picks.toSorted((a, b) => a.timestampMs - b.timestampMs);
}
