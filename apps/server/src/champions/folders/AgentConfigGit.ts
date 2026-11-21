// @effect-diagnostics nodeBuiltinImport:off -- Sync blob hashing and a scratch index directory need no Effect services, keeping the requirement to ProcessRunner.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../../processRunner.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024 * 1024;

export class AgentConfigGitError extends Schema.TaggedError<
  AgentConfigGitError,
  { readonly brand: unique symbol }
>()("AgentConfigGitError", { operation: Schema.String, detail: Schema.String }) {}

export interface FolderFile {
  readonly path: string;
  readonly blob: string;
  readonly content: string;
}

export interface FolderChange {
  readonly path: string;
  readonly content: string | null;
}

const gitOutput = Effect.fn("AgentConfigGit.git")(function* (
  root: string,
  operation: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: Duration.Input;
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly maxOutputBytes?: number;
  } = {},
) {
  const processes = yield* ProcessRunner.ProcessRunner;
  return yield* processes
    .run({
      command: "git",
      args: ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
      cwd: root,
      timeout: options.timeout ?? "30 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    })
    .pipe(
      Effect.mapError((error) => new AgentConfigGitError({ operation, detail: error.message })),
    );
});

const run = Effect.fn("AgentConfigGit.run")(function* (
  root: string,
  operation: string,
  args: ReadonlyArray<string>,
  options: Parameters<typeof gitOutput>[3] = {},
) {
  const output = yield* gitOutput(root, operation, args, options);
  if (output.timedOut) return yield* new AgentConfigGitError({ operation, detail: "timed out" });
  if (output.code !== 0)
    return yield* new AgentConfigGitError({
      operation,
      detail: output.stderr.trim() || `git exited with ${output.code}`,
    });
  if (output.stdoutInvalidUtf8)
    return yield* new AgentConfigGitError({ operation, detail: "output is not valid UTF-8" });
  return output.stdout;
});

export const blobId = (content: string): string => {
  const bytes = Buffer.from(content, "utf8");
  return NodeCrypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

export const fetchMain = Effect.fn("AgentConfigGit.fetchMain")(function* (root: string) {
  yield* run(root, "fetch", ["fetch", "origin", "main"], { timeout: "60 seconds" });
  return (yield* run(root, "fetch", ["rev-parse", "--verify", "origin/main^{commit}"])).trim();
});

export const readFiles = Effect.fn("AgentConfigGit.readFiles")(function* (
  root: string,
  commit: string,
  prefix: string,
) {
  const listing = yield* run(
    root,
    "read",
    ["ls-tree", "-r", "-z", "--long", commit, "--", prefix],
    { maxOutputBytes: MAX_LISTING_BYTES },
  );
  const entries: Array<{ path: string; blob: string; size: number }> = [];
  for (const record of listing.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, blob, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || blob === undefined) continue;
    const path = record.slice(tab + 1);
    const bytes = Number(size);
    if (bytes > MAX_FILE_BYTES)
      return yield* new AgentConfigGitError({
        operation: "read",
        detail: `${path} is ${bytes} bytes, over the ${MAX_FILE_BYTES} byte limit`,
      });
    entries.push({ path, blob, size: bytes });
  }
  if (entries.length === 0) return [] as ReadonlyArray<FolderFile>;

  const batch = yield* run(root, "read", ["cat-file", "--batch"], {
    stdin: entries.map((entry) => `${entry.blob}\n`).join(""),
    maxOutputBytes: MAX_READ_BYTES,
    timeout: "60 seconds",
  });
  const bytes = Buffer.from(batch, "utf8");
  const files: Array<FolderFile> = [];
  let offset = 0;
  for (const entry of entries) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0)
      return yield* new AgentConfigGitError({
        operation: "read",
        detail: "truncated cat-file output",
      });
    const [, , size] = bytes.subarray(offset, newline).toString("utf8").split(" ");
    if (Number(size) !== entry.size)
      return yield* new AgentConfigGitError({
        operation: "read",
        detail: `unexpected object for ${entry.path}`,
      });
    const start = newline + 1;
    files.push({
      path: entry.path,
      blob: entry.blob,
      content: bytes.subarray(start, start + entry.size).toString("utf8"),
    });
    offset = start + entry.size + 1;
  }
  return files as ReadonlyArray<FolderFile>;
});

