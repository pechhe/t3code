// @effect-diagnostics nodeBuiltinImport:off -- Reads must not follow links out of the root, which needs lstat, O_NOFOLLOW and inode checks that Effect's FileSystem lacks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";

/**
 * Read-only inspection of one exact checkout for external MCP clients. The caller has already
 * proven it may read `root`; nothing here accepts a path from the caller that is not
 * workspace-relative, and nothing runs a command that can change the checkout or its VCS state.
 */

export const INSPECTION_LIMITS = {
  responseBytes: 20 * 1024,
  fileBytes: 1024 * 1024,
  searchFileBytes: 512 * 1024,
  searchFiles: 5000,
  searchBytes: 64 * 1024 * 1024,
  maxLines: 400,
  maxResults: 50,
  maxStatusEntries: 100,
  maxLogEntries: 50,
  walkEntries: 50_000,
  driftDiffs: 5,
  driftContentChecks: 25,
  statusBytes: 8 * 1024,
  commandOutputBytes: 4 * 1024 * 1024,
  commandTimeout: "20 seconds",
} as const;

export class WorkspaceInspectionError extends Schema.TaggedError<WorkspaceInspectionError>()(
  "WorkspaceInspectionError",
  {
    reason: Schema.Literals([
      "workspace_unavailable",
      "stale_source",
      "invalid_path",
      "denied_path",
      "not_text",
      "too_large",
      "invalid_cursor",
      "invalid_request",
      "not_found",
    ]),
    message: Schema.String,
  },
) {}

const refuse = (reason: WorkspaceInspectionError["reason"], message: string) =>
  new WorkspaceInspectionError({ reason, message });

export interface ChangedPath {
  readonly path: string;
  /** M modified, A added, D deleted, ? untracked. */
  readonly status: "M" | "A" | "D" | "?";
  /** Where the change is recorded: the VCS, or only on disk since the last snapshot. */
  readonly recordedIn: "vcs" | "disk";
}

export interface SourceObservation {
  readonly vcs: "git" | "jj";
  readonly revision: string;
  readonly parents: ReadonlyArray<string>;
  readonly ref: string | null;
  /** jj only: the working copy is read from its last snapshot, then compared with the disk. */
  readonly snapshotAt: number | null;
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly observationComplete: boolean;
  readonly token: string;
  readonly observedAt: string;
}

const DENIED_DIRECTORIES = new Set([
  ".git",
  ".jj",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".t3",
  ".bws",
  ".secrets",
  "secrets",
  ".terraform",
]);
const DENIED_FILE =
  /^(\.env(\..*)?|\.dev\.vars|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account.*\.json|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars|secret|secrets)|.*\.(sqlite|sqlite3|db)(-wal|-shm)?)$/i;
const ENV_TEMPLATE = /^\.env\..*\.(example|sample|template)$|^\.env\.(example|sample|template)$/i;
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export const isDeniedPath = (relativePath: string): boolean => {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((segment) => DENIED_DIRECTORIES.has(segment))) return true;
  if (DENIED_DIRECTORIES.has(name)) return true;
  return DENIED_FILE.test(name) && !ENV_TEMPLATE.test(name);
};
const containsSecret = (text: string): boolean =>
  SECRET_CONTENT.some((pattern) => pattern.test(text));

/** A workspace-relative POSIX path, or a refusal that never echoes the input. */
const checkRelativePath = (input: string) => {
  if (
    input.length === 0 ||
    input.length > 1024 ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  )
    return refuse("invalid_path", "Pass a path relative to the workspace root.");
  const segments = input.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === ""))
    return refuse("invalid_path", "Pass a normalised path inside the workspace.");
  if (isDeniedPath(input)) return refuse("denied_path", "This path is not readable.");
  return input;
};

const SearchCursor = Schema.Struct({
  token: Schema.String,
  file: Schema.Int,
  line: Schema.Int,
  /** Everything that shapes the result order, so a cursor cannot be replayed on another query. */
  query: Schema.String,
});
const DiffCursor = Schema.Struct({
  token: Schema.String,
  offset: Schema.Int,
  key: Schema.String,
});
const searchKey = (input: {
  readonly query: string;
  readonly mode: string;
  readonly caseSensitive?: boolean | undefined;
  readonly pathPrefix?: string | undefined;
}) => [input.mode, input.caseSensitive === true, input.pathPrefix ?? "", input.query].join("\0");
const SearchCursorJson = Schema.fromJsonString(SearchCursor);
const DiffCursorJson = Schema.fromJsonString(DiffCursor);
const base64 = (text: string) => Buffer.from(text).toString("base64url");
const unbase64 = (cursor: string) => Buffer.from(cursor, "base64url").toString("utf8");
const badCursor = () =>
  refuse("invalid_cursor", "This cursor is not valid. Start the request again.");
