// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing and `git show` of retained evidence
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import amendments from "./retainedRunAmendments.json" with { type: "json" };

export const LOCK_FILE = "pnpm-lock.yaml";

/** Packages whose locked version changes what a decision call sends or how its answer is read. */
export const CALL_PATH_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "undici",
] as const;

/**
 * A change a person has certified leaves what a decision call sends and how its answer is read
 * as the run measured it, so re-running every evaluation would measure nothing new. One entry
 * covers exactly one digest or version step; a later change needs its own entry or a new run.
 */
export interface RetainedRunAmendments {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly from: string;
    readonly to: string;
    readonly why: string;
  }>;
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly from: string;
    readonly to: string;
    readonly why: string;
  }>;
}

export const RETAINED_RUN_AMENDMENTS: RetainedRunAmendments = amendments;

/** Where a recorded value ends after following every certified step from it. */
const certified = (
  steps: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  start: string,
) => {
  let at = start;
  for (let hops = 0; hops <= steps.length; hops++) {
    const step = steps.find((candidate) => candidate.from === at);
    if (step === undefined) return at;
    at = step.to;
  }
  return at;
};

/** A run's manifest as it stands after every certified step. */
export const amendedManifest = (
  files: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(files).map(([path, digest]) => [
      path,
      certified(
        RETAINED_RUN_AMENDMENTS.files.filter((step) => step.path === path),
        digest,
      ),
    ]),
  );

/** A retained run's manifest and the commit it measured. */
export interface RetainedRun {
  readonly head: string;
  readonly files: Readonly<Record<string, string>>;
}

/** A repository file's bytes at a revision, or in the working tree when `revision` is undefined. */
export type ReadFileAt = (path: string, revision?: string) => Buffer | undefined;

/** Reads from the repository at `root`; a path or commit git cannot show is undefined. */
export const gitFileAt =
  (root: string): ReadFileAt =>
  (path, revision) => {
    if (revision === undefined) {
      try {
        return NodeFS.readFileSync(NodePath.resolve(root, path));
      } catch {
        return undefined;
      }
    }
    const result = NodeChildProcess.spawnSync("git", ["show", `${revision}:${path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : undefined;
  };

const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The versions a package resolves to in a lock's `packages` and `snapshots` sections. */
function lockedVersions(lock: string, name: string): ReadonlyArray<string> {
  const versions = new Set<string>();
  let section = "";
  for (const line of lock.split("\n")) {
    const top = /^([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (top) {
      section = top[1]!;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      section = "";
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;
    if (!/^ {2}\S/.test(line) || !line.endsWith(":")) continue;
    const key = line
      .trim()
      .slice(0, -1)
      .replace(/^'(.*)'$/, "$1");
    const at = key.lastIndexOf("@");
    if (at <= 0 || key.slice(0, at) !== name) continue;
    const version = key.slice(at + 1).split(/[( ]/)[0]!;
    versions.add(version.startsWith("npm:") ? version.slice(4) : version);
  }
  return [...versions].toSorted();
}

/**
 * The names of the ways a retained result no longer stands, empty when it does. A result stays
 * tied to the exact lock it ran on: an unrelated later lock does not invalidate it, and a later
 * lock is never claimed as what it ran on.
 */
export function retainedRunProblems(
  run: RetainedRun,
  current: Readonly<Record<string, string>>,
  read: ReadFileAt,
  certifiedSteps: RetainedRunAmendments = RETAINED_RUN_AMENDMENTS,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const recordedLock = run.files[LOCK_FILE];
  const lockIsWellFormed = recordedLock !== undefined && SHA256.test(recordedLock);
  if (recordedLock === undefined) {
    problems.push(`the run's manifest has no ${LOCK_FILE} digest`);
  } else if (!SHA256.test(recordedLock)) {
    problems.push(`the run's recorded ${LOCK_FILE} digest is not a sha256`);
  }
  let lockAtRun: string | undefined;
  if (!COMMIT.test(run.head)) {
    problems.push(`the run's recorded commit ${JSON.stringify(run.head)} is not a commit id`);
  } else {
    const bytes = read(LOCK_FILE, run.head);
    if (bytes === undefined) {
      problems.push(`${LOCK_FILE} is missing at the run's commit ${run.head}`);
    } else {
      lockAtRun = bytes.toString("utf8");
      if (lockIsWellFormed && sha256(bytes) !== recordedLock) {
        problems.push(`${LOCK_FILE} at ${run.head} is not the lock the run recorded`);
      }
    }
  }
  for (const path of Object.keys(run.files)) {
    if (path === LOCK_FILE) continue;
    if (!(path in current)) {
      problems.push(`${path} is missing from the current manifest`);
    } else if (
      current[path] !==
      certified(
        certifiedSteps.files.filter((step) => step.path === path),
        run.files[path]!,
      )
    ) {
      problems.push(`${path} changed since the run`);
    }
  }
  for (const path of Object.keys(current)) {
    if (path !== LOCK_FILE && !(path in run.files)) {
      problems.push(`${path} is not in the run's manifest`);
    }
  }
  const lockNowBytes = read(LOCK_FILE);
  if (lockNowBytes === undefined) {
    problems.push(`${LOCK_FILE} is missing from the current tree`);
    return problems;
  }
  if (lockAtRun === undefined) return problems;
  const lockNow = lockNowBytes.toString("utf8");
  for (const name of CALL_PATH_PACKAGES) {
    const before = lockedVersions(lockAtRun, name);
    const after = lockedVersions(lockNow, name);
    if (before.length === 0) {
      problems.push(`${name} is not in ${LOCK_FILE} at ${run.head}`);
    } else if (after.length === 0) {
      problems.push(`${name} is not in the current ${LOCK_FILE}`);
    } else if (
      after.join(",") !==
      certified(
        certifiedSteps.packages.filter((step) => step.name === name),
        before.join(","),
      )
    ) {
      problems.push(
        `${name} moved from ${before.join(", ")} at ${run.head} to ${after.join(", ")} now`,
      );
    }
  }
  return problems;
}
