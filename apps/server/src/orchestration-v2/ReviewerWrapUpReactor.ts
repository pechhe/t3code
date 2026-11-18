import {
  CommandId,
  MessageId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  REVIEWER_WRAP_UP_TOOL_CALLS,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** The agent's own tool calls; a call nested inside one (codemode, a subagent) has a parent item. */
const TOOL_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;
const isToolItem = (item: OrchestrationV2TurnItem) =>
  (TOOL_ITEM_TYPES as ReadonlyArray<string>).includes(item.type) && item.parentItemId === null;

export type WrapUpStep = "report" | "restart";

const WRAP_UP_TEXT: Record<WrapUpStep, string> = {
  report:
    "T3: you have made many tool calls on this review without reporting. Write your report now with what you have, and mark anything you did not trace as suspected rather than reading further.",
  restart:
    "T3: you kept reading after being asked to report. Stop reading and write your report now from what you already have, making no further tool calls except to record the review. Mark anything you did not trace as suspected.",
};

/**
 * The step a reviewer task is due, if any: a request to report at the threshold, then at half as
 * many calls again an interrupt and restart. Each fires once; a later step skips an earlier one.
 */
export function dueWrapUpStep(
  count: number,
  threshold: number,
  sent: ReadonlySet<WrapUpStep>,
): WrapUpStep | undefined {
  if (count >= Math.ceil(threshold * 1.5) && !sent.has("restart")) return "restart";
  if (count >= threshold && !sent.has("report") && !sent.has("restart")) return "report";
  return undefined;
}

/**
 * How a step reaches a running turn. Asking to report steers where the provider takes a message
 * mid-turn, and otherwise restarts the turn with it; the orchestrator restarts in place where the
 * provider can, and otherwise stops the turn and runs the message next.
 */
export const wrapUpDispatchMode = (
  step: WrapUpStep,
  turns: OrchestrationV2ProviderCapabilities["turns"] | undefined,
  targetRunId: OrchestrationV2Run["id"],
) =>
  step === "report" && turns?.supportsActiveSteering === true
    ? ({ type: "steer_active", targetRunId } as const)
    : ({ type: "restart_active", targetRunId } as const);

export const wrapUpMessageId = (taskId: NodeId, step: WrapUpStep) =>
  MessageId.make(`message:reviewer-wrap-up:${taskId}:${step}`);

export class ReviewerWrapUpReactor extends Context.Service<
  ReviewerWrapUpReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ReviewerWrapUpReactor") {}

interface ReviewerThread {
  /** The task the thread was opened for; its runs carry no task id of their own. */
  readonly originalTaskId: NodeId | undefined;
  readonly tasks: Map<NodeId, TaskCount>;
}
interface TaskCount {
  readonly threshold: number;
  readonly calls: Set<TurnItemId>;
  readonly sent: Set<WrapUpStep>;
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);

  // Per child thread: undefined until seen, null when it is not a reviewer. A task's count is
  // rebuilt from the projection after a restart, so this only saves reads while a turn runs.
  const threads = new Map<ThreadId, ReviewerThread | null>();
  const taskOf = (reviewer: ReviewerThread, run: OrchestrationV2Run) =>
    run.delegatedTaskId ?? reviewer.originalTaskId;

  const threshold = Effect.fnUntraced(function* () {
    if (Option.isNone(managed)) return REVIEWER_WRAP_UP_TOOL_CALLS;
    const snapshot = yield* managed.value.snapshot().pipe(Effect.option);
    return Option.isSome(snapshot)
      ? (snapshot.value.manifest.roles.reviewer.wrapUpAfterToolCalls ?? REVIEWER_WRAP_UP_TOOL_CALLS)
      : REVIEWER_WRAP_UP_TOOL_CALLS;
  });

  const countTask = Effect.fnUntraced(function* (
    threadId: ThreadId,
    reviewer: ReviewerThread,
    taskId: NodeId,
  ) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const taskRunIds = runs.filter((run) => taskOf(reviewer, run) === taskId).map((run) => run.id);
    const { turnItems, messages } = yield* projections.getThreadRecords(
      threadId,
      ["turnItems", "messages"],
      {
        turnItemTypes: TOOL_ITEM_TYPES,
        turnItemRunIds: taskRunIds,
        messageIds: [wrapUpMessageId(taskId, "report"), wrapUpMessageId(taskId, "restart")],
      },
    );
    return {
      threshold: yield* threshold(),
      calls: new Set(turnItems.filter(isToolItem).map((item) => item.id)),
      sent: new Set(
        (["report", "restart"] as const).filter((step) =>
          messages.some((message) => message.id === wrapUpMessageId(taskId, step)),
        ),
      ),
    } satisfies TaskCount;
  });

  const send = Effect.fnUntraced(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    taskId: NodeId,
    step: WrapUpStep,
    trigger: OrchestrationV2TurnItem["id"],
  ) {
    const records = yield* projections.getThreadRecords(threadId, [
      "providerThreads",
      "providerSessions",
    ]);
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    const turns = records.providerSessions.find(
      (session) => session.id === providerThread?.providerSessionId,
    )?.capabilities.turns;
    yield* engine.dispatch({
      type: "message.dispatch",
      // Per triggering call: a refused attempt's receipt would otherwise reject the retry.
      commandId: CommandId.make(`server:reviewer-wrap-up:${taskId}:${step}:${trigger}`),
      threadId,
      messageId: wrapUpMessageId(taskId, step),
      text: WRAP_UP_TEXT[step],
      attachments: [],
      dispatchMode: wrapUpDispatchMode(step, turns, run.id),
      // Reading the run happened outside the thread lock; a turn that ended since gets nothing.
      onlyIntoActiveTurn: true,
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const onToolItem = Effect.fnUntraced(function* (
    threadId: ThreadId,
    item: OrchestrationV2TurnItem,
  ) {
    let reviewer = threads.get(threadId);
    if (reviewer === undefined) {
      const thread = yield* projections.getThread(threadId);
      reviewer =
        thread.agentTask?.role === "reviewer"
          ? {
              originalTaskId:
                thread.forkedFrom?.type === "node" ? thread.forkedFrom.nodeId : undefined,
              tasks: new Map(),
            }
          : null;
      threads.set(threadId, reviewer);
    }
    if (reviewer === null || item.runId === null) return;
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
      runIds: [item.runId],
    });
    const run = runs[0];
    const taskId = run === undefined ? undefined : taskOf(reviewer, run);
    if (run === undefined || taskId === undefined || run.status !== "running") return;
    let task = reviewer.tasks.get(taskId);
    if (task === undefined) {
      task = yield* countTask(threadId, reviewer, taskId);
      reviewer.tasks.set(taskId, task);
    }
    task.calls.add(item.id);
    const step = dueWrapUpStep(task.calls.size, task.threshold, task.sent);
    if (step === undefined) return;
    task.sent.add(step);
    // Refused when the turn was between steps; the next tool call of a running turn retries.
    yield* send(threadId, run, taskId, step, item.id).pipe(
      Effect.tapError(() => Effect.sync(() => task.sent.delete(step))),
    );
  });

  // Runs for every domain event; all but a running reviewer's own tool calls return at once.
  const handle: ReviewerWrapUpReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status))
          threads.delete(event.threadId);
        return;
      }
      if (event.type !== "turn-item.updated" || !isToolItem(event.payload)) return;
      if (threads.get(event.threadId) === null) return;
      yield* onToolItem(event.threadId, event.payload);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("asking a reviewer to wrap up failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ReviewerWrapUpReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("reviewer wrap-up event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies ReviewerWrapUpReactor["Service"];
});

export const layer = Layer.effect(ReviewerWrapUpReactor, make);
