import type { AgentPolicyPublish } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProcessRunner from "../processRunner.ts";

const POLICY_PATH = "roles/policy.json";

const git = Effect.fn("AgentConfigCheckout.git")(function* (
  root: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = "5 seconds",
) {
  const processes = yield* ProcessRunner.ProcessRunner;
  const output = yield* processes
    .run({
      command: "git",
      // --no-optional-locks: reading never rewrites the shared checkout's index.
      args: ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
      cwd: root,
      timeout,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 64 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0" },
    })
    .pipe(Effect.option);
  return Option.getOrNull(output);
});

type GitOutput = ProcessRunner.ProcessRunOutput;

const succeeded = (output: GitOutput | null): output is GitOutput =>
  output !== null && output.code === 0;

const stdout = (output: GitOutput | null): string | null =>
  succeeded(output) ? output.stdout : null;

/**
 * The agent-config checkout's revision and unlanded state, read with plain git. HEAD is both the
 * landed revision and the working copy, since a git checkout keeps edits in the files themselves.
 * Commands take no lock and never snapshot the shared checkout; anything unreadable is null.
 */
export const read = Effect.fn("AgentConfigCheckout.read")(function* (root: string) {
  const revision = stdout(yield* git(root, ["rev-parse", "HEAD"]))?.trim() || null;
  const status = stdout(yield* git(root, ["status", "--porcelain"]));
  return {
    root,
    revision,
    workingCopyRevision: revision,
    hasLocalChanges: status === null ? null : status.trim() !== "",
  };
});

/** Commits on `origin/main` the checkout does not contain yet; null without a readable `main`. */
export const commitsBehindMain = Effect.fn("AgentConfigCheckout.commitsBehindMain")(function* (
  root: string,
) {
  const count = stdout(yield* git(root, ["rev-list", "--count", "HEAD..origin/main"]));
  const parsed = count === null ? Number.NaN : Number.parseInt(count.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
});

/**
 * Commits and pushes one policy save so the shared checkout's other users see it, leaving every
 * other staged or unstaged change exactly as it was. Never fails: the policy file is already
 * written, so a checkout that cannot publish only reports why.
 */
export const publishPolicy = Effect.fn("AgentConfigCheckout.publishPolicy")(function* (
  root: string,
  revision: string,
): Effect.fn.Return<AgentPolicyPublish, never, ProcessRunner.ProcessRunner> {
  const notPushed = (detail: string): AgentPolicyPublish => ({ pushed: false, detail });
  const branch = stdout(yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (branch === null) return notPushed("not a git checkout");
  if (branch.trim() !== "main") return notPushed("not on main");
  if (stdout(yield* git(root, ["remote", "get-url", "origin"])) === null)
    return notPushed("no origin remote");
  const pending = stdout(yield* git(root, ["status", "--porcelain", "--", POLICY_PATH]));
  if (pending === null) return notPushed("git status failed");
  if (pending.trim() !== "") {
    // --only keeps other files' staged and unstaged changes out of this commit.
    const commit = yield* git(root, [
      "commit",
      "--only",
      "-m",
      `chore(policy): ${revision} from Settings`,
      "--",
      POLICY_PATH,
    ]);
    if (!succeeded(commit)) return notPushed("commit failed");
  }
  // Pushes an earlier save's commit too, if an earlier push was refused.
  const pushMain = git(root, ["push", "origin", "HEAD:main"], "30 seconds");
  let push = yield* pushMain;
  if (push !== null && !push.timedOut && push.code !== 0) {
    // A save applied across environments commits the same change on each checkout, so main moves
    // underneath us. Rebase drops commits origin already has; a real conflict is aborted.
    const fetched = yield* git(root, ["fetch", "origin", "main"], "30 seconds");
    if (succeeded(fetched)) {
      const rebased = yield* git(root, ["rebase", "--autostash", "origin/main"], "30 seconds");
      if (!succeeded(rebased)) {
        yield* git(root, ["rebase", "--abort"]);
        return notPushed("push rejected: main has conflicting changes to pull by hand");
      }
      push = yield* pushMain;
    }
  }
  if (push === null) return notPushed("push failed");
  if (push.timedOut) return notPushed("push timed out");
  if (push.code !== 0) return notPushed("push rejected: pull agent-config's main, then save again");
  return { pushed: true, detail: null };
});
