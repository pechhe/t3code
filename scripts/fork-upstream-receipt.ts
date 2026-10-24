#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Thin git/CLI gate with no Effect runtime so it runs under plain node in the landing gate.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

const RECEIPT_PATH = "fork/upstream-receipt.json";
const RECORD_PATH = "fork/differences.md";
const POLICY_PATH = "slipjay.json";
const SHA = /^[0-9a-f]{40}$/;
const DECISIONS = ["retain", "adopt", "adapt", "defer"];

export interface MergeInfo {
  readonly sha: string;
  readonly base: string;
  readonly target: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly merge: MergeInfo | null;
  readonly receipt: unknown;
}

class GitError extends Error {}

function git(repo: string, args: ReadonlyArray<string>): string {
  try {
    return NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new GitError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function gitOk(repo: string, args: ReadonlyArray<string>): boolean {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
}

const short = (sha: string) => sha.slice(0, 12);

function newestMerge(repo: string, rev: string): MergeInfo | null {
  const sha = git(repo, ["rev-list", "--first-parent", "--merges", "-n1", rev]);
  return sha === "" ? null : mergeInfo(repo, sha);
}

function mergeInfo(repo: string, sha: string): MergeInfo {
  const [, base, target] = git(repo, ["rev-list", "--parents", "-n1", sha]).split(" ");
  if (base === undefined || target === undefined) throw new GitError(`${sha} is not a merge`);
  return { sha, base, target };
}

function policyHash(policyJson: string): string {
  const parsed = JSON.parse(policyJson) as { requiredLandingVerification?: unknown };
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(parsed.requiredLandingVerification))
    .digest("hex");
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isString);

function validateSchema(receipt: unknown): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const bad = (path: string, expected: string) => problems.push(`${path}: expected ${expected}`);
  if (!isObject(receipt)) return ["receipt: expected object"];

  if (receipt.version !== 1) bad("version", "1");
  if (receipt.kind !== "update" && receipt.kind !== "seed") bad("kind", '"update" | "seed"');

  const ref = (value: unknown, path: string) => {
    if (!isObject(value)) return bad(path, "object");
    if (!isString(value.tag)) bad(`${path}.tag`, "string");
    if (!isString(value.sha) || !SHA.test(value.sha)) bad(`${path}.sha`, "40-hex sha");
  };
  const sha = (value: unknown, path: string) => {
    if (!isString(value) || !SHA.test(value)) bad(path, "40-hex sha");
  };

  if (!isObject(receipt.upstream)) bad("upstream", "object");
  else {
    ref(receipt.upstream.baseline, "upstream.baseline");
    ref(receipt.upstream.target, "upstream.target");
  }
  if (!isObject(receipt.fork)) bad("fork", "object");
  else sha(receipt.fork.base, "fork.base");
  if (!isObject(receipt.record)) bad("record", "object");
  else {
    if (receipt.record.path !== RECORD_PATH) bad("record.path", JSON.stringify(RECORD_PATH));
    sha(receipt.record.blob, "record.blob");
  }
  if (!isObject(receipt.policy)) bad("policy", "object");
  else if (
    !isString(receipt.policy.requiredLandingVerificationSha256) ||
    !/^[0-9a-f]{64}$/.test(receipt.policy.requiredLandingVerificationSha256)
  ) {
    bad("policy.requiredLandingVerificationSha256", "64-hex sha256");
  }
  if (!isString(receipt.attempt) || receipt.attempt === "") bad("attempt", "non-empty string");
  if (!isString(receipt.reviewedAt) || Number.isNaN(Date.parse(receipt.reviewedAt))) {
    bad("reviewedAt", "ISO timestamp");
  }
  if (!isObject(receipt.reviewer)) bad("reviewer", "object");
  else {
    if (!isString(receipt.reviewer.thread)) bad("reviewer.thread", "string");
    if (!isString(receipt.reviewer.model)) bad("reviewer.model", "string");
  }

  const areas = isObject(receipt.coverage) ? receipt.coverage.areas : undefined;
  if (!isObject(receipt.coverage)) bad("coverage", "object");
  else {
    const coverage = receipt.coverage;
    if (!Number.isInteger(coverage.upstreamCommits) || (coverage.upstreamCommits as number) < 0) {
      bad("coverage.upstreamCommits", "non-negative integer");
    }
    if (!isStringArray(coverage.entriesConsidered)) bad("coverage.entriesConsidered", "string[]");
    if (!isStringArray(coverage.areas)) bad("coverage.areas", "string[]");
    if (
      !Array.isArray(coverage.exclusions) ||
      !coverage.exclusions.every((e) => isObject(e) && isString(e.what) && isString(e.why))
    ) {
      bad("coverage.exclusions", "{what, why}[]");
    }
  }

  if (!Array.isArray(receipt.dispositions)) bad("dispositions", "array");
  else {
    receipt.dispositions.forEach((d, i) => {
      const path = `dispositions[${i}]`;
      if (!isObject(d)) return bad(path, "object");
      if (d.entry !== null && !isString(d.entry)) bad(`${path}.entry`, "string | null");
      if (!isString(d.upstream) || d.upstream === "") bad(`${path}.upstream`, "non-empty string");
      if (!DECISIONS.includes(d.decision as string)) bad(`${path}.decision`, DECISIONS.join(" | "));
      if (!isStringArray(d.requirements)) bad(`${path}.requirements`, "string[]");
      if (!isStringArray(d.evidence)) bad(`${path}.evidence`, "string[]");
      if (d.decision === "defer" && (!isString(d.reassessWhen) || d.reassessWhen === "")) {
        bad(`${path}.reassessWhen`, "non-empty string when decision is defer");
      }
    });
    if (
      receipt.dispositions.length === 0 &&
      !(isStringArray(areas) && areas.some((a) => a.trim() !== ""))
    ) {
      problems.push("dispositions: empty requires non-empty coverage.areas");
    }
  }

  if (
    !Array.isArray(receipt.unresolved) ||
    !receipt.unresolved.every(
      (u) =>
        isObject(u) &&
        (u.kind === "evidence" || u.kind === "owner-decision") &&
        isString(u.summary) &&
        isString(u.resumeBy),
    )
  ) {
    bad("unresolved", "{kind: evidence | owner-decision, summary, resumeBy}[]");
  }
  if (
    !Array.isArray(receipt.checks) ||
    !receipt.checks.every(
      (c) =>
        isObject(c) &&
        isString(c.command) &&
        ["passed", "failed", "not-run"].includes(c.result as string) &&
        isString(c.note),
    )
  ) {
    bad("checks", "{command, result: passed | failed | not-run, note}[]");
  }
  if (receipt.result !== "reconciled" && receipt.result !== "blocked") {
    bad("result", '"reconciled" | "blocked"');
  }
  return problems;
}

