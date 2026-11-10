// @effect-diagnostics nodeBuiltinImport:off - evaluation tooling reads local git clones, not server code
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Cases are real commits in Henry's repositories. The corpus records only the repository, the commit and a digest of
 * the text an engine sees, never the code itself: two of the three repositories are private and this one is public.
 */
export const REPOS = ["t3code", "yardsmith", "slipjay"] as const;
export type Repo = (typeof REPOS)[number];

export const REPO_PATH: Readonly<Record<Repo, string>> = {
  t3code: NodePath.join(NodeOS.homedir(), "Engineering/t3code"),
  yardsmith: NodePath.join(NodeOS.homedir(), "Engineering/yardsmith"),
  slipjay: NodePath.join(NodeOS.homedir(), "Engineering/slipjay"),
};

/** Integration branch of each repository, where a change counts as published. */
export const INTEGRATION_REF: Readonly<Record<Repo, string>> = {
  t3code: "origin/t3peach",
  yardsmith: "origin/develop",
  slipjay: "origin/main",
};

export const DIFF_CHAR_LIMIT = 16_000;
const GENERATED =
  /(pnpm-lock|package-lock|bun\.lock|yarn\.lock|\.snap$|\.png$|\.svg$|\.jpe?g$|\.gif$|\.ico$|\.lock$)/;
const CODE = /\.(ts|tsx|js|jsx|mjs|svelte|py|rs|swift|kt|sql|sh|css|yml|yaml)$/;

export const git = (repo: Repo, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: REPO_PATH[repo],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

export interface DiffEvidence {
  readonly text: string;
  readonly truncated: boolean;
  readonly changedLines: number;
  readonly hasCode: boolean;
}

/** What a reviewer (or an engine) is shown: the subject line and the unified diff without generated files, capped. */
export const diffEvidence = (repo: Repo, commit: string): DiffEvidence => {
  const files = git(repo, "show", "--name-only", "--format=", commit)
    .split("\n")
    .filter((f) => f !== "" && !GENERATED.test(f));
  const subject = git(repo, "show", "-s", "--format=%s", commit).trim();
  const diff = files.length === 0 ? "" : git(repo, "show", "--format=", commit, "--", ...files);
  const changedLines = diff
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
  const truncated = diff.length > DIFF_CHAR_LIMIT;
  const body = truncated ? `${diff.slice(0, DIFF_CHAR_LIMIT)}\n[... diff truncated ...]` : diff;
  return {
    text: `Subject: ${subject}\n\n${body}`,
    truncated,
    changedLines,
    hasCode: files.some((f) => CODE.test(f)),
  };
};

export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
