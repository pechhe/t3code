// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Pi compacts natively, but only its settings file decides when: `compaction.reserveTokens`
 * (default 16,384) or one model's `compaction.modelOverrides[...].reserveTokens`. There is no
 * launch flag, environment variable or RPC command for the point, so T3 writes the file and
 * restarts the session it just opened when the value changed, and reports the point the running
 * process then loaded.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/** Pi's `compaction.reserveTokens` default, from its built-in settings. */
export const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

/** Where T3 records the model overrides it wrote, and what each replaced. */
export const PI_COMPACTION_OWNERSHIP_FILENAME = ".t3-compaction-overrides.json";

/** A lock older than this was left by a crashed writer and may be taken over. */
const LOCK_STALE_MS = 15_000;
const LOCK_ATTEMPTS = 80;
const LOCK_RETRY_MS = 25;

export interface PiCompactionSettings {
  /** Pi's automatic compaction switch; a point is only in force while this is on. */
  readonly enabled: boolean;
  /** Free context tokens below which Pi's automatic compaction starts. */
  readonly reserveTokens: number;
  /** Per-model reserves, keyed by Pi's `provider/model` id. */
  readonly modelReserves: Readonly<Record<string, number>>;
}

/** The reserves T3 replaced, so clearing a point puts Pi's own value back. */
interface PiCompactionOwnership {
  /** Model key to the reserve it had before T3 wrote, or null when it had none. */
  readonly models: Readonly<Record<string, number | null>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Read Pi's compaction settings from a parsed `settings.json`; anything malformed keeps its default. */
export function decodePiCompactionSettings(raw: unknown): PiCompactionSettings {
  const compaction = isRecord(raw) ? raw["compaction"] : undefined;
  const modelOverrides = isRecord(compaction) ? compaction["modelOverrides"] : undefined;
  const modelReserves: Record<string, number> = {};
  if (isRecord(modelOverrides)) {
    for (const [modelKey, override] of Object.entries(modelOverrides)) {
      const reserve = isRecord(override)
        ? nonNegativeInteger(override["reserveTokens"])
        : undefined;
      if (reserve !== undefined) modelReserves[modelKey] = reserve;
    }
  }
  return {
    enabled: !isRecord(compaction) || compaction["enabled"] !== false,
    reserveTokens:
      (isRecord(compaction) ? nonNegativeInteger(compaction["reserveTokens"]) : undefined) ??
      PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
    modelReserves,
  };
}

export function parsePiCompactionSettings(text: string | undefined): PiCompactionSettings {
  if (text === undefined) return decodePiCompactionSettings(undefined);
  try {
    return decodePiCompactionSettings(JSON.parse(text));
  } catch {
    return decodePiCompactionSettings(undefined);
  }
}

/** The reserve Pi applies to a model: its own override, else the ordinary setting. */
export function piCompactionReserve(settings: PiCompactionSettings, modelKey: string): number {
  return settings.modelReserves[modelKey] ?? settings.reserveTokens;
}

/** Where Pi will compact this session, in context tokens, or null when it will not compact. */
export function piCompactionThreshold(
  contextWindow: number | null,
  reserveTokens: number,
  enabled = true,
): number | null {
  if (!enabled || contextWindow === null || contextWindow <= 0) return null;
  const threshold = Math.floor(contextWindow - reserveTokens);
  return threshold > 0 ? threshold : null;
}

/**
 * The reserve that puts Pi's compaction point at `compactAt`. A point too close to the window
 * keeps Pi's own reserve, since compacting inside the last 16k would not free usable context.
 */
export function piCompactionReserveForPoint(contextWindow: number, compactAt: number): number {
  return Math.max(
    PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
    Math.min(contextWindow, Math.floor(contextWindow - compactAt)),
  );
}

/**
 * Pi's agent directory, where `settings.json` and its overrides live, or null when the
 * environment names neither it nor a home directory (as in tests and bare probes).
 */
export function piAgentDirectory(
  environment: NodeJS.ProcessEnv,
  home = environment["HOME"] ?? environment["USERPROFILE"],
): string | null {
  const configured = environment["PI_CODING_AGENT_DIR"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return home === undefined && configured.startsWith("~")
      ? null
      : expandHomePath(configured, home ?? "");
  }
  return home === undefined || home.length === 0 ? null : NodePath.join(home, ".pi", "agent");
}

interface PiCompactionSnapshot {
  readonly text: string | undefined;
  readonly settings: PiCompactionSettings;
}

const readText = Effect.fn("readPiSettingsText")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
});

