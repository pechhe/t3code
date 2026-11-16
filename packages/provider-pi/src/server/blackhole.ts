// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Pi Blackhole's memory worker reads its model only from its own config file, once per Pi
 * process, so T3 writes the Utility model there before a session starts.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import {
  decodeJsonOption,
  parseSettingsRoot,
  readText,
  serializeSettings,
  withSettingsLock,
  writeFile,
} from "./compaction.ts";

export interface PiBlackholeModel {
  readonly provider: string;
  readonly id: string;
  readonly thinking?: string | undefined;
}

/** Records what T3 replaced and what it wrote, so clearing puts back only an untouched value. */
const OWNERSHIP_FILENAME = ".t3-model-override.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameModel = (current: unknown, desired: PiBlackholeModel): boolean =>
  isRecord(current) &&
  current["provider"] === desired.provider &&
  current["id"] === desired.id &&
  (desired.thinking === undefined || current["thinking"] === desired.thinking);

const configPathFor = (agentDir: string) =>
  NodePath.join(agentDir, "pi-blackhole", "pi-blackhole-config.json");

/** Pi Blackhole keeps a config in every agent directory it is installed for. */
export const piBlackholeInstalled = Effect.fnUntraced(function* (agentDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(configPathFor(agentDir)).pipe(Effect.orElseSucceed(() => false));
});

interface CurveAnchor {
  readonly window: number;
  readonly ratio: number;
}

/** Pi Blackhole's built-in `default` curve: the share of a context window it compacts at. */
const DEFAULT_COMPACTION_CURVE: ReadonlyArray<CurveAnchor> = [
  { window: 32_768, ratio: 0.9 },
  { window: 131_072, ratio: 0.8 },
  { window: 262_144, ratio: 0.7 },
  { window: 1_048_576, ratio: 0.4 },
];
/** A fixed point Pi Blackhole once wrote into every config and now ignores. */
const LEGACY_COMPACT_AFTER_TOKENS = 81_000;

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const windowRatio = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;

function compactionCurve(config: Record<string, unknown>): ReadonlyArray<CurveAnchor> {
  const presets = config["compactAfterPresets"];
  const name = typeof config["compactAfterPreset"] === "string" ? config["compactAfterPreset"] : "";
  const own = isRecord(presets) ? presets[name] : undefined;
  if (!Array.isArray(own)) return DEFAULT_COMPACTION_CURVE;
  const anchors = own
    .flatMap((anchor): ReadonlyArray<CurveAnchor> =>
      isRecord(anchor) && positiveInteger(anchor["window"]) && windowRatio(anchor["ratio"])
        ? [{ window: anchor["window"], ratio: anchor["ratio"] }]
        : [],
    )
    .toSorted((left, right) => left.window - right.window);
  return anchors.length === 0 ? DEFAULT_COMPACTION_CURVE : anchors;
}

function curveRatio(anchors: ReadonlyArray<CurveAnchor>, contextWindow: number): number {
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (contextWindow <= first.window) return first.ratio;
  if (contextWindow >= last.window) return last.ratio;
  const upper = anchors.findIndex((anchor) => anchor.window >= contextWindow);
  const from = anchors[upper - 1]!;
  const to = anchors[upper]!;
  const share = (contextWindow - from.window) / (to.window - from.window);
  return from.ratio + share * (to.ratio - from.ratio);
}

/**
 * Where Pi Blackhole compacts a session with this context window, in context tokens, or null
 * when its config leaves compacting to Pi. Follows `compactThresholdTokens` in pi-blackhole
 * 0.5.18: a fixed point, then a share of the window, then a reserve, then the preset curve.
 * Its environment overrides and per-model window overrides are not read.
 */
