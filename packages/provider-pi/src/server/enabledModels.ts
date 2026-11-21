// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pi's `/scoped-models` selection lives in `<agentDir>/settings.json` as `enabledModels`.
 * Linking it with T3's per-instance Pi model preferences keeps new provider catalog additions
 * hidden unless enabled in Pi, while edits in either UI update the other.
 */
import type {
  ProviderInstanceId,
  ServerProviderModel,
  ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import {
  decodeJsonOption,
  piAgentDirectory,
  readText,
  serializeSettings,
  withSettingsLock,
  writeFile,
} from "./compaction.ts";

const PI_DEFAULT_MODEL_SLUG = "default";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function splitThinkingSuffix(pattern: string): {
  readonly base: string;
  readonly thinkingLevel?: string | undefined;
} {
  const colonIndex = pattern.lastIndexOf(":");
  if (colonIndex <= 0) return { base: pattern };
  const suffix = pattern.slice(colonIndex + 1).toLowerCase();
  if (!THINKING_LEVELS.has(suffix)) return { base: pattern };
  return { base: pattern.slice(0, colonIndex), thinkingLevel: suffix };
}

function isGlobPattern(pattern: string): boolean {
  const { base } = splitThinkingSuffix(pattern.trim());
  return base.includes("*") || base.includes("?");
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += "$";
  return new RegExp(source, "i");
}

function modelIdOf(model: Pick<ServerProviderModel, "slug" | "subProvider">): string {
  if (model.subProvider && model.slug.startsWith(`${model.subProvider}/`)) {
    return model.slug.slice(model.subProvider.length + 1);
  }
  const slash = model.slug.indexOf("/");
  return slash >= 0 ? model.slug.slice(slash + 1) : model.slug;
}

/**
 * Matches one `enabledModels` entry against a discovered Pi model slug. Supports exact
 * `provider/id`, bare `id`, optional `:thinkingLevel` suffixes and simple `*`/`?` globs.
 */
export function matchesPiEnabledModelPattern(
  pattern: string,
  model: Pick<ServerProviderModel, "slug" | "subProvider">,
): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "" || model.slug === PI_DEFAULT_MODEL_SLUG) return false;
  const { base } = splitThinkingSuffix(trimmed);
  const lowerBase = base.toLowerCase();
  const lowerSlug = model.slug.toLowerCase();
  const lowerModelId = modelIdOf(model).toLowerCase();
  if (lowerBase === lowerSlug || lowerBase === lowerModelId) return true;
  if (base.includes("*") || base.includes("?")) {
    const regex = globToRegExp(base);
    return regex.test(model.slug) || regex.test(modelIdOf(model));
  }
  return false;
}

function decodePiEnabledModels(raw: unknown): ReadonlyArray<string> | null {
  if (!isRecord(raw)) return null;
  const value = raw["enabledModels"];
  if (!Array.isArray(value)) return null;
  const patterns = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  // Pi treats an empty `enabledModels` array as unscoped (all models enabled).
  return patterns.length > 0 ? patterns : null;
}

function parseStrictSettingsRoot(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined || text.trim() === "") return {};
  const parsed = decodeJsonOption(text);
  return Option.isSome(parsed) && isRecord(parsed.value) ? { ...parsed.value } : null;
}

export function parsePiEnabledModels(text: string | undefined): ReadonlyArray<string> | null {
  const root = parseStrictSettingsRoot(text);
  return root === null ? null : decodePiEnabledModels(root);
}

const readPiEnabledModels = Effect.fn("readPiEnabledModels")(function* (agentDir: string) {
  const text = yield* readText(NodePath.join(agentDir, "settings.json"));
  return parsePiEnabledModels(text);
});

export interface PiScopedModelResolution {
  readonly enabledSlugs: ReadonlyArray<string>;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
}

/**
 * Resolves Pi's `enabledModels` against T3's discovered Pi models into the `hiddenModels` and
 * `modelOrder` preferences T3 stores on the Pi instance. Returns null when Pi has no scope set.
 */
