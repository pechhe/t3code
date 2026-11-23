import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { unavailable } from "./threadAccess.ts";

const MAX_DELEGATION_DEPTH = 2;

/**
 * How many delegations a thread sits below a top-level thread. Counts `subagent` edges from the
 * server's lineage, starting from the depth a linked environment stated for a task it delegated
 * here; a fork sits at its source's depth. A launched thread has no parent, so it starts a fresh
 * count, visible in the sidebar.
 */
export const delegationDepth = Effect.fn("mcp.delegationDepth")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "delegatedFrom">,
) {
  const seen = new Set<ThreadId>([shell.id]);
  let depth = 0;
  let current: Pick<OrchestrationV2ThreadShell, "lineage" | "delegatedFrom"> = shell;
  while (true) {
    const lineage = current.lineage;
    if (lineage.parentThreadId === null) {
      depth += current.delegatedFrom?.depth ?? 0;
      break;
    }
    if (lineage.relationshipToParent === "subagent") depth += 1;
    if (depth >= MAX_DELEGATION_DEPTH || seen.has(lineage.parentThreadId)) break;
    seen.add(lineage.parentThreadId);
    const parent = yield* threads
      .getThreadShell(lineage.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null) return yield* unavailable();
    current = parent;
  }
  return depth;
});

/** Refuses a thread already two delegations below a top-level thread, by every route that starts another agent. */
export const assertBelowDelegationLimit = Effect.fn("mcp.assertBelowDelegationLimit")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "delegatedFrom">,
) {
  if ((yield* delegationDepth(threads, shell)) >= MAX_DELEGATION_DEPTH)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This thread is at the delegation limit, two levels below a top-level thread, so it can't delegate, launch or schedule. Do the work yourself, or say in your result what is left for the thread that delegated you.",
    });
});

/**
 * An agent inside a thread must say why a new top-level thread beats a delegated
 * child; an outside client, with no calling thread, needs no reason.
 */
export const requireWhyNotDelegated = (
  caller: { readonly id: ThreadId } | undefined,
  whyNotDelegated: string | undefined,
): Effect.Effect<void, OrchestratorMcpFailure> =>
  caller === undefined || (whyNotDelegated !== undefined && whyNotDelegated.trim() !== "")
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Is this better as a delegated task? Use `delegate_task` for work this thread owns, including a whole Spec in another project (`implementer` with forgeItem). If it must be its own thread, say why in `whyNotDelegated`.",
        }),
      );

/**
 * A thread whose delegation stance is implement starts no separate thread either; an outside
 * client, with no calling thread, is not refused.
 */
export const refuseImplementStance = Effect.fn("mcp.refuseImplementStance")(function* (
  caller: { readonly id: ThreadId } | undefined,
  /** Whether this call only replays work already accepted, which Implement lets through. */
  replaysAccepted?: Effect.Effect<boolean, OrchestratorMcpFailure>,
) {
  if (caller === undefined) return;
  // Without managed agents a thread has no stance, as with its stance note.
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  if (Option.isNone(managed)) return;
  yield* managed.value
    .assertLaunchAllowed({ threadId: caller.id })
    .pipe(
      Effect.catch((error) =>
        (replaysAccepted ?? Effect.succeed(false)).pipe(
          Effect.flatMap((replays) =>
            replays
              ? Effect.void
              : Effect.fail(
                  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
                ),
          ),
        ),
      ),
    );
});

/** The reason is logged on the server: no thread record carries it and none should. */
export const logWhyNotDelegated = (input: {
  readonly launchedFrom: ThreadId;
  readonly threadId: ThreadId;
  readonly whyNotDelegated: string | undefined;
}) =>
  input.whyNotDelegated === undefined
    ? Effect.void
    : Effect.logInfo("orchestrator-mcp.thread.launched-instead-of-delegated", {
        launchedFrom: input.launchedFrom,
        threadId: input.threadId,
        whyNotDelegated: input.whyNotDelegated,
      });
