import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";

const jjLog = Effect.fn("AgentConfigCheckout.jjLog")(function* (
  root: string,
  revset: string,
  template: string,
) {
  const processes = yield* ProcessRunner.ProcessRunner;
  // --ignore-working-copy: reading never snapshots or rewrites the live checkout.
  const output = yield* processes
    .run({
      command: "jj",
      args: ["--ignore-working-copy", "log", "-r", revset, "--no-graph", "-T", template],
      cwd: root,
      timeout: "5 seconds",
      maxOutputBytes: 64 * 1024,
    })
    .pipe(Effect.option);
  return Option.isSome(output) && output.value.code === 0 ? output.value.stdout : null;
});

/**
 * The agent-config checkout's landed base (the working copy's parent) and working copy.
 * Local changes come from git in a colocated checkout, whose HEAD is that landed base,
 * so edits made since jj's last snapshot still count. Anything unreadable is null.
 *
 * Unlike `handoffRevision` in `workspaceIdentity.ts`, this never snapshots the live
 * checkout, so `revision` is the working copy's parent. For a checkout with uncommitted
 * edits the two name different commits and are not comparable.
 */
export const read = Effect.fn("AgentConfigCheckout.read")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const stdout = yield* jjLog(
    root,
    "@",
    'commit_id ++ " " ++ parents.map(|c| c.commit_id()).join(",") ++ " " ++ if(empty, "empty", "changed")',
  );
  if (stdout === null)
    return { root, revision: null, workingCopyRevision: null, hasLocalChanges: null };
  const [workingCopy, parents, state] = stdout.trim().split(" ");
  const colocated = yield* fs
    .exists(path.join(root, ".git"))
    .pipe(Effect.orElseSucceed(() => false));
  const status = colocated
    ? yield* processes
        .run({
          command: "git",
          args: ["--no-optional-locks", "status", "--porcelain"],
          cwd: root,
          timeout: "5 seconds",
          maxOutputBytes: 64 * 1024,
        })
        .pipe(Effect.option)
    : Option.none();
  // A merge working copy has no single landed base.
  const revision =
    parents !== undefined && parents !== "" && !parents.includes(",") ? parents : null;
  return {
    root,
    revision,
    workingCopyRevision: workingCopy || null,
    hasLocalChanges:
      Option.isSome(status) && status.value.code === 0
        ? status.value.stdout.trim() !== ""
        : // An empty last snapshot says nothing about edits made since.
          state === "changed"
          ? true
          : null,
  };
});

/** Commits on `main` the working copy does not contain yet; null without a readable `main`. */
export const commitsBehindMain = Effect.fn("AgentConfigCheckout.commitsBehindMain")(function* (
  root: string,
) {
  const stdout = yield* jjLog(root, "::main ~ ::@", '"x\\n"');
  return stdout === null ? null : stdout.split("\n").filter((line) => line === "x").length;
});
