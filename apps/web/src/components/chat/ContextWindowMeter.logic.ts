import type {
  ModelSelection,
  OrchestrationV2ProviderTurnTokenUsage,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  chooseCompactionModel,
  conversationPromptCacheExpiresAt,
} from "@t3tools/shared/claudeCompaction";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

/**
 * The cheaper model that will summarise the next compaction, or null when the conversation's own
 * model does. The server decides with the same shared predicate, so this only labels the promise.
 */
export function resolveCompactionModelDisplayName(input: {
  readonly setting: {
    readonly model: string;
    readonly instanceId: ProviderInstanceId;
    readonly onlyWhenCold: boolean;
  };
  /** The account the conversation runs on, whose model compacts it in place. */
  readonly conversationInstanceId: ProviderInstanceId;
  /** The conversation's model, as the catalog names it. */
  readonly conversationModel: string;
  /** The chosen account's models. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage>;
  readonly usedTokens: number;
  readonly now: string;
}): string | null {
  const nowMs = Date.parse(input.now);
  const slug = input.setting.model.trim();
  const chosen = input.models.find((model) => model.slug === slug);
  if (!Number.isFinite(nowMs)) return null;
  const choice = chooseCompactionModel({
    setting: input.setting,
    conversationModel: input.conversationModel,
    usedTokens: input.usedTokens,
    promptCacheExpiresAt: conversationPromptCacheExpiresAt(input.usages),
    nowMs,
    chosenWindowTokens: chosen?.contextWindowTokens,
    sameAccount: input.setting.instanceId === input.conversationInstanceId,
  });
  if (choice.model === null) return null;
  // Another account can be offline, so its catalog may not list the model it would run.
  return chosen === undefined
    ? formatModelSlugName(choice.model)
    : getDisplayModelName(chosen, { preferShortName: true }).replace(/^Claude /, "");
}
export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
