import { defaultChildMode } from "../agents/delegationRuntime.ts";
import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as ExternalWork from "../agents/ExternalAgentWorkService.ts";
import { assertExternalWorkOwner, canReadExternalWork } from "./threadAccess.ts";
import * as Hex from "effect/encoding/Hex";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import { derive as deriveIds } from "@t3tools/provider-core/server/IdAllocator";
import {
  type ExperimentWorkOwner,
  type ExperimentWorkEnrollInput,
  type ExperimentWorkUnit,
  type ExperimentWorkAllocationInput,
  type ExperimentWorkAllocation,
  type ExperimentWorkEvidenceInput,
  type ExperimentWorkEvidence,
  type ExperimentWorkReport,
  type AgentTaskOutcomeInput,
  type ExperimentOutcome,
  type ExperimentOutcomeInput,
  CommandId,
  type EnvironmentId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type AgentSessionAttachInput,
  type AgentExternalSession,
  type AgentRolesInput,
  type AgentRolesResult,
  OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestReleaseApprovalInput,
  type OrchestratorMcpRequestReleaseApprovalResult,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadWatchInput,
  type OrchestratorMcpThreadWatchResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  isOrchestrationV2WorkActive,
  AGENT_ROLE_COARSE_KIND,
  isReviewerRole,
  type OrchestrationV2WatchTarget,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { parseForgeReference } from "@t3tools/shared/forgeLinks";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  subagentResultForRun,
  delegatedTaskProgress,
  delegatedTaskProgressTurnItems,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import {
  decideThreadWatch,
  queuedThreadWatchWakes,
  watchTargetsEqual,
  threadWatchRefusal,
  watchedThreadRecords,
} from "../orchestration-v2/threadWatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import { followupBinding, followupPrompt } from "../agents/followup.ts";
import { managedTaskTitle } from "../agents/taskTitle.ts";
import {
  occupantsEverywhere as occupantsInAllProjects,
  threadOwner,
} from "../agents/workspaceIdentity.ts";
import { liveWorkspaceAttachments } from "@t3tools/shared/workspaceAttachments";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientRuntimeModeCeiling,
  isReadOnlyClient,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";

const encodeDelegateTaskFingerprint = Schema.encodeEffect(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
);

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly recordWorkOutcome: (
    scope: McpInvocationScope,
    input: ExperimentOutcomeInput,
  ) => Effect.Effect<ExperimentOutcome, OrchestratorMcpFailure>;
  readonly enrollWork: (
    scope: McpInvocationScope,
    input: ExperimentWorkEnrollInput,
  ) => Effect.Effect<ExperimentWorkUnit, OrchestratorMcpFailure>;
  readonly allocateWork: (
    scope: McpInvocationScope,
    input: ExperimentWorkAllocationInput,
  ) => Effect.Effect<ExperimentWorkAllocation, OrchestratorMcpFailure>;
  readonly recordWorkEvidence: (
    scope: McpInvocationScope,
    input: ExperimentWorkEvidenceInput,
  ) => Effect.Effect<ExperimentWorkEvidence, OrchestratorMcpFailure>;
  readonly readWork: (
    scope: McpInvocationScope,
    input: { readonly workUnitId: string },
  ) => Effect.Effect<ExperimentWorkReport, OrchestratorMcpFailure>;
  readonly recordAgentOutcome: (
    scope: McpInvocationScope,
    input: AgentTaskOutcomeInput,
  ) => Effect.Effect<ExperimentOutcome, OrchestratorMcpFailure>;
  readonly attachAgentSession: (
    scope: McpInvocationScope,
    input: AgentSessionAttachInput,
  ) => Effect.Effect<AgentExternalSession, OrchestratorMcpFailure>;
  readonly agentRoles: (
    scope: McpInvocationScope,
    input: AgentRolesInput,
  ) => Effect.Effect<AgentRolesResult, OrchestratorMcpFailure>;
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  /** Only the owner answers; the result says whether to wait or that it is already approved. */
  readonly requestReleaseApproval: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestReleaseApprovalInput,
  ) => Effect.Effect<OrchestratorMcpRequestReleaseApprovalResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
  readonly watchThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWatchInput,
    watching: boolean,
  ) => Effect.Effect<OrchestratorMcpThreadWatchResult, OrchestratorMcpFailure>;
}

/**
 * The caller's checkout in a project: its primary workspace (null at its home project's main
 * checkout) or a live attachment elsewhere; undefined when it holds none there.
 */
const callerCheckoutIn = (
  thread: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath" | "workspaceAttachments">,
  projectId: ProjectId,
): string | null | undefined =>
  projectId === thread.projectId
    ? thread.worktreePath
    : liveWorkspaceAttachments(thread).find((attachment) => attachment.projectId === projectId)
        ?.workspacePath;
export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

/**
 * A caller's thread is live while it is not archived, runs on the caller's
 * provider instance, and has an active run or a background subagent that
 * instance started. A background subagent outlives its run and calls tools
 * with its thread's credential, which is revoked when the provider process
 * goes away.
 */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

/**
 * Threads an agent starts over MCP are `mcp:<uuid>`, and agents often paste the
 * bare uuid. The id is never rewritten, so permission checks keyed on it still
 * hold; the miss only names a live thread the caller could read by its full id.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadShell">,
  threadId: ThreadId,
  message: string,
) {
  const prefixed = ThreadId.make(`mcp:${threadId}`);
  const shell = yield* threads.getThreadShell(prefixed).pipe(Effect.orElseSucceed(() => null));
  return yield* failure(
    "thread_not_found",
    shell === null || shell.deletedAt !== null
      ? message
      : `${message} Did you mean \`${prefixed}\`?`,
  );
});

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  // An unbound run starts where a new thread does, so it needs no branch to exist.
  return boundToThread ? { type: "root" } : { type: "root", rootIsDefault: true };
}

function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    agentRole: task.agentRole ?? null,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}

/**
 * Large catalogs (OpenCode, Cursor, Pi) can list hundreds of models, so agents
 * get a short list by default and search for the rest. These providers have
 * small official catalogs, so all their current models are listed.
 */
const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODEL_LIMIT = 8;

/**
 * Picks the models orchestrator_capabilities shows for one provider. Hidden
 * models never appear. With search terms, lists matches; otherwise lists pinned
 * models (custom, favorite, the caller's own) plus the provider's non-legacy
 * models, or only the first few in the user's model order for large catalogs.
 */
