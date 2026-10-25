import {
  CommandId,
  MessageId,
  type ProjectId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as RunSetupRecorder from "../../../agents/RunSetupRecorder.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ThreadProjectMove from "../../../orchestration-v2/ThreadProjectMoveService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ThreadDirectory from "../../../peers/ThreadDirectory.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Refuses unless the thread is in No project and the target is another live project. */
const assertMovableToProject = Effect.fn("mcp.assertMovableToProject")(function* (
  threadProjectId: ProjectId,
  targetProjectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  const scratchRoot = yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
    Effect.flatMap((folders) => folders.scratchRoot),
  );
  const scratchProject = Option.isNone(scratchRoot)
    ? undefined
    : Option.getOrUndefined(
        yield* projects.getByWorkspaceRoot(scratchRoot.value).pipe(Effect.mapError(unavailable)),
      );
  if (scratchProject?.id !== threadProjectId)
    return yield* invalid("Only a No project thread can move into a project.");
  if (targetProjectId === threadProjectId)
    return yield* invalid("Choose a project other than No project.");
  const target = yield* projects.getById(targetProjectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(target)) return yield* invalid("The project was not found.");
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const handlers = {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const directory = yield* ThreadDirectory.ThreadDirectory;
      return yield* directory.searchAcross({
        query: input,
        localId: scope.environmentId,
        fromPeer: scope.client?.access === "peer-threads",
        local: Effect.gen(function* () {
          const { caller } = yield* readCaller();
          const { projectId: requested, environmentId: _environmentId, ...query } = input;
          // Like the other project tools, an omitted project means the caller's own; a client
          // outside a thread searches every project.
          const projectId = requested ?? caller?.projectId;
          const threadSearch = yield* ThreadSearch.ThreadSearch;
          const result = yield* threadSearch
            .searchThreads({ ...query, projectId })
            .pipe(Effect.mapError(unavailable));
          return {
            environmentId: scope.environmentId,
            matches: result.matches.map((match) => ({
              ...match,
              environmentId: scope.environmentId,
              link: formatThreadLink(match.threadId, match.title),
            })),
          };
        }),
      });
    }),
  ),
  t3_thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  t3_thread_suggest_project: writesThread(
    (input: {
      readonly projectId: ProjectId;
      readonly reason: string;
      readonly threadId?: never;
    }) =>
      Effect.gen(function* () {
        const { threads, projection } = yield* readThread(undefined);
        yield* assertMovableToProject(projection.thread.projectId, input.projectId);
        if (projection.thread.projectSuggestion != null)
          return yield* invalid("This thread already has a project suggestion.");
        const result = yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: yield* newCommandId(),
            threadId: projection.thread.id,
            projectSuggestion: { projectId: input.projectId, reason: input.reason },
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
  ),
  t3_thread_move_to_project: writesThread((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const commandId = yield* newCommandId();
      // A self-move reads as the chat continuing: its next turn starts there with the
      // conversation carried over, so T3 writes the continuation unless the agent names a
      // next step. Another thread moving this one says what happens next, or nothing does.
      const continues = scope.thread?.threadId === projection.thread.id;
      const result = yield* (yield* ThreadProjectMove.ThreadProjectMoveService)
        .move({
          commandId,
          threadId: projection.thread.id,
          projectId: input.projectId,
          continuation:
            input.continuationPrompt === undefined && !continues
              ? undefined
              : {
                  commandId: CommandId.make(`${commandId}:continuation`),
                  messageId: MessageId.make(`${commandId}:continuation`),
                  ...(input.continuationPrompt === undefined
                    ? {}
                    : { text: input.continuationPrompt }),
                  senderThreadId: scope.thread?.threadId,
                },
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      return { sequence: result.sequence };
    }),
  ),
  t3_thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
  ),
  t3_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  t3_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  t3_thread_setup: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(
        input.threadId,
        ["turnItems", "runs"],
        ["dynamic_tool"],
      );
      const runs = RunSetupRecorder.setupWindow(projection.runs, {
        limit: input.limit ?? 10,
        beforeOrdinal: input.beforeOrdinal,
        runOrdinal: input.runOrdinal,
      });
      const store = yield* RunSetupRecorder.RunSetupStore;
      const providers = yield* ProviderRegistry.ProviderRegistry;
      const records = yield* store
        .list(runs.map((run) => run.id))
        .pipe(Effect.mapError(unavailable));
      const drivers = new Map(
        (yield* providers.getProviders).map((provider) => [provider.instanceId, provider.driver]),
      );
      return {
        threadId: projection.thread.id,
        runs: yield* RunSetupRecorder.setupReport({
          runs,
          records,
          turnItems: projection.turnItems,
          driverOf: (instanceId) => drivers.get(instanceId as never),
          detail: input.runOrdinal === undefined ? "summary" : "full",
        }),
      };
    }),
  ),
  t3_thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  t3_pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  t3_pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readQuestion(input);
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  t3_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  t3_queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  t3_queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  t3_queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  t3_queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "mark_read") {
        return yield* threads
          .markThreadRead({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ThreadToolkit.tools>;

export const layer = McpToolAccess.toLayer(ThreadToolkit, handlers);
