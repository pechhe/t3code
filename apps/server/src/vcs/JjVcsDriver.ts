import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  PositiveInt,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as VcsDriver from "./VcsDriver.ts";
import { listGitCheckpointAuthoredPaths } from "./GitCheckpointPaths.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import { findSlipJayProject } from "./SlipJayProject.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const IGNORE_CHECK_MAX_STDIN_BYTES = 256 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TRUNCATED_MARKER = "\n\n[truncated]";
const decodeSlipJayStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      workspace: Schema.Struct({
        name: Schema.NonEmptyString,
        issueNumber: Schema.optional(PositiveInt),
      }),
      integration: Schema.Struct({ name: Schema.NonEmptyString }),
    }),
  ),
);
const quoteRevsetSymbol = Schema.encodeSync(Schema.fromJsonString(Schema.String));

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
  // Reads the policy a SlipJay checkout of an older revision lacks; see findSlipJayProject.
  const processes = yield* ProcessRunner.make();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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

  /**
   * The commit where this work left the base, the Jujutsu form of Git's merge-base. A
   * client names the base, so it is read as a bookmark or ref, never as an expression.
   */
  const resolveBase = (cwd: string, baseRef: string | undefined) =>
    jj(
      "JjVcsDriver.getDiffPreview.base",
      cwd,
      [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        `fork_point((${baseRef === undefined ? "trunk()" : quoteRevsetSymbol(baseRef)}) | @)`,
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
      // The working copy always compares with its parent, whatever base the client echoes.
      const oldRevision =
        input.sourceKind === "working-tree"
          ? "@-"
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

  // Hidden Git refs retain the exact objects even after JJ abandons the change
  // and prunes its operation/index history. JJ revision lookup alone cannot
  // resolve those pruned commits, so restore exports their trees through a
  // disposable Git index, then lets JJ snapshot the resulting working copy.
  const checkpointGit = Effect.fn("JjVcsDriver.checkpoints.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Pick<VcsProcess.VcsProcessInput, "env" | "allowNonZeroExit" | "outputMode">,
  ) {
    const store = yield* jj("JjVcsDriver.checkpoints.gitRoot", cwd, [
      "git",
      "root",
      "--ignore-working-copy",
    ]);
    return yield* vcsProcess.run({
      operation: "JjVcsDriver.checkpoints.git",
      command: "git",
      cwd,
      args: ["--git-dir", store.stdout.trim(), ...args],
      maxOutputBytes: 16 * 1024 * 1024,
      ...options,
    });
  });
  const checkpointCommit = (cwd: string, ref: string) =>
    checkpointGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
  const snapshot = Effect.fn("JjVcsDriver.checkpoints.snapshot")(function* (cwd: string) {
    const result = yield* jj("JjVcsDriver.checkpoints.snapshot", cwd, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'commit_id ++ " " ++ conflict',
    ]);
    const [revision, conflict] = result.stdout.trim().split(" ");
    if (conflict !== "false" || !revision || !/^[0-9a-f]+$/.test(revision))
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.checkpoints.snapshot",
        kind: "jj",
        detail: "A checkpoint requires a working-copy snapshot without unresolved conflicts.",
      });
    return revision;
  });
  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("JjVcsDriver.checkpoints.capture")(function* (input) {
      const revision = yield* snapshot(input.cwd);
      // The working copy's first parent plays Git's recorded HEAD for authored-path
      // accounting. The working-copy commit itself is rewritten on every snapshot, so
      // as a parent it would count every edit since its base as this turn's. The root
      // commit is no Git object, so a checkpoint on it has no parent.
      const parents = yield* jj("JjVcsDriver.checkpoints.parent", input.cwd, [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        revision,
        "-T",
        'parents.map(|c| if(c.root(), "", c.commit_id())).join(" ")',
      ]);
      const parent = parents.stdout.trim().split(" ")[0] ?? "";
      const commit = yield* checkpointGit(input.cwd, [
        "-c",
        "user.name=T3 Code",
        "-c",
        "user.email=checkpoint@t3.codes",
        "-c",
        "core.fsync=loose-object,reference",
        "commit-tree",
        `${revision}^{tree}`,
        ...(parent === "" ? [] : ["-p", parent]),
        "-m",
        `t3 checkpoint ref=${input.checkpointRef}`,
      ]);
      yield* checkpointGit(input.cwd, [
        "-c",
        "core.fsync=loose-object,reference",
        "update-ref",
        input.checkpointRef,
        commit.stdout.trim(),
      ]);
    }),
    hasCheckpointRef: (input) =>
      checkpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),
    restoreCheckpoint: Effect.fn("JjVcsDriver.checkpoints.restore")(function* (input) {
      const target =
        (yield* checkpointCommit(input.cwd, input.checkpointRef)) ??
        (input.fallbackToHead === true ? yield* snapshot(input.cwd) : null);
      if (target === null) return false;
      const current = yield* snapshot(input.cwd);
      const rootPath = yield* root(input.cwd);
      if (rootPath === null) return false;
      const store = yield* jj("JjVcsDriver.checkpoints.restore.gitRoot", input.cwd, [
        "git",
        "root",
        "--ignore-working-copy",
      ]);
      const indexId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const indexPath = path.join(store.stdout.trim(), `t3-jj-checkpoint-index-${indexId}`);
      yield* Effect.gen(function* () {
        const env = { ...globalThis.process.env, GIT_INDEX_FILE: indexPath };
        // The current tree tells Git which newly tracked files must disappear.
        // The repository's real index and every other JJ workspace stay untouched.
        yield* checkpointGit(input.cwd, ["read-tree", current], { env });
        yield* checkpointGit(
          input.cwd,
          ["--work-tree", rootPath, "restore", "--source", target, "--worktree", "--", "."],
          { env },
        );
      }).pipe(
        Effect.ensuring(
          Effect.forEach(
            [indexPath, `${indexPath}.lock`],
            (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );
      yield* snapshot(input.cwd);
      return true;
    }),
    diffCheckpoints: Effect.fn("JjVcsDriver.checkpoints.diff")(function* (input) {
      if (input.filePaths?.length === 0) return "";
      const from =
        (yield* checkpointCommit(input.cwd, input.fromCheckpointRef)) ??
        (input.fallbackFromToHead === true ? yield* snapshot(input.cwd) : input.fromCheckpointRef);
      return (yield* checkpointGit(
        input.cwd,
        [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${from}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        { outputMode: "error" },
      )).stdout;
    }),
    listAuthoredPaths: (input) =>
      listGitCheckpointAuthoredPaths(input, (read) =>
        checkpointGit(read.cwd, read.args, { outputMode: "error" }),
      ),

    deleteCheckpointRefs: Effect.fn("JjVcsDriver.checkpoints.delete")(function* (input) {
      yield* Effect.forEach(
        input.checkpointRefs,
        (ref) => checkpointGit(input.cwd, ["update-ref", "-d", ref]),
        { discard: true },
      );
    }),
  };

  // SlipJay owns workspace identity. Status refreshes often and an Issue is attached rarely,
  // so one `slipjay status` per workspace serves a few minutes. Without a working CLI the
  // strip just goes unlabelled.
  const slipJayWorkspaces = yield* Cache.makeWith(
    (workspaceRoot: string) =>
      vcsProcess
        .run({
          operation: "JjVcsDriver.getStatus.workspace",
          command: "slipjay",
          args: ["status"],
          cwd: workspaceRoot,
          timeoutMs: 3_000,
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.flatMap((result) => decodeSlipJayStatus(result.stdout)),
          Effect.map((status) => ({
            name: status.workspace.name,
            ...(status.workspace.issueNumber === undefined
              ? {}
              : { issueNumber: status.workspace.issueNumber }),
            isIntegration: status.workspace.name === status.integration.name,
          })),
          Effect.catch((cause) =>
            Effect.logDebug("SlipJay workspace identity unavailable", cause).pipe(
              Effect.as(undefined),
            ),
          ),
        ),
    { capacity: 64, timeToLive: () => Duration.minutes(2) },
  );

  const getStatus: NonNullable<VcsDriver.VcsDriver["Service"]["getStatus"]> = Effect.fn(
    "JjVcsDriver.getStatus",
  )(function* (input) {
    const rootPath = yield* root(input.cwd);
    if (rootPath === null)
      return yield* new VcsUnsupportedOperationError({
        operation: "JjVcsDriver.getStatus",
        kind: "jj",
        detail: "No Jujutsu repository is available.",
      });
    const slipJayProject = yield* findSlipJayProject(rootPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
    );
    const isSlipJay = slipJayProject !== null;
    const integration = slipJayProject?.integration ?? null;
    // Quote a bookmark as a revset symbol; config content cannot become a revset.
    // present() leaves a bookmark that does not exist yet with nothing behind it.
    const base = integration === null ? undefined : `present(${quoteRevsetSymbol(integration)})`;
    // Status needs line counts, not whole patches. A structured template also
    // preserves paths containing whitespace, quotes and line breaks.
    const stats = yield* jj("JjVcsDriver.getStatus.files", rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'self.diff().stat().files().map(|f| f.path() ++ "\\0" ++ f.lines_added() ++ "\\0" ++ f.lines_removed() ++ "\\0").join("")',
    ]);
    const fields = splitNullSeparated(stats.stdout, false);
    const files: Array<{ path: string; insertions: number; deletions: number }> = [];
    for (let offset = 0; offset < fields.length; offset += 3) {
      const insertions = Number(fields[offset + 1]);
      const deletions = Number(fields[offset + 2]);
      if (
        !Number.isSafeInteger(insertions) ||
        insertions < 0 ||
        !Number.isSafeInteger(deletions) ||
        deletions < 0
      )
        return yield* new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.getStatus.files",
          kind: "jj",
          detail: "Jujutsu returned invalid working-copy statistics.",
        });
      files.push({ path: fields[offset]!, insertions, deletions });
    }
    const totals = files.reduce(
      (sum, file) => ({
        insertions: sum.insertions + file.insertions,
        deletions: sum.deletions + file.deletions,
      }),
      { insertions: 0, deletions: 0 },
    );
    let behindCount = 0;
    if (base !== undefined) {
      const behind = yield* jj("JjVcsDriver.getStatus.behind", rootPath, [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        `fork_point((${base}) | @)..(${base})`,
        "-T",
        '"x"',
      ]);
      behindCount = behind.stdout.length;
    }
    const remotes = yield* listRemotes(rootPath);
    const workspace = isSlipJay ? yield* Cache.get(slipJayWorkspaces, rootPath) : undefined;
    return {
      // isRepo is the legacy Git-action gate. JJ identifies itself separately
      // while sharing the status payload; Git-only mutations stay unavailable.
      isRepo: false,
      otherVcsKind: "jj",
      hasPrimaryRemote: remotes.remotes.length > 0,
      isDefaultRef: false,
      refName: integration,
      ...(isSlipJay
        ? {
            slipJay: {
              integration,
              hasReleaseBranch: slipJayProject.hasReleaseBranch,
              ...(workspace === undefined ? {} : { workspace }),
            },
          }
        : {}),
      hasWorkingTreeChanges: files.length > 0,
      workingTree: { files, ...totals },
      hasUpstream: false,
      aheadCount: 0,
      behindCount,
      pr: null,
    };
  });

  const slipJayLandCandidate: NonNullable<VcsDriver.VcsDriver["Service"]["slipJayLandCandidate"]> =
    Effect.fn("JjVcsDriver.slipJayLandCandidate")(function* ({ cwd, integration }) {
      // SlipJay never submits a change already on the integration bookmark or its remote.
      const bookmark = quoteRevsetSymbol(integration);
      const integrated = `::(present(${bookmark}) | remote_bookmarks(exact:${bookmark}))`;
      const result = yield* jj("JjVcsDriver.slipJayLandCandidate", cwd, [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "coalesce(@ ~ empty(), @-)",
        "-T",
        `change_id ++ " " ++ if(self.contained_in(${quoteRevsetSymbol(integrated)}), "integrated") ++ "\\n"`,
      ]);
      const [changeId, state] = result.stdout.split("\n")[0]?.trim().split(" ") ?? [];
      return changeId ? { changeId, integrated: state === "integrated" } : null;
    });

  return {
    capabilities,
    execute,
    checkpoints,
    getStatus,
    slipJayLandCandidate,
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
