import type { AgentPolicyPublish } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

export class PolicyCheckoutError extends Schema.TaggedError<PolicyCheckoutError>()(
  "PolicyCheckoutError",
  {
    reason: Schema.Literals(["stale", "attention"]),
    commit: Schema.optional(Schema.String),
  },
) {}

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

const policyBlob = Effect.fn("AgentConfigCheckout.policyBlob")(function* (
  root: string,
  revision?: string,
) {
  return (
    stdout(
      yield* git(
        root,
        revision === undefined
          ? ["hash-object", "--", POLICY_PATH]
          : // A successful empty tree listing means deleted; null means unreadable.
            ["ls-tree", "--format=%(objectname)", revision, "--", POLICY_PATH],
      ),
    )?.trim() ?? null
  );
});

const synchronizePolicy = Effect.fn("AgentConfigCheckout.synchronizePolicy")(function* (
  root: string,
) {
  const pending = stdout(yield* git(root, ["status", "--porcelain", "--", POLICY_PATH]));
  if (pending !== "" || !succeeded(yield* git(root, ["merge", "--ff-only", "origin/main"])))
    return yield* new PolicyCheckoutError({ reason: "attention" });
  return yield* new PolicyCheckoutError({ reason: "stale" });
});

/** Fetch before touching the policy; never replace a hand edit in the working tree. */
export const preparePolicy = Effect.fn("AgentConfigCheckout.preparePolicy")(function* (
  root: string,
) {
  const base = yield* policyBlob(root);
  const branch = stdout(yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  if (branch !== "main") return base;
  const fetched = yield* git(root, ["fetch", "origin", "main"], "30 seconds");
  if (succeeded(fetched)) {
    const remote = yield* policyBlob(root, "origin/main");
    const contained = yield* git(root, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
    if (remote !== null && remote !== base && contained?.code !== 0)
      return yield* synchronizePolicy(root);
  }
  return base;
});

/**
 * Commits and pushes one policy save so the shared checkout's other users see it, leaving every
 * other staged or unstaged change exactly as it was. Remote policy divergence refuses the save;
 * ordinary publication failures keep the local save and report why it was not pushed.
 */
export const publishPolicy = Effect.fn("AgentConfigCheckout.publishPolicy")(function* (
  root: string,
  revision: string,
  base: string | null,
): Effect.fn.Return<AgentPolicyPublish, PolicyCheckoutError, ProcessRunner.ProcessRunner> {
  const notPushed = (detail: string): AgentPolicyPublish => ({ pushed: false, detail });
  const branch = stdout(yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (branch === null) return notPushed("not a git checkout");
  if (branch.trim() !== "main") return notPushed("not on main");
  if (stdout(yield* git(root, ["remote", "get-url", "origin"])) === null)
    return notPushed("no origin remote");
  const pending = stdout(yield* git(root, ["status", "--porcelain", "--", POLICY_PATH]));
  if (pending === null) return notPushed("git status failed");
  let created: string | null = null;
  if (pending.trim() !== "") {
    // --only keeps other files' staged and unstaged changes out of this commit.
    const commit = yield* git(root, [
      "-c",
      "core.abbrev=40",
      "-c",
      "color.ui=false",
      "commit",
      "--only",
      "-m",
      `chore(policy): ${revision} from Settings`,
      "--",
      POLICY_PATH,
    ]);
    if (!succeeded(commit)) return notPushed("commit failed");
    created = /^\[[^\]\n]* ([0-9a-f]{40})\]/m.exec(commit.stdout)?.[1] ?? null;
  }
  // Pushes an earlier save's commit too, if an earlier push was refused.
  const pushMain = git(root, ["push", "origin", "HEAD:main"], "30 seconds");
  let push = yield* pushMain;
  if (push !== null && !push.timedOut && push.code !== 0) {
    // Only unrelated remote changes may be rebased; unseen policy changes must be refused.
    const fetched = yield* git(root, ["fetch", "origin", "main"], "30 seconds");
    if (succeeded(fetched)) {
      const remote = yield* policyBlob(root, "origin/main");
      const contained = yield* git(root, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
      if (remote !== null && remote !== base && contained?.code !== 0) {
        const head = stdout(yield* git(root, ["rev-parse", "HEAD"]))?.trim();
        const paths =
          created === null
            ? null
            : stdout(
                yield* git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", created]),
              )?.trim();
        const reachable =
          created === null
            ? null
            : yield* git(root, ["merge-base", "--is-ancestor", created, "origin/main"]);
        const clean = stdout(yield* git(root, ["status", "--porcelain", "--", POLICY_PATH]));
        if (
          created === null ||
          head !== created ||
          paths !== POLICY_PATH ||
          reachable?.code !== 1 ||
          clean !== ""
        )
          return yield* new PolicyCheckoutError({
            reason: "attention",
            ...(created === null ? {} : { commit: created }),
          });
        // Drop only our still-unpublished tip; the index and other working files stay intact.
        if (
          !succeeded(yield* git(root, ["update-ref", "HEAD", `${created}^`, created])) ||
          !succeeded(
            yield* git(root, [
              "restore",
              "--source=HEAD",
              "--staged",
              "--worktree",
              "--",
              POLICY_PATH,
            ]),
          )
        )
          return yield* new PolicyCheckoutError({ reason: "attention", commit: created });
        return yield* synchronizePolicy(root);
      }
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
