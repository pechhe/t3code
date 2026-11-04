// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing of the measured source files
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverSrc = NodePath.resolve(here, "../..");
const repoRoot = NodePath.resolve(serverSrc, "../../..");

/** Everything that decides what a provider is asked and how it is called. A change to any of these invalidates a retained run. */
const RUN_FILES = [
  "decisionEvaluations/failureTriage/run.ts",
  "decisionEvaluations/failureTriage/provenance.ts",
  "decisionEvaluations/failureTriage/rule.ts",
  "decisionEvaluations/failureTriage/baseline.ts",
  "decisionEvaluations/failureTriage/harness.ts",
  "decisionEvaluations/failureTriage/corpusTypes.ts",
  "decisionEvaluations/failureTriage/corpusAuthentic.ts",
  "decisionEvaluations/failureTriage/corpusAuthentic.json",
  "decisionEvaluations/failureTriage/corpusTune.ts",
  "decisionEvaluations/failureTriage/corpusHeldout.ts",
] as const;
/** Foundation code the calls pass through. */
const SERVICE_FILES = NodeFS.readdirSync(NodePath.join(serverSrc, "decisions"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort()
  .map((f) => `decisions/${f}`);
const CONTRACT_FILES = ["../../../packages/contracts/src/decisions.ts"];
/** What turns recorded calls into numbers; a rescore changes only these. */
const SCORER_FILES = [
  "decisionEvaluations/failureTriage/scoring.ts",
  "decisionEvaluations/failureTriage/labels.ts",
  "decisionEvaluations/failureTriage/results/heldout-labels.json",
  "decisionEvaluations/semanticLint/scoring.ts",
] as const;

const digestOf = (files: ReadonlyArray<string>) =>
  Object.fromEntries(
    files.map((f) => [
      NodePath.relative(repoRoot, NodePath.resolve(serverSrc, f)),
      NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(NodePath.resolve(serverSrc, f)))
        .digest("hex"),
    ]),
  );

export const runDigests = () => digestOf([...RUN_FILES, ...SERVICE_FILES, ...CONTRACT_FILES]);
export const scorerDigests = () => digestOf(SCORER_FILES);

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

/** The checkout the run measured: its parent commit and whether the working copy differed from it. */
export const checkoutIdentity = () => ({
  head: git("rev-parse", "HEAD"),
  workingCopyDirty: git("status", "--porcelain", "--untracked-files=all").length > 0,
});
