// @effect-diagnostics-next-line nodeBuiltinImport:off -- SlipJay is a CLI, not an Effect service; cleanup and resume shell out to it.
import * as NodeChildProcess from "node:child_process";

/**
 * Releasing, and restoring, a SlipJay workspace from T3.
 *
 * Cleanup may not remove these with git: a SlipJay workspace is a git-worktree-backed
 * Jujutsu workspace, so `git worktree remove` would take ignored files a thread wrote
 * and leave Jujutsu believing the workspace still exists. SlipJay archives the checkout
 * before it retires it, so cleanup asks it to and keeps whatever it declines.
 *
 * A thread that resumes after that has no checkout either. Recreating it from the
 * branch would silently lose everything outside git, so the turn-start path asks
 * SlipJay to restore the newest archive of that path instead, and refuses the turn if
 * it cannot - never a branch-only checkout that looks complete.
 *
 * The operation id is derived from the thread, the workspace and the settlement it was
 * judged under, so a retry after a refused or interrupted attempt names the same
 * operation instead of archiving again. A resumed thread settles again, which makes a
 * new id: an old attempt can never release a newer incarnation.
 */
export type ReleaseRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SlipJayReleaseOutcome =
  | { kind: "retired"; archiveId: string | null }
  | { kind: "refused"; reason: string }
  | { kind: "uncertain"; reason: string }
  | { kind: "unavailable"; reason: string };

export type SlipJayRestoreOutcome =
  | { kind: "restored"; workspacePath: string }
  | { kind: "unavailable"; reason: string };

/** Stable per thread, workspace and settlement: a retry reuses it, a resume does not. */
export function releaseOperationId(threadId: string, workspacePath: string, settledAt: string | null): string {
  const settled = settledAt === null ? "unsettled" : String(Date.parse(settledAt) || 0);
  const parts = workspacePath.split(/[\\/]/u).filter(Boolean);
  const workspace = parts.at(-1) ?? "workspace";
  return `t3-${threadId}-${workspace}-${settled}`.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 128);
}

export type ParsedRelease = { state: string; reason?: string; archiveId?: string; workspacePath?: string };

/** The last JSON line a command printed: SlipJay's result, whatever it logged before it. */
export function parseReleaseResult(stdout: string): ParsedRelease | null {
  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .toReversed();
  for (const line of candidates) {
    let parsed: { state?: unknown; reason?: unknown; archiveId?: unknown; workspacePath?: unknown } | null = null;
    try {
      parsed = JSON.parse(line) as { state?: unknown; reason?: unknown; archiveId?: unknown; workspacePath?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.state === "string") {
      return {
        state: parsed.state,
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(typeof parsed.archiveId === "string" ? { archiveId: parsed.archiveId } : {}),
        ...(typeof parsed.workspacePath === "string" ? { workspacePath: parsed.workspacePath } : {}),
      };
    }
  }
  return null;
}

export async function releaseSlipJayWorkspace(input: {
  workspacePath: string;
  threadId: string;
  settledAt: string | null;
  run: ReleaseRunner;
}): Promise<SlipJayReleaseOutcome> {
  const operationId = releaseOperationId(input.threadId, input.workspacePath, input.settledAt);
  let outcome: { code: number; stdout: string; stderr: string };
  try {
    outcome = await input.run("slipjay", ["retire", input.workspacePath, "--operation", operationId]);
  } catch (error) {
    // No SlipJay on this host is a reason to keep the checkout, never to fall back to git.
    return { kind: "unavailable", reason: `slipjay could not be run: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = parseReleaseResult(outcome.stdout);
  if (!result) {
    const detail = (outcome.stderr || outcome.stdout).trim().split("\n").slice(-1)[0] ?? "no output";
    return { kind: "unavailable", reason: `slipjay gave no result (exit ${outcome.code}): ${detail}` };
  }
  switch (result.state) {
    case "retired":
      return { kind: "retired", archiveId: result.archiveId ?? null };
    case "refused":
      return { kind: "refused", reason: result.reason ?? "slipjay refused to release it" };
    case "uncertain":
      return { kind: "uncertain", reason: result.reason ?? "slipjay could not say whether it released it" };
    default:
      return { kind: "unavailable", reason: `slipjay answered "${result.state}"` };
  }
}

/**
 * Put a released checkout back where its thread expects it: the newest archive of that
 * path, restored in place. Anything else is a failure to report, not a branch checkout
 * that lacks what the thread wrote outside history.
 */
export async function restoreSlipJayWorkspace(input: {
  workspacePath: string;
  run: ReleaseRunner;
}): Promise<SlipJayRestoreOutcome> {
  let outcome: { code: number; stdout: string; stderr: string };
  try {
    outcome = await input.run("slipjay", ["restore", "--latest", "--path", input.workspacePath]);
  } catch (error) {
    return { kind: "unavailable", reason: `slipjay could not be run: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = parseReleaseResult(outcome.stdout);
  if (result?.state === "restored" && typeof result.workspacePath === "string") {
    return { kind: "restored", workspacePath: result.workspacePath };
  }
  const detail = result?.reason ?? (outcome.stderr || outcome.stdout).trim().split("\n").slice(-1)[0] ?? "no output";
  return { kind: "unavailable", reason: `no archived checkout to restore (exit ${outcome.code}): ${detail}` };
}

/** Whether a path is one SlipJay keeps its workspaces in. */
export function isSlipJayWorkspacePath(worktreePath: string, home: string, separator: string): boolean {
  if (home === "") return false;
  const homes = [".slipjay", ".slipway", ".pi"].map((name) => `${home}${separator}${name}${separator}workspaces`);
  return homes.some((root) => worktreePath === root || worktreePath.startsWith(`${root}${separator}`));
}

/** The default runner: `slipjay` from the host's PATH, with a bounded wait. */
export const hostReleaseRunner: ReleaseRunner = (command, args) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code === "string") return reject(error);
      resolve({ code: error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0, stdout, stderr });
    });
  });
