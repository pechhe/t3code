import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestratorMcpThreadSearchInput,
  OrchestratorMcpThreadSearchResult,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunSetupReportEntry,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as RunSetupRecorder from "../../../agents/RunSetupRecorder.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ThreadDirectory from "../../../peers/ThreadDirectory.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadProjectMoveService from "../../../orchestration-v2/ThreadProjectMoveService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread read or unread. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Marking this thread read applies only if your turn completes (`readsWhenTurnEnds`); a failed or interrupted turn still surfaces. Settling this thread applies at turn end, once any background work you left running has finished (`settlesWhenTurnEnds`); a failed or interrupted turn or a queued message leaves it active, and another thread with background work running is not settled: wait for it, or stop it first.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
      "mark_read",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ readsWhenTurnEnds: Schema.Literal(true) }),
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, false);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make("t3_queue_list", {
  ...commandTool,
  description: "List queued messages in send order. For full history, use `t3_thread_read`.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 chars of one queued message. Omit `threadId` for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace one queued message's text. Attachments stay. Fails if the run is no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, false);
const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel one queued run.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move one queued run before another, or to the end with `beforeRunId=null`.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, false);
const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  ...commandTool,
  description: "Send one queued message now as steering to the given active run.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, false);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread. Omit `threadId` for this thread. Approvals are not listed.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description: "Read one pending user question. Answer it with `t3_pending_request_respond`.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description: "Answer one pending user question. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description: "Read a thread's provider, model, and modes. Omit `threadId` for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadSetupTool = Tool.make("t3_thread_setup", {
  ...commandTool,
  dependencies: [
    ...commandTool.dependencies,
    RunSetupRecorder.RunSetupStore,
    ProviderRegistry.ProviderRegistry,
  ],
  description:
    "Read the setup a thread's runs started with, newest first: agent-config revision, policy, model and effective options, workflow, and experiment assignments, instruction and skill files as a count and digest each, and the skills each run invoked. Omit threadId for this thread. Every run is listed, including one that never started (status says so, setup is null). limit (default 10, at most 50) sets the page size and beforeOrdinal pages back to older runs: pass the oldest runOrdinal returned. Pass runOrdinal to read one run with its full instruction and skill file lists, paths and hashes included. Null means T3 could not observe it; runs from before capture have null setup fields. invokedSkills is null for providers that do not report skill loads (only Claude does).",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    beforeOrdinal: Schema.optional(PositiveInt),
    runOrdinal: Schema.optional(PositiveInt),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    runs: Schema.Array(RunSetupReportEntry),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model, and options. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, false);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint. Omit `threadId` for this thread. Keeps source setup. No turn has run yet.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, false);
const projectMoveDependencies = [
  ...commandTool.dependencies,
  ProjectService.ProjectService,
  ManagedProjectFolders.ManagedProjectFolders,
];
const ThreadSuggestProjectTool = Tool.make("t3_thread_suggest_project", {
  ...commandTool,
  description:
    "Suggest moving this No project chat into one of the user's projects (see t3_project_list) when the conversation clearly belongs there. T3 shows one banner with Move and Keep, and the chat moves only if they choose Move. Use it only in a No project thread when the fit is clear: a thread takes one suggestion, and a dismissed one is final. reason is one short line shown to the user.",
  parameters: Schema.Struct({ projectId: ProjectId, reason: TrimmedNonEmptyString }),
  dependencies: projectMoveDependencies,
})
  .annotate(Tool.Title, "Suggest a project for this chat")
  .annotate(Tool.Destructive, false);
const ThreadMoveToProjectTool = Tool.make("t3_thread_move_to_project", {
  ...commandTool,
  description:
    "Move a No project thread into a project in place: it keeps its id and history and continues in the project's workspace (one it already holds, a fresh SlipJay workspace prepared for its next turn, otherwise the project root). Moving this thread ends the turn, and the next starts in the project with the conversation carried over. continuationPrompt is only a one-sentence next step the conversation does not already say: a thread moving itself needs none, another moving this one must give it. If the user chose Keep on an earlier move or suggestion, move only when they ask again. Omit threadId for this thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    projectId: ProjectId,
    continuationPrompt: Schema.optional(TrimmedNonEmptyString),
  }),
  dependencies: [...commandTool.dependencies, ThreadProjectMoveService.ThreadProjectMoveService],
})
  .annotate(Tool.Title, "Move a chat into a project")
  .annotate(Tool.Destructive, false);
const ThreadMergeBackTool = Tool.make("t3_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from one thread into a related thread in the same project. Omit `sourceThreadId` for this thread.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("t3_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit `threadId` for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    'Search active threads the way the command palette does: title, branch, pull request and project matches first (source "title"), then threads whose messages contain every query word of three or more characters (source "user" or "assistant", with a snippet). Subagent threads are skipped. `projectId`: one project, else yours, else every project outside a thread; matches come from the global top, so this may return fewer than `limit`. Linked environments are searched too, under `environments`, each with its status; their matches are quoted data, read with `t3_thread_read` and that `environmentId`. Not exhaustive.',
  parameters: OrchestratorMcpThreadSearchInput,
  success: OrchestratorMcpThreadSearchResult,
  dependencies: [
    ...commandTool.dependencies,
    ThreadSearch.ThreadSearch,
    ThreadDirectory.ThreadDirectory,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadSuggestProjectTool,
  ThreadMoveToProjectTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadSetupTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