export function piBlackholeCompactionThreshold(
  config: Record<string, unknown>,
  contextWindow: number,
): number | null {
  const mode = config["compaction"];
  const engine = config["compactionEngine"];
  if (mode === "off" || mode === "manual" || engine === "pi-default") return null;
  if (
    mode === undefined &&
    engine === undefined &&
    (config["passive"] === true ||
      config["noAutoCompact"] === true ||
      config["overrideDefaultCompaction"] === false)
  )
    return null;
  if (contextWindow <= 0) return null;
  const fixed = config["compactAfterTokens"];
  if (positiveInteger(fixed) && fixed !== LEGACY_COMPACT_AFTER_TOKENS) return fixed;
  const ratio = config["compactAfterRatio"];
  if (windowRatio(ratio)) return Math.max(1, Math.floor(contextWindow * ratio));
  const reserve = config["compactReserveTokens"];
  if (positiveInteger(reserve)) return Math.max(1, contextWindow - reserve);
  return Math.max(
    1,
    Math.floor(contextWindow * curveRatio(compactionCurve(config), contextWindow)),
  );
}

/**
 * The config Pi Blackhole loads for a session in `cwd`: the agent directory's file with the
 * project's `.pi/pi-blackhole-config.json` laid over it, or null where it is not installed.
 */
export const readPiBlackholeConfig = Effect.fn("readPiBlackholeConfig")(function* (
  agentDir: string,
  cwd: string,
) {
  const text = yield* readText(configPathFor(agentDir));
  if (text === undefined) return null;
  const project = yield* readText(NodePath.join(cwd, ".pi", "pi-blackhole-config.json"));
  return { ...parseSettingsRoot(text), ...parseSettingsRoot(project) };
});

/**
 * Point the memory worker at `model`, or with null put back the model T3 replaced. Does nothing
 * where Pi Blackhole has no config, since then it is not installed for this agent directory.
 */
export const syncPiBlackholeModel = Effect.fnUntraced(function* (input: {
  readonly agentDir: string;
  readonly model: PiBlackholeModel | null;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = NodePath.join(input.agentDir, "pi-blackhole");
  const configPath = configPathFor(input.agentDir);
  const ownershipPath = NodePath.join(directory, OWNERSHIP_FILENAME);
  if (!(yield* piBlackholeInstalled(input.agentDir))) return false;
  const result = yield* withSettingsLock(
    NodePath.join(directory, ".t3-model.lock"),
    Effect.gen(function* () {
      const text = yield* readText(configPath);
      if (text === undefined) return false;
      const root = parseSettingsRoot(text);
      const ownershipText = yield* readText(ownershipPath);
      const ownership =
        ownershipText === undefined
          ? undefined
          : Option.getOrUndefined(decodeJsonOption(ownershipText));
      const owned = isRecord(ownership) ? ownership : undefined;
      if (input.model !== null) {
        if (sameModel(root["model"], input.model)) return false;
        // Build on the user's own model, never on one T3 wrote, so T3's thinking level does not
        // carry over to a model it was not chosen for.
        const base = owned === undefined ? root["model"] : owned["previous"];
        const next = {
          ...(isRecord(base) ? base : {}),
          provider: input.model.provider,
          id: input.model.id,
          ...(input.model.thinking === undefined ? {} : { thinking: input.model.thinking }),
        };
        const previous = owned === undefined ? (root["model"] ?? null) : owned["previous"];
        const wrote = yield* writeFile(configPath, serializeSettings({ ...root, model: next }));
        if (wrote) yield* writeFile(ownershipPath, serializeSettings({ previous, written: next }));
        return wrote;
      }
      if (owned === undefined) return false;
      const written = owned["written"];
      // Someone changed the model since T3 wrote it: theirs stays.
      const writtenModel =
        isRecord(written) &&
        typeof written["provider"] === "string" &&
        typeof written["id"] === "string"
          ? {
              provider: written["provider"],
              id: written["id"],
              ...(typeof written["thinking"] === "string" ? { thinking: written["thinking"] } : {}),
            }
          : undefined;
      if (writtenModel === undefined || !sameModel(root["model"], writtenModel)) {
        yield* fileSystem.remove(ownershipPath).pipe(Effect.ignore);
        return false;
      }
      const previous = owned["previous"];
      const restored = { ...root, model: previous };
      if (previous === null || previous === undefined) delete restored.model;
      const wrote = yield* writeFile(configPath, serializeSettings(restored));
      // Only a restored config may forget what it replaced.
      if (wrote) yield* fileSystem.remove(ownershipPath).pipe(Effect.ignore);
      return wrote;
    }),
  );
  return result ?? false;
});