export function resolvePiModelPreferencesFromEnabledModels(input: {
  readonly enabledModels: ReadonlyArray<string> | null;
  readonly discoveredModels: ReadonlyArray<
    Pick<ServerProviderModel, "slug" | "subProvider" | "isCustom">
  >;
  readonly currentPreferences?:
    | {
        readonly hiddenModels: ReadonlyArray<string>;
        readonly modelOrder: ReadonlyArray<string>;
      }
    | undefined;
}): PiScopedModelResolution | null {
  const { enabledModels, discoveredModels, currentPreferences } = input;
  if (enabledModels === null || enabledModels.length === 0) return null;
  const builtInModels = discoveredModels.filter(
    (model) => !model.isCustom && model.slug !== PI_DEFAULT_MODEL_SLUG,
  );
  if (builtInModels.length === 0) return null;

  const enabledSlugs: Array<string> = [];
  const enabledSet = new Set<string>();
  for (const pattern of enabledModels) {
    for (const model of builtInModels) {
      if (!enabledSet.has(model.slug) && matchesPiEnabledModelPattern(pattern, model)) {
        enabledSet.add(model.slug);
        enabledSlugs.push(model.slug);
      }
    }
  }

  // Shared setup syncs these preferences between machines whose Pi catalogs differ, so Pi's file
  // only decides models discovered here; every other entry keeps its place.
  const discoveredSet = new Set(builtInModels.map((model) => model.slug));
  const hiddenModels = (currentPreferences?.hiddenModels ?? []).filter(
    (slug) => !discoveredSet.has(slug) || !enabledSet.has(slug),
  );
  const hiddenSet = new Set(hiddenModels);
  for (const model of builtInModels) {
    if (!enabledSet.has(model.slug) && !hiddenSet.has(model.slug)) {
      hiddenModels.push(model.slug);
    }
  }

  // Enabled models take Pi's order within the slots they already hold; new ones go at the end.
  const existingOrder = [...new Set(currentPreferences?.modelOrder ?? [])];
  const existingSet = new Set(existingOrder);
  const reordered = enabledSlugs.filter((slug) => existingSet.has(slug));
  let next = 0;
  const modelOrder = existingOrder.map((slug) =>
    enabledSet.has(slug) ? reordered[next++]! : slug,
  );
  modelOrder.push(...enabledSlugs.filter((slug) => !existingSet.has(slug)));

  return { enabledSlugs, hiddenModels, modelOrder };
}

/**
 * Derives Pi's `enabledModels` from T3's Pi preferences, preserving `:thinkingLevel` suffixes,
 * intact glob patterns and patterns that match no currently discovered model. Null means unscoped.
 */
