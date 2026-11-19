import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";

/**
 * The thread config that points a managed task's shell at its own temp dir. Per thread because
 * the app-server is shared; `excludeTmpdirEnvVar` still keeps the server's own TMPDIR outside
 * the sandbox.
 */
export const codexSandboxTempConfig = (
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined,
): Readonly<Record<string, Schema.Json>> =>
  runtimePolicy?.sandboxTempRoot === undefined
    ? {}
    : {
        shell_environment_policy: {
          set: { TMPDIR: runtimePolicy.sandboxTempRoot },
        },
      };

/**
 * Every task on a provider session shares its app-server, so a task's temp dir cannot live in
 * the server's environment: it travels as that thread's shell config, is made before its turn,
 * and goes when the turn ends. The policy names one root per task. Must run in the session's
 * scope: its finalizer removes what is left when the session closes.
 */
export const makeCodexSandboxTempDirs = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
) {
  const sandboxTempDirs = yield* Ref.make(new Map<string, string>());
  const rememberSandboxTempDir = (threadId: string, directory: string) =>
    Ref.update(sandboxTempDirs, (current) => new Map(current).set(threadId, directory));
  const releaseSandboxTempDir = Effect.fn("CodexAdapterV2.releaseSandboxTempDir")(function* (
    directory: string,
  ) {
    yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not remove a managed task's temp directory.", {
          directory,
        }),
      ),
    );
  });
  const forgetSandboxTempDir = Effect.fn("CodexAdapterV2.forgetSandboxTempDir")(function* (
    threadId: string,
  ) {
    const directory = (yield* Ref.get(sandboxTempDirs)).get(threadId);
    if (directory === undefined) return;
    yield* Ref.update(sandboxTempDirs, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
    yield* releaseSandboxTempDir(directory);
  });
  yield* Effect.addFinalizer(() =>
    Ref.get(sandboxTempDirs).pipe(
      Effect.flatMap((directories) => Effect.forEach(directories.values(), releaseSandboxTempDir)),
    ),
  );
  // A task's temp dir must outlive every turn of it that has started and not finished.
  const sandboxTempTurns = yield* Ref.make(new Map<string, number>());
  const holdSandboxTempDir = (root: string) =>
    Ref.update(sandboxTempTurns, (current) => {
      const next = new Map(current);
      next.set(root, (next.get(root) ?? 0) + 1);
      return next;
    });
  const releaseSandboxTempTurn = (root: string) =>
    Ref.modify(sandboxTempTurns, (current) => {
      const live = (current.get(root) ?? 0) - 1;
      const next = new Map(current);
      if (live > 0) next.set(root, live);
      else next.delete(root);
      return [Math.max(0, live), next] as const;
    });

  return {
    /**
     * Made per turn because the same shared app-server serves every task, so the directory
     * cannot come from its environment; the turn's config names it.
     */
    begin: Effect.fnUntraced(function* (threadId: string, root: string | undefined) {
      if (root === undefined) return;
      // Hold it before it exists, so an earlier turn ending cannot remove it.
      yield* holdSandboxTempDir(root);
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* rememberSandboxTempDir(threadId, root);
    }),
    /**
     * A turn that never started keeps the directory only while another of the task's turns is
     * still live.
     */
    abandon: Effect.fnUntraced(function* <E>(
      threadId: string,
      root: string | undefined,
      cause: Cause.Cause<E>,
    ) {
      if (root !== undefined && (yield* releaseSandboxTempTurn(root)) === 0)
        yield* forgetSandboxTempDir(threadId);
      return yield* Effect.failCause(cause);
    }),
    /**
     * A task's temp dir goes when its turn ends, unless a process it started still runs or
     * another of its turns is live; unloading the thread then removes it. Untraced: it runs
     * inside the turn finalizer's span.
     */
    releaseIfIdle: Effect.fnUntraced(function* (
      threadId: string,
      root: string | undefined,
      hasRetainedBackgroundWork: Effect.Effect<boolean>,
    ) {
      if (root === undefined) return;
      if ((yield* releaseSandboxTempTurn(root)) > 0) return;
      if (yield* hasRetainedBackgroundWork) return;
      yield* forgetSandboxTempDir(threadId);
    }),
    forget: forgetSandboxTempDir,
  };
});
