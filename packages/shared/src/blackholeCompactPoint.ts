/** pi-blackhole's built-in "default" compaction curve (om/model-budget.ts): share of the window. */
const DEFAULT_PRESET = [
  { window: 32_768, ratio: 0.9 },
  { window: 131_072, ratio: 0.8 },
  { window: 262_144, ratio: 0.7 },
  { window: 1_048_576, ratio: 0.4 },
] as const;

function presetRatioForWindow(window: number): number {
  const first = DEFAULT_PRESET[0];
  const last = DEFAULT_PRESET[DEFAULT_PRESET.length - 1]!;
  if (window <= first.window) return first.ratio;
  if (window >= last.window) return last.ratio;
  for (let index = 0; index < DEFAULT_PRESET.length - 1; index++) {
    const from = DEFAULT_PRESET[index]!;
    const to = DEFAULT_PRESET[index + 1]!;
    if (window < from.window || window > to.window) continue;
    return (
      from.ratio + ((window - from.window) / (to.window - from.window)) * (to.ratio - from.ratio)
    );
  }
  return last.ratio;
}

/**
 * Where Blackhole compacts a thread: its set point when it has one, else pi-blackhole's default
 * curve over the model's window. Undefined when neither is known.
 */
export function blackholeCompactPoint(input: {
  readonly compactAt: number | null | undefined;
  readonly windowTokens: number | null | undefined;
}): number | undefined {
  if (input.compactAt != null && input.compactAt > 0) return Math.floor(input.compactAt);
  const window = input.windowTokens;
  if (window == null || !Number.isFinite(window) || window <= 0) return undefined;
  return Math.max(1, Math.floor(window * presetRatioForWindow(window)));
}

/**
 * The harness's own auto-compact point when Blackhole compacts first: far enough past
 * Blackhole's that one turn overrunning it is rescued, never past the window's end.
 */
export function nativeBackstopPoint(input: {
  readonly blackholePoint: number;
  readonly windowTokens: number | null | undefined;
}): number {
  const window = input.windowTokens;
  const margin =
    window == null || window <= 0 ? 32_000 : Math.max(16_000, Math.floor(window * 0.1));
  const backstop = input.blackholePoint + margin;
  return window == null || window <= 0 ? backstop : Math.min(backstop, window);
}
