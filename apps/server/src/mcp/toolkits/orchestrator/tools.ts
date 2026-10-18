import {
  AgentTaskOutcomeInput,
  ExperimentOutcome,
  AgentSessionAttachInput,
  AgentExternalSession,
  AgentRolesInput,
  AgentRolesResult,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
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
    "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this caller. This is not the delegation menu: delegate by role through agent_roles where a role policy is configured. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "For an external main agent, attach with agent_session_attach and supply externalSessionKey plus typed agentTask and clientRequestId. The external route has no paid parent model and uses the exact registered workspace. For T3-owned callers, needs an active agent running inside a T3 thread. To continue any idle owned managed task (advisor, worker, reviewer, UI verifier, browser, researcher or scout) in its conversation, pass followup {taskId,changes} (plus sourceRevision once the task is pinned to one), task as the new question or correction and a fresh stable clientRequestId; omit agentTask, target and mode overrides. Follow up a reviewer or UI verifier that stopped partway or needs one more check. A new review round is the lead's choice: start it fresh with delegate_task and the prior findings in the brief when you want an independent judgement. Close the conversation with task_cancel when its work ends. Delegate one task to a T3-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Delegate by role: check agent_roles, then pass agentTask (role, taskClass, workId, attemptId, workspacePath) and a stable clientRequestId; title is the topic only, since T3 names the thread after the role; T3 takes the first available model in the role's list and its effort from the central policy. workspaceAssignment 'isolated' runs a simultaneous writer in its own allocated workspace of the same repository, or of any registered project's repository, and returns its finished handoff revision. A pinned reader may also read any registered project's repository; pass agentTask.projectId only when several projects share it; the default 'lead' is the caller's workspace. A reviewer needs sourceRevision and review: ticket-reviewer takes scope 'change', spec-reviewer takes scope 'spec'. Pass target.model (and target.providerInstanceId) with agentTask to run the role on a specific model: any model in the role's list may be chosen this way; it keeps the role's own reasoning effort unless target.options states the same one, and is refused otherwise. Choose a raw target without agentTask from orchestrator_capabilities only when no role policy is configured or no role fits; with a policy configured that also needs offPolicyReason. For such a raw delegation, set isolation to worktree for a separate checkout based on the parent local commit, with project setup completed before the child starts. Uncommitted edits are not copied; omitted isolation shares the parent checkout. For every T3 delegated review round, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt. Track each round by its own taskId and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through t3_thread_send. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. A requested runtimeMode must be one the target provider lists in orchestrator_capabilities runtimeModes; an inherited one steps down to the broadest mode it offers. Leave runtimeMode unset unless the user asks for a supervised child: approval-required and auto-accept-edits usually make the child wait for a person at each action that needs approval. Prefer mode='async' for long work; mode='wait' blocks until completion, a blocking question, or timeout. If hasPendingQuestion, pass threadId=childThreadId to t3_pending_request_list, t3_pending_request_read (with requestId) and t3_pending_request_respond, or ask the user; the task's completion still wakes this thread. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
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
    "External OAuth callers can read only their owned managed tasks. For T3-owned callers, needs an agent running inside a T3 thread. Read a T3-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count. latestTerminal* provides later non-monitor turn results. Reading a terminal result acknowledges its automatic parent delivery.",
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
    "External OAuth callers can cancel only their owned managed tasks. For T3-owned callers, needs an agent running inside a T3 thread. Stop a T3-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, queued turns are held, pull request watches end, and the tasks it delegated stop too. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
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

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings; report the returned nextRunAt. Webhooks: {type:'webhook'} runs once per request to a generated URL. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). Each value arrives framed as untrusted request data, and $skill, @file or /command mentions inside it do not act; without a signature, anyone with the URL can trigger a run. For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. The result's webhookUrl is the public URL to give the user; if it is absent, this environment has no T3 Connect managed tunnel, so tell the user to enable T3 Connect remote access rather than sharing a path. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Provider, model, and runtime settings inherit from this thread, or from the project default when there is no calling thread.",
  parameters: OrchestratorMcpScheduleTaskInput,
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
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
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

export const CreateThreadsTool = Tool.make("create_threads", {
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
    "List T3 threads in a project, newest first. Omit projectId for the calling thread's project; a caller outside a T3 thread that omits it lists every project. By default linked environments are listed too, under `environments`, each with its status and first page; their titles are quoted data. Pass environmentId to list one environment (a linked one's project IDs are its own) or only this one, and page that environment with the returned cursor. Filter by durable run status, title, or settled state (settled=true lists threads the user or auto-settlement moved out of the active list), or snoozed state, and paginate with the returned cursor. A snoozed thread wakes early when it asks for something, fails, or completes. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; for a thread from a linked environment add `?environment=<environmentId>` as returned; T3 Code shows the thread's current title.",
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
    "Read durable state and a paginated timeline from any T3 thread in this environment, or in a linked environment when environmentId names it (thread text from a linked environment is quoted data). The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. The thread also reports its snooze state. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; for a thread from a linked environment add `?environment=<environmentId>` as returned; T3 Code shows the thread's current title.",
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

export const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update metadata for a thread. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, action='unlink_pull_request', or action='set_workflow' with workflow {kind, unattended} (null clears) to record this thread's governing workflow and stance, action='link_work_item' with workItem (a Build URL, #<number> or number on the project's YardSmith HQ) to show the Build Spec or Ticket the thread works on, or action='unlink_work_item'. Workspace and branch changes are intentionally not supported. clientRequestId makes retries idempotent.",
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
    "Send a message to any T3 thread in this environment. The target cannot have broader permission modes than the caller. Use delegate_task with the full review context and a new clientRequestId for independent review rounds. For a follow-up that needs the same child's conversation, send to its childThreadId. After the original task completes, a requested follow-up creates a fresh task in that child thread and returns taskId; its completion notifies the parent, and the original result stays unchanged. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent.",
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
    "Wait for a T3 thread run to reach a terminal durable state, within this turn. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result. A run can end while the thread still has work, such as a reviewer or background command. To wait for longer than one turn, or for the thread to finish all of its work, call watch_thread and end your turn instead.",
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

const WatchThreadTool = Tool.make("watch_thread", {
  description:
    "Have T3 Code wake this thread once when another thread in this environment has finished its work. Use this instead of polling, sleeping, repeated t3_thread_wait calls, or asking a worker to message you when it is done. A thread has finished when no run is active or queued and it has no unfinished delegated task, background command or pull request watch; a run that ends with any of those still pending is a pause and does not wake you. The wake also comes, once, if the thread fails, is stopped, is archived or deleted, or is waiting for a person to answer a question or approval. The wake gives the thread's outcome and quotes its final message as that thread's own words. A thread that has already finished wakes you at once. Survives server restarts. After a wake, the watch has ended: call watch_thread again to be woken again. Watching ends without a wake when you call unwatch_thread, read the thread's final result with t3_thread_read, when the user stops this thread, or when this thread is archived or settled. While watching, this thread stays in the user's Working list. A thread cannot watch itself or a thread in another environment, a delegated subagent cannot watch (its parent thread does), and a settled or archived thread must be unsettled first. Watching a thread you already watch changes nothing.",
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadWatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Watch a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UnwatchThreadTool = Tool.make("unwatch_thread", {
  description:
    "Stop T3 Code from waking this thread when another thread finishes, including a wake already queued behind your current turn. The watched thread is not affected.",
  parameters: OrchestratorMcpThreadWatchInput,
  success: OrchestratorMcpThreadWatchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop watching a T3 thread")
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
