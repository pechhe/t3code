/** A linked worktree or SlipJay's secondary jj workspace keeps its own gitignored `.t3`, so feature
 * work never shares the live app's database; an ambient T3CODE_HOME cannot override that here. */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Match worktrees/<name>; bare repos and GIT_COMMON_DIR need not use a directory named .git.
const pointsAtLinkedWorktree = (gitFileContents: string, path: Path.Path): boolean => {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) {
    return false;
  }
  const segments = path
    .normalize(gitdir.replaceAll("\\", "/"))
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
};

/**
 * Thrown instead of answering "not a workspace" when the shared home would be
 * the silent fallback for something that looks like an agent workspace.
 */
export class AmbiguousAgentWorkspaceError extends Schema.TaggedError<AmbiguousAgentWorkspaceError>()(
  "AmbiguousAgentWorkspaceError",
  { cwd: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot tell where the isolated .t3 belongs for ${this.cwd}: ${this.reason}. Name the directory explicitly: --home-dir for the dev runner, --base-dir for migrate-dev-db and pair.`;
  }
}

/** SlipJay allocates every agent workspace under `<slipjay home>/workspaces/<name>`. */
const isUnderSlipJayWorkspaces = (directory: string, path: Path.Path) => {
  const segments = directory.split(path.sep);
  const at = segments.indexOf(".slipjay");
  return at !== -1 && segments[at + 1] === "workspaces" && segments.length > at + 2;
};

/**
 * A jj workspace's root is the directory holding `.jj`. A secondary workspace
 * (every SlipJay one) stores `.jj/repo` as a pointer *file* to the shared
 * store; the primary workspace has a `repo` directory and is a main checkout.
 */
const classifyJjDirectory = Effect.fn("devHome.classifyJjDirectory")(function* (
  jjPath: string,
): Effect.fn.Return<
  "secondary" | "primary" | "unrecognised",
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fileSystem.stat(path.join(jjPath, "repo")).pipe(Effect.option);
  if (Option.isNone(info)) {
    return "unrecognised";
  }
  return info.value.type === "File" ? "secondary" : "primary";
});

/**
 * The root of the linked git worktree or secondary jj workspace containing
 * `cwd`; undefined for a main checkout or a directory in no repository.
 */
export const resolveWorkspacePath = Effect.fn("devHome.resolveWorkspacePath")(function* (
  cwd: string,
): Effect.fn.Return<
  string | undefined,
  AmbiguousAgentWorkspaceError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const start = path.resolve(cwd);

  const search = Effect.gen(function* () {
    let directory = start;
    for (;;) {
      const gitPath = path.join(directory, ".git");
      const gitInfo = yield* fileSystem.stat(gitPath).pipe(Effect.option);
      if (Option.isSome(gitInfo) && gitInfo.value.type === "File") {
        const contents = yield* fileSystem
          .readFileString(gitPath)
          .pipe(Effect.orElseSucceed(() => ""));
        if (pointsAtLinkedWorktree(contents, path)) {
          return directory;
        }
      }
      const jjPath = path.join(directory, ".jj");
      const jjInfo = yield* fileSystem.stat(jjPath).pipe(Effect.option);
      if (Option.isSome(jjInfo)) {
        const kind = yield* classifyJjDirectory(jjPath);
        if (kind === "secondary") {
          return directory;
        }
        // A primary workspace is a main checkout, but a `.jj` nested inside a
        // secondary workspace (a fixture, a vendored clone) must not hide the
        // workspace around it, so keep climbing.
        if (kind === "unrecognised") {
          return yield* new AmbiguousAgentWorkspaceError({
            cwd: start,
            reason: `${jjPath} is not a recognisable jj workspace`,
          });
        }
      }
      // A git checkout that is not a linked worktree (a main checkout, a
      // submodule) ends the search, after the `.jj` beside it had its say: a
      // colocated secondary jj workspace may carry a `.git` file that is not
      // a worktree pointer.
      if (Option.isSome(gitInfo)) {
        return undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  });

  const found = yield* search;
  if (found === undefined && isUnderSlipJayWorkspaces(start, path)) {
    return yield* new AmbiguousAgentWorkspaceError({
      cwd: start,
      reason:
        "it is inside a SlipJay workspace directory but no git worktree or jj workspace root was found",
    });
  }
  return found;
});

/**
 * Deliberately does not require the directory to exist yet: falling back
 * because it is missing would send callers at the shared home.
 */
export const resolveWorkspaceT3Home = Effect.fn("devHome.resolveWorkspaceT3Home")(function* (
  cwd: string,
): Effect.fn.Return<
  string | undefined,
  AmbiguousAgentWorkspaceError,
  FileSystem.FileSystem | Path.Path
> {
  const workspacePath = yield* resolveWorkspacePath(cwd);
  if (workspacePath === undefined) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(workspacePath, ".t3");
});
