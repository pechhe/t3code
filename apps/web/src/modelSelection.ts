import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  type CustomModelDefinition,
  createModelSelection,
  normalizeCustomModelSlug,
  readCustomModelEntries,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import {
  firstAccount,
  pooledKeyOfFavorite,
  pooledModels,
  selectionOnAccount,
} from "@t3tools/shared/accountPools";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { type ClientSettings, UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  getDefaultServerModel,
  getProviderModels,
  hasRuntimeModelCatalog,
  isRuntimeModelDefaultAlias,
  resolveSelectableProvider,
} from "./providerModels";
import { ModelEsque } from "./components/chat/providerIconUtils";
import {
  type ProviderInstanceEntry,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
  entryAnswersTo,
} from "./providerInstances";
import { sortModelsForProviderInstance } from "./modelOrdering";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";

export const MAX_CUSTOM_MODEL_LENGTH = 256;
const DEFAULT_TEXT_GENERATION_INSTANCE_ID = ProviderInstanceId.make("codex");

// Legacy per-driver buckets would leak custom-instance models into stock instances.
export function readInstanceCustomModels(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
): ReadonlyArray<CustomModelDefinition> {
  if (driverKind === "antigravity") return [];
  const instance = settings.providerInstances?.[instanceId];
  const config = instance?.config;
  if (config !== null && typeof config === "object") {
    const value = (config as Record<string, unknown>).customModels;
    if (Array.isArray(value)) {
      return readCustomModelEntries(value);
    }
  }
  return [];
}

export interface AppModelOption {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  aliases?: ReadonlyArray<string>;
  badge?: "new";
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  isUnavailable?: boolean;
}

function appendUnavailableDynamicModelSelection(
  options: AppModelOption[],
  rawModels: ReadonlyArray<ServerProvider["models"][number]>,
  provider: ProviderDriverKind,
  selectedModel: string | null | undefined,
  hiddenModels: ReadonlyArray<string>,
): AppModelOption[] {
  if (!hasRuntimeModelCatalog(provider)) return options;
  const slug = normalizeCustomModelSlug(selectedModel);
  if (!slug) return options;
  if (isRuntimeModelDefaultAlias(provider, slug)) return options;

  if (resolveSelectableModel(provider, slug, rawModels) !== null) return options;
  if (hiddenModels.includes(slug)) return options;
  if (options.some((option) => option.slug === slug)) return options;

  return [...options, { slug, name: slug, isCustom: false, isUnavailable: true }];
}

function toAppModelOption(
  model: ServerProvider["models"][number],
  driverKind: ProviderDriverKind,
): AppModelOption {
  const option: AppModelOption = {
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom,
  };
  const shortName = resolveModelShortName(model, driverKind);
  if (shortName) option.shortName = shortName;
  if (model.subProvider) option.subProvider = model.subProvider;
  if (model.aliases) option.aliases = model.aliases;
  if (model.badge) option.badge = model.badge;
  if (model.isDefault) option.isDefault = true;
  if (model.isLegacy) option.isLegacy = true;
  return option;
}

function readInstanceModelPreferences(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
): { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> } {
  return (
    settings.providerModelPreferences?.[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    }
  );
}

function applyInstanceModelPreferences(
  options: ReadonlyArray<AppModelOption>,
  preferences: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): AppModelOption[] {
  const hiddenModels = new Set(preferences.hiddenModels);
  return sortModelsForProviderInstance(
    options.filter((option) => option.isCustom || !hiddenModels.has(option.slug)),
    { modelOrder: preferences.modelOrder },
  );
}

function normalizeCustomModelEntries(
  models: ReadonlyArray<CustomModelDefinition>,
  builtInModelSlugs: ReadonlySet<string>,
): CustomModelDefinition[] {
  const normalizedModels: CustomModelDefinition[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    if (
      candidate.slug.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(candidate.slug) ||
      seen.has(candidate.slug)
    ) {
      continue;
    }

    seen.add(candidate.slug);
    normalizedModels.push(candidate);
  }

  return normalizedModels;
}

