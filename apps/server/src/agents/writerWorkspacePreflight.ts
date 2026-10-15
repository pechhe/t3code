// @effect-diagnostics nodeBuiltinImport:off - FileSystem.stat follows symlinks; the admission scan needs lstat, which the service does not expose.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WriterWorkspacePreflightError extends Schema.TaggedError<WriterWorkspacePreflightError>()(
  "WriterWorkspacePreflightError",
  {
    reason: Schema.Literals(["hard-link", "unavailable"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Version-control and package stores hard-link by design (`git clone --local`, pnpm's
 * store on Linux), and a writer edits source, not these; scanning them would refuse
 * every writer in such a checkout.
 */
const TOOL_OWNED_DIRECTORIES = new Set([".git", ".jj", "node_modules"]);

const inode = (stat: NodeFS.Stats) => `${stat.dev}:${stat.ino}`;

/** Visits every regular file below `root` with its lstat, without following symlinks. */
const walk = Effect.fn("walkWriterWorkspace")(function* (
  root: string,
  descend: (name: string) => boolean,
  visit: (file: string, stat: NodeFS.Stats) => Effect.Effect<void, WriterWorkspacePreflightError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = [root];
  while (directories.length > 0) {
    const dir = directories.pop()!;
    const names = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.mapError(
          (cause) => new WriterWorkspacePreflightError({ reason: "unavailable", path: dir, cause }),
        ),
      );
    const next = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const file = path.join(dir, name);
          const stat = yield* Effect.tryPromise({
            try: () => NodeFSP.lstat(file),
            catch: (cause) =>
              new WriterWorkspacePreflightError({ reason: "unavailable", path: file, cause }),
          });
          if (stat.isFile()) yield* visit(file, stat);
          return stat.isDirectory() && descend(name) ? file : undefined;
        }),
      { concurrency: 16 },
    );
    directories.push(...next.filter((dir): dir is string => dir !== undefined));
  }
});

/**
 * pnpm installs a `file:` directory dependency by hard-linking its sources into
 * `node_modules/.pnpm/<name>@file+…`, so those sources legitimately carry extra links
 * inside the same workspace. Counts those links per inode; an unreadable store counts none.
 * Only real directories count: a symlinked store or entry could reach files outside the
 * workspace and pass their aliases off as local.
 */
const localDependencyLinks = Effect.fn("localDependencyLinks")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realDirectory = (dir: string) =>
    Effect.tryPromise(() => NodeFSP.lstat(dir)).pipe(
      Effect.map((stat) => stat.isDirectory()),
      Effect.orElseSucceed(() => false),
    );
  const modules = path.join(root, "node_modules");
  const store = path.join(modules, ".pnpm");
  const links = new Map<string, number>();
  if (!(yield* realDirectory(modules)) || !(yield* realDirectory(store))) return links;
  const entries = yield* fs.readDirectory(store).pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    entries.filter((name) => name.includes("@file+")),
    (name) =>
      Effect.gen(function* () {
        const entry = path.join(store, name);
        if (!(yield* realDirectory(entry))) return;
        yield* walk(
          entry,
          () => true,
          (_file, stat) =>
            Effect.sync(() => links.set(inode(stat), (links.get(inode(stat)) ?? 0) + 1)),
        ).pipe(Effect.ignore);
      }),
  );
  return links;
});

/** A point-in-time alias guard, not containment; exclusive managed custody does not stop external filesystem changes. */
export const checkWriterWorkspace = Effect.fn("checkWriterWorkspace")(function* (root: string) {
  const dependencyLinks = yield* localDependencyLinks(root);
  yield* walk(
    root,
    (name) => !TOOL_OWNED_DIRECTORIES.has(name),
    (file, stat) =>
      stat.nlink > 1 + (dependencyLinks.get(inode(stat)) ?? 0)
        ? Effect.fail(new WriterWorkspacePreflightError({ reason: "hard-link", path: file }))
        : Effect.void,
  );
});
