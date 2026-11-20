/**
 * A draft with a project chosen launches its server thread while the user types, so Send only
 * dispatches the first message. These are the decisions around that: when the composer waits for
 * a project, when to launch, and which launched-but-never-used threads to give back.
 */

interface WarmShell {
  readonly latestRun: unknown;
  readonly latestUserMessageAt?: string | null | undefined;
}

interface WarmDraftSession {
  readonly environmentId: string;
  readonly threadId: string;
  readonly promotedTo?: { readonly environmentId: string; readonly threadId: string } | null;
}

/** No run and no message yet: the thread is still the draft's, not a conversation. */
export function isUnstartedThreadShell(shell: WarmShell | null | undefined): shell is WarmShell {
  return shell != null && shell.latestRun === null && shell.latestUserMessageAt == null;
}

/** A server thread that has begun owns its draft; an unstarted one is a launched draft. */
export function serverThreadOwnsDraft(shell: WarmShell | null | undefined): boolean {
  return shell != null && !isUnstartedThreadShell(shell);
}

/** The composer waits for a project chip while the draft has none, or none was picked yet. */
export function isProjectSelectionRequired(input: {
  readonly isDraft: boolean;
  readonly hasProject: boolean;
  readonly projectUnchosen: boolean;
}): boolean {
  return input.isDraft && (!input.hasProject || input.projectUnchosen);
}

/** Launch once per draft thread: a failed launch is not retried, Send then creates the thread itself. */
export function shouldLaunchWarmThread(input: {
  readonly hasDraftSession: boolean;
  readonly promoted: boolean;
  readonly projectChosen: boolean;
  readonly hasProject: boolean;
  readonly shellExists: boolean;
  readonly alreadyAttempted: boolean;
  readonly canOperate: boolean;
  /** Load balancing may still move the draft to another machine. */
  readonly environmentResolved: boolean;
}): boolean {
  return (
    input.hasDraftSession &&
    !input.promoted &&
    input.projectChosen &&
    input.hasProject &&
    !input.shellExists &&
    !input.alreadyAttempted &&
    input.canOperate &&
    input.environmentResolved
  );
}

/**
 * A launched thread that is gone (expired while the draft sat idle, or deleted elsewhere) leaves
 * its id taken on the server, so the unsent draft takes a fresh one. A refused launch earns one
 * fresh id, never a loop: after a reload the old id may name a deleted thread.
 */
export function shouldRenewDraftThread(input: {
  readonly promoted: boolean;
  readonly shellExists: boolean;
  readonly launchSeen: boolean;
  readonly launchRefused: boolean;
  readonly renewedAfterRefusal: boolean;
}): boolean {
  if (input.promoted || input.shellExists) return false;
  return input.launchSeen || (input.launchRefused && !input.renewedAfterRefusal);
}

/**
 * Threads a draft launched and then left behind: its session is gone or now names another
 * thread (a different project or machine), and it was not sent. A sent draft is marked promoted
 * first, so it is never listed.
 */
export function warmThreadsToDiscard<Session extends WarmDraftSession>(
  previous: Readonly<Record<string, Session>>,
  next: Readonly<Record<string, Session>>,
): ReadonlyArray<Pick<Session, "environmentId" | "threadId">> {
  const stillClaimed = new Set(
    Object.values(next).map((session) => `${session.environmentId}:${session.threadId}`),
  );
  const abandoned = new Map<string, Pick<Session, "environmentId" | "threadId">>();
  for (const [draftId, before] of Object.entries(previous)) {
    if (before.promotedTo != null) continue;
    const key = `${before.environmentId}:${before.threadId}`;
    if (stillClaimed.has(key)) continue;
    const after = next[draftId];
    if (after?.promotedTo != null) continue;
    abandoned.set(key, { environmentId: before.environmentId, threadId: before.threadId });
  }
  return [...abandoned.values()];
}