function listCapabilityModels(input: {
  readonly provider: ServerProvider;
  readonly preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly isPinned: (model: ServerProviderModel) => boolean;
  readonly searchTerms: ReadonlyArray<string>;
}) {
  const rank = new Map(input.preferences?.modelOrder.map((slug, index) => [slug, index]));
  const visible = input.provider.models
    .filter((model) => model.isCustom || !input.preferences?.hiddenModels.includes(model.slug))
    .toSorted((a, b) => (rank.get(a.slug) ?? rank.size) - (rank.get(b.slug) ?? rank.size));
  if (input.searchTerms.length > 0) {
    const matches = visible.filter((model) => {
      const text = `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
      return input.searchTerms.every((term) => text.includes(term));
    });
    const listed = matches.slice(0, LISTED_MODEL_LIMIT);
    return { listed, omitted: matches.length - listed.length };
  }
  const current = visible.filter((model) => !model.isLegacy);
  const shown = new Set(
    FULL_CATALOG_DRIVERS.has(input.provider.driver)
      ? current
      : current.slice(0, LISTED_MODEL_LIMIT),
  );
  const listed = visible.filter((model) => input.isPinned(model) || shown.has(model));
  return { listed, omitted: visible.length - listed.length };
}

/** Option ids and allowed values are all a delegating agent needs; labels are UI copy. */
function capabilityModelOption(descriptor: ProviderOptionDescriptor): OrchestratorMcpModelOption {
  const defaultValue = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    values:
      descriptor.type === "boolean" ? [false, true] : descriptor.options.map((choice) => choice.id),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  // Driver availability comes from the registry, even when health probes are skipped.
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * What a caller asked of a role: discovery and dispatch both build it here, so a model, an
 * instance or stated options are judged against the role's own selection the same way.
 */
function selectionOf(
  target:
    | {
        readonly providerInstanceId?: ProviderInstanceId | undefined;
        readonly model?: string | undefined;
        readonly options?: ModelSelection["options"] | undefined;
      }
    | undefined,
) {
  if (
    target === undefined ||
    (target.model === undefined &&
      target.options === undefined &&
      target.providerInstanceId === undefined)
  )
    return {};
  return {
    selection: {
      ...(target.providerInstanceId === undefined ? {} : { instanceId: target.providerInstanceId }),
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.options === undefined ? {} : { options: target.options }),
    },
  };
}

/**
 * Models without descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always fail: downstream
 * consumers disagree on whether the first or last value of a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run:
    | Pick<
        OrchestrationV2Run,
        "status" | "restartCancelledBackgroundWork" | "stoppedBackgroundWork"
      >
    | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    result.hasPendingQuestion ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;
  return pageIncludesRunResult({ ...input, run });
}

/** Whether the page shows `run`'s whole result, so the reader has seen it. */
function pageIncludesRunResult(input: {
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly target: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;
  readonly run: OrchestrationV2Run;
  readonly maxChars: number;
}): boolean {
  const result = subagentResultForRun(input.target, input.run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: Pick<ResolvedTarget, "modelSelection" | "supportedRuntimeModes">,
  defaultMode: OrchestratorMcpRuntimeMode = "inherit",
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const configured = defaultChildMode(parentMode, defaultMode);
  const resolved = inherited ? configured : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      failure(
        "runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      ),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      failure(
        "invalid_request",
        `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      ),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

/** The same links `list_thread_pull_requests` reports, without the snapshot details. */
function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
  environmentId: EnvironmentId,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    environmentId,
    projectId: shell.projectId,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "release_approval_request":
      return `Asked the owner to approve releasing ${item.repository} at ${item.candidate}: ${item.approvalStatus}${
        item.answer?.note ? ` (note: ${item.answer.note})` : ""
      }.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const forgeWorkItems = yield* ForgeWorkItems.ForgeWorkItems;
  const experiments = yield* Experiments.ExperimentService;
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const listProjects = projects
    .listShells()
    .pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read projects: ${error.message}`),
      ),
    );

  const occupantsEverywhere = occupantsInAllProjects(projects, threadManagement).pipe(
    Effect.mapError((error) =>
      failure("orchestration_error", `Unable to read workspace occupants: ${error.message}`),
    ),
  );

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;
  const releaseApprovals = yield* ReleaseApprovals.ReleaseApprovals;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(
        threadId,
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: {
          runtimeMode: clientRuntimeModeCeiling(scope.client),
          interactionMode: "default",
        } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
      } as const;
    }
    const parent = yield* loadProjection(scope.thread.threadId);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadProjection(threadScope.thread.threadId);
    return { scope: threadScope, parent } as const;
  });

  const workReader = (scope: McpInvocationScope) => ({
    environmentId: scope.environmentId,
    clientSessionId: scope.client?.sessionId,
    threadId: scope.thread?.threadId,
  });
  const workError = () =>
    failure("invalid_request", "Unable to access or record owned experimental work.");
  const requireWorkParent = Effect.fn(function* (scope: McpInvocationScope) {
    if (scope.client?.access === "read-only")
      return yield* failure(
        "capability_denied",
        "Read-only callers cannot enroll, allocate or record work.",
      );
    const caller = yield* loadCaller(scope);
    if (caller.parent !== undefined) {
      if (caller.parent.thread.agentTask !== undefined)
        return yield* failure("capability_denied", "Managed leaves cannot allocate parent work.");
      const run = ThreadManagementService.latestActiveRun(caller.parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== scope.thread?.providerInstanceId
      )
        return yield* failure(
          "parent_not_active",
          "Work allocation requires the calling provider's active parent run.",
        );
    }
    return caller;
  });
  const internalWorkOwner = Effect.fn(function* (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) {
    const project = yield* requireProject(parent.thread.projectId);
    return {
      environmentId: scope.environmentId,
      projectId: parent.thread.projectId,
      workspacePath: parent.thread.worktreePath ?? project.workspaceRoot,
      parentThreadId: parent.thread.id,
      externalSessionKey: null,
      clientSessionId: null,
    } satisfies ExperimentWorkOwner;
  });

  /** A target project: the one passed, else the calling thread's. */
  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a T3 thread.",
            ),
          );

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    return yield* loadProjectThread(shell.projectId, threadId);
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(threadId);
    yield* assertExternalWorkOwner(scope, target.thread);
    return { ...caller, target } as const;
  });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* loadCaller(scope);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "runs",
        "runtimeRequests",
        "contextTransfers",
      ])
      .pipe(Effect.mapError(threadManagementFailure));
    yield* assertExternalWorkOwner(scope, target.thread);
    return { parent, target, shell } as const;
  });

  const external = Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ExternalWork.ExternalAgentWorkService);
    if (Option.isNone(service))
      return yield* failure(
        "capability_denied",
        "External agent work is not configured in this environment.",
      );
    return service.value;
  });
  const externalFailure = (error: ExternalWork.ExternalAgentWorkError) =>
    failure(
      error.reason === "conflict"
        ? "invalid_request"
        : error.reason === "task"
          ? "task_not_found"
          : "capability_denied",
      error.message,
    );

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Set only when the command that will dispatch this target already has a receipt: that
     * dispatch can only replay the recorded result, never start anything new, so filtering
     * candidates by the project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different command id than the
     * one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
    /**
     * The target is a managed role's complete selection. The caller's own options never join it,
     * even on the caller's instance and model: the role's options are the whole set.
     */
    readonly roleSelection?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    const requestedInstanceId = input.target?.providerInstanceId;
    const requestedDriver = input.target?.driverKind;
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= input.parent.thread.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    const inheritedSelection = input.parent.thread.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider?.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      requestedModel !== undefined &&
      provider !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      );
    }

    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      input.roleSelection !== true &&
      instanceId === inheritedSelection.instanceId &&
      model === inheritedSelection.model;
    let options = inheritsOptions ? inheritedSelection.options : undefined;
    if (requestedOptions !== undefined) {
      const selections = new Map(
        (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      for (const selection of requestedOptions) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const parentProjection = yield* loadProjection(scope.thread.threadId);
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined || task.childThreadId === null) {
      return yield* failure(
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "runtimeRequests",
          "nodes",
          "turnItems",
        ],
        { messageRoles: ["user"], omitSettledLeafNodes: true, ...delegatedTaskProgressTurnItems },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "result_available"
          : "working"
        : progress.state;
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const status =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(taskResultRun ?? childRun)
          : taskStatusForRun(taskResultRun ?? childRun) === "queued"
            ? "queued"
            : "running";
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? subagentResultForRun(childProjection, taskResultRun).text
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const binding = childControls.thread.agentTask;
    const managed =
      binding === undefined || !isTerminalTaskStatus(status) || workState !== "result_available"
        ? Option.none()
        : yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
    const handoffRun = taskResultRun ?? childRun;
    const handoff =
      binding === undefined || Option.isNone(managed) || handoffRun === undefined
        ? undefined
        : yield* managed.value
            .handoff(binding, {
              threadId: task.childThreadId,
              runId: handoffRun.id,
            })
            .pipe(
              Effect.orElseSucceed(() => ({
                workspacePath: binding.workspacePath,
                revision: null,
                quiescent: false,
              })),
            );
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : subagentResultForRun(childProjection, terminalRun).text
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const modelSelection = childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const response = {
      ...(binding === undefined ? {} : { agentTask: binding }),
      ...(handoff === undefined ? {} : { handoff }),
      taskId: task.id,
      childThreadId: task.childThreadId,
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      options: modelSelection.options ?? [],
      summary: derivedResult,
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        childControls.runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, task.id, childRun),
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
    if (
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      const acknowledgementRequestKey = yield* requestKey(undefined);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: acknowledgementRequestKey,
            operation: acknowledgementOperation,
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return response;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
          threadManagement.streamStoredEventsFrom({
            threadId: thread === "parent" ? scope.thread.threadId : initial.childThreadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    },
    (effect, _scope, _taskId, timeoutMs) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten)),
  );

  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */
  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.parent === undefined
          ? scope.client === undefined || !isReadOnlyClient(scope.client)
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  return OrchestratorMcpService.of({
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
        modelSelection,
        ...(input.agentRole === undefined ? {} : { agentRole: input.agentRole }),
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const { task } = yield* scheduledTasks
        .upsert(upsertInput)
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not schedule task: ${error.message}`),
          ),
        );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: yield* Effect.forEach(
            tasks.filter((task) => projectId === undefined || task.projectId === projectId),
            (task) => summarizeScheduledTask(scope, { parent, limits }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a T3 thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Rebinding changes where runs execute, so the workspace strategy must
        // follow: unbinding a root-strategy task would otherwise run loose
        // prompts in the shared project checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          ...(input.agentRole === undefined ? {} : { agentRole: input.agentRole }),
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: Effect.fn("OrchestratorMcpService.requestSecret")(function* (scope, input) {
      const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
      const threadId = threadScope.thread.threadId;
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Asking for a secret requires an active run owned by this MCP provider session.",
        );
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const key = yield* requestKey(input.clientRequestId);
      const turnItemId = TurnItemId.make(
        `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
      );
      const record = (secretStatus: "pending" | "cancelled") =>
        threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: `secret-${secretStatus}`,
            }),
            threadId: threadId,
            runId,
            nodeId,
            turnItemId,
            label: input.label,
            reason: input.reason,
            ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
            secretStatus,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Could not record the secret request: ${errorMessage(error)}`,
              ),
            ),
          );
      yield* record("pending");
      // Only this call can hand the agent its ref, so the card must not
      // outlive it: a timeout, a failed wait or an aborted call closes it as
      // cancelled.
      const closeCard = record("cancelled").pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not close a secret request card", { error: error.message }),
        ),
      );

      const answered = yield* Effect.gen(function* () {
        while (true) {
          const projection = yield* threadManagement
            .getThreadRecords(threadId, ["runs", "turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to read the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
          const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
          if (item?.type === "secret_request" && item.secretStatus !== "pending") {
            return item.secretStatus;
          }
          const current = projection.runs.find((candidate) => candidate.id === runId);
          if (
            current === undefined ||
            ThreadManagementService.isTerminalRunStatus(current.status)
          ) {
            yield* record("cancelled");
            return "cancelled" as const;
          }
          yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
          ),
        ),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
      );
      if (Option.isNone(answered)) yield* closeCard;
      const status = Option.isSome(answered)
        ? answered.value
        : yield* threadManagement
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.map((records) => {
                const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
                return item?.type === "secret_request" &&
                  (item.secretStatus === "saved" || item.secretStatus === "declined")
                  ? item.secretStatus
                  : ("timed_out" as const);
              }),
              Effect.orElseSucceed(() => "timed_out" as const),
            );
      yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
      if (status !== "saved") return { status };
      const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
      if (Option.isNone(secretRef)) {
        return yield* failure(
          "orchestration_error",
          "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
        );
      }
      return { status, secretRef: secretRef.value };
    }),

    requestReleaseApproval: Effect.fn("OrchestratorMcpService.requestReleaseApproval")(
      function* (scope, input) {
        const { scope: threadScope, parent } = yield* loadThreadCaller(
          scope,
          "request_release_approval",
        );
        const run = ThreadManagementService.latestActiveRun(parent);
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== threadScope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Asking for a release approval requires an active run owned by this MCP provider session.",
          );
        }
        return yield* releaseApprovals
          .request(
            { threadId: threadScope.thread.threadId, runId: run.id, nodeId: run.rootNodeId },
            input,
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Could not request the release approval: ${error.message}`,
              ),
            ),
          );
      },
    ),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope, input = {}) {
      const { parent, limits } = yield* loadCaller(scope);
      const providers = yield* loadProviders;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/) ?? [];
      return {
        environmentId: scope.environmentId,
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions: inherited?.options ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          const constraints = providerConstraints(
            provider,
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          const { listed, omitted } = listCapabilityModels({
            provider,
            preferences: settings.providerModelPreferences?.[provider.instanceId],
            searchTerms,
            isPinned: (model) =>
              model.isCustom ||
              (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
              (settings.favorites ?? []).some(
                (favorite) =>
                  favorite.provider === provider.instanceId && favorite.model === model.slug,
              ),
          });
          return {
            providerInstanceId: provider.instanceId,
            driverKind: provider.driver,
            displayName: provider.displayName ?? null,
            models: listed.map((model) => {
              const options = model.capabilities?.optionDescriptors ?? [];
              return {
                id: model.slug,
                ...(model.name.toLowerCase() === model.slug.toLowerCase()
                  ? {}
                  : { label: model.name }),
                ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
              };
            }),
            ...(omitted === 0 ? {} : { omittedModels: omitted }),
            ...(provider.supportedRuntimeModes === undefined ||
            provider.supportedRuntimeModes.length === 0
              ? {}
              : { runtimeModes: [...provider.supportedRuntimeModes] }),
            canRunChildTask: constraints.length === 0,
            canRunCrossProviderChildTask: constraints.length === 0,
            constraints: [...constraints],
          };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
    enrollWork: Effect.fn("OrchestratorMcpService.enrollWork")(function* (scope, input) {
      yield* requireCapability(scope);
      const { parent } = yield* requireWorkParent(scope);
      const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
      if (Option.isNone(managed))
        return yield* failure("capability_denied", "Managed role policy is unavailable.");
      const policy = yield* managed.value.snapshot().pipe(Effect.mapError(workError));
      let owner: ExperimentWorkOwner;
      let selection: ModelSelection;
      if (parent !== undefined) {
        if (
          input.externalSessionKey !== undefined ||
          input.reportedOrchestratorSelection !== undefined
        )
          return yield* failure(
            "invalid_request",
            "T3 parent identity and selection are derived from the active run.",
          );
        owner = yield* internalWorkOwner(scope, parent);
        selection = ThreadManagementService.latestActiveRun(parent)!.modelSelection;
      } else {
        if (
          input.externalSessionKey === undefined ||
          input.reportedOrchestratorSelection === undefined
        )
          return yield* failure(
            "invalid_request",
            "External enrollment requires an attached session and reported parent selection.",
          );
        const session = yield* external.pipe(
          Effect.flatMap((service) =>
            service
              .session(scope, input.externalSessionKey!)
              .pipe(Effect.mapError(externalFailure)),
          ),
        );
        owner = {
          environmentId: scope.environmentId,
          projectId: session.projectId,
          workspacePath: session.workspacePath,
          parentThreadId: null,
          externalSessionKey: session.key,
          clientSessionId: session.clientSessionId,
        };
        selection = input.reportedOrchestratorSelection;
      }
      return yield* experiments
        .enrollWork({
          request: input,
          owner,
          orchestratorSelection: selection,
          modelSource: parent === undefined ? "self-report" : "run-selection",
          policyHash: policy.hash,
          policyRevision: policy.sourceRevision,
          alreadyStarted: input.alreadyStarted ?? false,
        })
        .pipe(Effect.mapError(workError));
    }),
    allocateWork: Effect.fn("OrchestratorMcpService.allocateWork")(function* (scope, input) {
      yield* requireCapability(scope);
      yield* requireWorkParent(scope);
      return yield* experiments
        .allocateWork(input, workReader(scope))
        .pipe(Effect.mapError(workError));
    }),
    recordWorkEvidence: Effect.fn("OrchestratorMcpService.recordWorkEvidence")(
      function* (scope, input) {
        yield* requireCapability(scope);
        yield* requireWorkParent(scope);
        return yield* experiments
          .recordWorkEvidence(input, workReader(scope))
          .pipe(Effect.mapError(workError));
      },
    ),
    recordWorkOutcome: Effect.fn("OrchestratorMcpService.recordWorkOutcome")(
      function* (scope, input) {
        yield* requireCapability(scope);
        yield* requireWorkParent(scope);
        return yield* experiments
          .recordWorkOutcome(input, workReader(scope))
          .pipe(Effect.mapError(workError));
      },
    ),
    readWork: Effect.fn("OrchestratorMcpService.readWork")(function* (scope, input) {
      yield* requireCapability(scope);
      yield* loadCaller(scope);
      return yield* experiments.readWork(input, workReader(scope)).pipe(Effect.mapError(workError));
    }),
    attachAgentSession: (scope, input) =>
      external.pipe(
        Effect.flatMap((service) =>
          service.attach(scope, input).pipe(Effect.mapError(externalFailure)),
        ),
      ),
    recordAgentOutcome: (scope, input) =>
      external.pipe(
        Effect.flatMap((service) =>
          service.recordOutcome(scope, input).pipe(Effect.mapError(externalFailure)),
        ),
      ),
    agentRoles: Effect.fn("OrchestratorMcpService.agentRoles")(function* (scope, input) {
      yield* requireCapability(scope);
      const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
      if (Option.isNone(managed))
        return yield* failure("capability_denied", "Managed role policy is unavailable.");
      const { parent, limits } = yield* loadCaller(scope);
      const session =
        input.externalSessionKey === undefined
          ? undefined
          : yield* external.pipe(
              Effect.flatMap((service) =>
                service
                  .session(scope, input.externalSessionKey!)
                  .pipe(Effect.mapError(externalFailure)),
              ),
            );
      const projectId = session?.projectId ?? parent?.thread.projectId;
      if (projectId === undefined)
        return yield* failure(
          "invalid_request",
          "Attach an external agent session before discovering roles.",
        );
      const catalog = yield* loadProviders;
      const eligible = yield* Effect.filter(catalog, (p) =>
        threadManagement.isProviderInstanceEnabledForProject({
          projectId,
          instanceId: p.instanceId,
        }),
      );
      const result = yield* managed.value
        .roles({
          projectId,
          providers: eligible,
          ceiling: limits.runtimeMode,
          request: input,
          ...selectionOf({
            providerInstanceId: input.providerInstanceId,
            model: input.model,
          }),
          ...(parent === undefined
            ? {}
            : {
                callerModel: parent.thread.modelSelection.model,
                caller: parent.thread.modelSelection,
              }),
        })
        .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
      return { ...result, environmentId: scope.environmentId };
    }),
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      if (
        input.followup !== undefined &&
        (input.agentTask !== undefined ||
          input.target !== undefined ||
          input.isolation !== undefined ||
          input.offPolicyReason !== undefined ||
          input.runtimeMode !== undefined ||
          input.interactionMode !== undefined ||
          input.role !== undefined ||
          input.title !== undefined ||
          input.clientRequestId === undefined)
      )
        return yield* failure(
          "invalid_request",
          "Follow-ups require a stable clientRequestId and retain their original role, model, workspace and modes.",
        );
      // Managed work binds and validates its checkout before launch, so it names one
      // through workspaceAssignment rather than a worktree T3 creates afterwards.
      if (input.agentTask !== undefined && input.isolation === "worktree")
        return yield* failure(
          "invalid_request",
          'isolation "worktree" applies only to a delegation without agentTask; managed work uses agentTask.workspaceAssignment "isolated".',
        );
      if (callerScope.client !== undefined && callerScope.thread === undefined) {
        const service = yield* external;
        const accepted = yield* service
          .submit(callerScope, input)
          .pipe(Effect.mapError(externalFailure));
        if (input.mode !== "wait" || accepted.workState === "result_available") return accepted;
        const budget = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        );
        const waited = yield* threadManagement
          .waitForThread({
            threadId: accepted.childThreadId,
            projectId:
              accepted.agentTask?.externalOwner?.projectId ??
              (yield* failure("invalid_request", "Missing owned task project.")),
            timeoutMs: budget,
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const current = yield* service
          .status(callerScope, accepted.taskId)
          .pipe(Effect.mapError(externalFailure));
        return { ...current, waitTimedOut: waited.timedOut };
      }
      if (input.externalSessionKey !== undefined)
        return yield* failure(
          "invalid_request",
          "External session bindings require an authenticated external caller.",
        );
      const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
      if (parent.thread.agentTask !== undefined)
        return yield* failure(
          "capability_denied",
          "Managed child tasks cannot delegate recursively.",
        );
      const parentRun = parent.runs
        .filter(ThreadManagementService.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
      if (input.followup !== undefined) {
        const followup = input.followup;
        const current = yield* readTask(scope, followup.taskId);
        const child = yield* threadManagement
          .getThreadRecords(current.childThreadId, ["runs", "messages"])
          .pipe(Effect.mapError(threadManagementFailure));
        if (child.thread.advisorClosedAt !== undefined)
          return yield* failure("invalid_request", "This advisor is closed. Start a new advisor.");
        const binding = child.thread.agentTask;
        if (binding === undefined)
          return yield* failure(
            "invalid_request",
            "Only a managed task can continue its conversation.",
          );
        const followupTarget = followupBinding(
          binding,
          followup,
          child.thread.followupSourceRevision,
        );
        if (followupTarget === undefined)
          return yield* failure(
            "invalid_request",
            "This agent is pinned to a source revision: state the revision its workspace is at now.",
          );
        const key = yield* requestKey(input.clientRequestId);
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "followup",
        });
        const messageId = stableOperationMessageId({
          scope,
          requestKey: key,
          operation: "followup",
        });
        const text = followupPrompt(followup, input.task);
        const priorTask = parent.subagents.find(
          (task) => task.id === deriveIds.delegatedTaskNode({ commandId }),
        );
        if (
          priorTask !== undefined &&
          (priorTask.childThreadId !== current.childThreadId || priorTask.prompt !== text)
        )
          return yield* failure(
            "invalid_request",
            "This follow-up identity already belongs to a different task.",
          );
        const prior = child.messages.find((message) => message.id === messageId);
        if (prior !== undefined) {
          if (prior.text !== text)
            return yield* failure(
              "invalid_request",
              "This follow-up identity already belongs to a different question.",
            );
          return yield* readTask(scope, deriveIds.delegatedTaskNode({ commandId }), false, true);
        }
        if (
          current.workState !== "result_available" ||
          // Status may derive a terminal child result before parent publication.
          // Orchestration creates a consultation task only after that publication.
          !parent.subagents.some((task) => task.id === followup.taskId && task.result !== null) ||
          current.hasPendingChildRuns ||
          parent.subagents.some(
            (task) =>
              task.childThreadId === current.childThreadId &&
              (task.status === "cancelled" ||
                task.status === "interrupted" ||
                task.completionDelivery?.state === "disposed"),
          ) ||
          child.thread.archivedAt !== null
        )
          return yield* failure(
            "invalid_request",
            "The agent is busy, awaiting result publication, or closed. Retry after publication; delegate a fresh task for new work.",
          );
        const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        if (Option.isNone(managed))
          return yield* failure("capability_denied", "Managed agent policy is unavailable.");
        const consultation = Effect.gen(function* () {
          const refreshed = yield* readTask(scope, followup.taskId);
          const owned = yield* loadProjection(parent.thread.id);
          yield* assertLiveCaller(scope, owned);
          if (
            refreshed.hasPendingChildRuns ||
            !owned.subagents.some((task) => task.id === followup.taskId && task.result !== null) ||
            owned.subagents.some(
              (task) =>
                task.childThreadId === current.childThreadId &&
                task.completionDelivery?.state === "disposed",
            )
          )
            return yield* failure(
              "invalid_request",
              "The agent is busy, awaiting result publication, or closed. If the advisor is closed, start a new advisor.",
            );
          // A task sent to another project stays there, where the caller holds a workspace
          // only while it has one attached.
          const taskProjectId = followupTarget.projectId ?? parent.thread.projectId;
          const leadCheckout = callerCheckoutIn(parent.thread, taskProjectId);
          const foreign = leadCheckout === undefined;
          const providers = yield* Effect.filter(yield* loadProviders, (provider) =>
            threadManagement.isProviderInstanceEnabledForProject({
              projectId: taskProjectId,
              instanceId: provider.instanceId,
            }),
          );
          yield* managed.value
            .validate({
              binding: followupTarget,
              runtimeMode: child.thread.runtimeMode,
              selection: binding.effective,
              projectId: taskProjectId,
              providers,
              ceiling: parent.thread.runtimeMode,
              workspacePath: leadCheckout ?? null,
              owner: threadOwner(parent.thread),
              projectRoot: (yield* requireProject(taskProjectId)).workspaceRoot,
              ...(foreign ? { foreignProject: true } : {}),
              occupants: yield* occupantsEverywhere,
            })
            .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
          if (binding.workUnitId !== undefined)
            yield* experiments
              .workDispatchPolicy({
                workUnitId: binding.workUnitId,
                owner: yield* internalWorkOwner(scope, parent),
                role: binding.role,
                followup: true,
              })
              .pipe(Effect.mapError(workError));
          yield* resolveRuntimeMode(parent.thread.runtimeMode, child.thread.runtimeMode);
          yield* resolveInteractionMode(
            parent.thread.interactionMode,
            child.thread.interactionMode,
          );
          yield* threadManagement
            .sendToThread({
              projectId: child.thread.projectId,
              threadId: child.thread.id,
              commandId,
              messageId,
              senderThreadId: parent.thread.id,
              ...(followup.sourceRevision === undefined
                ? {}
                : { followupSourceRevision: followup.sourceRevision }),
              text,
              attachments: [],
              mode: "queue",
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(
              Effect.mapError((error) =>
                isThreadManagementError(error)
                  ? threadManagementFailure(error)
                  : failure("orchestration_error", "Unable to continue the agent."),
              ),
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: parent.thread.runtimeMode,
                interactionMode: parent.thread.interactionMode,
              }),
            );
          return yield* readTask(scope, deriveIds.delegatedTaskNode({ commandId }), false, true);
        });
        const accepted = yield* managed.value.exclusive(consultation);
        if (input.mode !== "wait") return accepted;
        const waited = yield* waitForTask(
          scope,
          accepted.taskId,
          Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)),
        );
        return Option.isSome(waited)
          ? waited.value
          : yield* readTask(scope, accepted.taskId, true, true);
      }
      const providers = yield* loadProviders;
      const key = yield* requestKey(input.clientRequestId);
      const commandId = stableCommandId({
        scope,
        requestKey: key,
        operation: "delegate-task",
      });
      const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
      if (input.agentTask !== undefined && input.clientRequestId === undefined)
        return yield* failure("invalid_request", "Managed work requires a stable clientRequestId.");
      if (input.agentTask !== undefined && input.offPolicyReason !== undefined)
        return yield* failure(
          "invalid_request",
          "offPolicyReason applies only to a delegation without agentTask.",
        );
      // Managed identity is required by child capabilities, including native Weave access.
      if (input.agentTask === undefined && !isRetryOfAcceptedDelegation) {
        const policyService = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        // A named but unreadable policy still refuses: an outage must not open free choice.
        const configured =
          Option.isSome(policyService) && (yield* policyService.value.configured());
        if (configured)
          return yield* failure(
            "invalid_request",
            "A role policy is configured: call agent_roles, then delegate_task with agentTask (role, taskClass, workId, attemptId, workspacePath). If no eligible role fits, report the task as blocked.",
          );
      }
      const fingerprintText = yield* encodeDelegateTaskFingerprint({
        ...input,
        mode: undefined,
        timeoutMs: undefined,
      }).pipe(Effect.orDie);
      const requestFingerprint = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(fingerprintText))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      // Managed work compares its binding's fingerprint below; an unmanaged retry compares the
      // fingerprint recorded on the task its first call created.
      if (input.agentTask === undefined && isRetryOfAcceptedDelegation) {
        const prior = parent.subagents.find(
          (task) => task.id === deriveIds.delegatedTaskNode({ commandId }),
        );
        if (prior !== undefined && prior.requestFingerprint !== requestFingerprint)
          return yield* failure(
            "invalid_request",
            "The request identity already belongs to a different task.",
          );
      }
      const managed =
        input.agentTask === undefined
          ? undefined
          : yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
      if (managed !== undefined && Option.isNone(managed))
        return yield* failure(
          "capability_denied",
          "Managed delegation is not configured in this environment.",
        );
      const managedService =
        managed !== undefined && Option.isSome(managed) ? managed.value : undefined;
      const existing =
        input.agentTask !== undefined && isRetryOfAcceptedDelegation
          ? yield* threadManagement
              .getThreadRecords(deriveIds.delegatedTaskThread({ commandId }), [])
              .pipe(Effect.mapError(threadManagementFailure))
          : undefined;
      if (existing !== undefined) {
        const prior = existing.thread.agentTask;
        if (
          prior === undefined ||
          prior.requestFingerprint !== requestFingerprint ||
          prior.workId !== input.agentTask?.workId ||
          prior.attemptId !== input.agentTask?.attemptId ||
          prior.role !== input.agentTask?.role ||
          prior.taskClass !== input.agentTask?.taskClass ||
          prior.workspacePath !== input.agentTask?.workspacePath ||
          prior.workspaceAssignment !== input.agentTask?.workspaceAssignment
        )
          return yield* failure(
            "invalid_request",
            "The request identity already belongs to different managed work.",
          );
        return yield* readTask(scope, deriveIds.delegatedTaskNode({ commandId }), false, true);
      }
      // A managed task may work in any registered project's repository, not only the caller's;
      // a workspace the caller has attached names its own project.
      const attachedTarget =
        input.agentTask?.projectId == null
          ? liveWorkspaceAttachments(parent.thread).find(
              (attachment) => attachment.workspacePath === input.agentTask?.workspacePath,
            )?.projectId
          : undefined;
      const taskProjectId =
        managedService === undefined || input.agentTask === undefined
          ? parent.thread.projectId
          : attachedTarget !== undefined
            ? attachedTarget
            : yield* managedService
                .targetProject({
                  request: input.agentTask,
                  callerProjectId: parent.thread.projectId,
                  callerCheckout: parent.thread.worktreePath,
                  projects: listProjects,
                })
                .pipe(
                  Effect.mapError((error) =>
                    Schema.is(ManagedAgent.ManagedAgentError)(error)
                      ? failure("capability_denied", error.message)
                      : error,
                  ),
                );
      // The caller's checkout in the task's project: its primary workspace at home, or a live
      // attachment elsewhere. Without one, the task never shares a workspace there.
      const leadCheckout = callerCheckoutIn(parent.thread, taskProjectId);
      const foreign = leadCheckout === undefined;
      const eligibleProviders =
        input.agentTask === undefined
          ? providers
          : yield* Effect.filter(providers, (provider) =>
              threadManagement.isProviderInstanceEnabledForProject({
                projectId: taskProjectId,
                instanceId: provider.instanceId,
              }),
            );
      const priorAssignments =
        input.agentTask === undefined
          ? []
          : yield* experiments
              .assignments({ threadId: deriveIds.delegatedTaskThread({ commandId }) })
              .pipe(
                Effect.mapError(() =>
                  failure("orchestration_error", "Unable to read managed work assignments."),
                ),
              );
      let recordedBinding = priorAssignments.find(
        (assignment) => assignment.agentTask !== undefined,
      )?.agentTask;
      const workOwner =
        input.agentTask?.workUnitId === undefined
          ? undefined
          : yield* internalWorkOwner(scope, parent);
      const workUnit =
        input.agentTask?.workUnitId === undefined
          ? undefined
          : yield* experiments
              .workDispatchPolicy({
                workUnitId: input.agentTask.workUnitId,
                owner: workOwner!,
                role: input.agentTask.role,
              })
              .pipe(Effect.mapError(workError));
      if (workUnit !== undefined && recordedBinding === undefined)
        recordedBinding = (yield* experiments
          .readWork({ workUnitId: workUnit.id })
          .pipe(Effect.mapError(workError))).tasks.find(
          (t) => t.taskId === deriveIds.delegatedTaskNode({ commandId }),
        )?.binding;
      const isolated = input.agentTask?.workspaceAssignment === "isolated";
      // A pinned reader may use another workspace of the repository, so it is checked
      // against the writers there just as an isolated helper is.
      const elsewhere =
        foreign ||
        isolated ||
        (input.agentTask?.sourceRevision !== undefined &&
          input.agentTask.workspacePath !== leadCheckout);
      // Read again inside the launch lock, so two helpers cannot both claim one workspace.
      const readWorkspaceAuthority = Effect.gen(function* () {
        const bound = leadCheckout != null;
        if (!elsewhere && bound) return {};
        // A thread of any project may hold a workspace here as an attachment.
        const occupants = () => occupantsEverywhere;
        if (foreign)
          return {
            owner: threadOwner(parent.thread),
            workspacePath: null,
            projectRoot: (yield* requireProject(taskProjectId)).workspaceRoot,
            foreignProject: true,
            occupants: yield* occupantsEverywhere,
          };
        // A bound lead's own binding is its workspace; only isolated helpers and unbound
        // leads compare against the project's main checkout.
        if (bound && !isolated)
          return { owner: threadOwner(parent.thread), occupants: yield* occupants() };
        const projectRoot = (yield* requireProject(taskProjectId)).workspaceRoot;
        if (!elsewhere) return { projectRoot };
        return { owner: threadOwner(parent.thread), projectRoot, occupants: yield* occupants() };
      });
      const workspaceAuthority = yield* readWorkspaceAuthority;
      const agentTask =
        input.agentTask === undefined || taskProjectId === parent.thread.projectId
          ? input.agentTask
          : { ...input.agentTask, projectId: taskProjectId };
      const prepared =
        managedService === undefined || agentTask === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                input.runtimeMode,
                undefined,
                (yield* serverSettings.getSettings.pipe(
                  Effect.mapError(() =>
                    failure("orchestration_error", "Unable to read delegation settings."),
                  ),
                )).delegation.defaultChildRuntimeMode,
              );
              // The first choice's cached reading may hide that it is out of allowance, so
              // it is re-read before the task starts there.
              return yield* ProviderRegistry.chooseWithFreshUsage(
                providerRegistry,
                eligibleProviders.filter(
                  (provider) =>
                    (input.target?.providerInstanceId === undefined ||
                      provider.instanceId === input.target.providerInstanceId) &&
                    (input.target?.driverKind === undefined ||
                      provider.driver === input.target.driverKind),
                ),
                (providers) =>
                  managedService
                    .prepare({
                      runtimeMode,
                      projectId: taskProjectId,
                      request: agentTask,
                      requestFingerprint,
                      ...(workUnit === undefined ? {} : { policyHash: workUnit.policyHash }),
                      ...(recordedBinding === undefined ? {} : { recordedBinding }),
                      providers,
                      ceiling: parent.thread.runtimeMode,
                      workspacePath: leadCheckout ?? null,
                      ...workspaceAuthority,
                      callerModel: parent.thread.modelSelection.model,
                      caller: parent.thread.modelSelection,
                      ...selectionOf(input.target),
                    })
                    .pipe(Effect.mapError((error) => failure("capability_denied", error.message))),
                (result) => result.binding.effective.instanceId,
              );
            });
      let target = yield* resolveTargetRechecking({
        parent,
        target:
          prepared === undefined
            ? input.target
            : {
                providerInstanceId: prepared.binding.requested.instanceId,
                model: prepared.binding.requested.model,
                options: prepared.binding.requested.options,
              },
        providers,
        skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
        roleSelection: prepared !== undefined,
      });
      const taskAssignments = yield* (
        isRetryOfAcceptedDelegation
          ? experiments.assignments({ threadId: deriveIds.delegatedTaskThread({ commandId }) })
          : experiments.assignForTask({
              ...(prepared === undefined ? {} : { agentTask: prepared.binding }),
              threadId: deriveIds.delegatedTaskThread({ commandId }),
              projectId: taskProjectId,
              modelSelection: target.modelSelection,
              unitId: deriveIds.delegatedTaskNode({ commandId }),
              unitCreatedAt: DateTime.formatIso(yield* DateTime.now),
              taskLever: (
                input.agentTask === undefined
                  ? input.role === "review"
                  : isReviewerRole(input.agentTask.role)
              )
                ? "reviewer"
                : "delegation",
              taskCategory:
                input.role ??
                (input.agentTask === undefined
                  ? "general"
                  : AGENT_ROLE_COARSE_KIND[input.agentTask.role]),
              enrollment: "new",
            })
      ).pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to assign the delegated experiment."),
        ),
      );
      const assignments = [
        ...taskAssignments,
        ...(workUnit === undefined
          ? []
          : (yield* experiments.assignments({}).pipe(Effect.mapError(workError))).filter((a) =>
              workUnit.assignmentIds.includes(a.id),
            )),
      ];
      // A refused child fails its own task assignment; the work unit's policy assignment
      // measures the whole unit, which an optional refused child does not fail.
      const recordExperimentFailure = (
        note = "The delegated request failed before a child run was accepted.",
      ) =>
        Effect.forEach(
          taskAssignments,
          (assignment) =>
            experiments.recordOutcome({
              id: `${assignment.id}:dispatch-failure:${commandId}`,
              assignmentId: assignment.id,
              runId: null,
              kind: "failure",
              source: "independent-evidence",
              evidence: [`command:${commandId}`],
              note,
              actualModelSelection: null,
              fallbackReason: null,
            }),
          { discard: true },
        ).pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "Unable to record the experiment dispatch failure."),
          ),
        );
      const experimentSelection = assignments.find(
        (assignment) => assignment.variant.modelSelection !== undefined,
      )?.variant.modelSelection;
      if (experimentSelection !== undefined) {
        // Resolve again through the ordinary provider capability and permission checks.
        target = yield* resolveTargetRechecking({
          parent,
          providers,
          target: {
            providerInstanceId: experimentSelection.instanceId,
            model: experimentSelection.model,
            options: experimentSelection.options,
          },
          skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
          roleSelection: prepared !== undefined,
        }).pipe(Effect.tapError(() => recordExperimentFailure()));
      }
      // Child modes are checked before the task is reserved, then policy after, so a refusal
      // for either reason is visible without reserving work that could never launch.
      const runtimeMode = yield* resolveRuntimeMode(
        parent.thread.runtimeMode,
        input.runtimeMode,
        target,
        (yield* serverSettings.getSettings.pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "Unable to read delegation settings."),
          ),
        )).delegation.defaultChildRuntimeMode,
      ).pipe(Effect.tapError((error) => recordExperimentFailure(error.message)));
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        input.interactionMode,
      ).pipe(Effect.tapError((error) => recordExperimentFailure(error.message)));
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
      if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
        const project = yield* requireProject(parent.thread.projectId).pipe(
          Effect.tapError((error) => recordExperimentFailure(error.message)),
        );
        // A SlipJay workspace starts from the integration branch, so the
        // parent's commit (which a jj workspace may not expose to git) is unused.
        let baseRef = "HEAD";
        if ((yield* workspaces.resolve(project.workspaceRoot)) !== "slipjay") {
          const base = yield* gitDriver
            .resolveCommit({
              cwd: parent.thread.worktreePath ?? project.workspaceRoot,
              revision: "HEAD",
            })
            .pipe(
              Effect.mapError(() =>
                failure("invalid_request", "Unable to resolve the parent checkout commit."),
              ),
              Effect.tapError((error) => recordExperimentFailure(error.message)),
            );
          // Launch preparation creates the worktree from the project root, so a
          // parent checkout in another repository (such as a Git folder inside
          // Scratch) would hand it a commit it cannot find.
          if (parent.thread.worktreePath !== null) {
            yield* gitDriver
              .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "invalid_request",
                    `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                  ),
                ),
                Effect.tapError((error) => recordExperimentFailure(error.message)),
              );
          }
          baseRef = base.commitSha;
        }
        workspaceStrategy = { type: "worktree", baseRef, startFromOrigin: false };
      }
      if (workUnit !== undefined && prepared !== undefined)
        yield* experiments
          .registerWorkTask({
            workUnitId: workUnit.id,
            owner: workOwner!,
            binding: {
              ...prepared.binding,
              assigned: experimentSelection ?? null,
              effective: target.modelSelection,
            },
            taskId: deriveIds.delegatedTaskNode({ commandId }),
            threadId: deriveIds.delegatedTaskThread({ commandId }),
          })
          .pipe(Effect.mapError(workError));
      const parentNodeId = parentRun.rootNodeId;
      const launch = Effect.gen(function* () {
        if (prepared !== undefined && managedService !== undefined) {
          yield* managedService
            .validate({
              binding: prepared.binding,
              runtimeMode,
              selection: target.modelSelection,
              projectId: taskProjectId,
              providers: eligibleProviders,
              ceiling: parent.thread.runtimeMode,
              workspacePath: leadCheckout ?? null,
              ...(yield* readWorkspaceAuthority),
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  if (workUnit !== undefined)
                    yield* experiments
                      .recordWorkTaskLaunch({
                        taskId: deriveIds.delegatedTaskNode({ commandId }),
                        state: "refused",
                      })
                      .pipe(Effect.mapError(workError));
                  yield* recordExperimentFailure(error.message);
                }),
              ),
              Effect.mapError((error) => failure("capability_denied", error.message)),
            );
        }
        // ThreadManagementService.dispatch is the chokepoint for this command
        // type's own enablement check, using the same command id and its
        // receipt-replay exemption, so no separate assert runs here.
        return yield* threadManagement
          .dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            parentThreadId: scope.thread.threadId,
            parentRunId: parentRun.id,
            parentNodeId,
            requestFingerprint,
            ...(prepared === undefined
              ? {}
              : {
                  agentTask: {
                    ...prepared.binding,
                    assigned: experimentSelection ?? null,
                    effective: target.modelSelection,
                  },
                }),
            task:
              prepared === undefined
                ? taskPrompt(input)
                : `${prepared.brief}\n\n${taskPrompt(input)}`,
            ...(prepared === undefined
              ? input.title === undefined
                ? {}
                : { title: input.title }
              : { title: managedTaskTitle(prepared.binding.role, input.task, input.title) }),
            modelSelection: target.modelSelection,
            runtimeMode,
            interactionMode,
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
            // Async delegations wake the parent on every child terminal; wait
            // delegations deliver through the blocking tool call, so a wake is
            // only needed if the parent settled first (timeout, disconnect).
            completionWake: input.mode === "wait" ? "settled_only" : "always",
          })
          .pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                if (workUnit !== undefined) {
                  const receipt = yield* threadManagement.hasReceipt(commandId).pipe(
                    Effect.map((accepted) =>
                      accepted ? ("accepted" as const) : ("refused" as const),
                    ),
                    Effect.catchCause(() => Effect.succeed("launch-unknown" as const)),
                  );
                  yield* experiments
                    .recordWorkTaskLaunch({
                      taskId: deriveIds.delegatedTaskNode({ commandId }),
                      state: receipt,
                    })
                    .pipe(Effect.mapError(workError));
                }
                yield* recordExperimentFailure();
              }),
            ),
            Effect.mapError((error) =>
              error._tag === "ThreadManagementProviderInstanceDisabledError"
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to create delegated task: ${errorMessage(error)}`,
                  ),
            ),
          );
      });
      // Isolated writers and pinned readers elsewhere share one lock, so neither can launch
      // into a workspace the other has just claimed.
      const result = yield* elsewhere && managedService !== undefined
        ? managedService.exclusive(launch)
        : launch;
      if (workUnit !== undefined)
        yield* experiments
          .recordWorkTaskLaunch({
            taskId: deriveIds.delegatedTaskNode({ commandId }),
            state: "accepted",
          })
          .pipe(Effect.mapError(workError));
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      const taskId = taskEvent.event.payload.id;
      const childThreadId = taskEvent.event.payload.childThreadId;
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (
        childThreadId !== null &&
        childRunEvent?.event.type === "run.created" &&
        childRunEvent.event.payload.workspacePreparation !== undefined
      ) {
        yield* threadLaunch.prepareRun({
          commandId,
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        });
      }

      if (input.mode !== "wait") {
        return yield* readTask(scope, taskId, false, true);
      }
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const waited = yield* waitForTask(scope, taskId, timeoutMs);
      if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
        return waited.value;
      }
      // An incomplete wait gives up delivery: upgrade so a later terminal
      // wakes the parent even mid-turn.
      yield* threadManagement
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "delegate-task-wake-policy",
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          completionWake: "always",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome:
                error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "previously_rejected"
                  : "dispatch_failed",
              error,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome: "defect",
              cause,
            }),
          ),
        );
      return yield* readTask(scope, taskId, Option.isNone(waited), true);
    }),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(
      function* (callerScope, taskId, timeoutMs) {
        const budget =
          timeoutMs === undefined
            ? undefined
            : Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, timeoutMs));
        if (callerScope.client !== undefined && callerScope.thread === undefined) {
          const service = yield* external;
          const current = yield* service
            .status(callerScope, taskId)
            .pipe(Effect.mapError(externalFailure));
          if (
            budget === undefined ||
            current.workState === "result_available" ||
            current.launchState !== "accepted"
          )
            return current;
          const waited = yield* threadManagement
            .waitForThread({
              threadId: current.childThreadId,
              projectId:
                current.agentTask?.externalOwner?.projectId ??
                (yield* failure("invalid_request", "Missing owned task project.")),
              timeoutMs: budget,
            })
            .pipe(Effect.mapError(threadManagementFailure));
          const result = yield* service
            .status(callerScope, taskId)
            .pipe(Effect.mapError(externalFailure));
          return { ...result, waitTimedOut: waited.timedOut };
        }
        const scope = yield* requireThreadScope(callerScope, "task_status");
        if (budget !== undefined) {
          const waited = yield* waitForTask(scope, taskId, budget);
          if (Option.isSome(waited)) return waited.value;
          return yield* readTask(scope, taskId, true, true);
        }
        return yield* readTask(scope, taskId, false, true);
      },
    ),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      // External work owns its permit and takes the managed lock only after it.
      if (callerScope.client !== undefined && callerScope.thread === undefined)
        return yield* external.pipe(
          Effect.flatMap((service) =>
            service.cancel(callerScope, input).pipe(Effect.mapError(externalFailure)),
          ),
        );
      const policy = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
      const cancel = Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "task_cancel");
        const current = yield* readTask(scope, input.taskId);
        const key = yield* requestKey(input.clientRequestId);
        const parentProjection = yield* loadProjection(scope.thread.threadId);
        // Cancelling stops the child and every task under it, each a write to a
        // thread its user may have raised above the parent's modes since it was
        // delegated. All of them are checked before anything is stopped.
        const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
          threadId: ThreadId,
        ): Effect.fn.Return<void, OrchestratorMcpFailure> {
          const shell = yield* threadManagement
            .getThreadShell(threadId)
            .pipe(Effect.mapError(threadManagementFailure));
          // A deleted thread takes no stop, but the tasks under it still do.
          if (shell !== null && shell.deletedAt === null) {
            yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
            yield* resolveInteractionMode(
              parentProjection.thread.interactionMode,
              shell.interactionMode,
            );
          }
          const { subagents } = yield* threadManagement
            .getThreadRecords(threadId, ["subagents"])
            .pipe(Effect.mapError(threadManagementFailure));
          for (const task of subagents) {
            if (task.origin === "app_owned" && task.childThreadId !== null) {
              yield* assertStoppable(task.childThreadId);
            }
          }
        });
        yield* assertStoppable(current.childThreadId);
        const parentTask = parentProjection.subagents.find(
          (task) => task.id === input.taskId && task.origin === "app_owned",
        );
        const disposeCompletionDelivery =
          parentTask?.completionDelivery?.state === "disposed"
            ? Effect.void
            : threadManagement
                .dispatch({
                  type: "delegated_task.completion-delivery.dispose",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "cancel-task-completion-delivery",
                  }),
                  parentThreadId: scope.thread.threadId,
                  taskId: input.taskId,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                    ),
                  ),
                );
        // Cancelling stops the child thread the way Stop does, including work that came
        // after a published result: follow-up runs, pull request watch wakes, and the
        // tasks it delegated. The published result stays terminal.
        const stopChild = Effect.gen(function* () {
          const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
          const reason = input.reason;
          yield* threadManagement
            .dispatch({
              type: "thread.stop",
              commandId,
              threadId: current.childThreadId,
              stopDelegatedTasks: false,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
                ),
              ),
            );
          // A retry with the same clientRequestId repeats only the stops that failed.
          yield* threadManagement
            .stopDelegatedTasks({ threadId: current.childThreadId, commandId, reason })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
                ),
              ),
            );
          const stopped = yield* threadManagement
            .getThreadRecords(current.childThreadId, ["runs"])
            .pipe(Effect.mapError(threadManagementFailure));
          for (const run of stopped.runs) {
            if (
              run.status !== "queued" ||
              (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
            )
              continue;
            // Stop preserves the queue for Resume. Cancelling a task must also
            // remove that task's queued turn, including a previously held one.
            yield* threadManagement
              .dispatch({
                type: "queued-run.cancel",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: `cancel-task-queued-run:${run.id}`,
                }),
                threadId: current.childThreadId,
                runId: run.id,
              })
              .pipe(Effect.mapError(threadManagementFailure));
          }
        });
        // Checked above; a user raising one of these threads meanwhile is
        // caught again under that thread's lock, which leaves it running.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        const stopWithinLimit = stopChild.pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: parentProjection.thread.runtimeMode,
            interactionMode: parentProjection.thread.interactionMode,
            refused,
          }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail(
                refusal === undefined
                  ? error
                  : failure(
                      refusal.mode === "runtime"
                        ? "runtime_mode_escalation_denied"
                        : "interaction_mode_escalation_denied",
                      `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                    ),
              ),
            ),
          ),
        );
        // A follow-up that lost its child run (#19002) stays running on the parent, while its
        // status here comes from the child's last run. Stop on the parent cancels that task.
        const cancelOrphan = Effect.gen(function* () {
          if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
            return false;
          yield* threadManagement
            .dispatch({
              type: "subagent.stop",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: "cancel-task-orphan",
              }),
              threadId: scope.thread.threadId,
              runId: parentTask.runId,
              subagentId: parentTask.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
          const { subagents } = yield* threadManagement
            .getThreadRecords(scope.thread.threadId, ["subagents"])
            .pipe(Effect.mapError(threadManagementFailure));
          return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
        });
        if (isTerminalTaskStatus(current.status)) {
          // The child can still run work for another turn, so it is stopped either way.
          yield* stopWithinLimit;
          const cancelled = yield* cancelOrphan;
          yield* disposeCompletionDelivery;
          return {
            taskId: input.taskId,
            status: cancelled ? ("cancelled" as const) : current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        // A task waiting on its own delegates has work to stop below it. One with neither
        // a running turn nor delegates (such as one awaiting a restart) keeps its delivery.
        const child = yield* loadProjection(current.childThreadId);
        if (
          current.workState !== "waiting_for_children" &&
          ThreadManagementService.latestActiveRun(child) === undefined &&
          !child.runs.some(
            (run) =>
              run.status === "queued" &&
              (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
          )
        ) {
          if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" as const };
          return yield* failure(
            "task_not_cancellable",
            `Delegated task ${input.taskId} has no interruptible child run.`,
          );
        }
        yield* stopWithinLimit;
        yield* disposeCompletionDelivery.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
        return {
          taskId: input.taskId,
          status: "cancel_requested" as const,
        };
      });
      return yield* Option.isSome(policy) ? policy.value.exclusive(cancel) : cancel;
    }),
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* loadCaller(scope);
      // A caller with no thread of its own and no project spans every project, as a linked
      // environment's agent does: it cannot know this environment's project IDs.
      const spansProjects = input.projectId === undefined && parent === undefined;
      const projectId = spansProjects ? null : yield* resolveProjectTarget(parent, input.projectId);
      const listProject = (id: ProjectId) =>
        threadManagement
          .listProjectThreads({
            projectId: id,
            includeSubagents: input.includeSubagents !== false,
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
            ),
          );
      const projectThreads =
        projectId !== null
          ? yield* listProject(projectId)
          : (yield* projects.snapshot.pipe(
              Effect.mapError((error) =>
                failure("orchestration_error", `Unable to list projects: ${errorMessage(error)}`),
              ),
              Effect.flatMap((snapshot) =>
                Effect.forEach(
                  snapshot.projects.filter((project) => project.deletedAt === null),
                  (project) => listProject(project.id),
                  { concurrency: 4 },
                ),
              ),
            ))
              .flat()
              .toSorted((a, b) => b.updatedAt.epochMilliseconds - a.updatedAt.epochMilliseconds);
      const nowMs = yield* Clock.currentTimeMillis;
      const statuses = input.statuses === undefined ? null : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter((thread) => canReadExternalWork(scope, thread))
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        environmentId: scope.environmentId,
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(shell, nowMs, scope.environmentId)),
        nextCursor,
        total: filtered.length,
        environments: [],
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
      const view = input.view ?? "messages";
      const afterPosition = input.afterPosition ?? -1;
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      const timeline = yield* threadManagement
        .getTimelinePage(input.threadId, {
          afterPosition,
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = timeline.items;
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of page) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = yield* Effect.forEach(
        [...messageIdsByThread],
        ([threadId, messageIds]) =>
          threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map((records) => [threadId, records.messages] as const),
            Effect.mapError(threadManagementFailure),
          ),
        { concurrency: 1 },
      );
      const messagesByThreadId = new Map(sourceMessages);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined ? [] : directAppOwnedChildTasks(parent, target, returnedRunIds);
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        tasks.length > 0 &&
        (input.textOffset ?? 0) === 0
      ) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent, target, task);
          const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
          const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
          const resultRecords = yield* threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRunIds,
              turnItemRunIds: resultRunIds,
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesTerminalTaskResult({
              parent,
              page,
              task,
              target: { ...target, ...resultRecords },
              maxChars,
            })
          ) {
            yield* readTask(
              scope as McpThreadInvocationScope,
              task.id,
              false,
              true,
              "thread-read-acknowledge",
            );
          }
        }
      }
      // Reading the result a watch would wake the caller with ends the watch, so the wake cannot
      // arrive after the caller has moved on.
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        (input.textOffset ?? 0) === 0 &&
        ((parent.thread.threadWatches ?? []).some(
          (watch) => watch.target.kind === "thread" && watch.target.threadId === target.thread.id,
        ) ||
          queuedThreadWatchWakes(parent, target.thread.id).length > 0)
      ) {
        const watched = yield* threadManagement
          .getThreadRecords(
            target.thread.id,
            watchedThreadRecords.fields,
            watchedThreadRecords.filter,
          )
          .pipe(Effect.mapError(threadManagementFailure));
        const decision = decideThreadWatch(watched);
        if (decision !== undefined && "resultRun" in decision) {
          const resultRecords = yield* threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: [decision.resultRun.id],
              turnItemRunIds: [decision.resultRun.id],
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesRunResult({
              page,
              target: resultRecords,
              run: decision.resultRun,
              maxChars,
            })
          ) {
            yield* threadManagement
              .dispatch({
                type: "thread.thread-watch",
                commandId: stableCommandId({
                  scope,
                  requestKey: yield* requestKey(undefined),
                  operation: "thread-read-unwatch",
                }),
                threadId: scope.thread.threadId,
                watchedThreadId: target.thread.id,
                watching: false,
              })
              .pipe(
                Effect.mapError((error) =>
                  isThreadManagementError(error)
                    ? threadManagementFailure(error)
                    : failure(
                        "orchestration_error",
                        `Unable to end the watch on thread ${target.thread.id}: ${errorMessage(error)}`,
                      ),
                ),
              );
          }
        }
      }
      return {
        environmentId: scope.environmentId,
        thread: threadDetail(target, timeline.totalItems, shell, yield* Clock.currentTimeMillis),
        recentRuns: target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun),
        items: page.map((row) =>
          timelineItem({
            row,
            maxChars,
            messagesByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
        ),
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: timeline.hasMore,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      if (target.thread.agentTask !== undefined)
        return yield* failure(
          "invalid_request",
          "Use delegate_task with followup to continue a managed task, or a fresh managed task for a new independent review round.",
        );
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

      const mode = input.mode ?? "auto";
      const key = yield* requestKey(input.clientRequestId);
      const messageId = stableOperationMessageId({
        scope,
        requestKey: key,
        operation: "thread-send",
      });
      const result = yield* threadManagement
        .sendToThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-send",
          }),
          threadId: input.threadId,
          ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
          messageId,
          text: input.message,
          attachments: [],
          mode,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
          ),
        );
      return {
        threadId: input.threadId,
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendResult;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { target } = yield* loadScopedThread(scope, input.threadId);
      const result = yield* threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status: result.run === null ? "idle" : runOutcome(result.run),
        timedOut: result.timedOut,
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    watchThread: Effect.fn("OrchestratorMcpService.watchThread")(
      function* (scope, input, watching) {
        yield* requireCapability(scope);
        const { thread } = yield* requireThreadScope(scope, watching ? "watch" : "unwatch");
        const watcher = yield* threadManagement
          .getThreadShell(thread.threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (watcher === null || watcher.deletedAt !== null) {
          return yield* failure("thread_not_found", `Thread ${thread.threadId} was not found.`);
        }
        // A watch keeps the canonical number, however the agent named the item.
        const named = input.target;
        const resolveNumber = (reference: string) =>
          forgeWorkItems.resolve(reference).pipe(
            Effect.map((item) => item.number),
            Effect.mapError((error) => failure("invalid_request", error.message)),
          );
        // Stopping a watch never needs HQ for a number, and a ref is matched against the
        // watched items' cached refs first.
        const unwatchNumber = Effect.fnUntraced(function* (reference: string) {
          const parsed = parseForgeReference(reference);
          if (parsed?.kind === "number") return parsed.number;
          const watched = (watcher.threadWatches ?? []).flatMap((watch) =>
            watch.target.kind === "build_item" ? [watch.target.number] : [],
          );
          if (parsed?.kind === "ref" && watched.length > 0) {
            const found = yield* forgeWorkItems
              .mentions({ threadId: watcher.id, numbers: watched })
              .pipe(Effect.option);
            const match = Option.getOrUndefined(found)?.items.find(
              (view) => view.item?.ref?.toUpperCase() === parsed.ref,
            );
            if (match !== undefined) return match.number;
          }
          return yield* resolveNumber(reference);
        });
        const target: OrchestrationV2WatchTarget =
          named.kind === "thread"
            ? named
            : {
                kind: "build_item",
                until: named.until,
                number:
                  typeof named.number === "number"
                    ? named.number
                    : watching
                      ? yield* resolveNumber(named.number)
                      : yield* unwatchNumber(named.number),
              };
        const wasWatching = (watcher.threadWatches ?? []).some((watch) =>
          watchTargetsEqual(watch.target, target),
        );
        let title: string | undefined;
        let label: string | undefined;
        if (watching) {
          const refusal = threadWatchRefusal(
            watcher,
            target.kind === "thread" ? target.threadId : undefined,
          );
          if (refusal !== undefined) return yield* failure("invalid_request", refusal);
          if (target.kind === "thread") {
            const watched = yield* threadManagement
              .getThreadShell(target.threadId)
              .pipe(Effect.mapError(threadManagementFailure));
            if (watched === null || watched.deletedAt !== null) {
              return yield* failure(
                "thread_not_found",
                `Thread ${target.threadId} is not in this environment. A thread can watch only threads in its own environment.`,
              );
            }
          } else {
            const connection = yield* forgeWorkItems.connected.pipe(
              Effect.mapError((error) => failure("invalid_request", error.message)),
            );
            if (!connection.connected)
              return yield* failure(
                "invalid_request",
                "T3 is not connected to Weave, so it cannot watch Build items.",
              );
            // A mistyped number would otherwise wait forever; an unreachable Weave is retried by the sweep.
            const found = yield* forgeWorkItems
              .mentions({ threadId: watcher.id, numbers: [target.number] })
              .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
            const view = found.items.find((candidate) => candidate.number === target.number);
            label = view?.item?.ref ?? `#${target.number}`;
            if (view === undefined && found.unavailable !== true)
              return yield* failure(
                "invalid_request",
                `Build ${label} is not a Spec or Ticket T3's Weave can see.`,
              );
            title = view?.item?.title.trim() || `Build #${target.number}`;
          }
        }
        yield* threadManagement
          .dispatch({
            type: "thread.thread-watch",
            commandId: stableCommandId({
              scope,
              requestKey: yield* requestKey(undefined),
              operation: watching ? "watch" : "unwatch",
            }),
            threadId: watcher.id,
            target,
            ...(title === undefined ? {} : { title }),
            watching,
          })
          .pipe(
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : failure("orchestration_error", `Unable to update watch: ${errorMessage(error)}`),
            ),
          );
        return { target, ...(label === undefined ? {} : { label }), watching, wasWatching };
      },
    ),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* requestKey(input.clientRequestId);
      const result = yield* threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ForgeWorkItems.ForgeWorkItems
  | Experiments.ExperimentService
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ReleaseApprovals.ReleaseApprovals
  | ServerSettings.ServerSettingsService
  | WorkspaceProvider.WorkspaceProvider
> = Layer.effect(OrchestratorMcpService, make);
