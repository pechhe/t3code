import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The user's own MCP servers, hooks and plugins (`agy mcp add`, `rtk init --agent antigravity`)
 * live in `~/.gemini/config`; profiles link them as Pi, Claude and Codex read their own.
 */
export function antigravityUserToolingLinks(
  path: Path.Path,
  profileDirectory: string,
  userGemini: string,
  platform: NodeJS.Platform,
) {
  const entry = (name: string, type: "file" | "dir" | "junction") =>
    [
      path.join(profileDirectory, "config", name),
      path.join(userGemini, "config", name),
      type,
    ] as const;
  return [
    // File symlinks need elevation or Developer Mode on Windows.
    ...(platform === "win32"
      ? []
      : [entry("mcp_config.json", "file"), entry("hooks.json", "file")]),
    entry("plugins", platform === "win32" ? "junction" : "dir"),
  ];
}

/** agy writes an empty `mcp_config.json` before any server exists; only that gives way to a link. */
export const removeEmptyConfigPlaceholder = Effect.fn("removeEmptyConfigPlaceholder")(function* (
  link: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(link);
  if (info.type !== "File" || info.size > 4_096n) return false;
  if ((yield* fs.readFileString(link)).trim().length > 0) return false;
  yield* fs.remove(link);
  return true;
});

/** Plugins carry their own hooks and MCP servers, which can act before a helper denies a tool. */
export const antigravityProfileHasPlugins = Effect.fn("antigravityProfileHasPlugins")(function* (
  profileDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plugins = path.join(profileDirectory, "config", "plugins");
  if (!(yield* fs.exists(plugins).pipe(Effect.orElseSucceed(() => true)))) return false;
  return yield* fs.readDirectory(plugins).pipe(
    Effect.map((entries) => entries.length > 0),
    Effect.orElseSucceed(() => true),
  );
});