export function verify(options: {
  readonly repo: string;
  readonly rev: string;
  readonly landed?: string | undefined;
}): VerifyResult {
  const { repo, rev, landed } = options;
  const fail = (
    reasons: ReadonlyArray<string>,
    merge: MergeInfo | null,
    receipt: unknown = null,
  ): VerifyResult => ({ ok: false, reasons, merge, receipt });

  const merge = newestMerge(repo, rev);
  if (merge === null) return fail(["no upstream merge found"], null);

  let raw: string;
  try {
    raw = git(repo, ["show", `${rev}:${RECEIPT_PATH}`]);
  } catch {
    return fail(
      [`missing receipt for merge of ${merge.target} (${RECEIPT_PATH} at ${rev})`],
      merge,
    );
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    return fail([`invalid JSON in ${RECEIPT_PATH}: ${(error as Error).message}`], merge);
  }
  const problems = validateSchema(receipt);
  if (problems.length > 0) {
    return fail([`invalid receipt: ${problems.join("; ")}`], merge, receipt);
  }
  const r = receipt as {
    upstream: { baseline: { sha: string }; target: { sha: string } };
    fork: { base: string };
    record: { blob: string };
    policy: { requiredLandingVerificationSha256: string };
    unresolved: ReadonlyArray<{ kind: string; summary: string }>;
    result: string;
  };

  if (r.upstream.target.sha !== merge.target || r.fork.base !== merge.base) {
    return fail(
      [
        `stale receipt: reviewed ${r.upstream.target.sha} onto ${r.fork.base}, candidate merges ${merge.target} onto ${merge.base}`,
      ],
      merge,
      receipt,
    );
  }

  const reasons: Array<string> = [];
  if (r.upstream.baseline.sha === r.upstream.target.sha) {
    reasons.push("baseline must differ from target");
  } else if (!gitOk(repo, ["merge-base", "--is-ancestor", r.upstream.baseline.sha, merge.base])) {
    reasons.push(
      `baseline ${r.upstream.baseline.sha} is not an ancestor of fork base ${merge.base}`,
    );
  }

  const changedIn = git(repo, ["log", "-1", "--format=%H", rev, "--", RECEIPT_PATH]);
  // A merge this candidate introduces is reviewed as the candidate stands: nothing may
  // follow the reconciliation. A merge that already landed keeps its receipt while
  // ordinary fork work, each change gated on its own, lands after it.
  const introduced =
    landed !== undefined && !gitOk(repo, ["merge-base", "--is-ancestor", merge.sha, landed]);
  if (changedIn === "" || !gitOk(repo, ["merge-base", "--is-ancestor", merge.sha, changedIn])) {
    reasons.push(`receipt was not committed at or after merge ${merge.sha}`);
  } else if (introduced && changedIn !== git(repo, ["rev-parse", rev])) {
    reasons.push(
      `stale receipt: candidate changes follow the reconciliation (${short(changedIn)}); update the receipt in the candidate's last commit`,
    );
  } else {
    try {
      const blob = git(repo, ["rev-parse", `${changedIn}:${RECORD_PATH}`]);
      if (blob !== r.record.blob) {
        reasons.push(`record blob mismatch: receipt read ${r.record.blob}, committed ${blob}`);
      }
    } catch {
      reasons.push(`${RECORD_PATH} missing at ${short(changedIn)}`);
    }
    try {
      const actual = policyHash(git(repo, ["show", `${changedIn}:${POLICY_PATH}`]));
      if (actual !== r.policy.requiredLandingVerificationSha256) {
        reasons.push(
          `policy hash mismatch: receipt ${r.policy.requiredLandingVerificationSha256}, committed ${actual}`,
        );
      }
    } catch (error) {
      reasons.push(
        `cannot hash ${POLICY_PATH} at ${short(changedIn)}: ${(error as Error).message}`,
      );
    }
  }

  const ownerDecisions = r.unresolved.filter((u) => u.kind === "owner-decision");
  if (r.result !== "reconciled" || ownerDecisions.length > 0) {
    const summaries = (r.result === "reconciled" ? ownerDecisions : r.unresolved).map(
      (u) => u.summary,
    );
    reasons.push(
      `reconciliation blocked: ${summaries.length > 0 ? summaries.join("; ") : `result is ${r.result}`}`,
    );
  }

  return reasons.length > 0
    ? fail(reasons, merge, receipt)
    : { ok: true, reasons: [], merge, receipt };
}

