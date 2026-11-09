import type {
  ModelSelection,
  OrchestrationV2ProviderTurnTokenUsage,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  chooseCompactionModel,
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
 * How a Claude `/compact` turn is summarised: `conversation` (its own model, in place), `provider`
 * (a chosen model on this account), `summary` (a chosen model on another account, written by T3),
 * `choreWorker` (no model set and a cold cache: the chore worker's models write the summary, or
 * the conversation's model when it has none) or `windowTooSmall` (the chosen model was passed over).
 */
export type ClaudeCompactionPlan =
  | { readonly kind: "conversation" }
  | { readonly kind: "windowTooSmall" }
  | { readonly kind: "choreWorker" }
  | { readonly kind: "provider"; readonly modelSelection: ModelSelection }
  | { readonly kind: "summary"; readonly modelSelection: ModelSelection };

export function planClaudeCompaction(input: {
  readonly setting: {
    readonly model: string;
    readonly instanceId: ProviderInstanceId;
    readonly onlyWhenCold: boolean;
  };
  /** The account the conversation runs on, which compacts its own session. */
  readonly runInstanceId: ProviderInstanceId;
  /** The conversation's selection, which the run and the thread keep. */
  readonly modelSelection: ModelSelection;
  readonly usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage>;
  readonly nowMs: number;
}): ClaudeCompactionPlan {
  const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
  const sameAccount = input.setting.instanceId === input.runInstanceId;
  const chosenModel = sameAccount
    ? resolveClaudeModelSlug(catalog, input.setting.model.trim())
    : input.setting.model.trim();
  const latest = input.usages.reduce<OrchestrationV2ProviderTurnTokenUsage | undefined>(
    (current, usage) =>
      current === undefined || Date.parse(usage.updatedAt) > Date.parse(current.updatedAt)
        ? usage
        : current,
    undefined,
  );
  const choice = chooseCompactionModel({
    setting: { model: chosenModel, onlyWhenCold: input.setting.onlyWhenCold },
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
    sameAccount,
  });
  if (choice.choreWorker) return { kind: "choreWorker" };
  if (choice.model === null) {
    return choice.windowTooSmall ? { kind: "windowTooSmall" } : { kind: "conversation" };
  }
  if (choice.crossAccount) {
    return {
      kind: "summary",
      modelSelection: {
        instanceId: input.setting.instanceId,
        model: choice.model,
      },
    };
  }
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: getClaudeCatalogModelCapabilities(catalog, choice.model),
      selections: input.modelSelection.options,
    }),
    input.modelSelection.options,
  );
  return {
    kind: "provider",
    modelSelection: {
      instanceId: input.modelSelection.instanceId,
      model: choice.model,
      ...(options === undefined ? {} : { options }),
    },
  };
}
