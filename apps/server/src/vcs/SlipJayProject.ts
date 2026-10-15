import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { SLIPJAY_PROJECT_FILE_NAME } from "@t3tools/contracts";

/**
 * A Jujutsu workspace whose root holds a `slipjay.json`. SlipJay then allocates
 * the project's thread workspaces and lands their changes; any other project uses
 * Git worktrees. This is the one place that reads the file and makes that call.
 */
export interface SlipJayProject {
  /** The Jujutsu workspace root holding slipjay.json. */
  readonly root: string;
  /** The integration bookmark slipjay.json names; null when it names none SlipJay can use. */
  readonly integration: string | null;
  /** The remote SlipJay publishes to, which keys its landings on the runner. */
  readonly remote: string;
}

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      integrationBranch: Schema.optional(Schema.NonEmptyString),
      remote: Schema.optional(Schema.NonEmptyString),
    }),
  ),
);

/**
 * The SlipJay project containing `start`, found at the nearest Jujutsu workspace
 * root at or above it, so a project registered in a subdirectory is one too. The
 * file alone makes a SlipJay project; one SlipJay cannot use still counts, without
 * its integration bookmark.
 */
export const findSlipJayProject = Effect.fn("findSlipJayProject")(function* (start: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  let directory = path.resolve(start);
  while (true) {
    if (yield* exists(path.join(directory, ".jj"))) {
      const configPath = path.join(directory, SLIPJAY_PROJECT_FILE_NAME);
      if (!(yield* exists(configPath))) return null;
      const config = yield* fs.readFileString(configPath).pipe(
        Effect.map((text) => Option.getOrUndefined(decodeConfig(text))),
        Effect.orElseSucceed(() => undefined),
      );
      if (config?.integrationBranch === undefined) {
        yield* Effect.logWarning("Could not read the SlipJay integration bookmark", { configPath });
      }
      return {
        root: directory,
        integration: config?.integrationBranch ?? null,
        remote: config?.remote ?? "origin",
      } satisfies SlipJayProject;
    }
    // A Git repository without Jujutsu is never a SlipJay project.
    if (yield* exists(path.join(directory, ".git"))) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
});