const encodeSearchJson = Schema.encodeSync(SearchCursorJson);
const encodeDiffJson = Schema.encodeSync(DiffCursorJson);
const decodeSearchJson = Schema.decodeUnknownEffect(SearchCursorJson);
const decodeDiffJson = Schema.decodeUnknownEffect(DiffCursorJson);
const encodeSearchCursor = (value: typeof SearchCursor.Type) => base64(encodeSearchJson(value));
const encodeDiffCursor = (value: typeof DiffCursor.Type) => base64(encodeDiffJson(value));
const decodeSearchCursor = (cursor: string) =>
  decodeSearchJson(unbase64(cursor)).pipe(Effect.mapError(badCursor));
const decodeDiffCursor = (cursor: string) =>
  decodeDiffJson(unbase64(cursor)).pipe(Effect.mapError(badCursor));

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => refuse("workspace_unavailable", "The workspace could not be read."),
  });

const truncateBytes = (text: string, maxBytes: number) => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Do not cut a UTF-8 sequence in half.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
};

const SKIPPED_WALK = new Set([".git", ".jj", "node_modules", ".t3", ".turbo", "dist", "coverage"]);

export class WorkspaceInspection extends Context.Service<
  WorkspaceInspection,
  {
    readonly observe: (root: string) => Effect.Effect<SourceObservation, WorkspaceInspectionError>;
    readonly requireCurrent: (
      root: string,
      token: string,
    ) => Effect.Effect<SourceObservation, WorkspaceInspectionError>;
    readonly readFile: (
      root: string,
      input: {
        readonly token: string;
        readonly path: string;
        readonly startLine?: number | undefined;
        readonly lineCount?: number | undefined;
      },
    ) => Effect.Effect<FileRead, WorkspaceInspectionError>;
    readonly search: (
      root: string,
      input: {
        readonly token: string;
        readonly query: string;
        readonly mode: "content" | "name";
        readonly caseSensitive?: boolean | undefined;
        readonly pathPrefix?: string | undefined;
        readonly limit?: number | undefined;
        readonly cursor?: string | undefined;
      },
    ) => Effect.Effect<SearchPage, WorkspaceInspectionError>;
    readonly log: (
      root: string,
      input: { readonly token: string; readonly limit?: number | undefined },
    ) => Effect.Effect<LogRead, WorkspaceInspectionError>;
    /** Already-recorded SlipJay landing results; runs nothing. */
    readonly evidence: (
      root: string,
      token: string,
    ) => Effect.Effect<EvidenceRead, WorkspaceInspectionError>;
    readonly diff: (
      root: string,
      input: {
        readonly token: string;
        readonly scope: "working" | "committed";
        readonly path?: string | undefined;
        readonly cursor?: string | undefined;
      },
    ) => Effect.Effect<DiffPage, WorkspaceInspectionError>;
  }
>()("t3/workspace/WorkspaceInspection") {}

export interface FileRead {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly source: SourceObservation;
}
export interface SearchPage {
  readonly matches: ReadonlyArray<{
    readonly path: string;
    readonly line?: number;
    readonly text?: string;
  }>;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly source: SourceObservation;
}
export interface LogRead {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly date: string;
    readonly author: string;
    readonly summary: string;
  }>;
  readonly source: SourceObservation;
}
export interface EvidenceRead {
  readonly source: SourceObservation;
  readonly evidence: "recorded" | "unavailable";
  /**
   * current: the landing published exactly this clean revision. stale: a finished landing for
   * some other source. unverified: the record is unfinished or unreadable. none: no record.
   */
  readonly sourceMatch: "current" | "stale" | "unverified" | "none";
  readonly landing?: {
    readonly operationId: string;
    readonly status: string;
    readonly stage: string;
    readonly terminal?: boolean;
    readonly baseCommitId?: string;
    readonly commitId?: string;
    readonly submittedAt?: string;
    readonly finishedAt?: string;
    readonly failureReason?: string;
    readonly checks: ReadonlyArray<{
      readonly command: string;
      readonly purpose: string;
      readonly outcome: string;
      readonly durationMs?: number | undefined;
      readonly failingTests: ReadonlyArray<string>;
    }>;
  };
  readonly note: string;
}
export interface DiffPage {
  readonly scope: "working" | "committed";
  readonly diff: string;
  readonly nextCursor: string | null;
  readonly omittedPaths: number;
  readonly source: SourceObservation;
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EXTERNAL_DIFF: "",
} as NodeJS.ProcessEnv;

