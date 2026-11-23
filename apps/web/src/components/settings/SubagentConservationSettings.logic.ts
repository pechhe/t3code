export interface ConservationDraft {
  readonly enabled: boolean;
  readonly threshold: string;
  readonly window: string;
  readonly models: readonly string[];
}

export interface SavedConservation {
  readonly enabled: boolean;
  readonly remainingPercent: number;
  readonly window: string;
  readonly models: readonly string[];
}

export type ConservationPlan =
  | { readonly kind: "save"; readonly rule: SavedConservation }
  | { readonly kind: "none" }
  | { readonly kind: "hold"; readonly message: string };

export const THRESHOLD_MESSAGE = "Enter a percentage between 1 and 99.";
export const MODELS_MESSAGE = "Select at least one model, or turn conservation off.";
export const ENABLE_MESSAGE =
  "Enter a threshold (1–99%) and select at least one model to enable conservation.";

function parseThreshold(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
}

/** What auto-save should do with the draft given the rule saved on the server. */
export function planConservationSave(
  draft: ConservationDraft,
  rule: SavedConservation | undefined,
): ConservationPlan {
  const typed = parseThreshold(draft.threshold);
  const remainingPercent = typed ?? (draft.enabled ? null : (rule?.remainingPercent ?? null));
  if (remainingPercent === null || (draft.enabled && draft.models.length === 0)) {
    if (!draft.enabled && !rule && draft.threshold.trim() === "") return { kind: "none" };
    const enabling = draft.enabled && !rule?.enabled;
    return {
      kind: "hold",
      message: enabling
        ? ENABLE_MESSAGE
        : remainingPercent === null
          ? THRESHOLD_MESSAGE
          : MODELS_MESSAGE,
    };
  }
  const next = {
    enabled: draft.enabled,
    remainingPercent,
    window: draft.window,
    models: draft.models,
  };
  const same =
    rule !== undefined &&
    rule.enabled === next.enabled &&
    rule.remainingPercent === next.remainingPercent &&
    rule.window === next.window &&
    JSON.stringify(rule.models) === JSON.stringify(next.models);
  return same ? { kind: "none" } : { kind: "save", rule: next };
}
