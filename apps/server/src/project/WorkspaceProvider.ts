import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as WorkspaceAllocationIntents from "../persistence/WorkspaceAllocationIntents.ts";
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
  // False when SlipJay bound or resumed a checkout that already existed, such as an Issue's;
  // absent when it did not say.
  created: Schema.optional(Schema.Boolean),
});
const decodeSlipJayStartResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SlipJayStartResult),
);

// What `slipjay attempt show` prints. `interrupted` is a start whose process died mid-run.
const SlipJayAttempt = Schema.Struct({
  status: Schema.Literals(["allocating", "preparing", "ready", "failed"]),
  workspacePath: Schema.optional(Schema.String),
  owned: Schema.optional(Schema.Boolean),
  interrupted: Schema.Boolean,
});
const decodeSlipJayAttempt = Schema.decodeUnknownEffect(Schema.fromJsonString(SlipJayAttempt));

const SlipJayAttemptRelease = Schema.Struct({
  released: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
const decodeSlipJayAttemptRelease = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SlipJayAttemptRelease),
);

/** SlipJay's `attempt release` reason once it has already forgotten the attempt. */
// SlipJay's documented answers for an attempt it has no record of: `attempt release` says so in
// JSON, `attempt show` only on stderr.
const UNKNOWN_ATTEMPT = "unknown attempt";
const NO_ATTEMPT_MESSAGE = "No allocation attempt";

type AttemptState =
  | { readonly kind: "absent" }
  | { readonly kind: "running" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly workspacePath: string; readonly owned: boolean | null };

/** An attempt's state as a caller read it: `unknown` when SlipJay would not describe it. */
type AttemptReading = AttemptState | { readonly kind: "unknown" };

/** What opened a workspace allocation, recorded with its intent so a stranded one can be traced. */
export interface WorkspaceOwner {
  readonly kind: "thread-launch" | "terminal" | "mcp";
  readonly ref: string;
}

export class WorkspaceProvider extends Context.Service<
  WorkspaceProvider,
  {
    readonly resolve: (projectRoot: string) => Effect.Effect<WorkspaceProviderKind>;
    readonly contains: (projectRoot: string, workspacePath: string) => Effect.Effect<boolean>;
    readonly remove: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, WorkspaceProviderError | GitCommandError>;
    /**
     * Allocates a SlipJay workspace for `task`; `created` false or null means the caller must
     * not release it. A start that fails or loses its receipt is settled against SlipJay's
     * attempt record, not retried; one still running fails naming its attempt, and the same
     * thread-launch owner's retry reconciles that attempt instead of starting another.
     */
    readonly allocate: (input: {
      readonly projectRoot: string;
      readonly task: string;
      readonly owner: WorkspaceOwner;
      readonly issue?: { readonly number: number; readonly mode: "resume" | "attach" };
    }) => Effect.Effect<
      {
        readonly workspacePath: string;
        readonly created: boolean | null;
        readonly issue: number | null;
        readonly attemptId: string;
        readonly attachFailure?: string;
      },
      WorkspaceProviderError
    >;
    /** The checkout from `allocate` is bound to its owner or released by the caller, so its intent is complete. */
    readonly settled: (attemptId: string) => Effect.Effect<void>;
    /**
     * The checkout from `allocate` was never bound and the caller did not create it or cannot
     * say it did. SlipJay decides through the attempt: it removes the checkout only when the
     * attempt owns it and nothing has used it, and keeps one it resumed.
     */
    readonly abandon: (attemptId: string) => Effect.Effect<void>;
    /**
     * Settles allocations an earlier run left: releases a finished, unbound checkout unless
     * SlipJay refuses or its launching thread can still retry, and leaves this process's own.
     */
    readonly reconcile: (input: {
      readonly isBound: (workspacePath: string) => Effect.Effect<boolean>;
      readonly retryable: (threadId: string) => Effect.Effect<boolean>;
    }) => Effect.Effect<void>;
    /** Removes an allocated SlipJay workspace; SlipJay keeps one holding unfinished work. */
    readonly release: (input: {
      readonly projectRoot: string;
      readonly path: string;
    }) => Effect.Effect<void, WorkspaceProviderError>;
  }
>()("t3/project/WorkspaceProvider") {}

