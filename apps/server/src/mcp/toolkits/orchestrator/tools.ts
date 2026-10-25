import {
  AgentTaskOutcomeInput,
  ExperimentOutcome,
  AgentSessionAttachInput,
  AgentExternalSession,
  AgentRolesInput,
  AgentRolesResult,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskWireInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpRequestReleaseApprovalInput,
  OrchestratorMcpRequestReleaseApprovalResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskWireInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskWireInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpThreadWatchInput,
  OrchestratorMcpThreadWatchResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadDirectory from "../../../peers/ThreadDirectory.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
  ThreadDirectory.ThreadDirectory,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const AgentTaskOutcomeTool = Tool.make("agent_task_outcome", {
  description:
    "Record an outcome for this client's owned external work assignment. Caller claims remain self-report; this does not attest independent acceptance or missing parent usage.",
  parameters: AgentTaskOutcomeInput,
  success: ExperimentOutcome,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Idempotent, true);

const AgentSessionAttachTool = Tool.make("agent_session_attach", {
  description:
    "Attach an authenticated external main-agent session to an exact existing workspace in this environment and project. No model is started. The returned key scopes subsequent managed delegate_task calls to this OAuth client; reconnect with the same externalSessionId to recover it.",
  parameters: AgentSessionAttachInput,
  success: AgentExternalSession,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true);
const AgentRolesTool = Tool.make("agent_roles", {
  description:
    "The first step of delegation: the roles this caller can delegate to, the model and effort each resolves to under the configured policy, and each refusal, without starting a model. Accounts out of usage are passed over for the next model with allowance and named in usageLimited; if all are limited, the one resetting soonest serves. Pass model to see what each role resolves to for it, which must be in its model list. Reviewers put the author's model last but still need fresh context and read-only authority. Discovery does not authorise a launch.",
  parameters: AgentRolesInput,
  success: AgentRolesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "The provider instances, a short list of their models from the same live catalog as the composer, inherited runtime settings, and this caller's orchestration features. omittedModels counts the models left out; pass search, such as 'sonnet 4.6', to find one, and delegate_task accepts any catalog model. This is not the delegation menu: delegate by role through agent_roles. For a separate thread use t3_thread_launch.",
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Delegate one task to a child agent of this thread, which runs only the supplied prompt. Call agent_roles first, then pass agentTask (role, taskClass, workId, attemptId, workspacePath) and a stable clientRequestId; title is the topic only. With a role policy, agentTask is required and an unfillable role is blocked, not substituted. A reviewer also needs sourceRevision (the full commit id) and review scope. workspaceAssignment 'isolated' gives a simultaneous writer its own workspace and returns a handoff revision; 'lead' (default) uses the caller's. Pass a target for a model and options, or followup with a taskId to continue that conversation. External main agents pass the externalSessionKey.",
  parameters: OrchestratorMcpDelegateTaskWireInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read a T3-owned delegated task by taskId. summary is its final result; latestTerminal* holds a later turn; pendingApproval names the oldest live approval. Reading a terminal result acknowledges its automatic parent delivery. Follow up an idle task rather than starting another.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "External OAuth callers can cancel only their owned managed tasks; otherwise this needs an agent inside a T3 thread. Stop a delegated task and dispose its automatic parent delivery: its child thread stops like a user Stop, its queued turns are cancelled, its pull request watches end, and the tasks it delegated stop too. A terminal task returns its status; published results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const WorkflowStopTool = Tool.make("t3_workflow_stop", {
  description:
    "Stop one running Claude workflow in a T3 thread, using the coordinator's subagentId from t3_thread_read with view='activity'. Stops the whole workflow, its phases and agents, but not the parent thread or other workflows; a single phase or agent cannot be stopped.",
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);


const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent work in the app scheduler, which runs with no turn active. A webhook runs once per request to a generated URL, and that run sees the request ONLY through prompt placeholders such as {{body.action}} or {{request}}. Each value arrives as untrusted request data, so $skill, @file or /command mentions inside it do not act; without a signature anyone with the URL can trigger a run, so for a sender that signs requests set signature with a secretRef from request_secret, with header, encoding, prefix and the secretRef. filters, all of which must match, narrow a webhook by JSON path; ops are equals, notEquals, in, startsWith and exists, and a path segment ending in [] fans out over an array. replayKey and coalesceKey with coalesceWindowSeconds (10–3600, default 120) suppress replays for 7 days and keep the latest payload per window. agentRole (default 'implementation-worker') picks each run's model through its policy.",
  parameters: OrchestratorMcpScheduleTaskWireInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), with their id, schedule, prompt, enabled state, bound thread, next run time and last run status. Use its scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId. agentRole moves it to another subagent role instead of naming a model. replayKey, coalesceKey and coalesceWindowSeconds (10–3600, default 120) suppress webhook replays for 7 days. Only the provided fields change; enabled=false pauses without deleting. Without filters a webhook schedule keeps its stored ones; pass filters to replace them, or filters:[] to clear them.",
  parameters: OrchestratorMcpUpdateScheduledTaskWireInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId. The task stops running immediately; to keep it but stop runs, use update_scheduled_task with enabled=false.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a secret (a token, API key, password) through a private card in this thread, and wait for their answer. The app keeps it and NEVER returns it to you or the transcript. The result's secretRef works once, for a tool that accepts one (e.g. schedule_task's signature.secretRef). Never ask for a secret in chat, and never invent one.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const RequestReleaseApprovalTool = Tool.make("request_release_approval", {
  description:
    "Ask the owner to approve a release candidate, as `slipjay promote` describes. Never ask in chat. Pass repository, full candidate commit id, base and the plan summary. One card per repository: the same candidate joins it, a different one replaces it. On pending, end the turn; the yes covers exactly that candidate.",
  parameters: OrchestratorMcpRequestReleaseApprovalInput,
  success: OrchestratorMcpRequestReleaseApprovalResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a release approval")
  .annotate(Tool.Destructive, false);

const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Needs an agent running inside a T3 thread. Create a batch of ORDINARY TOP-LEVEL T3 conversations sharing this checkout. This is not delegation and creates no child agents: use delegate_task for child work and prefer t3_thread_launch for one thread; both need the user to ask for separate threads. Entries may override provider, model, options and modes; project, branch and worktree inherit.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List T3 threads in a project, newest first. Filter by status, title, settled or snoozed state; paginate with the cursor. Linked environments are included under environments.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read a T3 thread's durable state and paginated timeline. view=messages (default) returns user and assistant messages; activity returns summarized timeline items. Continue with afterPosition=nextPosition; recover long text with itemId and textOffset.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update a thread's metadata: rename, regenerate_title, link_pull_request, unlink_pull_request, set_workflow, link_work_item or unlink_work_item. Omit threadId for this thread.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update T3 thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to a T3 thread. mode=auto starts an idle thread or steers a live one; queue, steer and restart force the delivery. For a follow-up in the same child conversation, send to its childThreadId.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a T3 thread run to reach a terminal durable state, within this turn. Without runId the latest run at call time is selected, and an idle thread returns immediately. A timeout does not interrupt work, so call again or read the thread after timedOut=true. Waiting reports status only; it does not acknowledge a delegated result. A run can end while the thread still has work, such as a reviewer; to wait for all of it, call watch and end your turn.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WatchThreadTool = Tool.make("watch", {
  description:
    'Have T3 Code wake this thread once when a target is ready: another thread here ({kind: "thread", threadId}) or a Weave Build item ({kind: "build_item", number, until}). Use it instead of polling or sleeping. A thread has finished when no run is active or queued and it has no unfinished delegated task, background command or pull request watch; a run that ends with those pending is a pause and does not wake you. It also wakes you once if the thread fails, stops, is archived or deleted, or waits for a person to answer a question or approval. A finished thread wakes you at once, and it survives server restarts. After a wake it has ended, so call watch again; it also ends without a wake when you call unwatch, read the final result, stop this thread, or this thread is archived or settled. A thread cannot watch itself or a thread in another environment, a delegated child never watches, and a settled thread must be unsettled first. A Build item needs T3\'s Weave connection and is checked once a minute at most: "unblocked" wakes you when its waits and holds are clear, "closed" when it is Landed or Accepted, and either wakes you if it is Dropped.',
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadWatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Watch a thread or Build item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UnwatchThreadTool = Tool.make("unwatch", {
  description:
    "Stop T3 Code from waking this thread for the given thread or Build item target, including a wake already queued behind your current turn. The target itself is not affected.",
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadWatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop watching a target")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in any T3 thread in this environment. Without runId the newest interruptible run is selected; terminal runs and idle threads return without effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a T3 thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  AgentTaskOutcomeTool,
  AgentSessionAttachTool,
  AgentRolesTool,
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  WorkflowStopTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  RequestReleaseApprovalTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  WatchThreadTool,
  UnwatchThreadTool,
  ThreadInterruptTool,
);
