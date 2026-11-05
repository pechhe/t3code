import * as Digest from "effect/crypto/Digest";
import {
  OrchestratorMcpEnvironmentTarget,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
    environmentId: OrchestratorMcpEnvironmentTarget,
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
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
}).annotate(Tool.Destructive, true);

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
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  success: Schema.Union([
    Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const threadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

const ThreadSetupTool = Tool.make("t3_thread_setup", {
  ...commandTool,
  dependencies: [
    ...commandTool.dependencies,
    RunSetupRecorder.RunSetupStore,
    Digest.Digest,
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
    "Read a thread's provider, model, and modes, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
}).annotate(Tool.Destructive, true);

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
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
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
  ThreadSuggestProjectTool,
  ThreadMoveToProjectTool,
  ThreadSetupTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
);
