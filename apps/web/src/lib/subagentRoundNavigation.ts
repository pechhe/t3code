import type { RunId } from "@t3tools/contracts";

const SUBAGENT_ROUND_HASH_PREFIX = "subagent-round=";

/** A follow-up pill's link lands on its round inside the reviewer's conversation. */
export function subagentRoundHash(taskId: string): string {
  return `${SUBAGENT_ROUND_HASH_PREFIX}${encodeURIComponent(taskId)}`;
}

/** The delegated task a thread URL points at, when it carries a follow-up round anchor. */
export function subagentRoundTaskIdFromLocation(href: string): string | null {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;
  const hash = href.slice(hashIndex + 1);
  if (!hash.startsWith(SUBAGENT_ROUND_HASH_PREFIX)) return null;
  try {
    const taskId = decodeURIComponent(hash.slice(SUBAGENT_ROUND_HASH_PREFIX.length));
    return taskId.length > 0 ? taskId : null;
  } catch {
    return null;
  }
}

/**
 * A follow-up pill links to the child thread with its delegated task id; the child run that
 * answers that task is the round to land on.
 */
export function subagentRoundAnchor(
  href: string,
  runs: ReadonlyArray<{ readonly id: RunId; readonly delegatedTaskId?: string | undefined }> = [],
): { readonly runId: RunId; readonly key: string } | null {
  const taskId = subagentRoundTaskIdFromLocation(href);
  const run =
    taskId === null ? undefined : runs.find((candidate) => candidate.delegatedTaskId === taskId);
  return run === undefined || taskId === null
    ? null
    : { runId: run.id, key: `${taskId}:${run.id}` };
}
