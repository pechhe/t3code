// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing of the measured source files
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverSrc = NodePath.resolve(here, "../..");
const repoRoot = NodePath.resolve(serverSrc, "../../..");
const dir = "decisionEvaluations/threadHousekeeping";

/** Everything that decides what a provider is asked and how it is called. A change to any of these invalidates a retained run. */
const RUN_FILES = [
  "run.ts",
  "attemptLog.ts",
  "provenance.ts",
  "rule.ts",
  "definitions.ts",
  "harness.ts",
  "types.ts",
  "policy.ts",
].map((f) => `${dir}/${f}`);
const SERVICE_FILES = NodeFS.readdirSync(NodePath.join(serverSrc, "decisions"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort()
  .map((f) => `decisions/${f}`);
const CONTRACT_FILES = ["../../../packages/contracts/src/decisions.ts"];
/** What turns recorded calls into numbers; a rescore changes only these. */
const SCORER_FILES = [
  "scoring.ts",
  "baseline.ts",
  "labels.ts",
  "results/cases.json",
  "results/labels-A.json",
  "results/labels-B.json",
].map((f) => `${dir}/${f}`);
/** How the committed record and the labeler packets were made. */
const BUILD_FILES = ["record.ts", "buildRecord.ts"].map((f) => `${dir}/${f}`);

const digestOf = (files: ReadonlyArray<string>) =>
  Object.fromEntries(
    files.map((f) => [
      NodePath.relative(repoRoot, NodePath.resolve(serverSrc, f)),
      NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.resolve(serverSrc, f)))
        .digest("hex"),
    ]),
  );

export const runDigests = () =>
  digestOf([...RUN_FILES, ...SERVICE_FILES, ...CONTRACT_FILES, "../../../pnpm-lock.yaml"]);
export const runtimeIdentity = () => ({ node: process.version });
export const scorerDigests = () => digestOf(SCORER_FILES);
export const buildDigests = () => digestOf(BUILD_FILES);

const sh = (cmd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8" }).trim();

/** The checkout the run measured: its base commit and whether the working copy differed from it. Workspaces here are Jujutsu, with no git directory. */
export const checkoutIdentity = () =>
  NodeFS.existsSync(NodePath.join(repoRoot, ".git"))
    ? {
        head: sh("git", "rev-parse", "HEAD"),
        workingCopyDirty: sh("git", "status", "--porcelain", "--untracked-files=all").length > 0,
      }
    : {
        head: sh("jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id"),
        workingCopyDirty: sh("jj", "diff", "--summary").length > 0,
      };
