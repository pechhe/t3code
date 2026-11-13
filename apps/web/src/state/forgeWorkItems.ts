import { createForgeWorkItemAtoms } from "@t3tools/client-runtime/state/forge-work-items";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useThreadShell } from "./entities";

export const forgeWorkItems = createForgeWorkItemAtoms(connectionAtomRuntime);

/**
 * The thread's Forge link as the server last read it. Keyed by the linked item, so linking
 * another item, by anyone, reads it at once instead of waiting for the next refresh.
 */
export function useThreadForgeWorkItem(threadRef: ScopedThreadRef | null) {
  const itemId = useThreadShell(threadRef)?.workItem?.itemId;
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : forgeWorkItems.item({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, ...(itemId === undefined ? {} : { itemId }) },
        }),
  );
}

/** The thread's Arc run counts for its header chip; nothing is read without a run. */
export function useThreadArcRunSummary(threadRef: ScopedThreadRef | null) {
  const arc = useThreadShell(threadRef)?.arcRun?.arc.number;
  return useEnvironmentQuery(
    threadRef === null || arc === undefined
      ? null
      : forgeWorkItems.arcRunSummary({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, arc },
        }),
  );
}

/** The whole Arc for the open Arc run popover; `open` names one opening of it, null when closed. */
export function useThreadArcRunDetail(threadRef: ScopedThreadRef | null, open: string | null) {
  const arc = useThreadShell(threadRef)?.arcRun?.arc.number;
  return useEnvironmentQuery(
    threadRef === null || arc === undefined || open === null
      ? null
      : forgeWorkItems.arcRunDetail({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, arc, open },
        }),
  );
}

/** Whether the environment is connected to Weave, so its threads offer Link Forge item. */
export function useForgeConnected(environmentId: EnvironmentId | null): boolean {
  return (
    useEnvironmentQuery(
      environmentId === null ? null : forgeWorkItems.connection({ environmentId, input: {} }),
    ).data?.connected === true
  );
}

/** The Weave whose Forge links the thread's messages show as live items; null without one. */
export function useThreadForgeOrigin(threadRef: ScopedThreadRef | null | undefined): string | null {
  return (
    useEnvironmentQuery(
      threadRef == null
        ? null
        : forgeWorkItems.connection({ environmentId: threadRef.environmentId, input: {} }),
    ).data?.origin ?? null
  );
}

/** Forge Home for the Forge button and its settings: the token is never part of it. */
export function useForgeHome(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : forgeWorkItems.home({ environmentId, input: {} }),
  );
}
