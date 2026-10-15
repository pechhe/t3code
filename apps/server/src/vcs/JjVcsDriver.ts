import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Hex from "effect/encoding/Hex";

import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const IGNORE_CHECK_MAX_STDIN_BYTES = 256 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TRUNCATED_MARKER = "\n\n[truncated]";

const nowFreshness = Effect.fn("JjVcsDriver.nowFreshness")(function* () {
  return {
    source: "live-local" as const,
    observedAt: yield* DateTime.now,
    expiresAt: Option.none(),
  };
});

/** A fileset naming exactly one path from the repository root, whatever characters it holds. */
const literalFileset = (path: string) =>
  `root-file:"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const splitNullSeparated = (stdout: string, truncated: boolean) => {
  const paths = stdout.split("\0");
  // A truncated listing ends mid-path, so its last entry is not trusted.
  if (truncated || paths.at(-1) === "") paths.pop();
  return paths.filter((path) => path.length > 0);
};

/** Per-file additions and deletions from a git-format patch, which Jujutsu has no numstat for. */
export function parseGitPatchStats(patch: string): ReviewDiffFileStat[] {
  const files: Array<
    { -readonly [K in keyof ReviewDiffFileStat]: ReviewDiffFileStat[K] } & { inHunk: boolean }
  > = [];
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      files.push({
        path: header[2]!,
        previousPath: null,
        additions: 0,
        deletions: 0,
        inHunk: false,
      });
      continue;
    }
    const file = files.at(-1);
    if (file === undefined) continue;
    if (!file.inHunk) {
      if (line.startsWith("rename from ")) file.previousPath = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("@@")) file.inHunk = true;
    } else if (line.startsWith("+")) file.additions++;
    else if (line.startsWith("-")) file.deletions++;
  }
  return files.map(({ inHunk: _inHunk, ...stat }) => stat);
}

const clipPatch = (patch: string, limit: number) => {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length <= limit) return { diff: patch, truncated: false };
  return {
    diff: `${new TextDecoder().decode(bytes.subarray(0, limit))}${TRUNCATED_MARKER}`,
    truncated: true,
  };
};

export const makeVcsDriverShape = Effect.fn("makeJjVcsDriverShape")(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;

  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: true,
    supportsBookmarks: true,
    supportsAtomicSnapshot: true,
    supportsPushDefaultRemote: false,
    // Jujutsu has no check-ignore; ignores are classified by Git's own matcher.
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const jj = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Omit<VcsProcess.VcsProcessInput, "operation" | "command" | "args" | "cwd">,
  ) =>
    vcsProcess.run({
      operation,
      command: "jj",
      args: ["--no-pager", "--color=never", ...args],
      cwd,
      ...options,
    });

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    jj(input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const exitError = (
    operation: string,
    command: string,
    cwd: string,
    result: VcsProcess.VcsProcessOutput,
  ) =>
    new VcsProcessExitError({
      operation,
      command,
      cwd,
      exitCode: result.exitCode,
      detail: result.stderr.trim() || `${command} failed`,
    });

  // A missing folder or an absent `jj` both mean this is not a Jujutsu repository for us.
  const root = (cwd: string) =>
    jj("JjVcsDriver.root", cwd, ["root", "--ignore-working-copy"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
      Effect.catchTags({ VcsProcessSpawnError: () => Effect.succeed(null) }),
    );

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    root(cwd).pipe(Effect.map((value) => value !== null));

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const rootPath = yield* root(cwd);
    if (rootPath === null) return null;
    return {
      kind: "jj" as const,
      rootPath,
      // A workspace's `.jj/repo` points at the shared store; the folder itself is the marker.
      metadataPath: `${rootPath}/.jj`,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "JjVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    // Listing snapshots the working copy, which starts tracking new files that are not ignored.
    const result = yield* jj(
      "JjVcsDriver.listWorkspaceFiles",
      cwd,
      ["file", "list", "-T", 'path ++ "\\0"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    if (result.exitCode !== 0)
      return yield* exitError("JjVcsDriver.listWorkspaceFiles", "jj file list", cwd, result);
    return {
      paths: splitNullSeparated(result.stdout, result.stdoutTruncated),
      truncated: result.stdoutTruncated,
      freshness: yield* nowFreshness(),
    };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "JjVcsDriver.listRemotes",
  )(function* (cwd) {
    const result = yield* jj(
      "JjVcsDriver.listRemotes",
      cwd,
      ["git", "remote", "list", "--ignore-working-copy"],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0)
      return yield* exitError("JjVcsDriver.listRemotes", "jj git remote list", cwd, result);
    const remotes = result.stdout.split("\n").flatMap((line) => {
      const separator = line.indexOf(" ");
      if (separator <= 0) return [];
      const name = line.slice(0, separator);
      const url = line.slice(separator + 1).trim();
      return url.length === 0
        ? []
        : [{ name, url, pushUrl: Option.none<string>(), isPrimary: name === "origin" }];
    });
    return { remotes, freshness: yield* nowFreshness() };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) return relativePaths;
    const rootPath = yield* root(cwd);
    if (rootPath === null)
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.filterIgnoredPaths",
        kind: "jj",
        detail: `No Jujutsu repository at ${cwd}.`,
      });
    // The repository's Git store lets Git's matcher read the workspace's own .gitignore files.
    const gitRoot = yield* jj(
      "JjVcsDriver.filterIgnoredPaths.gitRoot",
      cwd,
      ["git", "root", "--ignore-working-copy"],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 4_096 },
    );
    if (gitRoot.exitCode !== 0)
      return yield* exitError("JjVcsDriver.filterIgnoredPaths", "jj git root", cwd, gitRoot);

    const chunks: string[][] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const path of relativePaths) {
      const size = new TextEncoder().encode(path).length + 1;
      if (chunk.length > 0 && bytes + size > IGNORE_CHECK_MAX_STDIN_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(path);
      bytes += size;
    }
    if (chunk.length > 0) chunks.push(chunk);

    const ignored = new Set<string>();
    for (const paths of chunks) {
      const result = yield* vcsProcess.run({
        operation: "JjVcsDriver.filterIgnoredPaths",
        command: "git",
        args: ["check-ignore", "--no-index", "-z", "--stdin"],
        cwd: rootPath,
        env: {
          ...globalThis.process.env,
          GIT_DIR: gitRoot.stdout.trim(),
          GIT_WORK_TREE: rootPath,
        },
        stdin: `${paths.join("\0")}\0`,
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      });
      // Exit 1 means none of these paths is ignored.
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* exitError("JjVcsDriver.filterIgnoredPaths", "git check-ignore", cwd, result);
      for (const path of splitNullSeparated(result.stdout, result.stdoutTruncated))
        ignored.add(path);
    }
    return ignored.size === 0 ? relativePaths : relativePaths.filter((path) => !ignored.has(path));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = () =>
    Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.initRepository",
        kind: "jj",
        detail: "Create a Jujutsu repository with `jj git init`.",
      }),
    );

  const hashDiff = (cwd: string, diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
    crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify([diff, files]))).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new VcsProcessExitError({
            operation: "JjVcsDriver.getDiffPreview.hash",
            command: "crypto.digest SHA-256",
            cwd,
            exitCode: 1,
            detail: `Failed to hash review diff: ${String(cause)}`,
          }),
      ),
    );

  /** The commit where this work left the base, the Jujutsu form of Git's merge-base. */
  const resolveBase = (cwd: string, baseRef: string | undefined) =>
    jj(
      "JjVcsDriver.getDiffPreview.base",
      cwd,
      [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        `fork_point((${baseRef ?? "trunk()"}) | @)`,
        "-T",
        "commit_id",
      ],
      { allowNonZeroExit: true, timeoutMs: 10_000, maxOutputBytes: 4_096 },
    ).pipe(
      Effect.map((result) => {
        const commit = result.stdout.trim();
        // No trunk leaves only the empty root commit, which is no base to review against.
        return result.exitCode === 0 && /^[0-9a-f]+$/.test(commit) && !/^0+$/.test(commit)
          ? commit
          : null;
      }),
    );

  const readDiff = Effect.fn("JjVcsDriver.getDiffPreview.diff")(function* (
    cwd: string,
    range: ReadonlyArray<string>,
    input: ReviewDiffPreviewInput,
  ) {
    const files = input.file
      ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])].map(
          literalFileset,
        )
      : [];
    const result = yield* jj(
      "JjVcsDriver.getDiffPreview.patch",
      cwd,
      [
        "diff",
        "--git",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        ...range,
        "--",
        ...files,
      ],
      { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
    );
    if (result.exitCode !== 0)
      return yield* exitError("JjVcsDriver.getDiffPreview", "jj diff", cwd, result);
    // Totals come from the whole patch; only the text shown is clipped.
    const clipped = clipPatch(
      result.stdout,
      input.file ? REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES : REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
    );
    return { ...clipped, files: parseGitPatchStats(result.stdout) };
  });

  const getDiffPreview: NonNullable<VcsDriver.VcsDriver["Service"]["getDiffPreview"]> = Effect.fn(
    "JjVcsDriver.getDiffPreview",
  )(function* (input) {
    const rootPath = yield* root(input.cwd);
    if (rootPath === null) return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources: [] };

    // A per-file request only reads its own source.
    const wantsWorkingCopy = input.file?.sourceKind !== "branch-range";
    const wantsRange = input.file?.sourceKind !== "working-tree";
    const base = wantsRange ? yield* resolveBase(rootPath, input.baseRef) : null;

    const empty = { diff: "", truncated: false, files: [] as ReviewDiffFileStat[] };
    const [workingCopy, range] = yield* Effect.all(
      [
        // The working copy is itself a commit, so its own changes are its diff against its parent.
        wantsWorkingCopy ? readDiff(rootPath, ["-r", "@"], input) : Effect.succeed(empty),
        base === null
          ? Effect.succeed(empty)
          : readDiff(rootPath, ["--from", base, "--to", "@"], input),
      ],
      { concurrency: 2 },
    );
    const [workingCopyHash, rangeHash] = yield* Effect.all([
      hashDiff(rootPath, workingCopy.diff, workingCopy.files),
      hashDiff(rootPath, range.diff, range.files),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Working copy",
        baseRef: "@-",
        headRef: "@",
        diff: workingCopy.diff,
        files: workingCopy.files,
        diffHash: workingCopyHash,
        truncated: workingCopy.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: input.baseRef ? `Changes vs ${input.baseRef}` : "Changes",
        baseRef: input.baseRef ?? null,
        headRef: "@",
        diff: range.diff,
        files: range.files,
        diffHash: rangeHash,
        truncated: range.truncated,
      },
    ];
    return { cwd: input.cwd, generatedAt: yield* DateTime.now, sources };
  });

  const readFileAtRevision = Effect.fn("JjVcsDriver.getDiffFileContents.read")(function* (
    cwd: string,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* jj(
      "JjVcsDriver.getDiffFileContents.read",
      cwd,
      ["file", "show", "-r", revision, literalFileset(relativePath)],
      { allowNonZeroExit: true, maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.exitCode !== 0)
      return yield* exitError("JjVcsDriver.getDiffFileContents", "jj file show", cwd, result);
    if (result.stdout.includes("\0"))
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.getDiffFileContents",
        kind: "jj",
        detail: `Cannot expand binary file '${relativePath}'.`,
      });
    return result.stdout;
  });

  // Both views compare a commit with the working copy: its parent for the working copy, the
  // fork point from the base for Changes.
  const getDiffFileContents: NonNullable<VcsDriver.VcsDriver["Service"]["getDiffFileContents"]> =
    Effect.fn("JjVcsDriver.getDiffFileContents")(function* (input) {
      const rootPath = yield* root(input.cwd);
      if (rootPath === null)
        return yield* new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.getDiffFileContents",
          kind: "jj",
          detail: `No Jujutsu repository at ${input.cwd}.`,
        });
      const oldRevision =
        input.sourceKind === "working-tree"
          ? (input.baseRef ?? "@-")
          : yield* resolveBase(rootPath, input.baseRef ?? undefined);
      if (oldRevision === null)
        return yield* new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.getDiffFileContents",
          kind: "jj",
          detail: "There is no base revision to expand against.",
        });
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readFileAtRevision(rootPath, oldRevision, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readFileAtRevision(rootPath, "@", input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    });

  return {
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    getDiffPreview,
    getDiffFileContents,
  } satisfies VcsDriver.VcsDriver["Service"];
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
