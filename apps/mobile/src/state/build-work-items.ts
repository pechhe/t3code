import { createBuildWorkItemAtoms } from "@t3tools/client-runtime/state/build-work-items";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const buildWorkItems = createBuildWorkItemAtoms(connectionAtomRuntime);

/** The thread's Build link; keyed by the linked item so a new link reads at once. */
export function useThreadBuildWorkItem(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly workItem?: { readonly itemId: string } | null;
  } | null,
) {
  const itemId = thread?.workItem?.itemId;
  return useEnvironmentQuery(
    thread === null
      ? null
      : buildWorkItems.item({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ...(itemId === undefined ? {} : { itemId }) },
        }),
  ).data;
}

/** One request per environment, shared by every row, decides whether threads offer linking. */
export function useBuildConnected(environmentId: EnvironmentId) {
  return (
    useEnvironmentQuery(buildWorkItems.connection({ environmentId, input: {} })).data?.connected ===
    true
  );
}
