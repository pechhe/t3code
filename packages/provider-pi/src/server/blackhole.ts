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
