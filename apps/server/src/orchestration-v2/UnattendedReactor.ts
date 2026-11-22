import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type RunId,
  type RuntimeRequestId,
  type ServerSettings,
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { cancelledBeforeStart, neverStarted } from "./RestartBackgroundNote.ts";
import {
  activeRunOf,
  ARC_RUN_ANSWER,
  arcLeadThreadId,
  AWAY_ANSWER,
  AWAY_CONTINUE_PROMPT,
  AWAY_LEAD_ANSWER,
  AWAY_LEAD_CONTINUE_PROMPT,
  hasDoneStatusMarker,
  isCoveredByAway,
  needsOwnerAnswer,
} from "./arcRun.ts";
import {
  isServerContinuationRun,
  MAX_CONTINUATION_CHAIN,
  serverContinuationChainLength,
  UNATTENDED_CONTINUATION_MESSAGE_PREFIX,
} from "./serverContinuation.ts";

const SUBAGENT_DONE = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * A sweep only continues runs that ended just now: as the server went down, or as Away went on.
 * An older completed run was already judged, and a skip then (snoozed, watching, away off) stands.
 */
const SWEEP_WINDOW_MS = 10 * 60 * 1000;

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
    /**
     * While Away is on, answers every covered thread's waiting question and continues each one
     * whose last run completed within the window without finishing cleanly.
     */
    readonly sweep: Effect.Effect<void>;
    /** Turning Away on sweeps at once, so threads already waiting on the owner carry on. */
    readonly setAway: (away: boolean) => Effect.Effect<ServerSettings, ServerSettingsError>;
  }