const readSnapshot = (settingsPath: string) =>
  Effect.map(readText(settingsPath), (text): PiCompactionSnapshot => ({
    text,
    settings: parsePiCompactionSettings(text),
  }));

const readOwnership = Effect.fn("readPiCompactionOwnership")(function* (ownershipPath: string) {
  const text = yield* readText(ownershipPath);
  if (text === undefined) return { models: {} } satisfies PiCompactionOwnership;
  try {
    const parsed: unknown = JSON.parse(text);
    const models = isRecord(parsed) ? parsed["models"] : undefined;
    // An earlier build recorded only the model names it changed; those replaced nothing known.
    if (Array.isArray(models)) {
      return {
        models: Object.fromEntries(
          models
            .filter((model): model is string => typeof model === "string")
            .map((model) => [model, null]),
        ),
      } satisfies PiCompactionOwnership;
    }
    if (!isRecord(models)) return { models: {} } satisfies PiCompactionOwnership;
    return {
      models: Object.fromEntries(
        Object.entries(models).map(([model, previous]) => [
          model,
          nonNegativeInteger(previous) ?? null,
        ]),
      ),
    } satisfies PiCompactionOwnership;
  } catch {
    return { models: {} } satisfies PiCompactionOwnership;
  }
});

const writeFile = Effect.fn("writePiSettingsFile")(function* (file: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeDirectory(NodePath.dirname(file), { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFileString(file, contents)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * One writer at a time, across Pi sessions and Pi's own TUI: the lock is a directory, so creating
 * it is atomic. Returns undefined when another writer holds it past the stale timeout.
 */
interface PiCompactionSyncResult {
  readonly settings: PiCompactionSettings;
  readonly wrote: boolean;
}

const withSettingsLock = Effect.fn("withPiSettingsLock")(function* (
  lockDirectory: string,
  use: Effect.Effect<PiCompactionSyncResult, never, FileSystem.FileSystem>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !acquired; attempt += 1) {
    acquired = yield* fileSystem.makeDirectory(lockDirectory).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (acquired) break;
    const info = yield* fileSystem.stat(lockDirectory).pipe(Effect.orElseSucceed(() => undefined));
    const modifiedAt = info === undefined ? undefined : Option.getOrUndefined(info.mtime);
    const now = yield* Clock.currentTimeMillis;
    if (modifiedAt !== undefined && now - modifiedAt.getTime() > LOCK_STALE_MS) {
      yield* fileSystem
        .remove(lockDirectory, { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined));
    }
    yield* Effect.sleep(LOCK_RETRY_MS);
  }
  if (!acquired) return undefined;
  return yield* use.pipe(
    Effect.ensuring(
      fileSystem
        .remove(lockDirectory, { recursive: true })
        .pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});

/** Remove a model's override, putting back the reserve T3 replaced (or nothing). */
function withoutModelReserve(
  root: Record<string, unknown>,
  modelKey: string,
  previousReserve: number | null,
): Record<string, unknown> {
  const compaction = isRecord(root["compaction"]) ? { ...root["compaction"] } : undefined;
  if (compaction === undefined) return root;
  const overrides = isRecord(compaction["modelOverrides"])
    ? { ...compaction["modelOverrides"] }
    : undefined;
  if (overrides === undefined || !isRecord(overrides[modelKey])) return root;
  const override = { ...(overrides[modelKey] as Record<string, unknown>) };
  if (previousReserve === null) delete override["reserveTokens"];
  else override["reserveTokens"] = previousReserve;
  if (Object.keys(override).length === 0) delete overrides[modelKey];
  else overrides[modelKey] = override;
  if (Object.keys(overrides).length === 0) delete compaction["modelOverrides"];
  else compaction["modelOverrides"] = overrides;
  if (Object.keys(compaction).length === 0) delete root["compaction"];
  else root["compaction"] = compaction;
  return root;
}

/** Set a model's reserve and turn automatic compaction on, leaving everything else alone. */
function withModelReserve(
  root: Record<string, unknown>,
  modelKey: string,
  reserveTokens: number,
): Record<string, unknown> {
  const compaction = isRecord(root["compaction"]) ? { ...root["compaction"] } : {};
  compaction["enabled"] = true;
  const overrides = isRecord(compaction["modelOverrides"])
    ? { ...compaction["modelOverrides"] }
    : {};
  const override = isRecord(overrides[modelKey])
    ? { ...(overrides[modelKey] as Record<string, unknown>) }
    : {};
  override["reserveTokens"] = reserveTokens;
  overrides[modelKey] = override;
  compaction["modelOverrides"] = overrides;
  root["compaction"] = compaction;
  return root;
}

function parseSettingsRoot(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const serializeSettings = (root: Record<string, unknown>): string =>
  `${JSON.stringify(root, null, 2)}\n`;

/**
 * Point Pi's native compaction at `compactAt` for one model. The reserve is written to Pi's own
 * settings, so it applies wherever that model runs. `settings` is what a Pi process started now
 * would load: the file as written when this changed anything, otherwise the file as read.
 */
export const syncPiCompactionPoint = Effect.fnUntraced(function* (input: {
  readonly agentDir: string;
  readonly modelKey: string;
  readonly contextWindow: number | null;
  readonly compactAt: number | null;
}) {
  const settingsPath = NodePath.join(input.agentDir, "settings.json");
  const ownershipPath = NodePath.join(input.agentDir, PI_COMPACTION_OWNERSHIP_FILENAME);
  const result = yield* withSettingsLock(
    NodePath.join(input.agentDir, ".t3-compaction.lock"),
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot(settingsPath);
      const ownership = yield* readOwnership(ownershipPath);
      const desired =
        input.compactAt !== null &&
        input.compactAt > 0 &&
        input.contextWindow !== null &&
        input.contextWindow > 0
          ? piCompactionReserveForPoint(input.contextWindow, input.compactAt)
          : null;
      if (desired !== null) {
        if (
          snapshot.settings.modelReserves[input.modelKey] === desired &&
          snapshot.settings.enabled
        ) {
          return { settings: snapshot.settings, wrote: false } as const;
        }
        const previous =
          input.modelKey in ownership.models
            ? ownership.models[input.modelKey]!
            : (snapshot.settings.modelReserves[input.modelKey] ?? null);
        const root = withModelReserve(parseSettingsRoot(snapshot.text), input.modelKey, desired);
        const wrote = yield* writeFile(settingsPath, serializeSettings(root));
        yield* writeFile(
          ownershipPath,
          serializeSettings({
            models: { ...ownership.models, [input.modelKey]: previous },
          }),
        );
        return { settings: decodePiCompactionSettings(root), wrote } as const;
      }
      if (!(input.modelKey in ownership.models)) {
        return { settings: snapshot.settings, wrote: false } as const;
      }
      const root = withoutModelReserve(
        parseSettingsRoot(snapshot.text),
        input.modelKey,
        ownership.models[input.modelKey]!,
      );
      const wrote = yield* writeFile(settingsPath, serializeSettings(root));
      const remaining = { ...ownership.models };
      delete remaining[input.modelKey];
      yield* writeFile(ownershipPath, serializeSettings({ models: remaining }));
      return { settings: decodePiCompactionSettings(root), wrote } as const;
    }),
  );
  if (result !== undefined) return result;
  // Another writer holds the lock: report the file as it stands, without changing it.
  const snapshot = yield* readSnapshot(settingsPath);
  return { settings: snapshot.settings, wrote: false } as const;
});