export function skeleton(options: {
  readonly repo: string;
  readonly rev: string;
  readonly tag: string;
  readonly baselineTag?: string | undefined;
}): unknown {
  const { repo, rev } = options;
  const merge = newestMerge(repo, rev);
  if (merge === null) throw new GitError("no upstream merge found");
  const previous = git(repo, ["rev-list", "--first-parent", "--merges", "-n1", merge.base]);
  if (previous === "") throw new GitError("no earlier upstream merge to take a baseline from");
  const baselineSha = mergeInfo(repo, previous).target;
  let baselineTag = options.baselineTag;
  if (baselineTag === undefined) {
    try {
      baselineTag = git(repo, ["describe", "--tags", "--exact-match", baselineSha]);
    } catch {
      baselineTag = "";
    }
  }
  return {
    version: 1,
    kind: "update",
    upstream: {
      baseline: { tag: baselineTag, sha: baselineSha },
      target: { tag: options.tag, sha: merge.target },
    },
    fork: { base: merge.base },
    record: { path: RECORD_PATH, blob: git(repo, ["rev-parse", `${rev}:${RECORD_PATH}`]) },
    policy: {
      requiredLandingVerificationSha256: policyHash(git(repo, ["show", `${rev}:${POLICY_PATH}`])),
    },
    attempt: "",
    reviewedAt: "",
    reviewer: { thread: "", model: "" },
    coverage: {
      upstreamCommits: Number(
        git(repo, ["rev-list", "--count", `${baselineSha}..${merge.target}`]),
      ),
      entriesConsidered: [],
      areas: [],
      exclusions: [],
    },
    dispositions: [],
    unresolved: [],
    checks: [],
    result: "blocked",
  };
}

