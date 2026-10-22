import type { ModelSelection, OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  chooseClaudeCompactionModel,
  conversationPromptCacheExpiresAt,
} from "@t3tools/shared/claudeCompaction";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelSlug,
} from "../provider/ClaudeModelCatalog.ts";

/**
 * How a Claude `/compact` turn is summarised, or undefined when the conversation's own model does
 * it as always. The chosen model is selected with the conversation's reasoning options where it
 * accepts them and its own defaults where it does not.
 */
export function planClaudeCompaction(input: {
  readonly setting: { readonly model: string; readonly onlyWhenCold: boolean };
  /** The conversation's selection, which the run and the thread keep. */
  readonly modelSelection: ModelSelection;
  readonly usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage>;
  readonly nowMs: number;
}): ProviderAdapterV2TurnInput["compaction"] {
  const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
  const chosenModel = resolveClaudeModelSlug(catalog, input.setting.model.trim());
  const latest = input.usages.reduce<OrchestrationV2ProviderTurnTokenUsage | undefined>(
    (current, usage) =>
      current === undefined || Date.parse(usage.updatedAt) > Date.parse(current.updatedAt)
        ? usage
        : current,
    undefined,
  );
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: getClaudeCatalogModelCapabilities(catalog, chosenModel),
      selections: input.modelSelection.options,
    }),
    input.modelSelection.options,
  );
  const chosenSelection: ModelSelection = {
    instanceId: input.modelSelection.instanceId,
    model: chosenModel,
    ...(options === undefined ? {} : { options }),
  };
  const choice = chooseClaudeCompactionModel({
    setting: input.setting,
    conversationModel: resolveClaudeModelSlug(catalog, input.modelSelection.model),
    usedTokens: latest?.usedTokens ?? 0,
    promptCacheExpiresAt: conversationPromptCacheExpiresAt(input.usages),
    nowMs: input.nowMs,
    // The model's default window, which is all the web client can see (`ServerProviderModel`), so the
    // chip and the turn agree; the conversation's own window option never raises the guard.
    chosenWindowTokens: resolveClaudeCatalogContextWindowTokens(catalog, {
      instanceId: input.modelSelection.instanceId,
      model: chosenModel,
    }),
  });
  if (choice.model !== null) return { modelSelection: chosenSelection };
  return choice.windowTooSmall ? { windowTooSmall: true } : undefined;
}
