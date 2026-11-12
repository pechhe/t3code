import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadShellRelationshipStatus } from "@t3tools/client-runtime/state/thread-relationships";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironment } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";

export const WAITING_FOR_CONNECTION = "Waiting for connection";

/**
 * A thread a watch names in a linked environment, as this client sees it: the environment's
 * name (as this client names it, else as the watcher's link does), whether this client is
 * connected there, and the thread's live status once it is. Never looks the id up among the
 * watcher's own threads. Inert without an `environmentId`, so a local row can call it too.
 */
export function useRemoteWatchedThread(input: {
  readonly watcherEnvironmentId: EnvironmentId;
  readonly target: {
    readonly threadId: ThreadId;
    readonly environmentId?: EnvironmentId | undefined;
  } | null;
}) {
  const environmentId = input.target?.environmentId;
  const environment = useEnvironment(environmentId ?? null);
  const linked = useLinkedEnvironments(
    environmentId === undefined ? null : input.watcherEnvironmentId,
  );
  const connected = useConnectedEnvironmentIds();
  const remoteRef =
    input.target !== null && environmentId !== undefined && connected.includes(environmentId)
      ? scopeThreadRef(environmentId, input.target.threadId)
      : null;
  const shell = useThreadShell(remoteRef);
  return {
    environmentLabel:
      environmentId === undefined
        ? null
        : (environment?.label ?? linked.get(environmentId) ?? null),
    connected: remoteRef !== null,
    shell,
    /** The thread's status, when it can be read; null until the shell is there. */
    status: shell === null ? null : threadShellRelationshipStatus(shell.source),
  };
}
