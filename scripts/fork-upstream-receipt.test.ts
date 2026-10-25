// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repositories to exercise the real receipt gate.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { recordHeadings, skeleton, verify } from "./fork-upstream-receipt.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

class Repo {
  readonly dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-receipt-"));
  constructor() {
    roots.push(this.dir);
    this.git("init", "-q", "-b", "main");
  }
  git(...args: Array<string>): string {
    return NodeChildProcess.execFileSync("git", ["-C", this.dir, ...args], {
      env,
      encoding: "utf8",
    }).trim();
  }
  write(path: string, content: string) {
    const full = NodePath.join(this.dir, path);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, content);
  }
  commit(message: string, files: Record<string, string> = {}): string {
    this.write(`files/${message.replaceAll(" ", "-")}.txt`, message);
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }
  merge(branch: string): string {
    this.git("merge", "--no-ff", "-q", "-m", `merge upstream ${branch}`, branch);
    return this.git("rev-parse", "HEAD");
  }
  receiptFor(merge: string, overrides: Record<string, unknown> = {}) {
    const policy = JSON.parse(this.git("show", "HEAD:slipjay.json"));
    return {
      version: 2,
      kind: "update",
      upstream: {
        baseline: { tag: "v1", sha: this.git("rev-parse", "up1") },
        target: { tag: "v2", sha: this.git("rev-parse", `${merge}^2`) },
      },
      fork: { base: this.git("rev-parse", `${merge}^1`) },
      record: {
        path: "fork/differences.md",
        blob: this.git("rev-parse", "HEAD:fork/differences.md"),
      },
      policy: {
        requiredLandingVerificationSha256: NodeCrypto.createHash("sha256")
          .update(JSON.stringify(policy.requiredLandingVerification))
          .digest("hex"),
      },
      attempt: "a1",
      reviewedAt: "2026-10-19T00:00:00Z",
      reviewer: { thread: "t", model: "m" },
      coverage: {
        upstreamCommits: 1,
        entriesConsidered: this.entries(),
        areas: ["all"],
        exclusions: [],
      },
      dispositions: [],
      unresolved: [],
      checks: [],
      result: "reconciled",
      ...overrides,
    };
  }
  commitReceipt(receipt: unknown): string {
    return this.commit("receipt", { "fork/upstream-receipt.json": JSON.stringify(receipt) });
  }
  entries(): ReadonlyArray<string> {
    return recordHeadings(this.git("show", "HEAD:fork/differences.md"));
  }
  check() {
    return verify({ repo: this.dir, rev: "HEAD" });
  }
}

