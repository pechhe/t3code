// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing of the measured source files
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverSrc = NodePath.resolve(here, "../..");
const repoRoot = NodePath.resolve(serverSrc, "../../..");
const dir = "decisionEvaluations/evidenceScreening";

/** Everything that decides what a provider is asked and how it is called. A change to any of these invalidates a retained run. */
const RUN_FILES = [
  "run.ts",
  "attemptLog.ts",
  "provenance.ts",
  "rule.ts",
  "definitions.ts",
  "harness.ts",
  "corpusTypes.ts",
  "corpusAuthentic.ts",
  "corpusAuthentic.json",
  "corpusTune.ts",
  "corpusHeldout.ts",
].map((f) => `${dir}/${f}`);
/** Foundation code the calls pass through. */
const SERVICE_FILES = NodeFS.readdirSync(NodePath.join(serverSrc, "decisions"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort()
  .map((f) => `decisions/${f}`);
const CONTRACT_FILES = ["../../../packages/contracts/src/decisions.ts"];
/** What turns recorded calls into numbers; a rescore changes only these. */
const SCORER_FILES = [
  "scoring.ts",
  "labels.ts",
  "policy.ts",
  "baseline.ts",
  "results/labels-A.json",
  "results/labels-B.json",
  "results/freeze.json",
]
  .map((f) => `${dir}/${f}`)
  .concat(["decisionEvaluations/semanticLint/scoring.ts"]);
/** How the corpus and the labeler packets were made; not executed by a run but part of the evidence. */
const BUILD_FILES = ["buildAuthentic.ts", "labelPacket.ts"].map((f) => `${dir}/${f}`);
/** Files whose content was fixed before the held-out cases were run (see `results/freeze.json`). */
export const FROZEN_FILES = [
  "baseline.ts",
  "policy.ts",
  "definitions.ts",
  "rule.ts",
  "corpusTypes.ts",
];

const sha = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
const digestOf = (files: ReadonlyArray<string>) =>
  Object.fromEntries(
    files.map((f) => [
      NodePath.relative(repoRoot, NodePath.resolve(serverSrc, f)),
      sha(NodePath.resolve(serverSrc, f)),
    ]),
  );

export const runDigests = () =>
  digestOf([...RUN_FILES, ...SERVICE_FILES, ...CONTRACT_FILES, "../../../pnpm-lock.yaml"]);
export const runtimeIdentity = () => ({ node: process.version });
export const scorerDigests = () => digestOf(SCORER_FILES);
export const buildDigests = () => digestOf(BUILD_FILES);

/** The frozen files that no longer match the digests taken before the held-out cases were run. */
export const changedSinceFreeze = (): ReadonlyArray<string> => {
  const freeze = JSON.parse(
    NodeFS.readFileSync(NodePath.join(here, "results/freeze.json"), "utf8"),
  ) as { files: Record<string, string> };
  return FROZEN_FILES.filter((f) => sha(NodePath.join(here, f)) !== freeze.files[f]);
};

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

/** The checkout the run measured: its parent commit and whether the working copy differed from it. */
export const checkoutIdentity = () => ({
  head: git("rev-parse", "HEAD"),
  workingCopyDirty: git("status", "--porcelain", "--untracked-files=all").length > 0,
});