export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const paths = yield* Path.Path;
  const sha = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const run = (root: string, command: "git" | "jj", args: ReadonlyArray<string>) =>
    processes
      .run({
        command,
        args:
          command === "jj"
            ? ["--ignore-working-copy", "--no-pager", "--color", "never", ...args]
            : ["--no-pager", "-c", "core.quotepath=off", ...args],
        cwd: root,
        env: command === "git" ? GIT_ENV : undefined,
        timeout: INSPECTION_LIMITS.commandTimeout,
        maxOutputBytes: INSPECTION_LIMITS.commandOutputBytes,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(() => refuse("workspace_unavailable", "The workspace could not be read.")),
      );

  const ok = (root: string, command: "git" | "jj", args: ReadonlyArray<string>) =>
    run(root, command, args).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout)
          : Effect.fail(refuse("workspace_unavailable", "The workspace could not be read.")),
      ),
    );

  const detect = Effect.fn("WorkspaceInspection.detect")(function* (root: string) {
    const real = yield* attempt(() => NodeFSP.realpath(root));
    if (real !== root)
      return yield* refuse("workspace_unavailable", "The bound workspace has moved or changed.");
    const hasJj = yield* attempt(() =>
      NodeFSP.stat(paths.join(root, ".jj")).then(
        (stat) => stat.isDirectory(),
        () => false,
      ),
    );
    if (hasJj) return "jj" as const;
    const top = yield* run(root, "git", ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || (yield* attempt(() => NodeFSP.realpath(top.stdout.trim()))) !== root)
      return yield* refuse(
        "workspace_unavailable",
        "The bound workspace is not a repository root.",
      );
    return "git" as const;
  });

  const fingerprint = Effect.fn("WorkspaceInspection.fingerprint")(function* (
    root: string,
    base: {
      readonly vcs: string;
      readonly revision: string;
      readonly changes: ReadonlyArray<ChangedPath>;
    },
  ) {
    // Content, not mtime, identifies a change: a preserved mtime must not keep a token alive.
    const stats = yield* Effect.forEach(
      base.changes,
      (change) =>
        Effect.gen(function* () {
          const bytes = yield* attempt(() =>
            NodeFSP.readFile(paths.join(root, change.path))
              .then((value) => value.subarray(0, INSPECTION_LIMITS.fileBytes))
              .catch(() => null),
          );
          const digest = bytes === null ? "gone" : yield* sha(bytes.toString("latin1"));
          return `${change.status}:${change.path}:${digest}`;
        }),
      { concurrency: 16 },
    );
    return (yield* sha([base.vcs, base.revision, ...stats.toSorted()].join("\0"))).slice(0, 32);
  });

  const parseGitStatus = (stdout: string): ChangedPath[] =>
    stdout
      .split("\0")
      .filter((entry) => entry.length > 3)
      .map((entry) => {
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        const status: ChangedPath["status"] =
          code === "??" ? "?" : code.includes("D") ? "D" : code.includes("A") ? "A" : "M";
        return { path, status, recordedIn: "vcs" as const };
      });

  /** Paths Git's matcher, reading the workspace's own .gitignore files, ignores. */
  const ignoredAmong = Effect.fn("WorkspaceInspection.ignoredAmong")(function* (
    root: string,
    candidates: ReadonlyArray<string>,
  ) {
    if (candidates.length === 0) return { ignored: new Set<string>(), known: true };
    const gitDir = yield* run(root, "jj", ["git", "root"]);
    if (gitDir.code !== 0) return { ignored: new Set<string>(), known: false };
    const result = yield* processes
      .run({
        command: "git",
        args: ["check-ignore", "--no-index", "-z", "--stdin"],
        cwd: root,
        env: { ...GIT_ENV, GIT_DIR: gitDir.stdout.trim(), GIT_WORK_TREE: root },
        stdin: `${candidates.join("\0")}\0`,
        timeout: INSPECTION_LIMITS.commandTimeout,
        maxOutputBytes: INSPECTION_LIMITS.commandOutputBytes,
        outputMode: "truncate",
      })
      .pipe(Effect.orElseSucceed(() => null));
    // Exit 1 means none of the paths is ignored.
    if (result === null || result.stdoutTruncated || (result.code !== 0 && result.code !== 1))
      return { ignored: new Set<string>(), known: false };
    return {
      ignored: new Set(result.stdout.split("\0").filter((entry) => entry !== "")),
      known: true,
    };
  });

  /** Files on disk newer than the jj snapshot, which `--ignore-working-copy` cannot see. */
  const jjDrift = Effect.fn("WorkspaceInspection.jjDrift")(function* (
    root: string,
    snapshotMs: number,
    tracked: ReadonlySet<string>,
  ) {
    const fresh: string[] = [];
    let seen = 0;
    let complete = true;
    const walk = (directory: string): Promise<void> =>
      NodeFSP.readdir(paths.join(root, directory), { withFileTypes: true }).then(
        async (entries) => {
          for (const entry of entries) {
            if (seen >= INSPECTION_LIMITS.walkEntries) {
              complete = false;
              return;
            }
            seen += 1;
            const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
            if (entry.isDirectory()) {
              if (!SKIPPED_WALK.has(entry.name)) await walk(relative);
            } else if (entry.isFile() && !tracked.has(relative)) {
              const stat = await NodeFSP.lstat(paths.join(root, relative));
              if (stat.mtimeMs >= snapshotMs) fresh.push(relative);
            }
          }
        },
        () => {
          complete = false;
        },
      );
    yield* attempt(() => walk(""));
    const { ignored, known } = yield* ignoredAmong(root, fresh);
    if (!known) complete = false;
    const found = fresh
      .filter((relative) => !ignored.has(relative))
      .map((relative): ChangedPath => ({ path: relative, status: "?", recordedIn: "disk" }));

    const deleted: ChangedPath[] = [];
    const touched: string[] = [];
    for (const relative of tracked) {
      const stat = yield* attempt(() =>
        NodeFSP.lstat(paths.join(root, relative)).then(
          (value) => value,
          () => null,
        ),
      );
      if (stat === null) deleted.push({ path: relative, status: "D", recordedIn: "disk" });
      else if (stat.mtimeMs >= snapshotMs) touched.push(relative);
    }
    // jj timestamps are whole seconds, so a file written in the snapshot's second may be
    // unchanged: only differing bytes count as an edit made after the snapshot. Each check
    // spawns jj, so a bulk rewrite beyond the cap is reported modified without the comparison.
    const verified = new Set(touched.slice(0, INSPECTION_LIMITS.driftContentChecks));
    if (touched.length > verified.size) complete = false;
    const edits = yield* Effect.forEach(
      touched,
      (relative) =>
        verified.has(relative)
          ? Effect.gen(function* () {
              const recorded = yield* jjSnapshotContent(root, relative);
              const onDisk = yield* attempt(() =>
                NodeFSP.readFile(paths.join(root, relative), "utf8").catch(() => null),
              );
              return recorded === onDisk
                ? []
                : [{ path: relative, status: "M", recordedIn: "disk" } satisfies ChangedPath];
            })
          : Effect.succeed([
              { path: relative, status: "M", recordedIn: "disk" } satisfies ChangedPath,
            ]),
      { concurrency: 8 },
    );
    return { changes: [...deleted, ...edits.flat(), ...found], complete };
  });

  const jjSnapshotContent = (root: string, relativePath: string) =>
    run(root, "jj", ["file", "show", "-r", "@", `root-file:${JSON.stringify(relativePath)}`]).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout : null)),
    );

  const observe = Effect.fn("WorkspaceInspection.observe")(function* (root: string) {
    const vcs = yield* detect(root);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    if (vcs === "git") {
      const head = yield* run(root, "git", ["rev-parse", "--verify", "-q", "HEAD"]);
      const revision = head.code === 0 ? head.stdout.trim() : "unborn";
      const parents =
        revision === "unborn"
          ? []
          : (yield* ok(root, "git", ["rev-list", "--parents", "-n", "1", "HEAD"]))
              .trim()
              .split(" ")
              .slice(1);
      const branch = yield* run(root, "git", ["symbolic-ref", "-q", "--short", "HEAD"]);
      const changes = parseGitStatus(
        yield* ok(root, "git", [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ]),
      );
      return {
        vcs,
        revision,
        parents,
        ref: branch.code === 0 ? branch.stdout.trim() : null,
        snapshotAt: null,
        changes,
        observationComplete: true,
        token: yield* fingerprint(root, { vcs, revision, changes }),
        observedAt,
      } satisfies SourceObservation;
    }
    const head = (yield* ok(root, "jj", [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ committer.timestamp().format("%s") ++ "\\t" ++ local_bookmarks.join(",") ++ "\\n"',
    ]))
      .trim()
      .split("\t");
    const revision = head[0] ?? "";
    const snapshotMs = Number(head[2] ?? "0") * 1000;
    const summary = (yield* ok(root, "jj", ["diff", "-r", "@", "--summary"]))
      .split("\n")
      .filter((line) => line.length > 2)
      .map((line): ChangedPath => ({
        path: line.slice(2),
        status: line[0] === "A" ? "A" : line[0] === "D" ? "D" : "M",
        recordedIn: "vcs",
      }));
    const tracked = new Set(
      (yield* ok(root, "jj", ["file", "list", "-r", "@"]))
        .split("\n")
        .filter((line) => line !== ""),
    );
    const drift = yield* jjDrift(root, snapshotMs, tracked);
    const recorded = new Set(summary.map((change) => change.path));
    const changes = [...summary, ...drift.changes.filter((change) => !recorded.has(change.path))];
    return {
      vcs,
      revision,
      parents: (head[1] ?? "").split(",").filter((parent) => parent !== ""),
      ref: (head[3] ?? "") === "" ? null : (head[3] ?? null),
      snapshotAt: snapshotMs,
      changes,
      observationComplete: drift.complete,
      token: yield* fingerprint(root, { vcs, revision, changes }),
      observedAt,
    } satisfies SourceObservation;
  });

  const requireCurrent = Effect.fn("WorkspaceInspection.requireCurrent")(function* (
    root: string,
    token: string,
  ) {
    const current = yield* observe(root);
    if (current.token !== token)
      return yield* refuse(
        "stale_source",
        "The workspace changed since this read context. Call workspace_read_context again.",
      );
    return current;
  });

  /** Tracked plus non-ignored untracked files, sorted; ignored and denied files never appear. */
  const readableFiles = Effect.fn("WorkspaceInspection.readableFiles")(function* (
    root: string,
    source: SourceObservation,
  ) {
    const names =
      source.vcs === "git"
        ? (yield* ok(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
            .split("\0")
            .filter((name) => name !== "")
        : [
            ...(yield* ok(root, "jj", ["file", "list", "-r", "@"])).split("\n"),
            ...source.changes
              .filter((change) => change.status === "?")
              .map((change) => change.path),
          ].filter((name) => name !== "");
    return [...new Set(names)].filter((name) => !isDeniedPath(name)).toSorted();
  });

  /** Opens a file only after its real path is re-checked inside the root, and never follows a link out. */
  const openText = (root: string, relativePath: string, maxBytes: number) =>
    attempt(async () => {
      const full = paths.join(root, relativePath);
      const link = await NodeFSP.lstat(full);
      if (link.isSymbolicLink() || !link.isFile()) return "unreadable" as const;
      const real = await NodeFSP.realpath(full);
      if (!real.startsWith(root + paths.sep)) return "unreadable" as const;
      if (link.size > maxBytes) return "too_large" as const;
      const handle = await NodeFSP.open(
        full,
        NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev)
          return "unreadable" as const;
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.subarray(0, 8192).includes(0)) return "binary" as const;
        return bytes.toString("utf8");
      } finally {
        await handle.close();
      }
    }).pipe(
      Effect.flatMap((result) =>
        result === "too_large"
          ? Effect.fail(refuse("too_large", "This file is too large to read."))
          : result === "binary"
            ? Effect.fail(refuse("not_text", "This file is not text."))
            : result === "unreadable"
              ? Effect.fail(refuse("not_found", "No readable file exists at this path."))
              : Effect.succeed(result),
      ),
    );

  const readFile = Effect.fn("WorkspaceInspection.readFile")(function* (
    root: string,
    input: {
      readonly token: string;
      readonly path: string;
      readonly startLine?: number | undefined;
      readonly lineCount?: number | undefined;
    },
  ) {
    const path = checkRelativePath(input.path);
    if (typeof path !== "string") return yield* path;
    const source = yield* requireCurrent(root, input.token);
    const readable = yield* readableFiles(root, source);
    if (!readable.includes(path))
      return yield* refuse("not_found", "No readable file exists at this path.");
    const text = yield* openText(root, path, INSPECTION_LIMITS.fileBytes);
    if (containsSecret(text))
      return yield* refuse(
        "denied_path",
        "This file contains secret material and is not readable.",
      );
    // The file must still be what the context described once its bytes are in hand.
    yield* requireCurrent(root, input.token);
    const lines = text.split("\n");
    const startLine = Math.max(1, input.startLine ?? 1);
    const count = Math.min(INSPECTION_LIMITS.maxLines, Math.max(1, input.lineCount ?? 200));
    const slice = lines.slice(startLine - 1, startLine - 1 + count).join("\n");
    const bounded = truncateBytes(slice, INSPECTION_LIMITS.responseBytes);
    const shownLines = bounded.text === "" ? 0 : bounded.text.split("\n").length;
    return {
      path,
      startLine,
      endLine: startLine + Math.max(0, shownLines - 1),
      totalLines: lines.length,
      content: bounded.text,
      truncated: bounded.truncated || startLine - 1 + count < lines.length,
      source,
    } satisfies FileRead;
  });

  const search = Effect.fn("WorkspaceInspection.search")(function* (
    root: string,
    input: {
      readonly token: string;
      readonly query: string;
      readonly mode: "content" | "name";
      readonly caseSensitive?: boolean | undefined;
      readonly pathPrefix?: string | undefined;
      readonly limit?: number | undefined;
      readonly cursor?: string | undefined;
    },
  ) {
    if (input.query.length === 0 || input.query.length > 200)
      return yield* refuse("invalid_request", "The query must be 1 to 200 characters.");
    const prefix = input.pathPrefix === undefined ? "" : input.pathPrefix.replace(/\/$/, "");
    if (prefix !== "") {
      const checked = checkRelativePath(prefix);
      if (typeof checked !== "string") return yield* checked;
    }
    const cursor = input.cursor === undefined ? undefined : yield* decodeSearchCursor(input.cursor);
    if (cursor !== undefined && (cursor.token !== input.token || cursor.query !== searchKey(input)))
      return yield* refuse("stale_source", "This cursor belongs to another read context or query.");
    const source = yield* requireCurrent(root, input.token);
    const files = (yield* readableFiles(root, source)).filter(
      (name) => prefix === "" || name === prefix || name.startsWith(`${prefix}/`),
    );
    const limit = Math.min(INSPECTION_LIMITS.maxResults, Math.max(1, input.limit ?? 25));
    const needle = input.caseSensitive === true ? input.query : input.query.toLowerCase();
    const fold = (text: string) => (input.caseSensitive === true ? text : text.toLowerCase());
    const matches: Array<{ path: string; line?: number; text?: string }> = [];
    let fileIndex = cursor?.file ?? 0;
    let startLine = cursor?.line ?? 0;
    let scannedBytes = 0;
    let scannedFiles = 0;
    let budgetHit = false;
    let outputBytes = 0;
    for (; fileIndex < files.length && matches.length < limit && !budgetHit; fileIndex += 1) {
      const name = files[fileIndex]!;
      if (input.mode === "name") {
        if (fold(name).includes(needle)) matches.push({ path: name });
        continue;
      }
      if (
        scannedFiles >= INSPECTION_LIMITS.searchFiles ||
        scannedBytes >= INSPECTION_LIMITS.searchBytes
      ) {
        budgetHit = true;
        break;
      }
      scannedFiles += 1;
      const text = yield* openText(root, name, INSPECTION_LIMITS.searchFileBytes).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (text === null) {
        startLine = 0;
        continue;
      }
      scannedBytes += text.length;
      // A secret anywhere in the file hides the whole file, as it does for a read.
      if (containsSecret(text)) {
        startLine = 0;
        continue;
      }
      const lines = text.split("\n");
      for (let index = startLine; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!fold(line).includes(needle) || containsSecret(line)) continue;
        const shown = truncateBytes(line, 240).text;
        outputBytes += shown.length + name.length + 24;
        if (matches.length >= limit || outputBytes > INSPECTION_LIMITS.responseBytes) {
          return {
            matches,
            nextCursor: encodeSearchCursor({
              token: input.token,
              file: fileIndex,
              line: index,
              query: input.query,
            }),
            truncated: true,
            filesScanned: scannedFiles,
            source,
          } satisfies SearchPage;
        }
        matches.push({ path: name, line: index + 1, text: shown });
      }
      startLine = 0;
    }
    yield* requireCurrent(root, input.token);
    const more = fileIndex < files.length;
    return {
      matches,
      nextCursor: more
        ? encodeSearchCursor({
            token: input.token,
            file: fileIndex,
            line: 0,
            query: searchKey(input),
          })
        : null,
      truncated: more,
      filesScanned: scannedFiles,
      source,
    } satisfies SearchPage;
  });

  const log = Effect.fn("WorkspaceInspection.log")(function* (
    root: string,
    input: { readonly token: string; readonly limit?: number | undefined },
  ) {
    const source = yield* requireCurrent(root, input.token);
    const limit = Math.min(INSPECTION_LIMITS.maxLogEntries, Math.max(1, input.limit ?? 20));
    const raw =
      source.vcs === "git"
        ? source.revision === "unborn"
          ? ""
          : yield* ok(root, "git", [
              "log",
              "-n",
              String(limit),
              "--format=%H%x1f%aI%x1f%an%x1f%s%x1e",
            ])
        : yield* ok(root, "jj", [
            "log",
            "-r",
            `ancestors(@, ${limit})`,
            "--no-graph",
            "-T",
            'commit_id ++ "\\x1f" ++ author.timestamp() ++ "\\x1f" ++ author.name() ++ "\\x1f" ++ description.first_line() ++ "\\x1e"',
          ]);
    const entries = raw
      .split("\x1e")
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record !== "")
      .slice(0, limit)
      .map((record) => {
        const [id = "", date = "", author = "", summary = ""] = record.split("\x1f");
        return {
          id,
          date,
          author: truncateBytes(author, 80).text,
          summary: truncateBytes(summary, 200).text,
        };
      });
    return { entries, source } satisfies LogRead;
  });

  const noIndexDiff = (root: string, left: string, right: string) =>
    run(root, "git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", left, right]).pipe(
      Effect.map((output) => output.stdout),
    );

  const diff = Effect.fn("WorkspaceInspection.diff")(function* (
    root: string,
    input: {
      readonly token: string;
      readonly scope: "working" | "committed";
      readonly path?: string | undefined;
      readonly cursor?: string | undefined;
    },
  ) {
    let path: string | undefined;
    if (input.path !== undefined) {
      const checked = checkRelativePath(input.path);
      if (typeof checked !== "string") return yield* checked;
      path = checked;
    }
    const key = `${input.scope}:${path ?? ""}`;
    const cursor = input.cursor === undefined ? undefined : yield* decodeDiffCursor(input.cursor);
    if (cursor !== undefined && (cursor.token !== input.token || cursor.key !== key))
      return yield* refuse(
        "stale_source",
        "This cursor belongs to another read context or request.",
      );
    const source = yield* requireCurrent(root, input.token);
    const pathArgs = path === undefined ? [] : ["--", path];
    let text = "";
    let skipped = 0;
    if (source.vcs === "git") {
      const base =
        source.revision === "unborn" ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : source.revision;
      text =
        input.scope === "working"
          ? yield* ok(root, "git", [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              base,
              ...pathArgs,
            ])
          : source.parents[0] === undefined
            ? yield* ok(root, "git", [
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                base,
                ...pathArgs,
              ])
            : yield* ok(root, "git", [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                source.parents[0],
                base,
                ...pathArgs,
              ]);
      if (input.scope === "working") {
        const untracked = source.changes.filter(
          (change) => change.status === "?" && (path === undefined || change.path === path),
        );
        const listable = untracked.filter((change) => !isDeniedPath(change.path));
        skipped += untracked.length - Math.min(listable.length, INSPECTION_LIMITS.driftDiffs);
        for (const change of listable.slice(0, INSPECTION_LIMITS.driftDiffs))
          text += yield* noIndexDiff(root, "/dev/null", change.path);
      }
    } else if (input.scope === "committed") {
      text = yield* ok(root, "jj", ["diff", "-r", "@-", "--git", ...pathArgs]);
    } else {
      text = yield* ok(root, "jj", ["diff", "-r", "@", "--git", ...pathArgs]);
      const drifted = source.changes.filter(
        (change) => change.recordedIn === "disk" && (path === undefined || change.path === path),
      );
      const drift = drifted.filter((change) => !isDeniedPath(change.path));
      skipped += drifted.length - Math.min(drift.length, INSPECTION_LIMITS.driftDiffs);
      const scratch = yield* attempt(() =>
        NodeFSP.mkdtemp(paths.join(NodeOS.tmpdir(), "t3-inspect-")),
      );
      // Snapshot copies hold workspace content, so they go even when a step fails or is cancelled.
      text += yield* Effect.gen(function* () {
        let drifted = "";
        for (const change of drift.slice(0, INSPECTION_LIMITS.driftDiffs)) {
          const snapshot =
            change.status === "?" ? null : yield* jjSnapshotContent(root, change.path);
          const before = paths.join(scratch, "snapshot");
          yield* attempt(() => NodeFSP.writeFile(before, snapshot ?? ""));
          const after = change.status === "D" ? "/dev/null" : change.path;
          drifted += (yield* noIndexDiff(
            root,
            snapshot === null ? "/dev/null" : before,
            after,
          )).replaceAll(before.replace(/^\//, ""), change.path);
        }
        return drifted;
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true })),
        ),
      );
    }
    // Per-file blocks: a denied path, or secret material in the block or anywhere in the file as it
    // is on disk, drops the whole block, so a hunk of a key's body cannot slip through alone.
    let omittedPaths = skipped;
    const blocks: string[] = [];
    for (const block of text.split(/^(?=diff --git )/m)) {
      if (block === "") continue;
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
      const named = header === null ? [] : [header[1]!, header[2]!];
      let denied = named.some(isDeniedPath) || containsSecret(block);
      if (!denied && header !== null) {
        // A file too large to check whole cannot be shown to hold no secret, so it is withheld;
        // one that is gone (a deletion) has nothing on disk to check.
        const whole = yield* openText(root, header[2]!, INSPECTION_LIMITS.fileBytes).pipe(
          Effect.catch((error) =>
            Effect.succeed(error.reason === "too_large" ? "-----BEGIN PRIVATE KEY-----" : ""),
          ),
        );
        denied = containsSecret(whole);
      }
      if (denied) omittedPaths += 1;
      else blocks.push(block);
    }
    const kept = blocks.join("");
    const offset = cursor?.offset ?? 0;
    const buffer = Buffer.from(kept, "utf8");
    const windowed = truncateBytes(
      buffer.subarray(offset).toString("utf8"),
      INSPECTION_LIMITS.responseBytes,
    );
    const consumed = offset + Buffer.byteLength(windowed.text, "utf8");
    yield* requireCurrent(root, input.token);
    return {
      scope: input.scope,
      diff: windowed.text,
      nextCursor:
        consumed < buffer.length
          ? encodeDiffCursor({ token: input.token, offset: consumed, key })
          : null,
      omittedPaths,
      source,
    } satisfies DiffPage;
  });

  const evidence = Effect.fn("WorkspaceInspection.evidence")(function* (
    root: string,
    token: string,
  ) {
    const source = yield* requireCurrent(root, token);
    const none = {
      source,
      evidence: "unavailable",
      sourceMatch: "none",
      note: "No SlipJay landing is recorded for this workspace. Nothing was run.",
    } satisfies EvidenceRead;
    const landings = yield* Effect.serviceOption(SlipJayLandings.SlipJayLandings);
    const project = yield* findSlipJayProject(root).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, paths),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
      Effect.orElseSucceed(() => null),
    );
    if (Option.isNone(landings) || project === null || project.integration === null) return none;
    const landing = yield* landings.value.landingFor(root, project.integration);
    if (landing === undefined) return none;
    const detail = yield* landings.value
      .readDetail({ cwd: root, operationId: landing.operationId })
      .pipe(Effect.option);
    const terminal = Option.isSome(detail) && detail.value.terminal;
    const commitId = Option.isSome(detail) ? detail.value.commitId : landing.commitId;
    const sourceMatch = !terminal
      ? "unverified"
      : commitId === source.revision && source.changes.length === 0
        ? "current"
        : "stale";
    return {
      source,
      evidence: "recorded",
      sourceMatch,
      landing: {
        operationId: landing.operationId,
        status: landing.status,
        stage: landing.stage,
        ...(Option.isSome(detail)
          ? {
              terminal: detail.value.terminal,
              ...(detail.value.baseCommitId === undefined
                ? {}
                : { baseCommitId: detail.value.baseCommitId }),
              ...(commitId === undefined ? {} : { commitId }),
              ...(detail.value.submittedAt === undefined
                ? {}
                : { submittedAt: detail.value.submittedAt }),
              ...(detail.value.finishedAt === undefined
                ? {}
                : { finishedAt: detail.value.finishedAt }),
              ...(detail.value.failure === undefined
                ? {}
                : { failureReason: truncateBytes(detail.value.failure.reason, 500).text }),
            }
          : {}),
        checks: Option.isSome(detail)
          ? detail.value.checks.slice(0, 30).map((check) => ({
              command: truncateBytes(check.command, 300).text,
              purpose: truncateBytes(check.purpose, 100).text,
              outcome: truncateBytes(check.outcome, 100).text,
              ...(check.durationMs === undefined ? {} : { durationMs: check.durationMs }),
              failingTests: check.failingTests
                .slice(0, 20)
                .map((name) => truncateBytes(name, 200).text),
            }))
          : [],
      },
      note: "Recorded by the SlipJay runner for this workspace's change; nothing was run to produce it. Only a landing that published exactly this clean revision is current evidence, and a command run inside T3 is not part of this record.",
    } satisfies EvidenceRead;
  });

  return { observe, requireCurrent, readFile, search, log, diff, evidence };
});

export const layer = Layer.effect(WorkspaceInspection, make);
