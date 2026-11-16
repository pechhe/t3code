/**
 * Where the permissions chip shows, whether the mode block overflows, and which control answers
 * the composer.mode shortcut. The model picker's footer always holds Permissions, so the chip
 * only shows while the mode differs from the default. The rule: composer.mode has one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const accessDisplay = input.matchesDefault
    ? ("hidden" as const)
    : input.collapsed
      ? ("icon" as const)
      : ("label" as const);
  const showModeBlock = accessDisplay !== "hidden";
  const blockIds = showModeBlock ? (["stance", "mode"] as const) : (["stance"] as const);
  const clampedHiddenCount = Math.max(0, Math.min(blockIds.length, input.measuredHiddenBlockCount));
  const hiddenBlockIds = blockIds.slice(blockIds.length - clampedHiddenCount);
  const overflowShowsPermissions = hiddenBlockIds.includes("mode");
  const overflowShowsStance = hiddenBlockIds.includes("stance");
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    overflowShowsPermissions,
    overflowShowsStance,
    /** Without a visible chip or an overflow menu holding it, the model picker answers composer.mode. */
    pickerOwnsModeShortcut:
      !overflowShowsPermissions && (accessDisplay === "hidden" || !showModeBlock),
  };
}