// In a colocated jj checkout (SlipJay's runner and workspaces) git's HEAD is the parent
// of the working-copy commit, so the candidate is jj's `@`, or its parent when `@` is
// an empty, undescribed commit started on top of it.
function currentRevision(repo: string): string {
  const jj = (revset: string) =>
    NodeChildProcess.execFileSync(
      "jj",
      ["--ignore-working-copy", "log", "-r", revset, "--no-graph", "-T", 'commit_id ++ "\\n"'],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  try {
    return jj('@ ~ (empty() & description(exact:""))') || jj("@-");
  } catch {
    return "HEAD";
  }
}

// The landing gate reads this CLI's stdout text, stderr text and exit code, so it writes
// those streams itself: Effect logging would add a runtime and reformat what it reports.
const writeLine = (line: string) => process.stdout.write(`${line}\n`);
const writeError = (line: string) => process.stderr.write(`${line}\n`);

function main(argv: ReadonlyArray<string>): number {
  const [command, ...rest] = argv;
  try {
    const { values } = NodeUtil.parseArgs({
      args: rest,
      options: {
        rev: { type: "string" },
        landed: { type: "string" },
        repo: { type: "string", default: process.cwd() },
        json: { type: "boolean", default: false },
        tag: { type: "string" },
        "baseline-tag": { type: "string" },
      },
      strict: true,
    });
    if (command === "verify") {
      if (
        values.landed !== undefined &&
        !gitOk(values.repo, ["rev-parse", "--verify", values.landed])
      ) {
        throw new Error(`cannot resolve --landed ${values.landed}`);
      }
      const result = verify({
        repo: values.repo,
        rev: values.rev ?? currentRevision(values.repo),
        landed: values.landed,
      });
      if (values.json) {
        writeLine(JSON.stringify(result, null, 2));
      } else if (result.ok && result.merge !== null) {
        const target = (result.receipt as { upstream: { target: { tag: string } } }).upstream.target
          .tag;
        writeLine(
          `receipt ok: ${target} (${short(result.merge.target)}) onto ${short(result.merge.base)}`,
        );
      } else {
        for (const reason of result.reasons) writeError(reason);
      }
      return result.ok ? 0 : 1;
    }
    if (command === "skeleton") {
      if (values.tag === undefined) throw new Error("skeleton requires --tag <tag>");
      const rev = values.rev ?? currentRevision(values.repo);
      writeLine(
        JSON.stringify(
          skeleton({
            repo: values.repo,
            rev,
            tag: values.tag,
            baselineTag: values["baseline-tag"],
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    throw new Error("usage: fork-upstream-receipt.ts verify|skeleton [options]");
  } catch (error) {
    writeError((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
