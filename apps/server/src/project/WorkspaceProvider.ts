import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * How a project creates a separate checkout for a thread. A repository with a
 * `slipjay.json` allocates through SlipJay, which owns its workspace pool and
 * landing; any other repository uses a Git worktree.
 */
export type WorkspaceProviderKind = "git-worktree" | "slipjay";

export class WorkspaceProviderError extends Schema.TaggedError<WorkspaceProviderError>()(
  "WorkspaceProviderError",
  {
    operation: Schema.Literals(["allocate", "release"]),
    projectRoot: Schema.String,
    /** The command's exit code; absent when it did not run or exited cleanly with bad output. */
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const outcome = this.exitCode === undefined ? "" : ` (slipjay exited with ${this.exitCode})`;
    return `SlipJay could not ${this.operation} a workspace for ${this.projectRoot}${outcome}.`;
  }
}

const SlipJayStartResult = Schema.Struct({ workspacePath: Schema.String });
const decodeSlipJayStartResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SlipJayStartResult),
);

export class WorkspaceProvider extends Context.Service<
  WorkspaceProvider,
  {
    readonly resolve: (projectRoot: string) => Effect.Effect<WorkspaceProviderKind>;
    /** Allocates a SlipJay workspace named after `task` and returns its path. */
    readonly allocate: (input: {
      readonly projectRoot: string;
      readonly task: string;
    }) => Effect.Effect<string, WorkspaceProviderError>;
    /** Removes an allocated SlipJay workspace; SlipJay keeps one holding unfinished work. */
    readonly release: (input: {
      readonly projectRoot: string;
      readonly path: string;
    }) => Effect.Effect<void, WorkspaceProviderError>;
  }
>()("t3/project/WorkspaceProvider") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;

  const slipjay = (
    operation: WorkspaceProviderError["operation"],
    projectRoot: string,
    args: ReadonlyArray<string>,
  ) =>
    processes
      .run({
        command: "slipjay",
        args,
        cwd: projectRoot,
        // A cold allocation installs the repository's dependencies.
        timeout: "10 minutes",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) => new WorkspaceProviderError({ operation, projectRoot, cause })),
        Effect.filterOrFail(
          (output) => output.code === 0,
          (output) =>
            new WorkspaceProviderError({
              operation,
              projectRoot,
              ...(output.code === null ? {} : { exitCode: output.code }),
            }),
        ),
      );

  const resolve: WorkspaceProvider["Service"]["resolve"] = (projectRoot) =>
    fs.exists(path.join(projectRoot, "slipjay.json")).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((exists): WorkspaceProviderKind => (exists ? "slipjay" : "git-worktree")),
    );

  const allocate: WorkspaceProvider["Service"]["allocate"] = Effect.fn(
    "WorkspaceProvider.allocate",
  )(function* ({ projectRoot, task }) {
    const output = yield* slipjay("allocate", projectRoot, [
      "start",
      "--integration",
      "--json",
      task,
    ]);
    const result = yield* decodeSlipJayStartResult(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
      ),
    );
    return result.workspacePath;
  });

  const release: WorkspaceProvider["Service"]["release"] = Effect.fn("WorkspaceProvider.release")(
    function* ({ projectRoot, path: workspacePath }) {
      yield* slipjay("release", projectRoot, ["remove", workspacePath]);
    },
  );

  return WorkspaceProvider.of({ resolve, allocate, release });
});

export const layer = Layer.effect(WorkspaceProvider, make).pipe(Layer.provide(ProcessRunner.layer));

/** A provider for tests whose projects all use Git worktrees. */
export const layerGitWorktree = Layer.mock(WorkspaceProvider)({
  resolve: () => Effect.succeed("git-worktree"),
});
