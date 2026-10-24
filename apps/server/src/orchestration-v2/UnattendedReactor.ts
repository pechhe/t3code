import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type RunId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { cancelledBeforeStart, neverStarted } from "./RestartBackgroundNote.ts";
import {
  isServerContinuationRun,
  MAX_CONTINUATION_CHAIN,
  serverContinuationChainLength,
  UNATTENDED_CONTINUATION_MESSAGE_PREFIX,
} from "./serverContinuation.ts";

const AWAY_ANSWER =
  "The owner is away and this thread is unattended, so nobody will answer questions. Decide yourself from the evidence and the governing intent. When you are unsure about a consequential choice, consult the advisor role, then decide. Record anything that truly needs the owner (acceptance, promotion, spending, permission widening, an irreversible choice) as a hold, and carry on with all other work.";

const CONTINUE_PROMPT =
  "This thread is unattended. Continue the remaining work. If it is finished, or only owner holds remain, give the final report and stop.";

const SUBAGENT_DONE = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * The startup sweep only catches runs that ended as the server went down. An older completed
 * run was already judged live, and a skip then (snoozed, watching, attended) must stand.
 */
const SWEEP_WINDOW_MS = 10 * 60 * 1000;

function isUnattendedTopLevel(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return (
    thread.workflow?.unattended === true &&
    thread.lineage.parentThreadId === null &&
    thread.agentTask === undefined &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    !(thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  );
}

// Message-mode questions arrive after the turn ended; the continuation dismisses and answers them.
function answerableLiveQuestion(request: OrchestrationV2RuntimeRequest) {
  return (
    request.kind === "user_input" &&
    request.status === "pending" &&
    request.responseCapability.type === "live"
  );
}

export class UnattendedReactor extends Context.Service<
  UnattendedReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Continues every unattended thread whose last run completed while the server was down. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/UnattendedReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // A provider may record the request before the item holding its questions, so either event
  // can be the one that finds both.
  const answerQuestion = Effect.fnUntraced(function* (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    const request = yield* projections.getRuntimeRequest(threadId, requestId);
    if (request === undefined || !answerableLiveQuestion(request)) return;
    const records = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_input_request"],
    });
    if (!isUnattendedTopLevel(records.thread, yield* DateTime.now)) return;
    const item = records.turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === requestId,
    );
    if (item?.type !== "user_input_request" || item.questions.length === 0) return;
    // Fixed-choice dialogs, such as Claude's resume prompt, stay with the owner.
    if (item.questions.some((question) => question.allowCustomAnswer === false)) return;
    yield* engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`server:unattended-answer:${requestId}`),
      threadId,
      requestId,
      answers: Object.fromEntries(item.questions.map((question) => [question.id, AWAY_ANSWER])),
    });
  });

  const continueAfter = Effect.fnUntraced(function* (threadId: ThreadId, sourceRunId: RunId) {
    const messageId = MessageId.make(`${UNATTENDED_CONTINUATION_MESSAGE_PREFIX}${sourceRunId}`);
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "subagents", "runtimeRequests", "messages", "providerThreads", "turnItems"],
      {
        messageIds: [messageId],
        turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
        turnItemStatuses: ["pending", "running", "waiting"],
      },
    );
    const { thread, runs } = records;
    if (!isUnattendedTopLevel(thread, yield* DateTime.now)) return;
    if (records.messages.some((message) => message.id === messageId)) return;
    const source = runs.find((run) => run.id === sourceRunId);
    if (source?.status !== "completed") return;
    // Anything else queued or running already continues the thread, and a held queue is the
    // owner's stop.
    if (
      runs.some(
        (run) =>
          run.id !== source.id &&
          (run.status === "queued" ||
            run.status === "preparing" ||
            run.status === "starting" ||
            run.status === "running" ||
            run.status === "waiting" ||
            (!cancelledBeforeStart(run) && runRanAfter(run, source))),
      )
    )
      return;
    // Delegated tasks, watches and the provider's own background commands and monitors wake the
    // thread themselves; a nudge then only makes the agent poll them.
    if (
      records.subagents.some(
        (task) => task.origin === "app_owned" && !SUBAGENT_DONE.has(task.status),
      ) ||
      derivePendingBackgroundWork({
        latestRun: source,
        runs,
        providerThreads: records.providerThreads,
        turnItems: records.turnItems,
        activeProviderThreadId: thread.activeProviderThreadId,
        pullRequests: thread.pullRequests,
        threadWatches: thread.threadWatches,
      }).length > 0
    )
      return;
    if (serverContinuationChainLength(runs, source) >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logInfo("Not continuing an unattended thread nudged too many times in a row", {
        threadId,
        sourceRunId,
      });
      return;
    }
    if (isServerContinuationRun(source) && !(yield* runDidWork(threadId, source))) return;

    const questions = records.runtimeRequests.filter(
      (request) =>
        request.kind === "user_input" &&
        request.status === "pending" &&
        request.responseCapability.type === "message",
    );
    for (const request of questions) {
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make(`server:unattended-dismiss:${request.id}`),
        threadId,
        requestId: request.id,
      });
    }
    const text = questions.length > 0 ? `${AWAY_ANSWER}\n\n${CONTINUE_PROMPT}` : CONTINUE_PROMPT;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:unattended-continuation:${sourceRunId}`),
      threadId,
      messageId,
      text,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "Unattended: continuing the work",
        detail: text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // Every adapter records its tool calls, MCP ones included, as tool_call nodes.
  const runDidWork = Effect.fnUntraced(function* (threadId: ThreadId, run: OrchestrationV2Run) {
    const { nodes } = yield* projections.getThreadRecords(threadId, ["nodes"]);
    return nodes.some(
      (node) => node.runId === run.id && (node.kind === "tool_call" || node.kind === "subagent"),
    );
  });

  // Untraced: it runs once per domain event, so a span per event would swamp traces.
  const handle: UnattendedReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "runtime-request.updated" && answerableLiveQuestion(event.payload)) {
        return yield* answerQuestion(event.threadId, event.payload.id);
      }
      if (event.type === "turn-item.updated" && event.payload.type === "user_input_request") {
        return yield* answerQuestion(event.threadId, event.payload.requestId);
      }
      if (event.type === "run.updated" && event.payload.status === "completed") {
        return yield* continueAfter(event.threadId, event.payload.id);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("unattended thread handling failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const sweep: UnattendedReactor["Service"]["sweep"] = Effect.gen(function* () {
    const since = DateTime.toEpochMillis(yield* DateTime.now) - SWEEP_WINDOW_MS;
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(payload_json, '$.workflow.unattended') = 1`;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const latest = runs.reduce<OrchestrationV2Run | undefined>(
        (last, run) =>
          !neverStarted(run) && (last === undefined || runRanAfter(run, last)) ? run : last,
        undefined,
      );
      if (
        latest?.status === "completed" &&
        latest.completedAt != null &&
        DateTime.toEpochMillis(latest.completedAt) >= since
      )
        yield* continueAfter(threadId, latest.id);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("unattended startup sweep failed", { cause })),
  );

  const start: UnattendedReactor["Service"]["start"] = () =>
    forkParked(
      Effect.all([sweep, Stream.runForEach(engine.streamDomainEvents, handle)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("unattended thread event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle, sweep } satisfies UnattendedReactor["Service"];
});

export const layer = Layer.effect(UnattendedReactor, make);
