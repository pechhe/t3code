// @effect-diagnostics nodeBuiltinImport:off - FileSystem.stat follows symlinks; the admission scan needs lstat, which the service does not expose.
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

/** A point-in-time alias guard, not containment; exclusive managed custody does not stop external filesystem changes. */
export const checkWriterWorkspace = Effect.fn("checkWriterWorkspace")(function* (root: string) {
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
          if (stat.isFile() && stat.nlink > 1)
            return yield* new WriterWorkspacePreflightError({ reason: "hard-link", path: file });
          return stat.isDirectory() && !TOOL_OWNED_DIRECTORIES.has(name) ? file : undefined;
        }),
      { concurrency: 16 },
    );
    directories.push(...next.filter((dir): dir is string => dir !== undefined));
  }
});
