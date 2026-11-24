// @effect-diagnostics nodeBuiltinImport:off -- Sync hashing and mirror directory handling need no Effect services, keeping the requirement to ProcessRunner.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../../processRunner.ts";
import { AgentConfigGitError, readFiles, type FolderFile } from "./AgentConfigGit.ts";

const CHAMPIONS_IN_REPO = ".agents/champions/";

const SLIPJAY_CONFIG = "slipjay.json";
const SlipjayConfig = Schema.fromJsonString(
  Schema.Struct({ integrationBranch: Schema.optional(Schema.String) }),
);
const decodeSlipjayConfig = Schema.decodeEffect(SlipjayConfig);
const MIRROR_REFS = "refs/champions/";

export interface PublishedChampions {
  readonly commit: string;
  readonly branch: string;
  readonly files: ReadonlyArray<FolderFile>;
}

const run = Effect.fn("ProjectChampionGit.run")(function* (
  cwd: string,
  operation: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: "30 seconds" | "60 seconds";
    readonly allowFailure?: boolean;
    readonly stdin?: string;
  } = {},
) {
  const processes = yield* ProcessRunner.ProcessRunner;
  const output = yield* processes
    .run({
      command: "git",
      args: ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      timeout: options.timeout ?? "30 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 16 * 1024 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0" },
    })
    .pipe(
      Effect.mapError((error) => new AgentConfigGitError({ operation, detail: error.message })),
    );
  if (output.timedOut) return yield* new AgentConfigGitError({ operation, detail: "timed out" });
  if (output.code !== 0) {
    if (options.allowFailure) return null;
    return yield* new AgentConfigGitError({
      operation,
      detail: output.stderr.trim() || `git exited with ${output.code}`,
    });
  }
  return output.stdout;
});

const fileError = (operation: string) => (cause: unknown) =>
  new AgentConfigGitError({ operation, detail: String(cause) });

// A remote whose tips still match the last read has the same Champions; skip the mirror work.
const MAX_CACHED_READS = 64;
const cachedReads = new Map<
  string,
  { readonly name: string; readonly tip: string; readonly published: PublishedChampions }
>();

