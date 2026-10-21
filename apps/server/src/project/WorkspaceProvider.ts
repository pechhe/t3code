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
    /** What SlipJay printed about the failure, bounded by `boundedDetail`. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const outcome = this.exitCode === undefined ? "" : ` (slipjay exited with ${this.exitCode})`;
    const reason = this.detail ? `: ${this.detail}` : ".";
    return `SlipJay could not ${this.operation} a workspace for ${this.projectRoot}${outcome}${reason}`;
  }
}

const MAX_DETAIL_CHARS = 1000;

/**
 * SlipJay prints the cause of a failure last, after any progress output, so a long
 * output keeps its tail. Stdout stands in when stderr is empty.
 */
const boundedDetail = (output: { readonly stdout: string; readonly stderr: string }) => {
  const text = (output.stderr.trim() || output.stdout.trim()).trim();
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `…${text.slice(-(MAX_DETAIL_CHARS - 1)).trimStart()}`;
};

const SlipJayStartResult = Schema.Struct({
  workspacePath: Schema.String,
  // False when SlipJay bound or resumed a checkout that already existed, such as an Issue's.
  created: Schema.optional(Schema.Boolean),
});
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
    /**
     * Allocates a SlipJay workspace named after `task`. An `issue` to `resume` returns that
     * Build item's existing workspace when it has one, with `created` false: the caller must
     * not release a checkout it did not create. An `issue` to `attach` always gets a new
     * checkout, which takes the item only when no other workspace holds it. `issue` in the
     * result is the item the workspace belongs to.
     */
    readonly allocate: (input: {
      readonly projectRoot: string;
      readonly task: string;
      readonly issue?: { readonly number: number; readonly mode: "resume" | "attach" };
    }) => Effect.Effect<
      { readonly workspacePath: string; readonly created: boolean; readonly issue: number | null },
      WorkspaceProviderError
    >;
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
    cwd = projectRoot,
  ) =>
    processes
      .run({
        command: "slipjay",
        args,
        cwd,
        // A cold allocation installs the repository's dependencies.
        timeout: "10 minutes",
        maxOutputBytes: 64 * 1024,
        // SlipJay reports why it failed last, after any progress output.
        outputMode: "truncate-tail",
      })
      .pipe(
        Effect.mapError((cause) => new WorkspaceProviderError({ operation, projectRoot, cause })),
        Effect.filterOrFail(
          (output) => output.code === 0,
          (output) => {
            const detail = boundedDetail(output);
            return new WorkspaceProviderError({
              operation,
              projectRoot,
              ...(output.code === null ? {} : { exitCode: output.code }),
              ...(detail === "" ? {} : { detail }),
            });
          },
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
  )(({ projectRoot, task, issue }) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // A project registered in a subdirectory allocates from its SlipJay root.
        const root = (yield* slipJayProject(projectRoot))?.root ?? projectRoot;
        // To resume, SlipJay returns the item's workspace (or its surviving checkout) and
        // creates one attached to it only when none exists.
        const resume = issue?.mode === "resume";
        const output = yield* slipjay("allocate", root, [
          "start",
          "--integration",
          "--json",
          ...(resume ? ["--issue", String(issue.number)] : []),
          task,
        ]);
        const result = yield* decodeSlipJayStartResult(output.stdout.trim()).pipe(
          Effect.mapError(
            (cause) => new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
          ),
        );
        // Resuming would hand over a workspace that may be another thread's. Attaching
        // refuses an item another workspace holds, so this checkout only ever belongs to
        // the thread that asked for it.
        const attached =
          issue === undefined || resume
            ? true
            : yield* slipjay(
                "allocate",
                root,
                ["attach-issue", String(issue.number)],
                result.workspacePath,
              ).pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("SlipJay workspace allocated without its Issue", {
                    workspacePath: result.workspacePath,
                    issue: issue.number,
                    error: error.message,
                  }).pipe(Effect.as(false)),
                ),
              );
        const allocation = {
          workspacePath: result.workspacePath,
          created: result.created ?? false,
          issue: issue !== undefined && attached ? issue.number : null,
        };
        // SlipJay emits the path after preparation. Cancellation waits for that
        // receipt so a workspace it created can be returned rather than orphaned.
        return yield* restore(Effect.succeed(allocation)).pipe(
          Effect.onInterrupt(() =>
            allocation.created
              ? release({ projectRoot, path: allocation.workspacePath }).pipe(
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void,
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