const NULL_BLOB = "0".repeat(40);

export const commitChanges = Effect.fn("AgentConfigGit.commitChanges")(function* (
  root: string,
  input: {
    readonly base: string;
    readonly changes: ReadonlyArray<FolderChange>;
    readonly message: string;
  },
) {
  const scratch = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-config-index-")),
      catch: (cause) => new AgentConfigGitError({ operation: "commit", detail: String(cause) }),
    }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const env = { GIT_INDEX_FILE: NodePath.join(scratch, "index") };
  const index = (operation: string, args: ReadonlyArray<string>, stdin?: string) =>
    run(root, operation, args, { env, ...(stdin === undefined ? {} : { stdin }) });

  yield* index("commit", ["read-tree", input.base]);
  const paths = input.changes.map((change) => change.path);
  const existing = new Map<string, string>();
  if (paths.length > 0) {
    const listing = yield* run(root, "commit", ["ls-tree", "-z", input.base, "--", ...paths], {
      maxOutputBytes: MAX_LISTING_BYTES,
    });
    for (const record of listing.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab >= 0) existing.set(record.slice(tab + 1), record.slice(0, tab).split(" ")[0] ?? "");
    }
  }
  const lines: Array<string> = [];
  for (const change of input.changes) {
    if (change.content === null) {
      if (existing.has(change.path)) lines.push(`0 ${NULL_BLOB}\t${change.path}\0`);
      continue;
    }
    const blob = (yield* run(root, "commit", ["hash-object", "-w", "--stdin"], {
      stdin: change.content,
    })).trim();
    lines.push(`${existing.get(change.path) ?? "100644"} ${blob}\t${change.path}\0`);
  }
  if (lines.length > 0)
    yield* index("commit", ["update-index", "-z", "--index-info"], lines.join(""));
  const tree = (yield* index("commit", ["write-tree"])).trim();
  const baseTree = (yield* run(root, "commit", ["rev-parse", `${input.base}^{tree}`])).trim();
  if (tree === baseTree) return null;
  return (yield* run(root, "commit", [
    "commit-tree",
    tree,
    "-p",
    input.base,
    "-m",
    input.message,
  ])).trim();
}, Effect.scoped);

export const pushToMain = Effect.fn("AgentConfigGit.pushToMain")(function* (
  root: string,
  commit: string,
) {
  const output = yield* gitOutput(root, "push", ["push", "origin", `${commit}:refs/heads/main`], {
    timeout: "60 seconds",
  });
  if (output.timedOut)
    return yield* new AgentConfigGitError({ operation: "push", detail: "timed out" });
  if (output.code === 0) return "pushed" as const;
  if (/non-fast-forward|fetch first|\[rejected\]/.test(output.stderr)) return "rejected" as const;
  return yield* new AgentConfigGitError({
    operation: "push",
    detail: output.stderr.trim() || `git exited with ${output.code}`,
  });
});

export const publish = Effect.fn("AgentConfigGit.publish")(function* <E, R>(
  root: string,
  input: {
    readonly prefix: string;
    readonly message: string;
    readonly attempts?: number;
    readonly changes: (
      files: ReadonlyArray<FolderFile>,
      base: string,
    ) => Effect.Effect<ReadonlyArray<FolderChange>, E, R>;
  },
) {
  for (let attempt = 0; attempt < (input.attempts ?? 3); attempt++) {
    const base = yield* fetchMain(root);
    const files = yield* readFiles(root, base, input.prefix);
    const changes = yield* input.changes(files, base);
    const commit = yield* commitChanges(root, { base, changes, message: input.message });
    if (commit === null) return { outcome: "unchanged" as const, base };
    if ((yield* pushToMain(root, commit)) === "pushed")
      return { outcome: "pushed" as const, commit };
  }
  return { outcome: "rejected" as const };
});