const remoteHeads = Effect.fn("ProjectChampionGit.remoteHeads")(function* (
  cwd: string,
  url: string,
  extraBranch: string | undefined,
) {
  const output = yield* run(cwd, "ls-remote", [
    "ls-remote",
    "--symref",
    url,
    "HEAD",
    ...(extraBranch === undefined ? [] : [`refs/heads/${extraBranch}`]),
  ]);
  const text = output ?? "";
  const name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(text)?.[1];
  if (name === undefined)
    return yield* new AgentConfigGitError({
      operation: "ls-remote",
      detail: "the remote has no default branch",
    });
  const tipOf = (ref: string) =>
    new RegExp(`^([0-9a-f]{40,64})\\t${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(
      text,
    )?.[1];
  return {
    name,
    tip: tipOf("HEAD"),
    branchTip: extraBranch === undefined ? undefined : tipOf(`refs/heads/${extraBranch}`),
  };
});

const prepareMirror = Effect.fn("ProjectChampionGit.prepareMirror")(function* (
  mirror: string,
  url: string,
) {
  const exists = yield* Effect.promise(() =>
    NodeFSP.stat(NodePath.join(mirror, "HEAD")).then(
      () => true,
      () => false,
    ),
  );
  if (!exists) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.dirname(mirror), { recursive: true }),
      catch: fileError("mirror"),
    });
    yield* run(NodePath.dirname(mirror), "mirror", ["init", "--bare", "--quiet", mirror]);
  }
  yield* run(mirror, "mirror", ["config", "remote.origin.url", url]);
});

const fetchBranch = Effect.fn("ProjectChampionGit.fetchBranch")(function* (
  mirror: string,
  branch: string,
  filtered: boolean,
) {
  const ref = `${MIRROR_REFS}${branch}`;
  const args = ["fetch", "--no-tags", "--depth", "1", ...(filtered ? ["--filter=blob:none"] : [])];
  const done = yield* run(mirror, "fetch", [...args, "origin", `+refs/heads/${branch}:${ref}`], {
    timeout: "60 seconds",
    allowFailure: filtered,
  });
  if (done === null) return null;
  return ((yield* run(mirror, "fetch", ["rev-parse", "--verify", `${ref}^{commit}`])) ?? "").trim();
});

const fetchBlobs = Effect.fn("ProjectChampionGit.fetchBlobs")(function* (
  mirror: string,
  commit: string,
  paths: ReadonlyArray<string>,
) {
  const listing = yield* run(mirror, "read", [
    "rev-list",
    "--objects",
    "--missing=print",
    "--no-object-names",
    commit,
    "--",
    ...paths,
  ]);
  const missing = (listing ?? "")
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1).trim());
  if (missing.length > 0)
    yield* run(
      mirror,
      "fetch",
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "origin",
        "--stdin",
      ],
      { timeout: "60 seconds", stdin: missing.map((id) => `${id}\n`).join("") },
    );
  return missing.length;
});

const integrationBranch = Effect.fn("ProjectChampionGit.integrationBranch")(function* (
  mirror: string,
  commit: string,
) {
  yield* fetchBlobs(mirror, commit, [SLIPJAY_CONFIG]);
  const raw = yield* run(mirror, "read", ["show", `${commit}:${SLIPJAY_CONFIG}`], {
    allowFailure: true,
  });
  if (raw === null) return null;
  const config = yield* decodeSlipjayConfig(raw).pipe(Effect.option);
  const branch = config._tag === "Some" ? config.value.integrationBranch?.trim() : undefined;
  return branch === undefined || branch === "" ? null : branch;
});

const readMirror = Effect.fn("ProjectChampionGit.readMirror")(function* (
  mirror: string,
  url: string,
  mirrorsRoot: string,
) {
  const key = `${mirror}\0${url}`;
  const cached = cachedReads.get(key);
  const heads = yield* remoteHeads(
    mirrorsRoot,
    url,
    cached?.published.branch === cached?.name ? undefined : cached?.published.branch,
  );
  if (
    cached !== undefined &&
    heads.tip !== undefined &&
    heads.name === cached.name &&
    heads.tip === cached.tip &&
    (cached.published.branch === cached.name || heads.branchTip === cached.published.commit) &&
    (yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(mirror, "HEAD")).then(
        () => true,
        () => false,
      ),
    ))
  )
    return cached.published;
  cachedReads.delete(key);
  yield* prepareMirror(mirror, url);
  const defaultName = heads.name;
  let filtered = true;
  let defaultTip = yield* fetchBranch(mirror, defaultName, true);
  if (defaultTip === null) {
    filtered = false;
    defaultTip = (yield* fetchBranch(mirror, defaultName, false)) ?? "";
  }
  let branch = defaultName;
  let commit = defaultTip;
  const named = yield* integrationBranch(mirror, defaultTip);
  if (named !== null && named !== defaultName) {
    const tip = yield* fetchBranch(mirror, named, filtered).pipe(Effect.orElseSucceed(() => null));
    if (tip !== null) {
      branch = named;
      commit = tip;
    }
  }
  if (filtered) yield* fetchBlobs(mirror, commit, [CHAMPIONS_IN_REPO]);
  const files = yield* readFiles(mirror, commit, CHAMPIONS_IN_REPO);
  const published = { commit, branch, files } satisfies PublishedChampions;
  if (heads.tip === defaultTip) {
    if (cachedReads.size >= MAX_CACHED_READS)
      cachedReads.delete(cachedReads.keys().next().value as string);
    cachedReads.set(key, { name: defaultName, tip: defaultTip, published });
  }
  return published;
});

export const readPublished = Effect.fn("ProjectChampionGit.readPublished")(function* (input: {
  readonly mirrorsRoot: string;
  readonly canonicalKey: string;
  readonly checkout: string;
}) {
  const origin = yield* run(input.checkout, "origin", ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  const url = origin?.trim();
  if (url === undefined || url === "") return null;

  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(input.mirrorsRoot, { recursive: true }),
    catch: fileError("mirror"),
  });
  const mirror = NodePath.join(
    input.mirrorsRoot,
    `${NodeCrypto.createHash("sha256").update(input.canonicalKey).digest("hex").slice(0, 16)}.git`,
  );
  // An unreachable remote fails before the mirror is touched; anything later may be a bad mirror.
  return yield* readMirror(mirror, url, input.mirrorsRoot).pipe(
    Effect.catchIf(
      (error) => error.operation !== "ls-remote",
      () =>
        Effect.tryPromise({
          try: () => NodeFSP.rm(mirror, { recursive: true, force: true }),
          catch: fileError("mirror"),
        }).pipe(Effect.andThen(readMirror(mirror, url, input.mirrorsRoot))),
    ),
  );
});