>()("t3/orchestration-v2/UnattendedReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettingsService;
  // Read on every event, so it is kept here rather than fetched from settings each time.
  const away = yield* Ref.make(false);
  const covered = Effect.fnUntraced(function* (thread: OrchestrationV2AppThread) {
    return (yield* Ref.get(away)) && isCoveredByAway(thread, yield* DateTime.now);
  });
  // A Spec lead under a running Arc or autonomous run reports to its parent lead: its question and
  // its turn-end both go there, so nothing here may answer or continue it first.
  const reportsToParentRun = Effect.fnUntraced(function* (thread: OrchestrationV2AppThread) {
    const parentId = arcLeadThreadId(thread);
    if (parentId === undefined) return false;
    const parent = yield* projections.getThread(parentId);
    return activeRunOf(parent) !== undefined;
  });

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
    const run = activeRunOf(records.thread);
    if (run !== undefined ? run.state !== "active" : yield* reportsToParentRun(records.thread)) {
      return;
    }
    if (run === undefined && !(yield* covered(records.thread))) return;
    const answer =
      run !== undefined
        ? ARC_RUN_ANSWER
        : records.thread.agentTask !== undefined
          ? AWAY_LEAD_ANSWER
          : AWAY_ANSWER;
    const item = records.turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === requestId,
    );
    if (item?.type !== "user_input_request" || item.questions.length === 0) return;
    if (needsOwnerAnswer(item.questions)) return;
    yield* engine.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`server:unattended-answer:${requestId}`),
      threadId,
      requestId,
      answers: Object.fromEntries(item.questions.map((question) => [question.id, answer])),
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
    // An Arc or autonomous run has its own reactor, whose wake carries the run's explicit end contract.
    if (activeRunOf(thread) !== undefined || (yield* reportsToParentRun(thread))) return;
    if (!(yield* covered(thread))) return;
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
    // Delegated tasks, waits and the provider's own background commands and monitors wake the
    // thread themselves; a nudge then only makes the agent poll them.
    if (
      (thread.parkedWaits?.length ?? 0) > 0 ||
      thread.ownerWait !== undefined ||
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
      }).length > 0
    )
      return;

    const pendingQuestions = records.runtimeRequests.filter(
      (request) =>
        request.kind === "user_input" &&
        request.status === "pending" &&
        request.responseCapability.type === "message",
    );

    // A non-run thread that explicitly ended with `🟢 Status: Done` (and has no pending
    // questions) is finished: never burn a wasted turn nudging it.
    if (pendingQuestions.length === 0) {
      const { messages: sourceMessages } = yield* projections.getThreadRecords(
        threadId,
        ["messages"],
        { messageRoles: ["assistant"], messageRunIds: [sourceRunId] },
      );
      if (sourceMessages.some((message) => hasDoneStatusMarker(message.text))) return;
    }

    if (serverContinuationChainLength(runs, source) >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logInfo("Not continuing an away thread nudged too many times in a row", {
        threadId,
        sourceRunId,
      });
      return;
    }
    if (isServerContinuationRun(source) && !(yield* runDidWork(threadId, source))) return;

    let answerableQuestions = pendingQuestions;
    if (pendingQuestions.length > 0) {
      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_input_request"],
      });
      const ownerOnlyIds = new Set(
        turnItems
          .filter(
            (item): item is Extract<typeof item, { readonly type: "user_input_request" }> =>
              item.type === "user_input_request" && needsOwnerAnswer(item.questions),
          )
          .map((item) => item.requestId),
      );
      if (pendingQuestions.some((q) => ownerOnlyIds.has(q.id))) return;
      answerableQuestions = pendingQuestions.filter((q) => !ownerOnlyIds.has(q.id));
    }

    for (const request of answerableQuestions) {
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make(`server:unattended-dismiss:${request.id}`),
        threadId,
        requestId: request.id,
      });
    }
    const awayAnswer = thread.agentTask !== undefined ? AWAY_LEAD_ANSWER : AWAY_ANSWER;
    const awayContinue =
      thread.agentTask !== undefined ? AWAY_LEAD_CONTINUE_PROMPT : AWAY_CONTINUE_PROMPT;
    const text = answerableQuestions.length > 0 ? `${awayAnswer}\n\n${awayContinue}` : awayContinue;
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
    if (!(yield* Ref.get(away))) return;
    const since = DateTime.subtract(yield* DateTime.now, { milliseconds: SWEEP_WINDOW_MS });
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads AS thread
      WHERE deleted_at IS NULL AND archived_at IS NULL
      AND (
        json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
        OR json_extract(payload_json, '$.agentTask.role') = 'lead'
      )
      AND (
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
          WHERE request.thread_id = thread.thread_id
          AND request.status = 'pending' AND request.kind = 'user_input'
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = thread.thread_id
          AND run.status = 'completed' AND run.completed_at >= ${DateTime.formatIso(since)}
        )
      )`;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      const { runs, runtimeRequests } = yield* projections.getThreadRecords(threadId, [
        "runs",
        "runtimeRequests",
      ]);
      for (const request of runtimeRequests) {
        if (answerableLiveQuestion(request)) yield* answerQuestion(threadId, request.id);
      }
      const latest = runs.reduce<OrchestrationV2Run | undefined>(
        (last, run) =>
          !neverStarted(run) && (last === undefined || runRanAfter(run, last)) ? run : last,
        undefined,
      );
      // The continuation carries the away answer to a question asked after the turn ended.
      const waitingOnMessage = runtimeRequests.some(
        (request) =>
          request.kind === "user_input" &&
          request.status === "pending" &&
          request.responseCapability.type === "message",
      );
      if (
        latest?.status === "completed" &&
        latest.completedAt != null &&
        (waitingOnMessage || !DateTime.isLessThan(latest.completedAt, since))
      )
        yield* continueAfter(threadId, latest.id);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("away sweep failed", { cause })));

  const setAway: UnattendedReactor["Service"]["setAway"] = Effect.fn("UnattendedReactor.setAway")(
    function* (next) {
      const before = (yield* settings.getSettings).away;
      const updated = yield* settings.setAway(next);
      yield* Ref.set(away, updated.away);
      if (!before && updated.away) yield* sweep;
      return updated;
    },
  );

  const start: UnattendedReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Subscribed before the read, so a change in between is not lost.
        const changes = yield* settings.subscribeChanges;
        yield* Ref.set(away, (yield* settings.getSettings).away);
        yield* Effect.all(
          [
            sweep,
            Stream.runForEach(engine.streamDomainEvents, handle),
            Stream.runForEach(changes, (next) => Ref.set(away, next.away)),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logWarning("away thread event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle, sweep, setAway } satisfies UnattendedReactor["Service"];
});

export const layer = Layer.effect(UnattendedReactor, make);