function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const rawModels = getProviderModels(providers, provider);
  // Server custom-model snapshots can lag removals; rebuild custom rows from settings.
  const options: AppModelOption[] = rawModels
    .filter((model) => !model.isCustom)
    .map((model) => toAppModelOption(model, provider));
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(getProviderModels(providers, provider), (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  const customModels = readInstanceCustomModels(settings, defaultInstanceId, provider);
  for (const entry of normalizeCustomModelEntries(customModels, builtInModelSlugs)) {
    if (seen.has(entry.slug)) {
      continue;
    }

    seen.add(entry.slug);
    const shortName = resolveModelShortName(entry, provider);
    options.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      ...(shortName ? { shortName } : {}),
    });
  }

  const preferences = readInstanceModelPreferences(settings, defaultInstanceId);
  return appendUnavailableDynamicModelSelection(
    applyInstanceModelPreferences(options, preferences),
    rawModels,
    provider,
    selectedModel,
    preferences.hiddenModels,
  );
}

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = entry.models
    .filter((model) => !model.isCustom)
    .map((model) => toAppModelOption(model, entry.driverKind));
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(entry.models, (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const customModels = readInstanceCustomModels(settings, entry.instanceId, entry.driverKind);
  for (const custom of normalizeCustomModelEntries(customModels, builtInModelSlugs)) {
    if (seen.has(custom.slug)) {
      continue;
    }

    seen.add(custom.slug);
    const shortName = resolveModelShortName(custom, entry.driverKind);
    options.push({
      slug: custom.slug,
      name: custom.name,
      isCustom: true,
      ...(shortName ? { shortName } : {}),
    });
  }

  const preferences = readInstanceModelPreferences(settings, entry.instanceId);
  return appendUnavailableDynamicModelSelection(
    applyInstanceModelPreferences(options, preferences),
    entry.models,
    entry.driverKind,
    selectedModel,
    preferences.hiddenModels,
  );
}

export function resolveAppModelSelection(
  provider: ProviderDriverKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function resolveAppModelSelectionForInstance(
  instanceId: ProviderInstanceId,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
  resolutionOptions?: { readonly preserveUnavailableSelection?: boolean },
): string | null {
  const entry = deriveProviderInstanceEntries(providers).find((candidate) =>
    entryAnswersTo(candidate, instanceId),
  );
  if (!entry) return null;
  const options = getAppModelOptionsForInstance(
    settings,
    entry,
    resolutionOptions?.preserveUnavailableSelection ? selectedModel : null,
  );
  const resolvedSelection = resolveSelectableModel(entry.driverKind, selectedModel, options);
  if (resolvedSelection) {
    return resolvedSelection;
  }
  if (resolutionOptions?.preserveUnavailableSelection && hasRuntimeModelCatalog(entry.driverKind)) {
    const unavailableSelection = normalizeCustomModelSlug(selectedModel);
    const hiddenModels = readInstanceModelPreferences(settings, entry.instanceId).hiddenModels;
    if (
      unavailableSelection &&
      !hiddenModels.includes(unavailableSelection) &&
      resolveSelectableModel(entry.driverKind, selectedModel, entry.models) === null &&
      !isRuntimeModelDefaultAlias(entry.driverKind, unavailableSelection)
    ) {
      return unavailableSelection;
    }
  }
  return options.find((option) => option.isDefault)?.slug ?? options[0]?.slug ?? null;
}

// New drafts carry the stored selection; capabilities resolve its raw options later.
export function resolveEffectiveDefaultModelSelection(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ModelSelection {
  const model = resolveAppModelSelectionForInstance(
    selection.instanceId,
    settings,
    providers,
    selection.model,
    { preserveUnavailableSelection: true },
  );
  return model === null || model === selection.model ? selection : { ...selection, model };
}

/**
 * The composer's first slot: the first favourite whose provider this project can still run and
 * which still supplies that model. It is what a new thread starts on, so it deliberately skips a
 * favourite the slider still shows as a detent under a provider that cannot run here.
 */
export function resolveFirstFavoriteModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
  projectId: ProjectId | null,
): ModelSelection | null {
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const runnable = (instanceId: string) =>
    entries.some((entry) => entry.instanceId === instanceId && entry.enabled && entry.isAvailable);
  for (const favorite of settings.favorites) {
    const pooledKey = pooledKeyOfFavorite(favorite);
    if (pooledKey !== undefined) {
      // A pooled favourite starts where the model's account order would, among accounts here.
      const pool = pooledModels(providers, settings).find((model) => model.key === pooledKey);
      const first =
        pool === undefined
          ? undefined
          : firstAccount(
              {
                ...pool,
                accounts: pool.accounts.filter((entry) => runnable(entry.provider.instanceId)),
              },
              settings.accountSkips,
              Date.now(),
            );
      if (first !== undefined) return selectionOnAccount(first, undefined);
      continue;
    }
    const entry = entries.find((candidate) => candidate.instanceId === favorite.provider);
    if (!entry?.enabled || !entry.isAvailable) continue;
    const option = resolveModelPickerSelectedModel({
      driverKind: entry.driverKind,
      model: favorite.model,
      options: getAppModelOptionsForInstance(settings, entry, null),
    });
    if (option !== undefined) return { instanceId: entry.instanceId, model: option.slug };
  }
  return null;
}

/** Where a new thread starts: the composer's first slot, else the first provider's own default. */
export function resolveAutomaticDefaultModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
  projectId: ProjectId | null,
): ModelSelection | null {
  return (
    resolveFirstFavoriteModelSelection(providers, settings, projectId) ??
    resolveProjectDefaultProviderModelSelection(providers, settings, projectId)
  );
}

export function defaultModelSelectionsAreMixed(
  clientSettings: ClientSettings,
  targets: ReadonlyArray<{
    projectId: ProjectId | null;
    settings: ServerSettings;
    providers: ReadonlyArray<ServerProvider>;
  }>,
): boolean {
  const selections = targets.map(({ projectId, settings, providers }) => {
    const stored = settings.defaultModelSelection;
    const merged = {
      ...clientSettings,
      ...settings,
      ...resolveModelPreferences(settings, clientSettings),
    };
    const selection =
      stored === null
        ? resolveAutomaticDefaultModelSelection(providers, merged, projectId)
        : resolveDefaultProviderModelSelection(providers, stored);
    return {
      stored,
      effective: selection
        ? resolveEffectiveDefaultModelSelection(merged, providers, selection)
        : null,
    };
  });
  return selections.some((selection) => !Equal.equals(selection, selections[0]));
}

export function getCustomModelOptionsByInstance(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedInstanceId?: ProviderInstanceId | null,
  selectedModel?: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
  for (const entry of deriveProviderInstanceEntries(providers)) {
    out.set(
      entry.instanceId,
      getAppModelOptionsForInstance(
        settings,
        entry,
        entry.instanceId === selectedInstanceId ? selectedModel : null,
      ),
    );
  }
  return out;
}

function getTextGenerationModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
  selectedModel?: string | null,
): AppModelOption[] {
  const unsupported = new Set(
    entry.models
      .filter((model) => model.supportsTextGeneration === false)
      .map((model) => model.slug),
  );
  // Filter after custom entries are rebuilt so a display-name override cannot restore a model.
  return getAppModelOptionsForInstance(settings, entry, selectedModel).filter(
    (option) => !unsupported.has(option.slug),
  );
}

