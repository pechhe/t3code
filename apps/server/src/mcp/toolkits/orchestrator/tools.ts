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
    "The first step of delegation: list the canonical roles this caller can delegate to, the model and effort each resolves to under the configured policy, current catalog and caller permissions, and each refusal, without assigning an experiment or starting a model. Accounts out of usage are passed over for the next listed model with allowance and named in usageLimited; when every candidate is limited, the one resetting soonest serves. Use ticket-reviewer for a change and spec-reviewer for a Spec, and keep authorModel truthful. Pass model (and providerInstanceId) to see what each role resolves to when that model is requested; it must be in the role's model list. Reviewers place the author's model last among accounts with allowance by default, but an explicit listed choice may match authorModel; every review still requires fresh context and enforced read-only authority. External callers supply their attached externalSessionKey. Refused routes remain refused; discovery does not authorise a launch.",
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
    "List the V2 provider instances, a short list of their models from the same live catalog as the composer, inherited runtime settings, and app-owned orchestration features available to this caller. The list has the user's favorite and custom models, your own model, every current Codex, Claude, Muse and Grok model, and the first 8 current models of other providers. Other legacy models are left out. omittedModels counts models left out; pass search, such as 'sonnet 4.6', to find them. delegate_task accepts any catalog model, listed or not. This is not the delegation menu: delegate by role through agent_roles where a role policy is configured. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy.",
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
    "Delegate one task to a child agent of this thread, which runs only the supplied prompt. External main agents attach with agent_session_attach and pass externalSessionKey. Call agent_roles first, then pass agentTask (role, taskClass, workId, attemptId, workspacePath) and a stable clientRequestId; title is the topic only. A reviewer also needs sourceRevision (the full commit id) and review scope. workspaceAssignment 'isolated' gives a simultaneous writer its own workspace and returns a handoff revision; the default 'lead' uses the caller's workspace. Pass target.model/providerInstanceId and target.options to choose an advertised model and its settings. Use mode='wait' only when this turn needs the result; otherwise mode='async' and end the turn. The child's completion wakes this thread, so do not poll. Follow up in the same conversation with followup and its taskId. Check providerInstanceId, model, and options in the result.",
  parameters: OrchestratorMcpDelegateTaskInput,
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
    "Read a T3-owned delegated task by taskId. summary is its final result; latestTerminal* holds a later turn; pendingApproval names the oldest live approval. Reading a terminal result acknowledges its automatic parent delivery. Use followup on an idle task instead of starting another.",
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
    "External OAuth callers can cancel only their owned managed tasks. For T3-owned callers, needs an agent running inside a T3 thread. Stop a T3-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, other queued turns are held, pull request watches end, and the tasks it delegated stop too. The task's own queued turn is cancelled, including when held in a stopped queue. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
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
    "Stop one running Claude workflow in a T3 thread. Use the workflow coordinator's subagentId returned by t3_thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
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
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings; report the returned nextRunAt. Webhook dedupe accepts replayKey and coalesceKey templates with coalesceWindowSeconds (10–3600, default 120); replay keys expire after 7 days and coalescing keeps the latest payload in a window measured from its first delivery. Webhooks: {type:'webhook'} runs once per request to a generated URL. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). Each value arrives framed as untrusted request data, and $skill, @file or /command mentions inside it do not act; without a signature, anyone with the URL can trigger a run. For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. To run only for some requests, add filters, all of which must match, e.g. filters:[{path:'headers.x-github-event', op:'equals', value:'pull_request'}, {path:'body.action', op:'in', value:['opened','reopened']}]; ops are equals, notEquals, in, startsWith and exists. A path segment ending in [] fans out over an array: {path:'body.issue.labels[].name', op:'equals', value:'needs more info'} matches when any label has that name, and notEquals only when none does. The result's webhookUrl is the public URL to give the user; if it is absent, this environment has no T3 Connect managed tunnel, so tell the user to enable T3 Connect remote access rather than sharing a path. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Provider, model, and runtime settings inherit from this thread, or from the project default when there is no calling thread.",
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
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
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
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Webhook schedule dedupe accepts replayKey, coalesceKey, and coalesceWindowSeconds (10–3600, default 120) to suppress replays for 7 days and retain the latest payload in each fixed window. Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run. A webhook schedule without filters keeps the stored filters; pass filters to replace them, or filters:[] to clear them.",
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
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
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
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. schedule_task's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
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
    "Ask the owner to approve a release candidate, as `slipjay promote` describes. Never ask in chat. Pass repository, full candidate commit id, base, and the plan summary. One card per repository: the same candidate joins it, a different one replaces it. On pending, end the turn. Your yes covers exactly that candidate.",
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
    "Needs an agent running inside a T3 thread. Create one or more ORDINARY TOP-LEVEL T3 conversations. This is not delegation and does not create child agents/subagents. For delegated work, check agent_roles and call delegate_task with agentTask. Use create_threads for a batch of separate top-level threads sharing this checkout. Prefer t3_thread_launch for a single thread. Both require the user to request separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden here. For independent implementation or a PR stack in its own worktree, use t3_thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt.",
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
    "List T3 threads in a project, newest first. Filter by status, title, settled or snoozed state; paginate with the cursor. Linked environments are included under environments. Link a thread to the user as `[title](t3-thread://v1/<threadId>)`, adding `?environment=<environmentId>` for a linked one.",
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
    "Read a T3 thread's durable state and paginated timeline by threadId. view=messages (default) returns user and assistant messages; activity returns summarized timeline items. Continue with afterPosition=nextPosition; recover long text with itemId and textOffset.",
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
    "Update a thread's metadata: rename, regenerate_title, link_pull_request, unlink_pull_request, set_workflow, link_work_item or unlink_work_item. Omit threadId for this thread. clientRequestId makes retries idempotent.",
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
    "Send a message to a T3 thread. mode=auto starts an idle thread or steers a live one; queue, steer and restart force the delivery. For a follow-up in the same child conversation, send to its childThreadId. clientRequestId makes retries idempotent.",
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
    "Wait for a T3 thread run to reach a terminal durable state, within this turn. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result. A run can end while the thread still has work, such as a reviewer or background command. To wait for longer than one turn, or for the thread to finish all of its work, call watch and end your turn instead.",
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
    'Have T3 Code wake this thread once when a target is ready: another thread in this environment ({kind: "thread", threadId}) or a YardSmith Build item ({kind: "build_item", number, until}). Use this instead of polling, sleeping, repeated t3_thread_wait calls, or asking a worker to message you when it is done. A thread has finished when no run is active or queued and it has no unfinished delegated task, background command or pull request watch; a run that ends with any of those still pending is a pause and does not wake you. The wake also comes, once, if the thread fails, is stopped, is archived or deleted, or is waiting for a person to answer a question or approval. The wake gives the thread\'s outcome and quotes its final message as that thread\'s own words. A thread that has already finished wakes you at once. Survives server restarts. After a wake, the watch has ended: call watch again to be woken again. Watching ends without a wake when you call unwatch, read the thread\'s final result with t3_thread_read, when the user stops this thread, or when this thread is archived or settled. While watching, this thread stays in the user\'s Working list. A thread cannot watch itself or a thread in another environment, a delegated subagent cannot watch (its parent thread does), and a settled or archived thread must be unsettled first. Watching a target you already watch changes nothing. A Build item target needs T3\'s HQ connection and is checked at most once a minute: until "unblocked" wakes you when all its waits and holds are clear, until "closed" when it is Landed or Accepted; either wakes you if it is Dropped.',
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
    "Stop T3 Code from waking this thread for the given thread or Build item target, including a wake already queued behind your current turn. The target is not affected.",
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
    "Request interruption of a running turn in any T3 thread in this environment. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
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
