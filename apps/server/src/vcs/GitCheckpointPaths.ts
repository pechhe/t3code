import * as Effect from "effect/Effect";
import type { VcsError } from "@t3tools/contracts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, type VcsListAuthoredPathsInput } from "./VcsDriver.ts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";

// Paths are repository-relative, and log.showSignature prints verification text into the output.
const STABLE_OUTPUT_CONFIG = ["-c", "diff.relative=false", "-c", "log.showSignature=false"];
// Reflog subjects that only move a ref. Unknown subjects conservatively count as creating a commit.
const REF_MOVE_REFLOG_SUBJECT =
  /^(?:$|(?:checkout|reset|branch|clone|fetch)\b|[^:]*\((?:start|finish|abort|reset)\): |(?:merge|pull|rebase|cherry-pick)\b[^()]*: fast-forward$)/i;

/** Filters clean imported upstream changes out of a turn's checkpoint summary. */
export const listGitCheckpointAuthoredPaths = Effect.fn("listGitCheckpointAuthoredPaths")(
  function* (
    input: VcsListAuthoredPathsInput,
    read: (input: Omit<VcsProcessInput, "command">) => Effect.Effect<VcsProcessOutput, VcsError>,
  ) {
    const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
    const heads = yield* read({
      operation,
      cwd: input.cwd,
      args: [
        ...STABLE_OUTPUT_CONFIG,
        "log",
        "--no-walk=unsorted",
        "--format=%ct %P",
        `${input.fromCheckpointRef}^{commit}`,
        `${input.toCheckpointRef}^{commit}`,
      ],
    });
    // Each line is "<committer time> <parent>"; the parent is the HEAD at capture.
    const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
    const [capturedAt = "", startHead = ""] = fromLine.split(" ");
    const [, endHead = ""] = toLine.split(" ");
    if (startHead === "" || endHead === "" || startHead === endHead) return null;

    const listLines = (args: ReadonlyArray<string>, stdin?: string) =>
      read({
        operation,
        cwd: input.cwd,
        args: ["-c", "log.showSignature=false", ...args],
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\n").filter((line) => line !== "")));
    const listPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      read({
        operation,
        cwd: input.cwd,
        args: [
          ...STABLE_OUTPUT_CONFIG,
          ...args,
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
        ],
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\0")));

    // A fetched commit is not attributed to the turn unless a worktree reflog shows T3 created it.
    const listImportedCommits = Effect.gen(function* () {
      const entries = (yield* listLines([
        "log",
        "--walk-reflogs",
        "--all",
        `--since=@${capturedAt}`,
        "--format=%H %gD %gs",
      ])).map((line) => {
        const [commit = "", selector = "", ...subject] = line.split(" ");
        return {
          commit,
          fetched: selector.startsWith("refs/remotes/"),
          subject: subject.join(" "),
        };
      });
      const fetchedTips = new Set(
        entries
          .filter((entry) => entry.fetched && entry.subject !== "update by push")
          .map((entry) => entry.commit),
      );
      if (fetchedTips.size === 0) return fetchedTips;
      const createdHere = new Set(
        entries
          .filter((entry) => !entry.fetched && !REF_MOVE_REFLOG_SUBJECT.test(entry.subject))
          .map((entry) => entry.commit),
      );
      const fetched = yield* listLines(
        ["rev-list", `--since=@${capturedAt}`, "--stdin"],
        `${[...fetchedTips, `^${startHead}`].join("\n")}\n`,
      );
      return new Set(fetched.filter((commit) => !createdHere.has(commit)));
    });

    // Remerge paths keep a merge's conflict fixes and omit its clean upstream changes.
    const [recentCommits, ...pathLists] = yield* Effect.all(
      [
        listLines(["rev-list", `--since=@${capturedAt}`, `${startHead}..${endHead}`]),
        listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
        listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
        listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
      ],
      { concurrency: 2 },
    );
    // Unreadable reflogs retain all recent commits as authored, matching the previous behavior.
    const importedCommits =
      recentCommits.length === 0
        ? new Set<string>()
        : yield* listImportedCommits.pipe(Effect.orElseSucceed(() => new Set<string>()));
    const ownCommits = recentCommits.filter((commit) => !importedCommits.has(commit));
    const ownCommitPaths =
      ownCommits.length === 0
        ? []
        : yield* listPaths(
            ["log", "--no-walk=unsorted", "--stdin", "--format=", "--diff-merges=remerge"],
            `${ownCommits.join("\n")}\n`,
          );
    return new Set([...pathLists.flat(), ...ownCommitPaths].filter((path) => path.length > 0));
  },
);