/** @public */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const intents = yield* WorkspaceAllocationIntents.WorkspaceAllocationIntents;
  const crypto = yield* Crypto.Crypto;
  // Allocations this process is making or has not yet settled; `reconcile` leaves them alone.
  const live = new Set<string>();
  // Serialises settling an intent against `adoptPrior` claiming it.
  const settling = yield* Semaphore.make(1);

  const runSlipjay = (
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
      );

  const slipjay = (
    operation: WorkspaceProviderError["operation"],
    projectRoot: string,
    args: ReadonlyArray<string>,
    cwd = projectRoot,
  ) =>
    runSlipjay(operation, projectRoot, args, cwd).pipe(
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

  const attemptState = (root: string, attemptId: string) =>
    runSlipjay("allocate", root, ["attempt", "show", attemptId]).pipe(
      Effect.flatMap((output): Effect.Effect<AttemptState, WorkspaceProviderError> =>
        output.code !== 0
          ? // Only SlipJay's own "No allocation attempt" means the start never recorded itself;
            // any other failure leaves the attempt's state unknown.
            `${output.stderr}${output.stdout}`.includes(NO_ATTEMPT_MESSAGE)
            ? Effect.succeed({ kind: "absent" })
            : Effect.fail(
                new WorkspaceProviderError({
                  operation: "allocate",
                  projectRoot: root,
                  ...(output.code === null ? {} : { exitCode: output.code }),
                  detail: boundedDetail(output),
                }),
              )
          : decodeSlipJayAttempt(output.stdout.trim()).pipe(
              Effect.map((attempt): AttemptState => {
                if (attempt.status === "failed" || attempt.interrupted) return { kind: "failed" };
                if (attempt.status !== "ready" || attempt.workspacePath === undefined)
                  return { kind: "running" };
                return {
                  kind: "ready",
                  workspacePath: attempt.workspacePath,
                  owned: attempt.owned ?? null,
                };
              }),
              Effect.mapError(
                (cause) =>
                  new WorkspaceProviderError({ operation: "allocate", projectRoot: root, cause }),
              ),
            ),
      ),
    );

  // Ends the intent. A failed write leaves a row that `reconcile` settles again, harmlessly.
  const forgetIntent = (attemptId: string) =>
    intents.forget(attemptId).pipe(
      Effect.ensuring(Effect.sync(() => live.delete(attemptId))),
      Effect.catch((error) =>
        Effect.logWarning("Could not forget a workspace allocation intent", {
          attemptId,
          error: error.message,
        }),
      ),
    );

  // The allocation is over: only a later sweep can settle the row now.
  const annotateIntent = (attemptId: string, detail: string) =>
    intents.annotate(attemptId, detail).pipe(
      Effect.ensuring(Effect.sync(() => live.delete(attemptId))),
      Effect.catch((error) =>
        Effect.logWarning("Could not annotate a workspace allocation intent", {
          attemptId,
          error: error.message,
        }),
      ),
    );

  // Asks SlipJay to give the attempt's checkout back. It removes only a checkout the attempt
  // created and nothing has used since, so this is safe for a resumed or bound one. A refusal
  // (unlanded work, a live process) keeps the intent with SlipJay's reason for a later sweep.
  const releaseAttempt = (root: string, attemptId: string) =>
    runSlipjay("release", root, ["attempt", "release", attemptId]).pipe(
      Effect.flatMap((output) =>
        decodeSlipJayAttemptRelease(output.stdout.trim()).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceProviderError({
                operation: "release",
                projectRoot: root,
                detail: boundedDetail(output),
                cause,
              }),
          ),
        ),
      ),
      Effect.flatMap((result) =>
        result.released || result.reason === UNKNOWN_ATTEMPT
          ? forgetIntent(attemptId)
          : annotateIntent(attemptId, result.reason ?? "SlipJay kept the checkout"),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not release a workspace allocation attempt", {
          attemptId,
          error: error.message,
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

  // A start that has not settled: the caller learns its attempt and that retrying the same
  // request reconciles it. The intent stays for that retry or the startup sweep.
  const unsettled = (
    root: string,
    attemptId: string,
    state: "running" | "unknown",
    owner: WorkspaceOwner,
    cause?: WorkspaceProviderError,
  ) =>
    Effect.logWarning("Workspace allocation attempt has not settled", {
      attemptId,
      state,
      owner: `${owner.kind}:${owner.ref}`,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new WorkspaceProviderError({
            operation: "allocate",
            projectRoot: root,
            ...(cause?.exitCode === undefined ? {} : { exitCode: cause.exitCode }),
            detail: `${cause?.detail ? `${cause.detail}. ` : ""}${
              state === "running"
                ? `SlipJay attempt ${attemptId} is still running and may yet complete`
                : `SlipJay could not report the state of attempt ${attemptId}, which may still be running`
            }. T3 keeps the attempt${
              // Only a thread launch's retry adopts its earlier attempt; any other new request starts another.
              owner.kind === "thread-launch"
                ? ": retry the same request to reconcile it rather than start another checkout."
                : ` and settles it when it finishes; check it with \`slipjay attempt show ${attemptId}\` before asking again, since a new request starts another checkout.`
            }`,
          }),
        ),
      ),
    );

  // The receipt of a start that did not return one, read from SlipJay's attempt record. A
  // finished checkout is used rather than started again; one that did not finish is released.
  // `cause` is why the start looked failed, and is what the caller sees when nothing was made.
  const settleStart = (
    root: string,
    attemptId: string,
    owner: WorkspaceOwner,
    cause: WorkspaceProviderError,
  ) =>
    attemptState(root, attemptId).pipe(
      Effect.orElseSucceed((): AttemptReading => ({ kind: "unknown" })),
      Effect.flatMap(
        (
          state,
        ): Effect.Effect<
          { workspacePath: string; created: boolean | null },
          WorkspaceProviderError
        > => {
          switch (state.kind) {
            case "ready":
              return Effect.succeed({ workspacePath: state.workspacePath, created: state.owned });
            case "absent":
              return forgetIntent(attemptId).pipe(Effect.andThen(Effect.fail(cause)));
            case "failed":
              return releaseAttempt(root, attemptId).pipe(Effect.andThen(Effect.fail(cause)));
            case "running":
            case "unknown":
              return Effect.sync(() => live.delete(attemptId)).pipe(
                Effect.andThen(unsettled(root, attemptId, state.kind, owner, cause)),
              );
          }
        },
      ),
    );

  // The checkout an earlier, interrupted launch of this thread finished. Only a thread's own
  // launch adopts: a retry is the same request, so the checkout is the one it was owed. Rows
  // that SlipJay shows were never made or did not finish are settled on the way, and one still
  // running is refused rather than raced: a second start would make a second checkout.
  const adoptPrior = Effect.fn("WorkspaceProvider.adoptPrior")(function* (
    root: string,
    owner: WorkspaceOwner,
  ) {
    if (owner.kind !== "thread-launch") return null;
    // Held with `reconcile`'s per-intent step, so a sweep cannot release a checkout between
    // this reading it ready and claiming it in `live`.
    return yield* settling.withPermits(1)(
      Effect.gen(function* () {
        const earlier = yield* intents.list.pipe(
          Effect.map((rows) =>
            rows.filter(
              (row) =>
                row.projectRoot === root &&
                row.ownerKind === owner.kind &&
                row.ownerRef === owner.ref &&
                !live.has(row.attemptId),
            ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not look for an earlier workspace allocation", {
              owner: `${owner.kind}:${owner.ref}`,
              error: error.message,
            }).pipe(Effect.as([])),
          ),
        );
        for (const row of earlier) {
          const state = yield* attemptState(root, row.attemptId).pipe(
            Effect.orElseSucceed((): AttemptReading => ({ kind: "unknown" })),
          );
          switch (state.kind) {
            case "ready":
              live.add(row.attemptId);
              return {
                attemptId: row.attemptId,
                workspacePath: state.workspacePath,
                created: state.owned,
              };
            case "absent":
              yield* forgetIntent(row.attemptId);
              break;
            case "failed":
              yield* releaseAttempt(root, row.attemptId);
              break;
            case "running":
            case "unknown":
              return yield* unsettled(root, row.attemptId, state.kind, owner);
          }
        }
        return null;
      }),
    );
  });

  const allocate: WorkspaceProvider["Service"]["allocate"] = Effect.fn(
    "WorkspaceProvider.allocate",
  )(({ projectRoot, task, issue, owner }) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // A project registered in a subdirectory allocates from its SlipJay root.
        const root = (yield* slipJayProject(projectRoot))?.root ?? projectRoot;
        const prior = yield* adoptPrior(root, owner);
        const attemptId =
          prior?.attemptId ??
          (yield* crypto
            .randomUUIDv4()
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
              ),
            ));
        live.add(attemptId);
        // Recorded before SlipJay runs, so nothing T3 loses track of can strand a checkout.
        if (prior === null) {
          yield* intents
            .record({
              attemptId,
              projectRoot: root,
              ownerKind: owner.kind,
              ownerRef: owner.ref,
              createdAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(
              Effect.tapError(() => Effect.sync(() => live.delete(attemptId))),
              Effect.mapError(
                (cause) =>
                  new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
              ),
            );
        }
        // To resume, SlipJay returns the item's workspace (or its surviving checkout) and
        // creates one attached to it only when none exists.
        const resume = issue?.mode === "resume";
        const result =
          prior ??
          (yield* slipjay("allocate", root, [
            "start",
            "--integration",
            "--json",
            "--attempt",
            attemptId,
            ...(resume ? ["--issue", String(issue.number)] : []),
            task,
          ]).pipe(
            Effect.flatMap((output) =>
              decodeSlipJayStartResult(output.stdout.trim()).pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkspaceProviderError({ operation: "allocate", projectRoot, cause }),
                ),
              ),
            ),
            Effect.catch((error) => settleStart(root, attemptId, owner, error)),
          ));
        // Resuming would hand over a workspace that may be another thread's. Attaching
        // refuses an item another workspace holds, so this checkout only ever belongs to
        // the thread that asked for it.
        const attachFailure =
          issue === undefined || resume
            ? undefined
            : yield* slipjay(
                "allocate",
                root,
                ["attach-issue", String(issue.number)],
                result.workspacePath,
              ).pipe(
                Effect.as(undefined),
                Effect.catch((error) =>
                  Effect.logWarning("SlipJay workspace allocated without its Issue", {
                    workspacePath: result.workspacePath,
                    issue: issue.number,
                    error: error.message,
                  }).pipe(Effect.as(error.message)),
                ),
              );
        const allocation = {
          workspacePath: result.workspacePath,
          created: result.created ?? null,
          issue: issue !== undefined && attachFailure === undefined ? issue.number : null,
          attemptId,
          ...(attachFailure === undefined ? {} : { attachFailure }),
        };
        // SlipJay emits the path after preparation. Cancellation waits for that
        // receipt so a workspace it created can be returned rather than orphaned.
        return yield* restore(Effect.succeed(allocation)).pipe(
          Effect.onInterrupt(() => releaseAttempt(root, attemptId)),
        );
      }),
    ),
  );

  const settled: WorkspaceProvider["Service"]["settled"] = (attemptId) => forgetIntent(attemptId);

  const abandon: WorkspaceProvider["Service"]["abandon"] = (attemptId) =>
    intents.list.pipe(
      Effect.map((rows) => rows.find((row) => row.attemptId === attemptId)),
      Effect.flatMap((intent) =>
        intent === undefined ? Effect.void : releaseAttempt(intent.projectRoot, attemptId),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not abandon a workspace allocation", {
          attemptId,
          error: error.message,
        }),
      ),
    );

  const reconcile: WorkspaceProvider["Service"]["reconcile"] = Effect.fn(
    "WorkspaceProvider.reconcile",
  )(function* ({ isBound, retryable }) {
    const pending = yield* intents.list.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not list workspace allocation intents", {
          error: error.message,
        }).pipe(Effect.as([])),
      ),
    );
    yield* Effect.forEach(
      pending,
      (intent) =>
        // Checked under the lock `adoptPrior` claims with, so an allocation this process took
        // over after the list was read is left alone.
        settling.withPermits(1)(
          Effect.suspend(() =>
            live.has(intent.attemptId)
              ? Effect.void
              : attemptState(intent.projectRoot, intent.attemptId).pipe(
                  Effect.flatMap((state) => {
                    switch (state.kind) {
                      case "absent":
                        return forgetIntent(intent.attemptId);
                      case "running":
                        return Effect.void;
                      case "failed":
                        return releaseAttempt(intent.projectRoot, intent.attemptId);
                      case "ready":
                        return isBound(state.workspacePath).pipe(
                          Effect.flatMap((bound) =>
                            bound
                              ? forgetIntent(intent.attemptId)
                              : // A failed preparation's retry adopts the checkout; nothing else will.
                                (intent.ownerKind === "thread-launch"
                                  ? retryable(intent.ownerRef)
                                  : Effect.succeed(false)
                                ).pipe(
                                  Effect.flatMap((awaited) =>
                                    awaited
                                      ? Effect.void
                                      : releaseAttempt(intent.projectRoot, intent.attemptId),
                                  ),
                                ),
                          ),
                        );
                    }
                  }),
                  Effect.catch((error) =>
                    Effect.logWarning("Could not settle a workspace allocation intent", {
                      attemptId: intent.attemptId,
                      owner: `${intent.ownerKind}:${intent.ownerRef}`,
                      error: error.message,
                    }),
                  ),
                ),
          ),
        ),
      { discard: true },
    );
  });

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

  return WorkspaceProvider.of({
    resolve,
    allocate,
    settled,
    abandon,
    reconcile,
    release,
    contains,
    remove,
  });
});

export const layer = Layer.effect(WorkspaceProvider, make).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(WorkspaceAllocationIntents.layer),
);

/** A provider for tests whose projects all use Git worktrees. */
export const layerGitWorktree = Layer.mock(WorkspaceProvider)({
  resolve: () => Effect.succeed("git-worktree"),
});
