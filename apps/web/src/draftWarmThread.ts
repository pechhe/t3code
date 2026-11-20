import type { LaunchEmptyThreadInput } from "@t3tools/client-runtime/operations";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  warmThreadsToDiscard,
  isUnstartedThreadShell,
  shouldRenewDraftThread,
} from "./components/chat/draftWarmThread.logic";
import { type DraftId, useComposerDraftStore } from "./composerDraftStore";
import { newThreadId } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readThreadShell } from "./state/entities";
import { threadEnvironment } from "./state/threads";

const attempted = new Set<string>();
const launched = new Set<string>();
const inFlight = new Map<string, Promise<unknown>>();
const seen = new Set<string>();
const refused = new Set<string>();
const renewedAfterRefusal = new Set<string>();

export function hasAttemptedWarmLaunch(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return attempted.has(`${environmentId}:${threadId}`);
}

/** The draft's launched thread reached this client, so its later absence means it is gone. */
export function noteWarmThreadSeen(environmentId: EnvironmentId, threadId: ThreadId): void {
  seen.add(`${environmentId}:${threadId}`);
}

/**
 * Gives an unsent draft a fresh thread id when its launched thread is gone, so Send creates a new
 * thread instead of one the server refuses; the fresh id launches again.
 */
export function renewDraftThreadIfGone(draftId: DraftId): void {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  if (session === null) return;
  const key = `${session.environmentId}:${session.threadId}`;
  const renew = shouldRenewDraftThread({
    promoted: session.promotedTo != null,
    shellExists: readThreadShell(scopeThreadRef(session.environmentId, session.threadId)) !== null,
    launchSeen: seen.has(key),
    launchRefused: refused.has(key),
    renewedAfterRefusal: renewedAfterRefusal.has(draftId),
  });
  if (!renew) return;
  if (refused.has(key)) renewedAfterRefusal.add(draftId);
  seen.delete(key);
  refused.delete(key);
  launched.delete(key);
  store.setLogicalProjectDraftThreadId(
    session.logicalProjectKey,
    { environmentId: session.environmentId, projectId: session.projectId },
    draftId,
    { threadId: newThreadId() },
  );
}

/** Launches the draft's server thread with no message. A failure only means Send creates it. */
export async function launchWarmThread(
  environmentId: EnvironmentId,
  draftId: DraftId,
  input: LaunchEmptyThreadInput,
): Promise<void> {
  const key = `${environmentId}:${input.threadId}`;
  if (attempted.has(key)) return;
  attempted.add(key);
  const run = runAtomCommand(
    appAtomRegistry,
    threadEnvironment.launchEmpty,
    { environmentId, input },
    { label: threadEnvironment.launchEmpty.label, reportFailure: false, reportDefect: true },
  );
  inFlight.set(key, run);
  const result = await run;
  inFlight.delete(key);
  if (result._tag === "Success") {
    launched.add(key);
    return;
  }
  refused.add(key);
  renewDraftThreadIfGone(draftId);
}

async function giveBackThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const key = `${environmentId}:${threadId}`;
  await inFlight.get(key);
  const ours = launched.has(key);
  // After a reload only the shell shows a launched thread; a started one is never deleted.
  if (!ours && !isUnstartedThreadShell(readThreadShell(scopeThreadRef(environmentId, threadId)))) {
    return;
  }
  launched.delete(key);
  await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.delete,
    { environmentId, input: { threadId, onlyIfUnused: true } },
    { label: threadEnvironment.delete.label, reportFailure: false, reportDefect: true },
  );
}

/**
 * A launched thread whose draft is discarded, or moves to another project or machine, was never
 * used: delete it so the server gives its workspace back. `onlyIfUnused` keeps a thread that
 * started meanwhile.
 */
export function subscribeWarmThreadDiscard(): () => void {
  return useComposerDraftStore.subscribe((state, previous) => {
    if (state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey) return;
    for (const abandoned of warmThreadsToDiscard(
      previous.draftThreadsByThreadKey,
      state.draftThreadsByThreadKey,
    )) {
      void giveBackThread(abandoned.environmentId, abandoned.threadId);
    }
  });
}
