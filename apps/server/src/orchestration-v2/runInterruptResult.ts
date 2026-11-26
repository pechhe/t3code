import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunInterruptCause,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const INTERRUPT_CAUSE_MESSAGES = {
  user: "Run interrupted by user",
  "provider-abort": "The provider ended the run before it finished",
  "server-close": "The provider session was closed before the run finished",
} as const;

export function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly reason: string | undefined;
  readonly completedAt: DateTime.Utc;
  readonly cause: OrchestrationV2RunInterruptCause;
  /** Where the thread moved, which is the message when `cause` is `move`. */
  readonly moved?: string | undefined;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: input.cause === "move" ? "Moved" : "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message:
      input.cause === "move"
        ? (input.moved ?? "Moved")
        : (input.reason ?? INTERRUPT_CAUSE_MESSAGES[input.cause]),
    cause: input.cause,
  };
}
