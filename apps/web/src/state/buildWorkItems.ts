import { createBuildWorkItemAtoms } from "@t3tools/client-runtime/state/build-work-items";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useThreadShell } from "./entities";

export const buildWorkItems = createBuildWorkItemAtoms(connectionAtomRuntime);

/**
 * The thread's Build link as the server last read it. Keyed by the linked item, so linking
 * another item, by anyone, reads it at once instead of waiting for the next refresh.
 */
export function useThreadBuildWorkItem(threadRef: ScopedThreadRef | null) {
  const itemId = useThreadShell(threadRef)?.workItem?.itemId;
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : buildWorkItems.item({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, ...(itemId === undefined ? {} : { itemId }) },
        }),
  );
}

/** Whether the project is connected to YardSmith HQ, so its threads offer Link Build item. */
export function useProjectBuildConnected(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): boolean {
  return (
    useEnvironmentQuery(
      environmentId === null || projectId === null
        ? null
        : buildWorkItems.connection({ environmentId, input: { projectId } }),
    ).data?.connected === true
  );
}

/** The HQ whose Build links the thread's messages show as live items; null without one. */
export function useThreadBuildOrigin(threadRef: ScopedThreadRef | null | undefined): string | null {
  const projectId = useThreadShell(threadRef ?? null)?.projectId ?? null;
  return (
    useEnvironmentQuery(
      threadRef == null || projectId === null
        ? null
        : buildWorkItems.connection({
            environmentId: threadRef.environmentId,
            input: { projectId },
          }),
    ).data?.origin ?? null
  );
}