// main: base -> (merge up1) -> work -> (merge up2); upstream tags are branches up1/up2.
function fixture() {
  const repo = new Repo();
  repo.commit("base", {
    "fork/differences.md": "## Entries\n\n### alpha\n\n- **Kind:** durable extension\n",
    "slipjay.json": JSON.stringify({ requiredLandingVerification: [{ command: "x" }] }),
  });
  repo.git("branch", "up1");
  repo.git("checkout", "-q", "up1");
  repo.commit("upstream 1");
  repo.git("tag", "v1");
  repo.git("checkout", "-q", "main");
  const merge1 = repo.merge("up1");
  repo.commit("fork work");
  repo.git("checkout", "-q", "-b", "up2", "up1");
  repo.commit("upstream 2");
  repo.git("checkout", "-q", "main");
  const merge2 = repo.merge("up2");
  return { repo, merge1, merge2 };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("fork upstream receipt", () => {
  it("requires a newly introduced merge's receipt in the candidate's last commit", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(repo.receiptFor(merge2));
    const landedBase = repo.git("rev-parse", `${merge2}^1`);
    repo.commit("edit after review");
    const introduced = verify({ repo: repo.dir, rev: "HEAD", landed: landedBase });
    expect(introduced.ok).toBe(false);
    expect(introduced.reasons.join("\n")).toMatch(/candidate changes follow the reconciliation/);
    // Once the merge has landed, ordinary fork work after it keeps the receipt valid.
    const landed = verify({ repo: repo.dir, rev: "HEAD", landed: repo.git("rev-parse", "HEAD~1") });
    expect(landed.reasons).toEqual([]);
  });

  it("passes a newly introduced merge reconciled in the last commit", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(repo.receiptFor(merge2));
    const result = verify({
      repo: repo.dir,
      rev: "HEAD",
      landed: repo.git("rev-parse", `${merge2}^1`),
    });
    expect(result.reasons).toEqual([]);
  });

  it("passes a valid receipt", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(repo.receiptFor(merge2));
    const result = repo.check();
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails without a merge", () => {
    const repo = new Repo();
    repo.commit("only");
    expect(repo.check().reasons).toEqual(["no upstream merge found"]);
  });

  it("fails when the receipt is missing", () => {
    const { repo } = fixture();
    expect(repo.check().reasons[0]).toContain("missing receipt for merge of");
  });

  it("fails on invalid JSON and schema violations", () => {
    const { repo, merge2 } = fixture();
    repo.commit("bad", { "fork/upstream-receipt.json": "{" });
    expect(repo.check().reasons[0]).toContain("invalid JSON");
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        result: "maybe",
        dispositions: [],
        coverage: { upstreamCommits: 1, entriesConsidered: [], areas: [], exclusions: [] },
      }),
    );
    const reason = repo.check().reasons[0];
    expect(reason).toContain("result");
    expect(reason).toContain("empty requires non-empty coverage.areas");
  });

  it("is stale after a receipt from an older merge meets a newer merge", () => {
    const { repo, merge1 } = fixture();
    // fixture already holds merge2 on top; only merge1's receipt is committed
    repo.commitReceipt(repo.receiptFor(merge1));
    expect(repo.check().reasons[0]).toContain("stale receipt");
  });

  it("is stale when the fork base moved under the same target", () => {
    const { repo, merge2 } = fixture();
    const receipt = repo.receiptFor(merge2);
    repo.git("reset", "-q", "--hard", `${merge2}^1`);
    repo.commit("newer fork work");
    repo.merge("up2");
    repo.commitReceipt(receipt);
    const result = repo.check();
    expect(result.reasons[0]).toContain("stale receipt");
    expect(result.reasons[0]).toContain(receipt.fork.base);
  });

  it("fails on a record blob mismatch", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        record: { path: "fork/differences.md", blob: "0".repeat(40) },
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain("record blob mismatch");
  });

  it("fails on a policy hash mismatch", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(
      repo.receiptFor(merge2, { policy: { requiredLandingVerificationSha256: "0".repeat(64) } }),
    );
    expect(repo.check().reasons.join("\n")).toContain("policy hash mismatch");
  });

  it("fails when baseline equals target or is not an ancestor", () => {
    const { repo, merge2 } = fixture();
    const target = repo.git("rev-parse", `${merge2}^2`);
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        upstream: { baseline: { tag: "v2", sha: target }, target: { tag: "v2", sha: target } },
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain("baseline must differ");
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        upstream: {
          baseline: { tag: "x", sha: "1".repeat(40) },
          target: { tag: "v2", sha: target },
        },
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain("not an ancestor");
  });

  it("stays valid after a later ordinary edit to the record", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(repo.receiptFor(merge2));
    repo.commit("edit record", { "fork/differences.md": "# record\nmore\n" });
    expect(repo.check().ok).toBe(true);
  });

  it("fails when the result is blocked or has owner decisions", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        result: "blocked",
        unresolved: [{ kind: "evidence", summary: "need logs", resumeBy: "x" }],
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain("reconciliation blocked: need logs");
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        unresolved: [{ kind: "owner-decision", summary: "pick one", resumeBy: "x" }],
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain("reconciliation blocked: pick one");
  });

  it("fails a version 2 receipt that leaves out a recorded entry", () => {
    const { repo, merge2 } = fixture();
    const partial = {
      upstreamCommits: 1,
      entriesConsidered: [],
      areas: ["all"],
      exclusions: [],
    };
    repo.commitReceipt(repo.receiptFor(merge2, { coverage: partial }));
    expect(repo.check().reasons.join("\n")).toContain("leaves out recorded entries: alpha");
    // A receipt the candidate introduces is judged as the candidate stands, whatever version
    // it claims; an already landed one keeps its own meaning.
    repo.commitReceipt({ ...repo.receiptFor(merge2, { coverage: partial }), version: 1 });
    const introduced = verify({
      repo: repo.dir,
      rev: "HEAD",
      landed: repo.git("rev-parse", `${merge2}^1`),
    });
    expect(introduced.reasons.join("\n")).toContain("leaves out recorded entries: alpha");
    expect(repo.check().reasons).toEqual([]);
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        coverage: { ...partial, entriesConsidered: ["alpha"] },
      }),
    );
    expect(repo.check().reasons).toEqual([]);
  });

  it("requires a disposition for an entry the reconciliation retires", () => {
    const { repo, merge2 } = fixture();
    repo.commit("retire alpha", { "fork/differences.md": "## Entries\n\n### beta\n" });
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        coverage: {
          upstreamCommits: 1,
          entriesConsidered: ["alpha", "beta"],
          areas: ["all"],
          exclusions: [],
        },
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain(
      "record entries retired without a disposition: alpha",
    );
  });

  it("fails a disposition naming an entry the record does not define", () => {
    const { repo, merge2 } = fixture();
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        dispositions: [
          {
            entry: "gamma",
            upstream: "#1",
            decision: "retain",
            requirements: ["r"],
            evidence: ["e"],
          },
        ],
      }),
    );
    expect(repo.check().reasons.join("\n")).toContain(
      "dispositions name entries the record does not define: gamma",
    );
  });

  it("lets a disposition name an entry this reconciliation retired", () => {
    const { repo, merge2 } = fixture();
    repo.commit("retire alpha", { "fork/differences.md": "## Entries\n\n### beta\n" });
    repo.commitReceipt(
      repo.receiptFor(merge2, {
        coverage: {
          upstreamCommits: 1,
          entriesConsidered: ["alpha", "beta"],
          areas: ["all"],
          exclusions: [],
        },
        dispositions: [
          {
            entry: "alpha",
            upstream: "#1",
            decision: "adopt",
            requirements: ["r"],
            evidence: ["e"],
          },
        ],
      }),
    );
    expect(repo.check().reasons).toEqual([]);
  });

  it("emits a skeleton that fails until filled and committed", () => {
    const { repo, merge2 } = fixture();
    const draft = skeleton({ repo: repo.dir, rev: "HEAD", tag: "v2" }) as Record<string, any>;
    expect(draft.version).toBe(2);
    expect(draft.upstream.baseline).toEqual({ tag: "v1", sha: repo.git("rev-parse", "up1") });
    expect(draft.upstream.target.sha).toBe(repo.git("rev-parse", `${merge2}^2`));
    expect(draft.coverage.upstreamCommits).toBe(1);
    repo.commitReceipt(draft);
    expect(repo.check().ok).toBe(false);
    repo.commitReceipt({
      ...draft,
      attempt: "a1",
      reviewedAt: "2026-10-19T00:00:00Z",
      coverage: { ...draft.coverage, entriesConsidered: repo.entries(), areas: ["all"] },
      result: "reconciled",
    });
    expect(repo.check().reasons).toEqual([]);
  });
});
