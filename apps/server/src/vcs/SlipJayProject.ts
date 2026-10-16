import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { SLIPJAY_PROJECT_FILE_NAME } from "@t3tools/contracts";

import * as ProcessRunner from "../processRunner.ts";

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
  /** Whether slipjay.json names a release branch; without one there is nothing to promote. */
  readonly hasReleaseBranch: boolean;
  /** The remote SlipJay publishes to, which keys its landings on the runner. */
  readonly remote: string;
}

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      integrationBranch: Schema.optional(Schema.NonEmptyString),
      releaseBranch: Schema.optional(Schema.NonEmptyString),
      remote: Schema.optional(Schema.NonEmptyString),
    }),
  ),
);

// SlipJay's branch rule; it also keeps the name a plain quoted revset symbol.
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * The policy committed on the integration bookmark SlipJay itself would resolve without
 * one declared: origin/HEAD's branch, then `main`, then `master`. Null when none has one.
 */
const committedConfig = Effect.fn("committedSlipJayConfig")(function* (root: string) {
  const processes = yield* ProcessRunner.ProcessRunner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    processes
      .run({ command, args, cwd: root, timeout: "10 seconds", maxOutputBytes: 64 * 1024 })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
  const gitDir = (yield* run("jj", ["--ignore-working-copy", "git", "root"]))?.trim();
  const head = gitDir
    ? (yield* run("git", [
        "--git-dir",
        gitDir,
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]))
        ?.trim()
        .replace(/^origin\//, "")
    : undefined;
  for (const branch of [head, "main", "master"]) {
    if (branch === undefined || !SAFE_BRANCH.test(branch)) continue;
    const text = yield* run("jj", [
      "--ignore-working-copy",
      "file",
      "show",
      "-r",
      `present("${branch}")`,
      SLIPJAY_PROJECT_FILE_NAME,
    ]);
    if (text !== null) return text;
  }
  return null;
});

/**
 * The SlipJay project containing `start`, found at the nearest Jujutsu workspace
 * root at or above it, so a project registered in a subdirectory is one too. The
 * file alone makes a SlipJay project; one SlipJay cannot use still counts, without
 * its integration bookmark. Like SlipJay, a checkout of an older revision without the
 * file reads the one committed on its integration bookmark.
 */
export const findSlipJayProject = Effect.fn("findSlipJayProject")(function* (start: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  let directory = path.resolve(start);
  while (true) {
    if (yield* exists(path.join(directory, ".jj"))) {
      const configPath = path.join(directory, SLIPJAY_PROJECT_FILE_NAME);
      const text = (yield* exists(configPath))
        ? yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""))
        : yield* committedConfig(directory);
      if (text === null) return null;
      const config = Option.getOrUndefined(decodeConfig(text));
      if (config?.integrationBranch === undefined) {
        yield* Effect.logWarning("Could not read the SlipJay integration bookmark", { configPath });
      }
      return {
        root: directory,
        integration: config?.integrationBranch ?? null,
        hasReleaseBranch: config?.releaseBranch !== undefined,
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
