import { adviceVersion } from "./adviceDelivery.ts";
import * as Duration from "effect/Duration";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpAdvice,
  OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpAskAdviceInput,
  type OrchestratorMcpAdviceQuestion,
  OrchestratorMcpFailure,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(OrchestratorMcpAdvice));
const encodeFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeEffect(Schema.fromJsonString(OrchestratorMcpAdvice));
const decodeAdvisor = Schema.decodeEffect(Schema.fromJsonString(OrchestratorMcpDelegateTaskResult));
const encodeAdvisor = Schema.encodeEffect(Schema.fromJsonString(OrchestratorMcpDelegateTaskResult));
const isFailure = Schema.is(OrchestratorMcpFailure);
const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Advice is private to the managed worker and its authenticated immediate parent.",
  });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Advice could not be read or saved. Retry with the same request identity.",
  });

interface Row {
  readonly worker_thread_id: string;
  readonly worker_run_id: string | null;
  readonly request_id: string;
  readonly parent_thread_id: string;
  readonly parent_environment_id: string | null;
  readonly worker_environment_id: string | null;
  readonly fingerprint: string;
  readonly payload_json: string;
  readonly status: "pending" | "answered" | "cancelled";
  readonly request_delivered: number;
  readonly answer_delivered: number;
}

export class AdviceService extends Context.Service<
  AdviceService,
  {
    readonly release: (
      scope: McpInvocationScope,
      requestId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly reserve: (
      scope: McpInvocationScope,
      input: Extract<OrchestratorMcpAskAdviceInput, { action: "ask" }>,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly advisor: (
      scope: McpInvocationScope,
      requestId?: string,
    ) => Effect.Effect<
      { readonly requestId: string; readonly task: OrchestratorMcpDelegateTaskResult } | undefined,
      OrchestratorMcpFailure
    >;
    readonly recordAdvisor: (
      scope: McpInvocationScope,
      requestId: string,
      task: OrchestratorMcpDelegateTaskResult,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly ask: (
      scope: McpInvocationScope,
      requestId: string,
      question: OrchestratorMcpAdviceQuestion,
    ) => Effect.Effect<OrchestratorMcpAdvice, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
      requestId: string,
    ) => Effect.Effect<OrchestratorMcpAdvice, OrchestratorMcpFailure>;
    readonly answer: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
      requestId: string,
      answer: string,
      remoteParentThreadId?: ThreadId,
    ) => Effect.Effect<OrchestratorMcpAdvice, OrchestratorMcpFailure>;
    readonly cancel: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
      requestId: string,
      remoteParentThreadId?: ThreadId,
    ) => Effect.Effect<OrchestratorMcpAdvice, OrchestratorMcpFailure>;
    readonly pending: (
      workerThreadId: ThreadId,
    ) => Effect.Effect<OrchestratorMcpAdvice | undefined, OrchestratorMcpFailure>;
    readonly waitPeer: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
      parentThreadId: ThreadId,
      seen?: string,
    ) => Effect.Effect<ReadonlyArray<OrchestratorMcpAdvice>, OrchestratorMcpFailure>;
    readonly suppressWake: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly peerRead: (
      scope: McpInvocationScope,
      workerThreadId: ThreadId,
      parentThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OrchestratorMcpAdvice>, OrchestratorMcpFailure>;
    readonly receiveRemote: (
      environmentId: EnvironmentId,
      advice: OrchestratorMcpAdvice,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly remoteUnavailable: (
      workerThreadId: ThreadId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly delivered: (
      workerThreadId: ThreadId,
      requestId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly recover: () => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agents/AdviceService") {}

const make = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<ThreadId>();
  const peers = new Map<ThreadId, number>();
  const mutations = yield* Semaphore.make(1);
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const rowsFor = (workerThreadId: ThreadId) =>
    sql<Row>`SELECT * FROM advice_consultations WHERE worker_thread_id = ${workerThreadId}`.pipe(
      Effect.mapError(unavailable),
    );
  const value = (row: Row) =>
    decode(row.payload_json).pipe(
      Effect.map((advice) =>
        row.parent_environment_id !== null &&
        advice.status === "pending" &&
        (peers.get(advice.workerThreadId) ?? 0) === 0
          ? { ...advice, delivery: "unavailable" as const }
          : advice,
      ),
      Effect.mapError(unavailable),
    );
  const get = Effect.fn("AdviceService.get")(function* (
    workerThreadId: ThreadId,
    requestId: string,
  ) {
    const rows =
      yield* sql<Row>`SELECT * FROM advice_consultations WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`.pipe(
        Effect.mapError(unavailable),
      );
    if (rows[0] === undefined) return yield* refuse("Advice request not found.");
    return rows[0];
  });
  const records = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["subagents", "runs"]).pipe(Effect.mapError(unavailable));
  const shell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  const requireWorker = Effect.fn("AdviceService.requireWorker")(function* (
    scope: McpInvocationScope,
  ) {
    if (
      scope.thread === undefined ||
      scope.client !== undefined ||
      !scope.capabilities.has("orchestration")
    )
      return yield* denied();
    const worker = yield* shell(scope.thread.threadId);
    if (worker === null || worker.deletedAt !== null || worker.archivedAt !== null)
      return yield* denied();
    const latest = latestExecutedRun((yield* records(worker.id)).runs);
    if (
      latest !== null &&
      ["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status)
    )
      return yield* denied();
    return worker;
  });
  const liveParent = Effect.fn("AdviceService.liveParent")(function* (
    workerThreadId: ThreadId,
    parentThreadId: ThreadId,
    workerEnvironmentId?: string | null,
  ) {
    const parent = yield* records(parentThreadId);
    const latest = latestExecutedRun(parent.runs);
    if (
      latest !== null &&
      ["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status)
    )
      return yield* denied();
    const task = parent.subagents.findLast(
      (task) =>
        task.origin === "app_owned" &&
        (workerEnvironmentId == null
          ? task.childThreadId === workerThreadId
          : task.remoteChild?.threadId === workerThreadId &&
            task.remoteChild.environmentId === workerEnvironmentId) &&
        task.completionDelivery?.state !== "disposed",
    );
    if (
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null ||
      task === undefined ||
      ["completed", "cancelled", "interrupted", "failed"].includes(task.status)
    )
      return yield* denied();
    return { parent, task };
  });
  const authorizePeer = Effect.fn("AdviceService.authorizePeer")(function* (
    scope: McpInvocationScope,
    workerThreadId: ThreadId,
    parentThreadId: ThreadId,
  ) {
    const worker = yield* shell(workerThreadId);
    if (
      scope.client?.linked !== true ||
      worker?.linkOrigin?.sessionId !== scope.client.sessionId ||
      worker.delegatedFrom?.threadId !== parentThreadId ||
      worker.agentTask === undefined ||
      worker.deletedAt !== null ||
      worker.archivedAt !== null
    )
      return yield* denied();
    return worker;
  });
  const authorize = Effect.fn("AdviceService.authorize")(function* (
    scope: McpInvocationScope,
    row: Row,
    parentOnly: boolean,
    remoteParentThreadId?: ThreadId,
  ) {
    const workerThreadId = ThreadId.make(row.worker_thread_id);
    if (parentOnly && row.worker_environment_id === null) {
      const worker = yield* records(workerThreadId);
      const latest = latestExecutedRun(worker.runs);
      if (
        latest !== null &&
        (["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status) ||
          (latest.status === "completed" &&
            !(yield* threads
              .delegatedTaskResultPending(workerThreadId)
              .pipe(Effect.mapError(unavailable)))))
      )
        return yield* denied();
    }
    if (remoteParentThreadId !== undefined) {
      if (row.parent_environment_id === null || row.parent_thread_id !== remoteParentThreadId)
        return yield* denied();
      yield* authorizePeer(scope, workerThreadId, remoteParentThreadId);
      return;
    }
    const caller = yield* requireWorkerCaller(scope);
    if (!parentOnly && caller === workerThreadId) return;
    if (row.parent_environment_id !== null || caller !== row.parent_thread_id)
      return yield* denied();
    yield* liveParent(workerThreadId, caller, row.worker_environment_id);
  });
  const requireWorkerCaller = (scope: McpInvocationScope) =>
    scope.thread !== undefined &&
    scope.client === undefined &&
    scope.capabilities.has("orchestration")
      ? Effect.succeed(scope.thread.threadId)
      : Effect.fail(denied());

  const write = Effect.fn("AdviceService.write")(function* (advice: OrchestratorMcpAdvice) {
    const payload = yield* encode(advice);
    yield* sql`UPDATE advice_consultations SET status = ${advice.status}, payload_json = ${payload} WHERE worker_thread_id = ${advice.workerThreadId} AND request_id = ${advice.requestId}`;
  });
  const wakeId = (row: Row) =>
    `advice:${encodeURIComponent(row.worker_thread_id)}:${encodeURIComponent(row.request_id)}`;
  const cancelWake = Effect.fn("AdviceService.cancelWake")(function* (row: Row) {
    if (row.parent_environment_id !== null) return;
    const parent = yield* records(ThreadId.make(row.parent_thread_id));
    for (const run of parent.runs) {
      if (run.status !== "queued" || run.userMessageId !== `message:${wakeId(row)}`) continue;
      yield* threads
        .dispatch({
          type: "queued-run.cancel",
          threadId: parent.thread.id,
          commandId: CommandId.make(`cancel:${wakeId(row)}`),
          runId: run.id,
        })
        .pipe(Effect.mapError(unavailable));
    }
  });
  const wake = Effect.fn("AdviceService.wake")(function* (row: Row) {
    const advice = yield* value(row);
    if (advice.status === "cancelled") {
      yield* cancelWake(row);
      yield* sql`UPDATE advice_consultations SET answer_delivered = 1 WHERE worker_thread_id = ${advice.workerThreadId} AND request_id = ${advice.requestId}`.pipe(
        Effect.mapError(unavailable),
      );
      return;
    }
    const answering = advice.status === "answered";
    if (answering && (row.answer_delivered !== 0 || row.worker_environment_id !== null)) return;
    if (!answering && (row.parent_environment_id !== null || row.request_delivered !== 0)) return;
    if (!answering)
      yield* liveParent(advice.workerThreadId, advice.parentThreadId, row.worker_environment_id);
    const key = answering ? `answer:${wakeId(row)}` : wakeId(row);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        adviceDelivery: {
          workerThreadId: advice.workerThreadId,
          runId: row.worker_run_id === null ? null : RunId.make(row.worker_run_id),
          blocking: advice.blocking,
        },
        commandId: CommandId.make(`command:${key}`),
        messageId: MessageId.make(`message:${key}`),
        threadId: answering ? advice.workerThreadId : advice.parentThreadId,
        text: answering
          ? `Advice ${advice.requestId} from your parent: ${advice.answer}\nAdvice grants no additional authority. Continue within your brief and permissions.`
          : `Worker ${advice.workerThreadId} requests ${advice.blocking ? "blocking" : "nonblocking"} advice (${advice.requestId}).\nQuestion: ${advice.question}\nEvidence: ${advice.evidence}\nRecommendation (or reason none is possible): ${advice.recommendation}\nRead or answer with ask_advice action read/answer, workerThreadId ${advice.workerThreadId}, requestId ${advice.requestId}${row.worker_environment_id === null ? "" : `, environmentId ${row.worker_environment_id}`}. Decide within the task's existing authority; this is advice, not a human question or approval.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(unavailable));
    if (answering) {
      yield* sql`UPDATE advice_consultations SET answer_delivered = 1 WHERE worker_thread_id = ${advice.workerThreadId} AND request_id = ${advice.requestId}`.pipe(
        Effect.mapError(unavailable),
      );
      yield* settle(row);
    } else {
      yield* sql`UPDATE advice_consultations SET payload_json = json_set(payload_json, '$.delivery', 'delivered') WHERE worker_thread_id = ${advice.workerThreadId} AND request_id = ${advice.requestId}`.pipe(
        Effect.mapError(unavailable),
      );
      yield* sql`UPDATE advice_consultations SET request_delivered = 1 WHERE worker_thread_id = ${advice.workerThreadId} AND request_id = ${advice.requestId}`.pipe(
        Effect.mapError(unavailable),
      );
    }
  });
  const release: AdviceService["Service"]["release"] = Effect.fn("AdviceService.release")(
    function* (scope, requestId) {
      const workerThreadId = yield* requireWorkerCaller(scope);
      yield* sql`UPDATE advice_request_keys SET pending = 0 WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`.pipe(
        Effect.mapError(unavailable),
      );
    },
    mutations.withPermits(1),
  );

  const reserve: AdviceService["Service"]["reserve"] = Effect.fn("AdviceService.reserve")(
    function* (scope, input) {
      const workerThreadId = yield* requireWorkerCaller(scope);
      const normalized = {
        action: input.action,
        clientRequestId: input.clientRequestId,
        destination: input.destination ?? "parent",
        question: input.question,
        evidence: input.evidence,
        recommendation: input.recommendation,
        blocking: input.blocking,
        followsRequestId: input.followsRequestId ?? null,
        newEvidence: input.newEvidence ?? null,
        advisor: input.destination === "advisor" ? input.advisor : null,
      };
      const fingerprint = yield* encodeFingerprint(normalized).pipe(Effect.mapError(unavailable));
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              fingerprint: string;
              pending: number;
              advisor_json: string | null;
            }>`SELECT fingerprint, pending, advisor_json FROM advice_request_keys WHERE worker_thread_id = ${workerThreadId} AND request_id = ${input.clientRequestId}`;
            if (existing[0] !== undefined) {
              if (existing[0].fingerprint !== fingerprint)
                return yield* refuse(
                  "This request identity already names a different consultation or destination.",
                );
              if (existing[0].pending === 0 && existing[0].advisor_json === null) {
                const recorded =
                  yield* sql`SELECT 1 FROM advice_consultations WHERE worker_thread_id = ${workerThreadId} AND request_id = ${input.clientRequestId}`;
                if (recorded.length === 0) {
                  const pending =
                    yield* sql`SELECT 1 FROM advice_request_keys WHERE worker_thread_id = ${workerThreadId} AND pending = 1`;
                  if (pending.length > 0)
                    return yield* refuse("This thread already has a pending consultation.");
                  yield* sql`UPDATE advice_request_keys SET pending = 1 WHERE worker_thread_id = ${workerThreadId} AND request_id = ${input.clientRequestId}`;
                }
              }
              return;
            }
            if (input.followsRequestId !== undefined) {
              if (!input.newEvidence?.trim())
                return yield* refuse("A follow-up requires new evidence or an unresolved point.");
              const answered =
                yield* sql`SELECT 1 FROM advice_request_keys k WHERE k.worker_thread_id = ${workerThreadId} AND k.request_id = ${input.followsRequestId} AND k.pending = 0 AND (k.advisor_json IS NOT NULL OR EXISTS (SELECT 1 FROM advice_consultations a WHERE a.worker_thread_id = k.worker_thread_id AND a.request_id = k.request_id AND a.status = 'answered'))`;
              if (answered.length === 0)
                return yield* refuse(
                  "A follow-up must name an answered consultation in this thread.",
                );
            }
            const pending =
              yield* sql`SELECT 1 FROM advice_request_keys WHERE worker_thread_id = ${workerThreadId} AND pending = 1`;
            if (pending.length > 0)
              return yield* refuse(
                "This thread already has a pending consultation. Read or cancel it first.",
              );
            yield* sql`INSERT INTO advice_request_keys(worker_thread_id, request_id, fingerprint, destination) VALUES (${workerThreadId}, ${input.clientRequestId}, ${fingerprint}, ${normalized.destination})`;
          }),
        )
        .pipe(Effect.mapError((error) => (isFailure(error) ? error : unavailable())));
    },
    mutations.withPermits(1),
  );

  const advisor: AdviceService["Service"]["advisor"] = Effect.fn("AdviceService.advisor")(
    function* (scope, requestId) {
      const workerThreadId = yield* requireWorkerCaller(scope);
      const rows = yield* sql<{
        request_id: string;
        advisor_json: string | null;
      }>`SELECT request_id, advisor_json FROM advice_request_keys WHERE worker_thread_id = ${workerThreadId} AND destination = 'advisor' AND ${requestId === undefined ? sql`pending = 1` : sql`request_id = ${requestId}`}`.pipe(
        Effect.mapError(unavailable),
      );
      if (rows[0]?.advisor_json == null) return undefined;
      const task = yield* decodeAdvisor(rows[0].advisor_json).pipe(Effect.mapError(unavailable));
      return { requestId: rows[0].request_id, task };
    },
  );
  const recordAdvisor: AdviceService["Service"]["recordAdvisor"] = Effect.fn(
    "AdviceService.recordAdvisor",
  )(function* (scope, requestId, task) {
    const workerThreadId = yield* requireWorkerCaller(scope);
    const payload = yield* encodeAdvisor(task).pipe(Effect.mapError(unavailable));
    const pending = ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      ? 0
      : 1;
    yield* sql`UPDATE advice_request_keys SET advisor_json = ${payload}, pending = ${pending} WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId} AND destination = 'advisor'`.pipe(
      Effect.mapError(unavailable),
    );
  }, mutations.withPermits(1));

  const ask: AdviceService["Service"]["ask"] = Effect.fn("AdviceService.ask")(function* (
    scope,
    requestId,
    question,
  ) {
    const worker = yield* requireWorker(scope);
    const parentThreadId = worker.delegatedFrom?.threadId ?? worker.lineage.parentThreadId;
    if (parentThreadId === null)
      return yield* new OrchestratorMcpFailure({
        code: "no_parent",
        message: "This thread has no managed parent. Select the advisor destination explicitly.",
      });
    if (worker.agentTask === undefined) return yield* denied();
    const parentEnvironmentId = worker.delegatedFrom?.environmentId ?? null;
    if (parentEnvironmentId === null) yield* liveParent(worker.id, parentThreadId);
    const fingerprint = yield* encodeFingerprint({
      question: question.question,
      evidence: question.evidence,
      recommendation: question.recommendation,
      blocking: question.blocking,
      followsRequestId: question.followsRequestId ?? null,
      newEvidence: question.newEvidence ?? null,
      destination: "parent",
    }).pipe(Effect.mapError(unavailable));
    const row = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* rowsFor(worker.id);
          const existing = rows.find((row) => row.request_id === requestId);
          if (existing !== undefined) {
            if (existing.fingerprint !== fingerprint)
              return yield* refuse(
                "This request identity already belongs to different advice. Use a fresh identity.",
              );
            return existing;
          }
          const currentWorker = yield* requireWorker(scope);
          if (currentWorker.activeRunId !== worker.activeRunId)
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "The worker's run ended before advice acceptance.",
            });
          if (parentEnvironmentId === null) yield* liveParent(worker.id, parentThreadId);
          if (worker.activeRunId === null)
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "A new advice request needs the worker's active run.",
            });
          if (parentEnvironmentId !== null && (peers.get(worker.id) ?? 0) === 0)
            return yield* new OrchestratorMcpFailure({
              code: "provider_unavailable",
              message:
                "The managed parent's advice delivery channel is unavailable. No request was accepted; retry with the same clientRequestId after it reconnects.",
            });
          if (rows.some((row) => row.status === "pending"))
            return yield* refuse(
              "This worker already has pending advice. Read or cancel it before asking again.",
            );
          if (question.followsRequestId !== undefined) {
            if (!question.newEvidence?.trim())
              return yield* refuse("A follow-up requires new evidence or an unresolved point.");
            if (
              !rows.some(
                (row) => row.request_id === question.followsRequestId && row.status === "answered",
              )
            )
              return yield* refuse(
                "A follow-up must name an answered advice request in this worker thread.",
              );
          }
          const advice: OrchestratorMcpAdvice = {
            requestId,
            workerThreadId: worker.id,
            parentThreadId,
            ...question,
            status: "pending",
            answer: null,
            delivery: "pending",
          };
          const payload = yield* encode(advice);
          yield* sql`INSERT INTO advice_consultations (worker_thread_id, worker_run_id, request_id, parent_thread_id, parent_environment_id, fingerprint, payload_json, status) VALUES (${worker.id}, ${worker.activeRunId}, ${requestId}, ${parentThreadId}, ${parentEnvironmentId}, ${fingerprint}, ${payload}, 'pending')`;
          return yield* get(worker.id, requestId);
        }),
      )
      .pipe(Effect.mapError((error) => (isFailure(error) ? error : unavailable())));
    yield* PubSub.publish(changes, worker.id);
    yield* wake(row).pipe(Effect.ignore);
    return yield* value(yield* get(worker.id, requestId));
  }, mutations.withPermits(1));

  const read: AdviceService["Service"]["read"] = Effect.fn("AdviceService.read")(
    function* (scope, workerThreadId, requestId) {
      const row = yield* get(workerThreadId, requestId);
      yield* authorize(scope, row, false);
      return yield* value(row);
    },
  );
  const answer: AdviceService["Service"]["answer"] = Effect.fn("AdviceService.answer")(function* (
    scope,
    workerThreadId,
    requestId,
    answer,
    remoteParentThreadId,
  ) {
    if (!answer.trim()) return yield* refuse("Advice requires a nonempty answer.");
    const row = yield* get(workerThreadId, requestId);
    yield* authorize(scope, row, true, remoteParentThreadId);
    if (row.worker_environment_id !== null)
      return yield* refuse(
        "This worker is remote. Pass its environmentId to answer through the linked environment.",
      );
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* value(yield* get(workerThreadId, requestId));
          if (current.status === "cancelled")
            return yield* refuse(
              "This advice was cancelled; a late answer cannot resume the worker.",
            );
          if (current.status === "answered" && current.answer !== answer)
            return yield* refuse("This advice already has a different answer.");
          const result = { ...current, status: "answered" as const, answer };
          yield* write(result);
          yield* sql`UPDATE advice_request_keys SET pending = 0 WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`;
          return result;
        }),
      )
      .pipe(Effect.mapError((error) => (isFailure(error) ? error : unavailable())));
    yield* PubSub.publish(changes, workerThreadId);
    yield* cancelWake(row);
    yield* wake(yield* get(workerThreadId, requestId)).pipe(Effect.ignore);
    return result;
  }, mutations.withPermits(1));

  const settle = Effect.fn("AdviceService.settle")(function* (row: Row) {
    if (
      row.parent_environment_id === null &&
      (yield* liveParent(
        ThreadId.make(row.worker_thread_id),
        ThreadId.make(row.parent_thread_id),
      ).pipe(Effect.option))._tag === "None"
    )
      return;
    if (row.worker_environment_id === null && row.worker_run_id !== null)
      yield* threads.recoverDelegatedTask(
        ThreadId.make(row.worker_thread_id),
        RunId.make(row.worker_run_id),
      );
  });
  const cancel: AdviceService["Service"]["cancel"] = Effect.fn("AdviceService.cancel")(function* (
    scope,
    workerThreadId,
    requestId,
    remoteParentThreadId,
  ) {
    const row = yield* get(workerThreadId, requestId);
    yield* authorize(scope, row, false, remoteParentThreadId);
    if (row.worker_environment_id !== null)
      return yield* refuse(
        "This worker is remote. Pass its environmentId to cancel through the linked environment.",
      );
    const current = yield* value(row);
    if (current.status !== "pending") {
      if (current.status === "cancelled") yield* wake(row);
      return current;
    }
    yield* sql`UPDATE advice_consultations SET status = 'cancelled', payload_json = json_set(payload_json, '$.status', 'cancelled') WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId} AND status = 'pending'`.pipe(
      Effect.mapError(unavailable),
    );
    yield* sql`UPDATE advice_request_keys SET pending = 0 WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`.pipe(
      Effect.mapError(unavailable),
    );
    yield* PubSub.publish(changes, workerThreadId);
    yield* wake(yield* get(workerThreadId, requestId));
    yield* settle(row);
    return yield* value(yield* get(workerThreadId, requestId));
  }, mutations.withPermits(1));

  const pending: AdviceService["Service"]["pending"] = Effect.fn("AdviceService.pending")(
    function* (workerThreadId) {
      const rows =
        yield* sql<Row>`SELECT * FROM advice_consultations WHERE worker_thread_id = ${workerThreadId} AND status = 'pending'`.pipe(
          Effect.mapError(unavailable),
        );
      return rows[0] === undefined ? undefined : yield* value(rows[0]);
    },
  );
  const peerRead: AdviceService["Service"]["peerRead"] = Effect.fn("AdviceService.peerRead")(
    function* (scope, workerThreadId, parentThreadId) {
      yield* authorizePeer(scope, workerThreadId, parentThreadId);
      return yield* Effect.forEach(yield* rowsFor(workerThreadId), value);
    },
  );
  const waitPeer: AdviceService["Service"]["waitPeer"] = Effect.fn("AdviceService.waitPeer")(
    function (scope, workerThreadId, parentThreadId, seen) {
      return Effect.scoped(
        Effect.gen(function* () {
          yield* authorizePeer(scope, workerThreadId, parentThreadId);
          yield* Effect.acquireRelease(
            Effect.sync(() => peers.set(workerThreadId, (peers.get(workerThreadId) ?? 0) + 1)),
            () =>
              Effect.sync(() => {
                const remaining = (peers.get(workerThreadId) ?? 1) - 1;
                if (remaining === 0) peers.delete(workerThreadId);
                else peers.set(workerThreadId, remaining);
              }),
          );
          const subscription = yield* PubSub.subscribe(changes);
          const wait = Effect.gen(function* () {
            while (true) {
              const records = yield* peerRead(scope, workerThreadId, parentThreadId);
              if (
                seen === undefined
                  ? !records.some((request) => request.status === "pending" && request.blocking)
                  : adviceVersion(records) !== seen
              )
                return records;
              yield* PubSub.take(subscription);
            }
          });
          const result = yield* wait.pipe(Effect.timeoutOption(Duration.seconds(30)));
          return result._tag === "Some"
            ? result.value
            : yield* peerRead(scope, workerThreadId, parentThreadId);
        }),
      );
    },
  );
  const suppressWake: AdviceService["Service"]["suppressWake"] = Effect.fn(
    "AdviceService.suppressWake",
  )(function* (scope, workerThreadId) {
    const records = yield* rowsFor(workerThreadId);
    for (const row of records) {
      if (row.status !== "pending") continue;
      yield* authorize(scope, row, true);
      yield* cancelWake(row);
    }
  }, mutations.withPermits(1));

  const receiveRemote: AdviceService["Service"]["receiveRemote"] = Effect.fn(
    "AdviceService.receiveRemote",
  )(function* (environmentId, advice) {
    yield* liveParent(advice.workerThreadId, advice.parentThreadId, environmentId);
    const payload = yield* encode(advice).pipe(Effect.mapError(unavailable));
    yield* sql`INSERT INTO advice_consultations (worker_thread_id, request_id, parent_thread_id, worker_environment_id, fingerprint, payload_json, status)
      VALUES (${advice.workerThreadId}, ${advice.requestId}, ${advice.parentThreadId}, ${environmentId}, '', ${payload}, ${advice.status})
      ON CONFLICT (worker_thread_id, request_id) DO UPDATE SET
        payload_json = excluded.payload_json, status = excluded.status
      WHERE advice_consultations.worker_environment_id = excluded.worker_environment_id
        AND advice_consultations.status = 'pending'`.pipe(Effect.mapError(unavailable));
    const row = yield* get(advice.workerThreadId, advice.requestId);
    if (advice.status !== "pending") yield* cancelWake(row);
    yield* wake(row);
  }, mutations.withPermits(1));

  const remoteUnavailable: AdviceService["Service"]["remoteUnavailable"] = Effect.fn(
    "AdviceService.remoteUnavailable",
  )(function* (workerThreadId) {
    yield* sql`UPDATE advice_consultations SET payload_json = json_set(payload_json, '$.delivery', 'unavailable') WHERE worker_thread_id = ${workerThreadId} AND worker_environment_id IS NOT NULL AND status = 'pending'`.pipe(
      Effect.mapError(unavailable),
    );
  }, mutations.withPermits(1));

  const delivered: AdviceService["Service"]["delivered"] = Effect.fn("AdviceService.delivered")(
    function* (workerThreadId, requestId) {
      yield* get(workerThreadId, requestId);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE advice_consultations SET payload_json = json_set(payload_json, '$.delivery', 'delivered') WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`;
            yield* sql`UPDATE advice_consultations SET request_delivered = 1 WHERE worker_thread_id = ${workerThreadId} AND request_id = ${requestId}`;
          }),
        )
        .pipe(Effect.mapError(unavailable));
    },
    mutations.withPermits(1),
  );

  const dispose = Effect.fn("AdviceService.dispose")(function* (row: Row) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE advice_consultations SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END, payload_json = CASE WHEN status = 'pending' THEN json_set(payload_json, '$.status', 'cancelled') ELSE payload_json END WHERE worker_thread_id = ${row.worker_thread_id} AND request_id = ${row.request_id}`;
          yield* sql`UPDATE advice_request_keys SET pending = 0 WHERE worker_thread_id = ${row.worker_thread_id} AND request_id = ${row.request_id}`;
        }),
      )
      .pipe(Effect.mapError(unavailable));
    yield* PubSub.publish(changes, ThreadId.make(row.worker_thread_id));
    yield* cancelWake(row);
    yield* settle(row);
    yield* sql`UPDATE advice_consultations SET answer_delivered = 1 WHERE worker_thread_id = ${row.worker_thread_id} AND request_id = ${row.request_id}`.pipe(
      Effect.mapError(unavailable),
    );
  });
  const recover: AdviceService["Service"]["recover"] = Effect.fn("AdviceService.recover")(
    function* () {
      const rows =
        yield* sql<Row>`SELECT * FROM advice_consultations WHERE status = 'pending' OR (status IN ('answered', 'cancelled') AND answer_delivered = 0)`.pipe(
          Effect.mapError(unavailable),
        );
      for (const row of rows) {
        if (row.worker_environment_id !== null) {
          const parent = yield* liveParent(
            ThreadId.make(row.worker_thread_id),
            ThreadId.make(row.parent_thread_id),
            row.worker_environment_id,
          ).pipe(Effect.option);
          if (parent._tag === "None") yield* dispose(row);
          else yield* wake(row).pipe(Effect.ignore);
          continue;
        }
        const worker = yield* shell(ThreadId.make(row.worker_thread_id));
        const latest = worker === null ? null : latestExecutedRun((yield* records(worker.id)).runs);
        const ended =
          worker === null ||
          worker.archivedAt !== null ||
          worker.deletedAt !== null ||
          (latest !== null &&
            (["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status) ||
              (latest.status === "completed" &&
                !(yield* threads
                  .delegatedTaskResultPending(worker.id)
                  .pipe(Effect.mapError(unavailable))))));
        const localParent =
          row.parent_environment_id === null
            ? yield* liveParent(
                ThreadId.make(row.worker_thread_id),
                ThreadId.make(row.parent_thread_id),
              ).pipe(Effect.option)
            : undefined;
        if (ended || (localParent !== undefined && localParent._tag === "None")) {
          yield* dispose(row);
        } else yield* wake(row).pipe(Effect.ignore);
      }
    },
    mutations.withPermits(1),
  );

  const start: AdviceService["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        ["subagent.updated", "thread.updated", "run.updated"].includes(event.type)
          ? recover().pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkScoped, Effect.andThen(recover()), Effect.ignore),
    );
  return AdviceService.of({
    release,
    reserve,
    advisor,
    recordAdvisor,
    ask,
    read,
    answer,
    cancel,
    pending,
    peerRead,
    waitPeer,
    suppressWake,
    receiveRemote,
    remoteUnavailable,
    delivered,
    recover,
    start,
  });
});

export const layer = Layer.effect(AdviceService, make);
