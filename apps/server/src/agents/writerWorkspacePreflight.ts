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

const isWriterWorkspacePreflightError = Schema.is(WriterWorkspacePreflightError);

/**
 * Version-control and package stores hard-link by design (`git clone --local`, pnpm's
 * store on Linux), and a writer edits source, not these; scanning them would refuse
 * every writer in such a checkout.
 */
const TOOL_OWNED_DIRECTORIES = new Set([".git", ".jj", "node_modules"]);

const inode = (stat: NodeFS.Stats) => `${stat.dev}:${stat.ino}`;

/** Visits multiply linked regular files below `root` with its lstat, without following symlinks. */
const walk = Effect.fn("walkWriterWorkspace")(function* (
  root: string,
  descend: (name: string) => boolean,
  visit: (file: string, stat: NodeFS.Stats) => void,
) {
  const path = yield* Path.Path;
  yield* Effect.tryPromise({
    try: async (signal) => {
      const directories = [root];
      while (directories.length > 0) {
        signal.throwIfAborted();
        const dir = directories.pop()!;
        let entries;
        try {
          entries = await NodeFSP.readdir(dir, { withFileTypes: true });
        } catch (cause) {
          throw new WriterWorkspacePreflightError({ reason: "unavailable", path: dir, cause });
        }
        let index = 0;
        let failed = false;
        const worker = async () => {
          try {
            while (index < entries.length) {
              if (failed || signal.aborted) return;
              const entry = entries[index++]!;
              if (entry.isSymbolicLink()) continue;
              const file = path.join(dir, entry.name);
              let stat;
              try {
                stat = await NodeFSP.lstat(file);
              } catch (cause) {
                throw new WriterWorkspacePreflightError({
                  reason: "unavailable",
                  path: file,
                  cause,
                });
              }
              if (failed || signal.aborted) return;
              if (stat.isFile() && stat.nlink > 1) visit(file, stat);
              if (stat.isDirectory() && descend(entry.name)) directories.push(file);
            }
          } catch (error) {
            failed = true;
            throw error;
          }
        };
        await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker));
      }
    },
    catch: (cause) =>
      isWriterWorkspacePreflightError(cause)
        ? cause
        : new WriterWorkspacePreflightError({ reason: "unavailable", path: root, cause }),
  });
});

/**
 * pnpm hard-links `file:` dependencies into `node_modules/.pnpm/<name>@file+…`.
 * Count only real directories so outside aliases cannot be mistaken for local links.
 */
const localDependencyLinks = Effect.fn("localDependencyLinks")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realDirectory = (dir: string) =>
    Effect.promise(() => NodeFSP.lstat(dir).catch(() => null)).pipe(
      Effect.map((stat) => stat?.isDirectory() ?? false),
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
          (_file, stat) => {
            const key = inode(stat);
            links.set(key, (links.get(key) ?? 0) + 1);
          },
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
    (file, stat) => {
      if (stat.nlink > 1 + (dependencyLinks.get(inode(stat)) ?? 0))
        throw new WriterWorkspacePreflightError({ reason: "hard-link", path: file });
    },
  );
});