export function getTextGenerationModelOptionsByInstance(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedInstanceId?: ProviderInstanceId | null,
  selectedModel?: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  return new Map(
    deriveProviderInstanceEntries(
      providers.filter((provider) => provider.supportsTextGeneration !== false),
    ).map((entry) => [
      entry.instanceId,
      getTextGenerationModelOptionsForInstance(
        settings,
        entry,
        entry.instanceId === selectedInstanceId ? selectedModel : null,
      ),
    ]),
  );
}

export function selectsPlanAgent(options: ModelSelection["options"]): boolean {
  return options?.some((option) => option.id === "agent" && option.value === "plan") ?? false;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    instanceId: DEFAULT_TEXT_GENERATION_INSTANCE_ID,
    model: DEFAULT_TEXT_GENERATION_MODEL,
  };
  const supportedProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const entries = deriveProviderInstanceEntries(supportedProviders);
  const selectedEntry = entries.find(
    (entry) => entryAnswersTo(entry, selection.instanceId) && entry.enabled && entry.isAvailable,
  );
  const entry =
    selectedEntry ?? entries.find((candidate) => candidate.enabled && candidate.isAvailable);
  if (entry) {
    const selectedModel = selectedEntry ? selection.model : null;
    // Use the cheap generation default; the catalog default is the expensive chat flagship.
    const options = getTextGenerationModelOptionsForInstance(settings, entry);
    const model =
      resolveSelectableModel(entry.driverKind, selectedModel, options) ??
      resolveSelectableModel(
        entry.driverKind,
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind],
        options,
      ) ??
      options.find((option) => option.isDefault)?.slug ??
      options[0]?.slug ??
      entry.models.find((model) => model.supportsTextGeneration !== false)?.slug ??
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind];
    if (!model) {
      return createModelSelection(entry.instanceId, "", []);
    }
    const provider = entry.driverKind;
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider,
      model,
      models: entry.models,
      modelOptions: selectedEntry ? selection.options : undefined,
      includePlanAgent: selectsPlanAgent(selection.options),
    });

    return createModelSelection(entry.instanceId, model, modelOptionsForDispatch);
  }

  return NO_PROVIDER_MODEL_SELECTION;
}
