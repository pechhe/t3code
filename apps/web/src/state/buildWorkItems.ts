import { createBuildWorkItemAtoms } from "@t3tools/client-runtime/state/build-work-items";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

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

/** Whether the environment is connected to YardSmith HQ, so its threads offer Link Build item. */
export function useBuildConnected(environmentId: EnvironmentId | null): boolean {
  return (
    useEnvironmentQuery(
      environmentId === null ? null : buildWorkItems.connection({ environmentId, input: {} }),
    ).data?.connected === true
  );
}

/** The HQ whose Build links the thread's messages show as live items; null without one. */
export function useThreadBuildOrigin(threadRef: ScopedThreadRef | null | undefined): string | null {
  return (
    useEnvironmentQuery(
      threadRef == null
        ? null
        : buildWorkItems.connection({ environmentId: threadRef.environmentId, input: {} }),
    ).data?.origin ?? null
  );
}

/** Build Home for the Build button and its settings: the token is never part of it. */
export function useBuildHome(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : buildWorkItems.home({ environmentId, input: {} }),
  );
}
