import * as Effect from "effect/Effect";
import type { VcsError } from "@t3tools/contracts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, type VcsListAuthoredPathsInput } from "./VcsDriver.ts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";

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
        "log",
        "--no-walk=unsorted",
        "--format=%P %ct",
        `${input.fromCheckpointRef}^{commit}`,
        `${input.toCheckpointRef}^{commit}`,
      ],
    });
    // Each line is "<parent> <committer time>". The parent is the HEAD at capture.
    const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
    const [startHead = "", capturedAt = ""] = fromLine.split(" ");
    const [endHead = ""] = toLine.split(" ");
    if (startHead === "" || endHead === "" || startHead === endHead) {
      return null;
    }

    const listPaths = (args: ReadonlyArray<string>) =>
      read({
        operation,
        cwd: input.cwd,
        args: [...args, "--name-only", "-z", "--no-renames", "--no-ext-diff"],
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\0")));
    // Remerge diff lists a merge's paths only where the result differs from Git's
    // automatic merge, so a merge keeps its conflict fixes and drops clean upstream changes.
    const pathLists = yield* Effect.all(
      [
        listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
        listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
        listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
        listPaths([
          "log",
          "--format=",
          "--diff-merges=remerge",
          `--since=@${capturedAt}`,
          `${startHead}..${endHead}`,
        ]),
      ],
      { concurrency: 2 },
    );
    return new Set(pathLists.flat().filter((path) => path.length > 0));
  },
);
