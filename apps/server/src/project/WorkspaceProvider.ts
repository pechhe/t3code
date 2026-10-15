import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { type GitCommandError, type VcsRemoveWorktreeInput } from "@t3tools/contracts";
import { containingRepositoryStore, repositoryStore } from "../agents/workspaceIdentity.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";

/**
 * How a project creates a separate checkout for a thread. A SlipJay project
 * (see `findSlipJayProject`) allocates through SlipJay, which owns its workspace
 * pool and landing; any other repository uses a Git worktree.
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
    readonly contains: (projectRoot: string, workspacePath: string) => Effect.Effect<boolean>;
    readonly remove: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, WorkspaceProviderError | GitCommandError>;
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
  const git = yield* GitVcsDriver.GitVcsDriver;

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

  const slipJayProject = (projectRoot: string) =>
    findSlipJayProject(projectRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
    );

  const resolve: WorkspaceProvider["Service"]["resolve"] = (projectRoot) =>
    slipJayProject(projectRoot).pipe(
      Effect.map((project): WorkspaceProviderKind => (project ? "slipjay" : "git-worktree")),
    );

  const allocate: WorkspaceProvider["Service"]["allocate"] = Effect.fn(
    "WorkspaceProvider.allocate",
  )(({ projectRoot, task }) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // A project registered in a subdirectory allocates from its SlipJay root.
        const root = (yield* slipJayProject(projectRoot))?.root ?? projectRoot;
        const output = yield* slipjay("allocate", root, ["start", "--integration", "--json", task]);
        const result = yield* decodeSlipJayStartResult(output.stdout.trim()).pipe(
          Effect.mapError(
            (cause) => new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
          ),
        );
        // SlipJay emits the path after preparation. Cancellation waits for that
        // receipt so the allocated workspace can be returned rather than orphaned.
        return yield* restore(Effect.succeed(result.workspacePath)).pipe(
          Effect.onInterrupt(() =>
            release({ projectRoot, path: result.workspacePath }).pipe(
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
      }),
    ),
  );

  const release: WorkspaceProvider["Service"]["release"] = Effect.fn("WorkspaceProvider.release")(
    function* ({ projectRoot, path: workspacePath }) {
      yield* slipjay("release", projectRoot, ["remove", workspacePath]);
    },
  );

  const contains: WorkspaceProvider["Service"]["contains"] = Effect.fn(
    "WorkspaceProvider.contains",
  )(function* (projectRoot, workspacePath) {
    const store = (root: string, lookup = repositoryStore) =>
      lookup(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, processes),
        Effect.orElseSucceed((): string | null => null),
      );
    // A project may be registered in a subdirectory of its checkout.
    const project = yield* store(projectRoot, containingRepositoryStore);
    if (project !== null && (yield* store(workspacePath)) === project) return true;
    // Colocated JJ projects also have linked Git worktrees with Git identity.
    const real = (root: string) => fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    const listed = yield* git.listWorktreePaths(projectRoot).pipe(
      Effect.flatMap((paths) => Effect.forEach(paths, real)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return listed.includes(yield* real(workspacePath));
  });

  const remove: WorkspaceProvider["Service"]["remove"] = Effect.fn("WorkspaceProvider.remove")(
    function* (input) {
      if (
        (yield* resolve(input.cwd)) === "slipjay" &&
        (yield* fs.exists(path.join(input.path, ".jj")).pipe(Effect.orElseSucceed(() => false)))
      ) {
        yield* release({ projectRoot: input.cwd, path: input.path });
      } else {
        yield* git.removeWorktree(input);
      }
    },
  );

  return WorkspaceProvider.of({ resolve, allocate, release, contains, remove });
});

export const layer = Layer.effect(WorkspaceProvider, make).pipe(Layer.provide(ProcessRunner.layer));

/** A provider for tests whose projects all use Git worktrees. */
export const layerGitWorktree = Layer.mock(WorkspaceProvider)({
  resolve: () => Effect.succeed("git-worktree"),
});