export function buildPiEnabledModelsFromPreferences(input: {
  readonly existingEnabledModels: ReadonlyArray<string> | null;
  readonly discoveredModels: ReadonlyArray<
    Pick<ServerProviderModel, "slug" | "subProvider" | "isCustom">
  >;
  readonly preferences: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  };
  readonly favoriteModels?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> | null {
  const builtInModels = input.discoveredModels.filter(
    (model) => !model.isCustom && model.slug !== PI_DEFAULT_MODEL_SLUG,
  );
  if (builtInModels.length === 0) return input.existingEnabledModels;

  const hiddenSet = new Set(input.preferences.hiddenModels);
  for (const favorite of input.favoriteModels ?? []) {
    hiddenSet.delete(favorite);
  }

  const orderRank = new Map(
    input.preferences.modelOrder.map((slug, index) => [slug, index] as const),
  );
  const discoveryRank = new Map(builtInModels.map((model, index) => [model.slug, index] as const));
  const enabledBuiltIns = builtInModels
    .filter((model) => !hiddenSet.has(model.slug))
    .toSorted((left, right) => {
      const leftOrder = orderRank.get(left.slug) ?? Number.POSITIVE_INFINITY;
      const rightOrder = orderRank.get(right.slug) ?? Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return (discoveryRank.get(left.slug) ?? 0) - (discoveryRank.get(right.slug) ?? 0);
    });
  const enabledSlugSet = new Set(enabledBuiltIns.map((model) => model.slug));

  if (enabledBuiltIns.length === builtInModels.length && input.existingEnabledModels === null) {
    return null;
  }

  const thinkingBySlug = new Map<string, string>();
  const unmatchedPatterns: Array<string> = [];
  const globByFirstSlug = new Map<string, string>();
  const globCoveredSlugs = new Set<string>();

  for (const pattern of input.existingEnabledModels ?? []) {
    const matched = builtInModels.filter((model) => matchesPiEnabledModelPattern(pattern, model));
    if (matched.length === 0) {
      if (!unmatchedPatterns.includes(pattern)) unmatchedPatterns.push(pattern);
      continue;
    }
    if (isGlobPattern(pattern) && matched.every((model) => enabledSlugSet.has(model.slug))) {
      const firstEnabled = enabledBuiltIns.find((model) =>
        matched.some((candidate) => candidate.slug === model.slug),
      );
      if (firstEnabled !== undefined && !globByFirstSlug.has(firstEnabled.slug)) {
        globByFirstSlug.set(firstEnabled.slug, pattern);
      }
      for (const model of matched) {
        globCoveredSlugs.add(model.slug);
      }
      continue;
    }
    const { thinkingLevel } = splitThinkingSuffix(pattern.trim());
    if (thinkingLevel !== undefined) {
      for (const model of matched) {
        if (!thinkingBySlug.has(model.slug)) thinkingBySlug.set(model.slug, thinkingLevel);
      }
    }
  }

  if (
    enabledBuiltIns.length === builtInModels.length &&
    unmatchedPatterns.length === 0 &&
    thinkingBySlug.size === 0 &&
    globByFirstSlug.size === 0
  ) {
    return null;
  }

  const nextPatterns: Array<string> = [];
  for (const model of enabledBuiltIns) {
    const globPattern = globByFirstSlug.get(model.slug);
    if (globPattern !== undefined) {
      if (!nextPatterns.includes(globPattern)) nextPatterns.push(globPattern);
      continue;
    }
    if (globCoveredSlugs.has(model.slug)) continue;
    const thinking = thinkingBySlug.get(model.slug);
    const entry = thinking === undefined ? model.slug : `${model.slug}:${thinking}`;
    if (!nextPatterns.includes(entry)) nextPatterns.push(entry);
  }
  for (const unmatched of unmatchedPatterns) {
    if (!nextPatterns.includes(unmatched)) nextPatterns.push(unmatched);
  }
  return nextPatterns;
}

/**
 * Writes `enabledModels` into `<agentDir>/settings.json` under the Pi settings lock when it
 * differs from what the file currently holds. `null` deletes the `enabledModels` key.
 * Refuses to overwrite an existing settings file whose JSON is malformed.
 */
export const writePiEnabledModels = Effect.fn("writePiEnabledModels")(function* (input: {
  readonly agentDir: string;
  readonly enabledModels: ReadonlyArray<string> | null;
}) {
  const settingsPath = NodePath.join(input.agentDir, "settings.json");
  const result = yield* withSettingsLock(
    NodePath.join(input.agentDir, ".t3-compaction.lock"),
    Effect.gen(function* () {
      const text = yield* readText(settingsPath);
      const root = parseStrictSettingsRoot(text);
      if (root === null) return false;
      const current = decodePiEnabledModels(root);
      if (Equal.equals(current, input.enabledModels)) {
        return false;
      }
      if (input.enabledModels === null) {
        delete root["enabledModels"];
      } else {
        root["enabledModels"] = [...input.enabledModels];
      }
      return yield* writeFile(settingsPath, serializeSettings(root));
    }),
  );
  return result ?? false;
});

/**
 * Reconciles T3's `providerModelPreferences[instanceId]` with Pi's `<agentDir>/settings.json`
 * `enabledModels`. Called after Pi model discovery and when T3's model preferences change.
 */
export const reconcilePiScopedModels = Effect.fn("reconcilePiScopedModels")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly discoveredModels: ReadonlyArray<ServerProviderModel>;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettings?:
    | ((patch: {
        readonly providerModelPreferences: NonNullable<ServerSettings["providerModelPreferences"]>;
      }) => Effect.Effect<ServerSettings, ServerSettingsError>)
    | undefined;
  readonly direction: "from-pi" | "to-pi";
}) {
  const agentDir = piAgentDirectory(input.environment);
  if (agentDir === null) return false;
  const builtInModels = input.discoveredModels.filter(
    (model) => !model.isCustom && model.slug !== PI_DEFAULT_MODEL_SLUG,
  );
  if (builtInModels.length === 0) return false;

  const settings = yield* input.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (settings === undefined) return false;
  const currentPrefs = settings.providerModelPreferences?.[input.instanceId];

  if (input.direction === "from-pi") {
    if (input.updateSettings === undefined) return false;
    const enabledModels = yield* readPiEnabledModels(agentDir);
    const resolved = resolvePiModelPreferencesFromEnabledModels({
      enabledModels,
      discoveredModels: input.discoveredModels,
      currentPreferences: currentPrefs,
    });
    if (resolved === null) return false;
    const sameHidden =
      currentPrefs !== undefined &&
      currentPrefs.hiddenModels.length === resolved.hiddenModels.length &&
      currentPrefs.hiddenModels.every((slug, index) => slug === resolved.hiddenModels[index]);
    const sameOrder =
      currentPrefs !== undefined &&
      currentPrefs.modelOrder.length === resolved.modelOrder.length &&
      currentPrefs.modelOrder.every((slug, index) => slug === resolved.modelOrder[index]);
    if (sameHidden && sameOrder) return false;

    const nextPreferences = {
      ...settings.providerModelPreferences,
      [input.instanceId]: {
        ...currentPrefs,
        hiddenModels: [...resolved.hiddenModels],
        modelOrder: [...resolved.modelOrder],
      },
    };
    yield* input.updateSettings({ providerModelPreferences: nextPreferences }).pipe(Effect.ignore);
    return true;
  }

  if (currentPrefs === undefined) return false;
  const existingEnabledModels = yield* readPiEnabledModels(agentDir);
  const favoriteModels = (settings.favorites ?? [])
    .filter((favorite) => favorite.provider === input.instanceId)
    .map((favorite) => favorite.model);
  const nextEnabledModels = buildPiEnabledModelsFromPreferences({
    existingEnabledModels,
    discoveredModels: input.discoveredModels,
    preferences: currentPrefs,
    favoriteModels,
  });
  return yield* writePiEnabledModels({
    agentDir,
    enabledModels: nextEnabledModels,
  });
});
