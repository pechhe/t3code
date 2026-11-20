import * as AdviceService from "../agents/AdviceService.ts";
import type { SecretsListInput, SecretsListResult } from "@t3tools/contracts";
import * as SavedSecrets from "../secrets/SavedSecrets.ts";
import * as ManagedTaskControl from "../agents/ManagedTaskControl.ts";
import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";
import * as Digest from "effect/crypto/Digest";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ExternalWork from "../agents/ExternalAgentWorkService.ts";
import { assertExternalWorkOwner, canReadExternalWork } from "./threadAccess.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import {
  type ExperimentWorkOwner,
  type ExperimentWorkEnrollInput,
  type ExperimentWorkUnit,
  type ExperimentWorkAllocationInput,
  type ExperimentWorkAllocation,
  type ExperimentWorkEvidenceInput,
  type ExperimentWorkEvidence,
  type ExperimentWorkReport,
  type AgentRole,
  type AgentTaskOutcomeInput,
  type ExperimentOutcome,
  type ExperimentOutcomeInput,
  CommandId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
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
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestReleaseApprovalInput,
  type OrchestratorMcpRequestReleaseApprovalResult,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
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
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  scheduledTaskPurpose,
  scheduledTaskThreadMode,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  type OrchestrationV2ParkedWaitTarget,
  latestProviderTurnForAttempt,
  resolveProjectProviderInstanceEnabled,
  SECRET_REQUEST_UNSAVED_NOTE,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue, withLegacyUltracodeEffort } from "@t3tools/shared/model";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { threadPullRequestUpdatedAtMs } from "@t3tools/shared/threadPullRequests";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
  delegatedTaskReportRuns,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun,
  delegatedTaskRuns,
  runOutcome,
} from "../orchestration-v2/RestartBackgroundNote.ts";
import {
  decideThreadWatch,
  queuedThreadWatchWakes,
  threadWatchRefusal,
  watchedThreadRecords,
} from "../orchestration-v2/threadWatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { placeholderThreadTitle } from "../orchestration-v2/placeholderThreadTitle.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { DEFAULT_WAIT_MS, parkedWaitTargetsEqual } from "../orchestration-v2/parkedWait.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import { occupantsEverywhere as occupantsInAllProjects } from "../agents/workspaceIdentity.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientModeCeiling,
  isReadOnlyClient,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
  threadLinkFor,
  assertSettingsWrite,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import {
  interactionModeRank,
  resolveInteractionMode,
  resolveRuntimeMode,
  runtimeModeRank,
} from "./delegatedTaskModes.ts";
import {
  assertTargetWithinLimits,
  isLiveCallerShell,
  logWhyNotDelegated,
  requireWhyNotDelegated,
  threadNotFound,
} from "./threadAccess.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ManagedDelegation from "./ManagedDelegation.ts";
import { managedTaskHandoff } from "./ManagedDelegation.ts";

// Return recoverable handles before common MCP client timeouts expire.
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 45_000;
const DEFAULT_SECRET_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_SECRET_REQUEST_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "parent", eventType: "message.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 10;
const DEFAULT_THREAD_READ_LIMIT = 10;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 500;
const THREAD_PULL_REQUEST_PREVIEW_LIMIT = 5;
// Claude Code saves MCP results over ~25k tokens to a file instead of showing them. Bytes, not
// chars: CJK text runs near one token per char, which a char budget lets through at 30k tokens.
const THREAD_READ_RESULT_MAX_BYTES = 30_000;

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
    input: AgentRolesInput & { readonly projectId?: ProjectId | undefined },
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
  /** Only status reaches the agent, never this value. */
  readonly searchSecrets: (
    scope: McpInvocationScope,
    input: SecretsListInput,
  ) => Effect.Effect<SecretsListResult, OrchestratorMcpFailure>;
  readonly deleteSecret: (
    scope: McpInvocationScope,
    input: { readonly id: string },
  ) => Effect.Effect<{ readonly deleted: boolean }, OrchestratorMcpFailure>;
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
    /** For a thread in a linked environment: what the caller read of it there. */
    remote?: { readonly title: string },
  ) => Effect.Effect<OrchestratorMcpThreadWatchResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

export const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

export function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementWorktreeRestoreError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementNoSteerableRunError":
      return failure(
        "thread_not_sendable",
        `${error.message} Send with mode: "auto" or "queue" to start a new turn there.`,
      );
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

// Without a reason, a Stop reads as the user's (see RunExecutionService.USER_STOP_REASON).
function agentStopReason(reason: string | undefined): string {
  return reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    modelSelection: task.modelSelection,
    freshSession: scheduledTaskThreadMode(task) === "fresh_session",
    purpose: scheduledTaskPurpose(task),
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.webhook?.url == null || !mayRun || task.blockedByPolicy !== undefined
      ? {}
      : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
    ...(task.blockedByPolicy === undefined ? {} : { blockedByPolicy: task.blockedByPolicy }),
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
 * Lists visible models, keeping pinned models and limiting large catalogs by default.
 * Whole provider words select the provider; partial words filter models when any match.
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
  const { instanceId, driver, displayName } = input.provider;
  const providerText = `${instanceId} ${driver} ${displayName ?? ""}`.toLowerCase();
  // Whole ids like "codex-work" and their parts both name the provider.
  const providerWords = new Set([
    ...providerText.split(/\s+/),
    ...providerText.split(/[^\p{L}\p{N}]+/u),
  ]);
  const modelText = (model: ServerProviderModel) =>
    `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
  // Part of a provider word ("agent" in "claudeAgent") names the provider unless a model matches it.
  const modelTerms = input.searchTerms.filter(
    (term) =>
      !providerWords.has(term) &&
      (!providerText.includes(term) || visible.some((model) => modelText(model).includes(term))),
  );
  if (modelTerms.length > 0) {
    const matches = visible.filter((model) => {
      const text = modelText(model);
      return modelTerms.every((term) => text.includes(term));
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

/** Names advertised slugs to retry with: same last `/` segment first, else a short list. */
function advertisedModelsHint(models: ReadonlyArray<ServerProviderModel>, requested: string) {
  const lastSegment = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const wanted = lastSegment(requested);
  const close = models.filter((model) => lastSegment(model.slug) === wanted);
  if (close.length > 0) {
    return `Did you mean ${close
      .slice(0, LISTED_MODEL_LIMIT)
      .map((model) => model.slug)
      .join(", ")}?`;
  }
  const listed = models
    .toSorted((a, b) => Number(a.isLegacy ?? false) - Number(b.isLegacy ?? false))
    .slice(0, LISTED_MODEL_LIMIT);
  const omitted = models.length - listed.length;
  return `Advertised models: ${listed.map((model) => model.slug).join(", ")}${
    omitted > 0 ? ` and ${omitted} more; orchestrator_capabilities with search finds them` : ""
  }.`;
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

const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

/** Antigravity 1.3 IDs append the thinking level (`gemini-3.8-flash-high`); the agent still accepts them. */
function antigravitySuffixedModel(provider: ServerProvider, model: string) {
  if (provider.driver !== "antigravity" || advertisedModel(provider, model)) return;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return { model: family, thinking: { id: thinking.id, value } };
  }
}

/** A folder's own provider config can add models that only its workspace snapshot lists. */
export const withWorkspaceModels = (
  providers: ReadonlyArray<ServerProvider>,
  cwd: string | undefined,
): ReadonlyArray<ServerProvider> =>
  cwd === undefined
    ? providers
    : providers.map((provider) => {
        const models = provider.workspaceSnapshots?.find(
          (snapshot) => snapshot.cwd === cwd,
        )?.models;
        return models === undefined ? provider : { ...provider, models };
      });

const withV = (version: string) => (version.startsWith("v") ? version : `v${version}`);

/** A provider that lists no models accepts any slug. */
export const requireAdvertisedModel = (provider: ServerProvider, model: string) => {
  if (provider.models.length === 0 || advertisedModel(provider, model) !== undefined) {
    return Effect.void;
  }
  const updateRequired = provider.updateRequiredModels?.find(
    (candidate) => candidate.slug === model,
  );
  const detectedVersion = provider.installedVersion ?? provider.version;
  return Effect.fail(
    failure(
      "model_unavailable",
      updateRequired === undefined
        ? `Model ${model} is not advertised by provider ${provider.instanceId}. ${advertisedModelsHint(provider.models, model)}`
        : `Model ${model} needs provider ${provider.instanceId} at ${withV(updateRequired.minVersion)} or newer, but the detected CLI is ${detectedVersion === null ? "an unknown version" : withV(detectedVersion)}. Ask the user to update it or point the provider's binary path at a newer install.`,
    ),
  );
};

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
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

/** t3_thread_launch keeps a selection as given, so it can hold options its model does not have. */
function knownOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (options === undefined || descriptors === undefined) return options;
  return options.filter((option) => descriptors.some((descriptor) => descriptor.id === option.id));
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
    case "starting":
      return "starting";
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
    result.pendingAdvice?.blocking === true ||
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

/** Every task `directAppOwnedChildTasks` can return, so callers load only those. */
function directChildTaskIds(
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<NodeId> {
  const ids = new Set<NodeId>();
  if (target.thread.forkedFrom?.type === "node") ids.add(target.thread.forkedFrom.nodeId);
  for (const run of target.runs) {
    if (returnedRunIds.has(run.id) && run.delegatedTaskId !== undefined) {
      ids.add(run.delegatedTaskId);
    }
  }
  return [...ids];
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

// The child's transfers include the results it sent, so the parent's transfers are never read.
function taskResultTransfer(
  parentThreadId: ThreadId,
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
  return child.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parentThreadId &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parentThreadId: ThreadId;
  readonly items: ReadonlyArray<OrchestratorMcpThreadTimelineItem>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems" | "providerTurns"
  >;
}): boolean {
  const transfer = taskResultTransfer(input.parentThreadId, input.target, input.task);
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
  readonly items: ReadonlyArray<OrchestratorMcpThreadTimelineItem>;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "messages" | "turnItems" | "providerTurns"
  >;
  readonly run: OrchestrationV2Run;
}): boolean {
  const result = subagentResultForRun(input.target, input.run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.items.some((item) => {
    if (item.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && item.itemId === result.turnItemId) ||
      (result.messageId !== null &&
        item.type === "assistant_message" &&
        item.messageId === result.messageId);
    return matchesResult && item.text !== null && !item.textTruncated;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
  awaitingContinuationRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  // A restart-cut run, and each cut run before it in the chain, has no outcome while a
  // continuation is pending, live, or ran to a result.
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  const supersededRunIds = new Set<RunId>();
  const supersede = (runId: RunId | undefined) => {
    let id = runId;
    while (id !== undefined && !supersededRunIds.has(id)) {
      supersededRunIds.add(id);
      id = runsById.get(id)?.restartContinuationOfRunId;
    }
  };
  supersede(awaitingContinuationRun?.id);
  for (const run of projection.runs) {
    if (
      !ThreadManagementService.isTerminalRunStatus(run.status) ||
      (run.status !== "rolled_back" && run.startedAt !== null)
    )
      supersede(run.restartContinuationOfRunId);
  }
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        !supersededRunIds.has(run.id) &&
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
  if (!detail) return placeholderThreadTitle(input.parentTitle, input.index);
  if (detail.length <= 80) return detail;
  let end = 77;
  const previous = detail.charCodeAt(end - 1);
  const next = detail.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${detail.slice(0, end)}...`;
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

// Provider-internal links (parentTaskId, providerInstanceId) stay out of agent results.
function threadBackgroundWork(
  thread: Pick<OrchestrationV2ThreadShell, "blockedOnThreadWait" | "pendingBackgroundTasks">,
): Required<Pick<OrchestratorMcpThreadListItem, "blockedOnThreadWait" | "pendingBackgroundTasks">> {
  return {
    blockedOnThreadWait: thread.blockedOnThreadWait === true,
    pendingBackgroundTasks: (thread.pendingBackgroundTasks ?? []).map((task) => ({
      taskId: task.taskId,
      kind: task.kind,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.awaited === undefined ? {} : { awaited: task.awaited }),
      ...(task.kind === "subagent" && task.childThreadId !== undefined
        ? { childThreadId: task.childThreadId }
        : {}),
    })),
  };
}

function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
  includeLinks = true,
): Pick<
  OrchestratorMcpThreadListItem,
  "pullRequests" | "pullRequestCount" | "openPullRequestCount"
> {
  const visible = visibleThreadPullRequests(links ?? []);
  if (!includeLinks) return { pullRequestCount: visible.length };
  const open = visible.filter(
    (link) => link.snapshot?.state !== "merged" && link.snapshot?.state !== "closed",
  );
  return {
    pullRequests: open
      .toSorted(
        (left, right) =>
          Number(right.watch !== undefined) - Number(left.watch !== undefined) ||
          threadPullRequestUpdatedAtMs(right) - threadPullRequestUpdatedAtMs(left),
      )
      .slice(0, THREAD_PULL_REQUEST_PREVIEW_LIMIT)
      .map((link) => ({
        host: normalizeThreadPullRequestKey(link).host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        source: link.source,
        state: link.snapshot?.state ?? null,
        watching: link.watch !== undefined,
        watchStartedAt: link.watch?.startedAt ?? null,
      })),
    pullRequestCount: visible.length,
    openPullRequestCount: open.length,
  };
}

// Awaited background work keeps a thread live after its turn ends, as auto-settle and the sidebar treat it.
function threadStatus(
  activeStatus: OrchestratorMcpThreadListItem["status"] | null | undefined,
  settledStatus: OrchestratorMcpThreadListItem["status"],
  pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"],
) {
  if (activeStatus != null) return activeStatus;
  if (settledStatus === "failed") return settledStatus;
  return backgroundWorkHoldsCompletion(pendingBackgroundTasks ?? []) ? "waiting" : settledStatus;
}

const LIVE_LISTED_THREAD_STATUSES: ReadonlySet<OrchestratorMcpThreadListItem["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function listedThreadStatus(shell: OrchestrationV2ThreadShell) {
  return threadStatus(shell.activityRunStatus, shell.status, shell.pendingBackgroundTasks);
}

function listItemFromShell(
  scope: McpInvocationScope,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    environmentId: scope.environmentId,
    projectId: shell.projectId,
    title: shell.title,
    link: threadLinkFor(scope, shell.id, shell.title),
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: listedThreadStatus(shell),
    ...(shell.standing === undefined ? {} : { standing: shell.standing }),
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    ...threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    pinned: shell.pinnedAt != null,
    ...threadBackgroundWork(shell),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    ...(shell.delegatedFrom == null ? {} : { delegatedFrom: shell.delegatedFrom }),
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  scope: McpInvocationScope,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  runCount: number,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
  firstPage: boolean,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    link: threadLinkFor(scope, projection.thread.id, projection.thread.title),
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: threadStatus(active?.status, latest?.status ?? "idle", shell.pendingBackgroundTasks),
    ...(shell.standing === undefined ? {} : { standing: shell.standing }),
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    ...threadPullRequests(projection.thread.pullRequests, firstPage),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    lastTitleRegeneration:
      projection.thread.lastTitleRegeneration == null
        ? null
        : {
            ...projection.thread.lastTitleRegeneration,
            completedAt: DateTime.formatIso(projection.thread.lastTitleRegeneration.completedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    ...(projection.thread.delegatedFrom == null
      ? {}
      : { delegatedFrom: projection.thread.delegatedFrom }),
    runCount,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    pinned: shell.pinnedAt != null,
    ...threadBackgroundWork(shell),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function runExecutedModel(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns">,
  run: Pick<OrchestrationV2Run, "activeAttemptId"> | undefined,
): string | null {
  return run === undefined
    ? null
    : (latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.model ?? null);
}

function threadRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns">,
  run: OrchestrationV2Run,
): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    executedModel: runExecutedModel(projection, run),
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
    case "link_request":
      return item.linkStatus === "linked"
        ? `Linked ${item.linkedLabel ?? item.url ?? "an environment"} (${item.linkedAccess}).`
        : `Asked the user to link ${item.url ?? "an environment"}: ${item.linkStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

/** A cut inside a surrogate pair would leave half an emoji on each page. */
function textPageEnd(text: string | null, offset: number, maxChars: number): number {
  const end = offset + maxChars;
  if (text === null || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  if (last < 0xd800 || last > 0xdbff) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = textPageEnd(text, offset, input.maxChars);
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

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The longest prefix length in [low, high] that `fits`, or `low - 1`. */
function longestFitting(low: number, high: number, fits: (length: number) => boolean): number {
  let best = low - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** The item with its text cut, and an oversized title too, until its JSON fits `maxBytes`. */
function timelineItemWithin(
  input: Parameters<typeof timelineItem>[0],
  maxBytes: number,
): OrchestratorMcpThreadTimelineItem {
  const longestText = (title: string | null) => {
    const withText = (maxChars: number) => ({ ...timelineItem({ ...input, maxChars }), title });
    const chars = longestFitting(2, input.maxChars - 1, (n) => jsonBytes(withText(n)) <= maxBytes);
    return withText(Math.max(chars, 1));
  };
  const item = longestText(input.row.item.title);
  const title = item.title;
  if (title === null || jsonBytes(item) <= maxBytes) return item;
  // Half the budget for the title keeps `textOffset` pages of the text useful.
  const cutTitle = (chars: number) =>
    title.slice(0, chars === 0 ? 0 : textPageEnd(title, 0, chars));
  const titleChars = longestFitting(
    1,
    title.length - 1,
    (n) => jsonBytes({ ...item, title: cutTitle(n) }) <= maxBytes / 2,
  );
  return longestText(cutTitle(Math.max(titleChars, 0)));
}

/**
 * The items, read from the end the caller pages toward, whose result fits
 * THREAD_READ_RESULT_MAX_BYTES; `start` is the first kept index. Never empty for a non-empty page.
 */
function timelineItemsWithinBudget(
  envelope: Omit<OrchestratorMcpThreadReadResult, "items">,
  inputs: ReadonlyArray<Parameters<typeof timelineItem>[0]>,
  newestFirst: boolean,
): { readonly items: Array<OrchestratorMcpThreadTimelineItem>; readonly start: number } {
  // An oversized envelope (say, a huge thread title) must not starve items to one char per read.
  const budget = Math.max(
    THREAD_READ_RESULT_MAX_BYTES - jsonBytes({ ...envelope, items: [] }),
    THREAD_READ_RESULT_MAX_BYTES / 2,
  );
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let bytes = 0;
  for (const input of newestFirst ? inputs.toReversed() : inputs) {
    const item = timelineItem(input);
    bytes += jsonBytes(item) + (items.length === 0 ? 0 : 1);
    if (bytes <= budget) {
      items.push(item);
      continue;
    }
    if (items.length === 0) items.push(timelineItemWithin(input, budget));
    break;
  }
  return newestFirst
    ? { items: items.toReversed(), start: inputs.length - items.length }
    : { items, start: 0 };
}

const make = Effect.gen(function* () {
  const advice = yield* Effect.serviceOption(AdviceService.AdviceService);
  const forgeWorkItems = yield* ForgeWorkItems.ForgeWorkItems;
  const experiments = yield* Experiments.ExperimentService;
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;
  const slipJay = yield* Effect.serviceOption(SlipJayLandings.SlipJayLandings);

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

  /** Why T3 cannot tell when `target` reaches Production, if it cannot. */
  const productionRefusal = Effect.fn("OrchestratorMcpService.productionRefusal")(function* (
    watcher: { readonly projectId: ProjectId; readonly worktreePath: string | null },
    target: Extract<OrchestrationV2ParkedWaitTarget, { readonly kind: "production" }>,
  ) {
    if (!/^[0-9a-f]{7,64}$/i.test(target.commitId)) {
      return "Name the published commit by its hexadecimal id.";
    }
    const projectId = target.projectId ?? watcher.projectId;
    const project = yield* requireProject(projectId);
    return yield* SlipJayLandings.productionWaitRefusal(slipJay, {
      projectId,
      checkouts: [
        ...(projectId === watcher.projectId && watcher.worktreePath !== null
          ? [watcher.worktreePath]
          : []),
        project.workspaceRoot,
      ],
    });
  });

  /** The Build item a landing published `commitId` for, as clients name it; else none. */
  const productionSubject = Effect.fn("OrchestratorMcpService.productionSubject")(function* (
    threadId: ThreadId,
    commitId: string,
  ) {
    if (Option.isNone(slipJay)) return undefined;
    const landings = yield* slipJay.value.landings;
    const spec = landings.find(
      (landing) =>
        landing.commitId !== undefined &&
        (landing.commitId.startsWith(commitId) || commitId.startsWith(landing.commitId)),
    )?.spec;
    if (spec === undefined) return undefined;
    const found = yield* forgeWorkItems.mentions({ threadId, numbers: [spec] }).pipe(Effect.option);
    const ref = Option.getOrUndefined(found)?.items.find((view) => view.number === spec)?.item?.ref;
    return ref ?? `Build #${spec}`;
  });

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

  const projectDefaultModelSelection = Effect.fn(
    "OrchestratorMcpService.projectDefaultModelSelection",
  )(function* (project: Effect.Success<ReturnType<typeof requireProject>>) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
    );
    const selection = resolveProjectSettings(settings, project.id, project).settings
      .defaultModelSelection;
    if (selection === null)
      return yield* failure(
        "invalid_request",
        `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
      );
    return selection;
  });
  const secretRequests = yield* SecretRequests.SecretRequests;
  const savedSecrets = yield* Effect.serviceOption(SavedSecrets.SavedSecrets);
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

  const loadThreadRecords = <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    threadManagement
      .getThreadRecords(threadId, fields, filter)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjection = (
    threadId: ThreadId,
    includeUserMessages = true,
    subagentIds: ReadonlyArray<NodeId> = [],
  ) =>
    loadThreadRecords(
      threadId,
      [
        "runs",
        "subagents",
        "messages",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "contextTransfers",
        "turnItems",
      ],
      { turnItemTypes: [], messageRoles: includeUserMessages ? ["user"] : [], subagentIds },
    );

  // Runs on every MCP call, and long threads hold thousands of records; callers need only active runs.
  const loadCallerRecords = <K extends "runs">(threadId: ThreadId, fields: ReadonlyArray<K>) =>
    loadThreadRecords(threadId, fields, {
      runStatuses: ThreadManagementService.ACTIVE_RUN_STATUSES,
    });

  // A dispatcher thread holds thousands of tasks, each with its full prompt; read only the ones named.
  const loadTasks = (threadId: ThreadId, taskIds: ReadonlyArray<NodeId>) =>
    threadManagement.getThreadRecords(threadId, ["subagents"], { subagentIds: taskIds }).pipe(
      Effect.map(({ subagents }) => subagents),
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read thread ${threadId}: ${errorMessage(error)}`),
      ),
    );

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* <K extends "runs">(
    scope: McpInvocationScope,
    fields: ReadonlyArray<K>,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: clientModeCeiling(scope.client),
      } as const;
    }
    const parent = yield* loadCallerRecords(scope.thread.threadId, fields);
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
    const parent = yield* loadCallerRecords(threadScope.thread.threadId, ["runs"]);
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
    const caller = yield* loadCaller(scope, ["runs"]);
    if (caller.parent !== undefined) {
      if (caller.parent.thread.agentTask?.externalOwner !== undefined)
        return yield* failure(
          "capability_denied",
          "Work an outside client owns cannot allocate parent work.",
        );
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
    missingMessage = "Pass projectId: this MCP client is not running inside a T3 thread.",
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(failure("target_required", missingMessage));

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        scope,
        threadId,
        `Thread ${threadId} was not found.`,
      );
    }
    // Keeps legacy import and project validation; callers read only the thread row.
    return yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
      .pipe(Effect.mapError(threadManagementFailure));
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* <
    K extends "runs",
  >(scope: McpInvocationScope, threadId: ThreadId, callerFields: ReadonlyArray<K>) {
    const caller = yield* loadCaller(scope, callerFields);
    // Only the thread row: the caller's own record holds just its active runs.
    const target: Pick<OrchestrationV2ThreadProjection, "thread"> =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(scope, threadId);
    yield* assertExternalWorkOwner(scope, target.thread);
    return { ...caller, target } as const;
  });

  /** Cross-thread writes require a live caller run; stale session credentials cannot authorize them. */
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

  // A background subagent keeps calling tools after the run that started it settles. Its
  // delegations join that latest run, whose completion cohort wakes the thread once they finish.
  const backgroundSubagentRun = Effect.fn("OrchestratorMcpService.backgroundSubagentRun")(
    function* (scope: McpInvocationScope, threadId: ThreadId) {
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (
        shell?.activeRunId !== null ||
        shell.latestRunId === null ||
        !isLiveCallerShell(shell, scope.thread?.providerInstanceId)
      ) {
        return undefined;
      }
      const { runs } = yield* loadThreadRecords(threadId, ["runs"], {
        runIds: [shell.latestRunId],
      });
      return runs[0];
    },
  );

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
    runLimit: number,
  ) {
    const { parent } = yield* loadCaller(scope, []);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        scope,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const input = { projectId: shell.projectId, threadId };
    // Acknowledging a caller's child-task result matches it against every run and transfer.
    if (
      parent !== undefined &&
      shell.lineage.parentThreadId === parent.thread.id &&
      shell.lineage.relationshipToParent === "subagent"
    ) {
      const target = yield* threadManagement
        .getProjectThreadRecords(input, [
          "runs",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
        ])
        .pipe(Effect.mapError(threadManagementFailure));
      yield* assertExternalWorkOwner(scope, target.thread);
      return { parent, target, shell, runCount: target.runs.length } as const;
    }
    // Long threads hold thousands of runs; the read shows only the recent and active ones.
    const [records, runCount] = yield* Effect.all([
      threadManagement.getProjectThreadRecords(input, ["runs", "runtimeRequests"], {
        latestRunLimit: runLimit,
        runStatuses: ThreadManagementService.ACTIVE_RUN_STATUSES,
        runtimeRequestStatuses: ["pending"],
      }),
      threadManagement.getRunCount(threadId),
    ]).pipe(Effect.mapError(threadManagementFailure));
    const { providerTurns } = yield* threadManagement
      .getProjectThreadRecords(input, ["providerTurns"], {
        providerTurnAttemptIds: records.runs.flatMap((run) => run.activeAttemptId ?? []),
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const target = { ...records, providerTurns, contextTransfers: [] };
    yield* assertExternalWorkOwner(scope, target.thread);
    return { parent, target, shell, runCount } as const;
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

  /** The folder the composer's model picker scans for this thread. */
  const parentWorkspaceCwd = (parent: Pick<OrchestrationV2ThreadProjection, "thread">) =>
    parent.thread.worktreePath
      ? Effect.succeed(parent.thread.worktreePath)
      : projects.getById(parent.thread.projectId).pipe(
          Effect.map((project) =>
            Option.getOrUndefined(Option.map(project, ({ workspaceRoot }) => workspaceRoot)),
          ),
          Effect.orElseSucceed(() => undefined),
        );

  const scanWorkspace = (instanceId: ServerProvider["instanceId"], cwd: string) =>
    projects
      .workspaceScanDirectory(cwd)
      .pipe(
        Effect.flatMap((scanCwd) =>
          providerRegistry.refreshWorkspaceSnapshot({ instanceId, cwd, scanCwd }),
        ),
      );

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /** Background agents miss foreground-only health probes; re-probe once before refusing. */
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

  const resolveTargetRechecking = (
    input: Parameters<typeof resolveTarget>[0] & { readonly cwd: string | undefined },
  ) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget({
      ...input,
      providers: withWorkspaceModels(input.providers, input.cwd),
    });
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable" || error.code === "model_unavailable",
        () =>
          (input.cwd === undefined
            ? providerRegistry.refreshInstance(instanceId)
            : providerRegistry
                .refreshInstance(instanceId)
                .pipe(Effect.andThen(scanWorkspace(instanceId, input.cwd)))
          ).pipe(
            Effect.flatMap((providers) =>
              resolveTarget({ ...input, providers: withWorkspaceModels(providers, input.cwd) }),
            ),
          ),
      ),
    );
  };

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /** Receipt replays bypass current settings because they start no work. Dispatch must reuse the checked command ID. */
    readonly skipProjectEnablementFilter?: boolean;
    /**
     * The target is a managed role's complete selection. The caller's own options never join it,
     * even on the caller's instance and model: the role's options are the whole set.
     */
    readonly roleSelection?: boolean;
    /** Whether the account is named and stays put; by default, when the target names an instance. */
    readonly pinned?: boolean;
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
    const antigravityTarget =
      requestedModel === undefined ? undefined : antigravitySuffixedModel(provider, requestedModel);
    const model =
      antigravityTarget?.model ??
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (requestedModel !== undefined) yield* requireAdvertisedModel(provider, model);
    const advertised = advertisedModel(provider, model);
    const descriptors = advertised?.capabilities?.optionDescriptors;
    const requestedOptions = withLegacyUltracodeEffort(descriptors, input.target?.options);
    if (requestedOptions !== undefined) {
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
      (advertised?.slug ?? model) ===
        (advertisedModel(provider, inheritedSelection.model)?.slug ?? inheritedSelection.model);
    let options = inheritsOptions
      ? knownOptions(
          withLegacyUltracodeEffort(descriptors, inheritedSelection.options),
          descriptors,
        )
      : undefined;
    if (requestedOptions !== undefined || antigravityTarget !== undefined) {
      const selections = new Map(
        (requestedOptions?.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      if (antigravityTarget !== undefined && requestedOptions?.length !== 0) {
        selections.set(antigravityTarget.thinking.id, antigravityTarget.thinking);
      }
      for (const selection of requestedOptions ?? []) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    const pinned = input.pinned ?? requestedInstanceId !== undefined;
    return {
      modelSelection: {
        instanceId,
        model,
        ...(pinned ? { pinned: true } : {}),
        ...(options === undefined ? {} : { options }),
      },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const validateScheduledModel = Effect.fn("OrchestratorMcpService.validateScheduledModel")(
    function* (
      projectId: ProjectId,
      selection: ModelSelection,
      agentRole: AgentRole | null | undefined,
    ) {
      if (agentRole != null) {
        return yield* failure("invalid_request", "Choose modelSelection or agentRole, not both.");
      }
      const providers = yield* loadProviders;
      const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${selection.instanceId} is not registered.`,
        );
      }
      const constraints = providerConstraints(
        provider,
        (yield* loadOrchestrationCapableInstanceIds()).has(selection.instanceId),
      );
      if (
        constraints.length > 0 ||
        !(yield* threadManagement.isProviderInstanceEnabledForProject({
          projectId,
          instanceId: selection.instanceId,
        }))
      ) {
        return yield* failure(
          "provider_unavailable",
          `Provider ${selection.instanceId} is unavailable or disabled for this project.`,
        );
      }
      yield* requireAdvertisedModel(provider, selection.model);
      const descriptors = advertisedModel(provider, selection.model)?.capabilities
        ?.optionDescriptors;
      const options = withLegacyUltracodeEffort(descriptors, selection.options);
      const invalid = invalidOptionSelections(options ?? [], descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${selection.model} on provider ${selection.instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
      return { ...selection, ...(options === undefined ? {} : { options }) };
    },
  );

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined ? random.uuidV4() : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const task = (yield* loadTasks(scope.thread.threadId, [taskId])).find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined || (task.childThreadId === null && task.remoteChild === undefined)) {
      return yield* failure(
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    if (task.childThreadId === null) {
      return yield* readRemoteTask(scope, task, waitTimedOut, acknowledgeTerminal);
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
          "providerTurns",
          "runtimeRequests",
          "nodes",
          "turnItems",
        ],
        {
          messageRoles: ["user"],
          omitSettledLeafNodes: true,
          omitSettledSubagents: true,
          ...delegatedTaskProgressTurnItems,
        },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const pendingAdvice = Option.isSome(advice)
      ? yield* advice.value.pending(task.childThreadId)
      : undefined;
    const progress = delegatedTaskProgress({
      ...childControls,
      pendingBlockingAdvice: pendingAdvice?.blocking === true,
    });
    const followupRuns =
      childRun?.delegatedTaskId === task.id ? delegatedTaskRuns(childControls, task.id) : undefined;
    const taskResultRun =
      followupRuns === undefined ? progress.resultRun : delegatedTaskResultRun(followupRuns);
    const taskWorkState =
      followupRuns === undefined
        ? progress.state
        : !isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "working"
          : delegatedTaskAwaitsWork(followupRuns, childControls)
            ? "waiting_for_children"
            : "result_available";
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const terminalRun = latestTerminalResultRun(
      childControls,
      childRun,
      heldForRestart ? taskResultRun : undefined,
    );
    // Only the task's own result looks back for its report, and only among its own runs.
    const reportRuns =
      task.result === null && taskResultRun !== undefined
        ? delegatedTaskReportRuns(childControls, taskResultRun)
        : [];
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id, ...reportRuns.map((run) => run.id)].filter(
          (id): id is RunId => id !== undefined,
        ),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error", "system_notice"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const resultText = (run: OrchestrationV2Run) =>
      subagentResultForRun(
        { ...childProjection, runs: run.id === taskResultRun?.id ? reportRuns : [] },
        run,
      ).text;
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const runStatus = taskStatusForRun(taskResultRun ?? childRun);
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
          ? // A cancelled task's finished turn settles it as interrupted.
            task.cancelledRunId !== undefined && runStatus === "completed"
            ? "interrupted"
            : runStatus
          : runStatus === "queued" || runStatus === "starting"
            ? runStatus
            : "running";
    // Retention cut an expired parent's record to one line; the child's messages keep the answer.
    const childResult =
      taskResultRun !== undefined && isTerminalTaskStatus(status)
        ? resultText(taskResultRun)
        : null;
    const derivedResult =
      task.result === null
        ? childResult
        : task.detailRemoved !== undefined && childResult
          ? childResult
          : task.result;
    const resultTransfers = childControls.contextTransfers.filter(
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
    const resultTransfer = taskResultTransfer(scope.thread.threadId, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const binding = childControls.thread.agentTask;
    const handoff = yield* managedTaskHandoff({
      binding,
      settled: isTerminalTaskStatus(status) && workState === "result_available",
      threadId: task.childThreadId,
      run: taskResultRun ?? childRun,
    });
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : resultText(terminalRun)
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const executionRun =
      task.result === null
        ? (taskResultRun ?? childRun)
        : (childControls.runs.find((run) => run.id === resultTransfer?.sourcePoint.runId) ??
          childRun);
    const modelSelection = executionRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    if (pendingAdvice?.blocking && acknowledgeTerminal && Option.isSome(advice))
      yield* advice.value.suppressWake(scope, task.childThreadId);
    const result = {
      ...(binding === undefined ? {} : { agentTask: binding }),
      ...(handoff === undefined ? {} : { handoff }),
      taskId: task.id,
      childThreadId: task.childThreadId,
      link: formatThreadLink(
        { environmentId: scope.environmentId, threadId: task.childThreadId },
        childControls.thread.title,
      ),
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      ...(task.pausedByParentStop === true ? { pausedByParentStop: true as const } : {}),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      executedModel: runExecutedModel(childControls, executionRun),
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
      ...(pendingAdvice === undefined
        ? {}
        : { pendingAdvice, ...(pendingAdvice.blocking ? { status: "waiting" as const } : {}) }),
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
    const response: OrchestratorMcpDelegateTaskResult =
      endsTaskWait(result) || task.completionDelivery?.state === "disposed"
        ? result
        : { ...result, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT };
    if (
      pendingAdvice === undefined &&
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const parentProjection = yield* loadCallerRecords(scope.thread.threadId, ["runs"]);
      const observingRun = ThreadManagementService.latestActiveRun({
        runs: parentProjection.runs.filter(
          (run) => run.providerInstanceId === scope.thread.providerInstanceId,
        ),
      });
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
          observedByRunId: observingRun?.id ?? null,
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

  /**
   * Blocks for `mode=wait`. A wait that ends without a terminal result, including an
   * interrupted tools/call, upgrades the wake so a later result still reaches the parent.
   */
  const awaitTask = Effect.fn("OrchestratorMcpService.awaitTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    wakePolicyRequestKey: string,
    requestedTimeoutMs: number | undefined,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) =>
      effect,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, requestedTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    const upgradeWake = threadManagement
      .dispatch({
        type: "delegated_task.wake-policy",
        commandId: stableCommandId({
          scope,
          requestKey: wakePolicyRequestKey,
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
    const delivered = (waited: Option.Option<OrchestratorMcpDelegateTaskResult>) =>
      Option.isSome(waited) && isTerminalTaskStatus(waited.value.status);
    // The finalizer runs uninterruptibly, and only the wait and the fallback read are
    // restored, so a cancel just before or after the wait still upgrades without the read
    // acknowledging a result the caller never receives.
    const waited = yield* restore(waitForTask(scope, taskId, timeoutMs)).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && delivered(exit.value) ? Effect.void : upgradeWake,
      ),
    );
    if (Option.isSome(waited) && delivered(waited)) return waited.value;
    return yield* restore(readTask(scope, taskId, Option.isNone(waited), true));
  });

  /**
   * A task that runs in a linked environment, answered from its row here:
   * the follower records its result once its thread there ends.
   */
  const readRemoteTask = Effect.fn("OrchestratorMcpService.readRemoteTask")(function* (
    scope: McpThreadInvocationScope,
    task: OrchestrationV2Subagent,
    waitTimedOut: boolean,
    acknowledgeTerminal: boolean,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const pendingAdvice =
      Option.isSome(advice) && task.remoteChild !== undefined
        ? yield* remoteDelegation.pendingAdvice(task.remoteChild.threadId)
        : undefined;
    if (
      pendingAdvice?.blocking &&
      acknowledgeTerminal &&
      Option.isSome(advice) &&
      task.remoteChild !== undefined
    )
      yield* advice.value.suppressWake(scope, task.remoteChild.threadId);
    const status: OrchestratorMcpDelegateTaskResult["status"] = pendingAdvice?.blocking
      ? "waiting"
      : task.result === null
        ? (yield* remoteDelegation.runStatus(scope, task)) === "starting"
          ? "starting"
          : "running"
        : task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled" ||
            task.status === "interrupted"
          ? task.status
          : "completed";
    const terminal = isTerminalTaskStatus(status);
    if (
      acknowledgeTerminal &&
      terminal &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const parentProjection = yield* loadCallerRecords(scope.thread.threadId, ["runs"]);
      const observingRun = ThreadManagementService.latestActiveRun({
        runs: parentProjection.runs.filter(
          (run) => run.providerInstanceId === scope.thread.providerInstanceId,
        ),
      });
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: yield* requestKey(undefined),
            operation: "task-status-acknowledge",
          }),
          parentThreadId: scope.thread.threadId,
          taskId: task.id,
          observedByRunId: observingRun?.id ?? null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${task.id}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return {
      taskId: task.id,
      childThreadId: null,
      ...(task.remoteChild === undefined
        ? {}
        : {
            remoteChild: task.remoteChild,
            link: formatThreadLink(task.remoteChild, task.remoteChild.title),
          }),
      childRunId: null,
      childNodeId: task.id,
      status,
      workState: terminal ? "result_available" : "working",
      hasPendingChildRuns: false,
      providerInstanceId: task.providerInstanceId,
      model: task.model,
      executedModel: task.executedModel ?? null,
      summary: task.result,
      resultContextTransferId: null,
      latestTerminalRunId: null,
      latestTerminalStatus: terminal
        ? (status as OrchestratorMcpDelegateTaskResult["latestTerminalStatus"])
        : null,
      latestTerminalSummary: terminal ? task.result : null,
      latestTerminalResultContextTransferId: null,
      ...(task.remoteChild?.agentTask === undefined
        ? {}
        : { agentTask: task.remoteChild.agentTask }),
      ...(pendingAdvice === undefined ? {} : { pendingAdvice }),
      // Its questions and approvals are answered in the environment it runs in.
      hasPendingQuestion: terminal ? false : yield* remoteDelegation.pendingThere(scope, task),
      pendingApproval: null,
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // One global cursor before both reads captures later events from either thread.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      // A remote task has no child here; its completion lands on the parent.
      const childThreadId = initial.childThreadId;
      const wakeEvents =
        childThreadId === null
          ? TASK_WAKE_EVENTS.filter(({ thread }) => thread === "parent")
          : TASK_WAKE_EVENTS;
      return yield* Stream.mergeAll(
        wakeEvents.map(({ thread, eventType }) =>
          threadManagement
            .streamStoredEventsFrom({
              threadId:
                thread === "parent" || childThreadId === null
                  ? scope.thread.threadId
                  : childThreadId,
              afterSequence,
              eventType,
            })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  thread === "child" ||
                  event.type !== "subagent.updated" ||
                  event.payload.id === taskId,
              ),
            ),
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

  const scheduledTaskWorkspaceStrategy = Effect.fn(
    "OrchestratorMcpService.scheduledTaskWorkspaceStrategy",
  )(function* (boundToThread: boolean, _projectId: ProjectId) {
    return boundToThread
      ? { type: "root" as const }
      : { type: "root" as const, rootIsDefault: true };
  });

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
   * Creation returns a webhook URL only to callers allowed to start its runs: never a read-only
   * client, and a thread caller only with a live turn at modes covering every mode the task runs at.
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

  const managedDelegation = yield* ManagedDelegation.make({
    failure,
    errorMessage,
    threadManagementFailure,
    isThreadManagementError,
    stableCommandId,
    stableOperationMessageId,
    defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    maxWaitTimeoutMs: MAX_WAIT_TIMEOUT_MS,
    assertLiveCaller,
    awaitTask,
    backgroundSubagentRun,
    parentWorkspaceCwd,
    external,
    externalFailure,
    internalWorkOwner,
    listProjects,
    loadProjection,
    loadProviders,
    loadTasks,
    loadCaller,
    loadCallerRecords,
    loadThreadRecords,
    directChildTaskIds,
    threadRun,
    loadThreadCaller,
    occupantsEverywhere,
    readTask,
    requestKey,
    requireCapability,
    requireProject,
    resolveTargetRechecking,
    waitForTask,
    workError,
  });

  const service: OrchestratorMcpService["Service"] = OrchestratorMcpService.of({
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope, ["runs"]);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (input.modelSelection === undefined &&
          parent !== undefined &&
          parent.thread.projectId === projectId);
      if (input.modelSelection !== undefined && bindToCurrentThread)
        return yield* failure(
          "invalid_request",
          "A bound schedule follows its thread's model. Use bindToCurrentThread: false for an explicit model.",
        );
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        input.modelSelection === undefined
          ? (parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project)))
          : yield* validateScheduledModel(projectId, input.modelSelection, input.agentRole);
      // Never end on a lone high surrogate, which renders as a broken character.
      const derivedTitle = (input.prompt.split("\n")[0]?.trim() ?? "")
        .slice(0, 80)
        .replace(/[\uD800-\uDBFF]$/, "");
      const title = input.title ?? (derivedTitle.length > 0 ? derivedTitle : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        threadMode: input.freshSession
          ? "fresh_session"
          : bindToCurrentThread
            ? "continue"
            : "new_thread",
        purpose: input.purpose,
        workspaceStrategy: yield* scheduledTaskWorkspaceStrategy(bindToCurrentThread, projectId),
        modelSelection,
        ...(input.modelSelection !== undefined
          ? { agentRole: null }
          : input.agentRole === undefined
            ? {}
            : { agentRole: input.agentRole }),
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
        const { parent } = yield* loadCaller(scope, []);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: tasks
            .filter(
              (task) =>
                (projectId === undefined || task.projectId === projectId) &&
                (input.scheduledTaskId === undefined || task.id === input.scheduledTaskId),
            )
            .map((task) => scheduledTaskSummary(task, false)),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope, ["runs"]);
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
        // A save keeps a bound thread unless the task goes back to new threads, so this pair
        // would leave runs in the old thread.
        if (
          input.bindToCurrentThread === false &&
          input.freshSession === true &&
          existing.threadId !== null
        ) {
          return yield* failure(
            "invalid_request",
            "To move this task to a new thread with fresh sessions, first unbind it with bindToCurrentThread: false, then set freshSession: true in a second call.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        if (input.modelSelection !== undefined && threadId !== null)
          return yield* failure(
            "invalid_request",
            "A bound schedule follows its thread's model. Unbind it with bindToCurrentThread: false when changing its model.",
          );
        // Reset the workspace only when the binding flips, so unbinding cannot leave runs in the shared checkout.
        const workspaceStrategy =
          (threadId === null) === (existing.threadId === null)
            ? existing.workspaceStrategy
            : yield* scheduledTaskWorkspaceStrategy(threadId !== null, existing.projectId);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          threadMode:
            input.freshSession === undefined && input.bindToCurrentThread === undefined
              ? scheduledTaskThreadMode(existing)
              : (input.freshSession ??
                  (input.bindToCurrentThread !== false &&
                    scheduledTaskThreadMode(existing) === "fresh_session"))
                ? "fresh_session"
                : threadId === null &&
                    (input.bindToCurrentThread === false ||
                      scheduledTaskThreadMode(existing) === "new_thread")
                  ? "new_thread"
                  : "continue",
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          workspaceStrategy,
          modelSelection:
            input.modelSelection === undefined
              ? existing.modelSelection
              : yield* validateScheduledModel(
                  existing.projectId,
                  input.modelSelection,
                  input.agentRole,
                ),
          ...(input.modelSelection !== undefined
            ? { agentRole: null }
            : input.agentRole === undefined
              ? {}
              : { agentRole: input.agentRole }),
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
        return scheduledTaskSummary(task, false);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope, ["runs"]);
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
    searchSecrets: Effect.fn("OrchestratorMcpService.searchSecrets")(function* (scope, input) {
      yield* loadThreadCaller(scope, "search_secrets");
      if (Option.isNone(savedSecrets))
        return yield* failure(
          "orchestration_error",
          "Bitwarden is not configured on this environment.",
        );
      return yield* savedSecrets.value
        .list(input)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
    }),
    deleteSecret: Effect.fn("OrchestratorMcpService.deleteSecret")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope, ["runs"]);
      yield* assertSettingsWrite(
        scope,
        parent !== undefined &&
          ThreadManagementService.latestActiveRun(parent)?.vaultWriteAuthorized === true,
      );
      if (limits.runtimeMode !== "full-access" || limits.interactionMode !== "default")
        return yield* failure(
          "capability_denied",
          "Deleting saved secrets requires full-access/default mode.",
        );
      if (Option.isNone(savedSecrets))
        return yield* failure(
          "orchestration_error",
          "Bitwarden is not configured on this environment.",
        );
      yield* savedSecrets.value
        .remove(input.id)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      return { deleted: true };
    }),
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
      if (input.savedSecretId !== undefined && input.secretKey === undefined) {
        if (input.storage === "temporary" || input.value !== undefined)
          return yield* failure(
            "invalid_request",
            "Reusing a saved secret requires storage bws and no pasted value.",
          );
        const delivered = yield* secretRequests
          .deliverSaved({
            id: input.savedSecretId,
            threadId,
            requestNamespace: scope.requestNamespace,
            requestKey: yield* requestKey(input.clientRequestId),
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            label: input.label,
          })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { status: "saved" as const, ...delivered };
      }
      let secretProjectId: string | undefined;
      if (input.storage === "bws") {
        if (input.secretKey?.startsWith("BROWSER_LOGIN_"))
          return yield* failure(
            "invalid_request",
            "Manage browser logins in Settings; use them through the bounded browser saved-login binding.",
          );
        if (!input.secretKey || input.value !== undefined)
          return yield* failure(
            "invalid_request",
            "A Bitwarden save needs secretKey and a secure card, not a pasted value.",
          );
        if (Option.isNone(savedSecrets))
          return yield* failure(
            "orchestration_error",
            "Bitwarden is not configured on this environment.",
          );
        const listing = yield* savedSecrets.value
          .list({ query: input.secretKey, limit: 100 })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        secretProjectId = listing.projectId;
        if (
          input.savedSecretId === undefined &&
          listing.entries.some((entry) => entry.key === input.secretKey)
        )
          return yield* failure(
            "invalid_request",
            "That key exists. Reuse its ID, or explicitly select it for replacement.",
          );
        if (
          input.savedSecretId !== undefined &&
          !listing.entries.some((entry) => entry.id === input.savedSecretId)
        )
          return yield* failure(
            "invalid_request",
            "Select the existing secret by its current name and ID before replacing it.",
          );
      }
      // A secret the user already pasted needs no card: it goes straight to a file.
      if (input.value !== undefined) {
        if (input.delivery === "secretRef") {
          return yield* failure(
            "invalid_request",
            'A pasted `value` is saved as a file. Leave out `delivery: "secretRef"`.',
          );
        }
        const file = yield* secretRequests
          .savePasted({
            threadId,
            requestNamespace: scope.requestNamespace,
            requestKey: yield* requestKey(input.clientRequestId),
            value: input.value,
            label: input.label,
          })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        yield* Effect.annotateCurrentSpan({ "secret_request.status": "saved_pasted" });
        yield* Metrics.increment(Metrics.secretRequestsTotal, { status: "saved_pasted" });
        return { status: "saved" as const, file };
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const key = `${runId}:${yield* requestKey(input.clientRequestId)}`;
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
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
            ...(input.delivery === "file" ? { delivery: "file" as const } : {}),
            ...(input.storage === undefined ? {} : { storage: input.storage }),
            ...(input.secretKey === undefined ? {} : { secretKey: input.secretKey }),
            ...(input.savedSecretId === undefined ? {} : { savedSecretId: input.savedSecretId }),
            ...(secretProjectId === undefined ? {} : { secretProjectId }),
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
          // A steering restart replaced the run's root, so this request belonged to
          // the superseded attempt: its card can never be answered into that attempt,
          // and the call must stop blocking the agent's turn.
          if (current.rootNodeId !== nodeId) {
            yield* record("cancelled");
            return "cancelled" as const;
          }
          yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(
              input.timeoutMs ?? DEFAULT_SECRET_REQUEST_TIMEOUT_MS,
              MAX_SECRET_REQUEST_TIMEOUT_MS,
            ),
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
      if (status !== "saved") return { status, note: SECRET_REQUEST_UNSAVED_NOTE[status] };
      if (input.delivery === "file") {
        const file = yield* secretRequests
          .saveToFile({ threadId, turnItemId })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { status, file };
      }
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
      const { parent, limits } = yield* loadCaller(scope, []);
      const cwd = parent === undefined ? undefined : yield* parentWorkspaceCwd(parent);
      const machineProviders = yield* loadProviders;
      const unscanned =
        cwd === undefined
          ? []
          : machineProviders.filter(
              (provider) =>
                provider.enabled &&
                !provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd),
            );
      if (cwd !== undefined && unscanned.length > 0) {
        yield* Effect.forEach(unscanned, (provider) => scanWorkspace(provider.instanceId, cwd), {
          concurrency: "unbounded",
          discard: true,
        });
      }
      const providers = withWorkspaceModels(
        unscanned.length > 0 ? yield* loadProviders : machineProviders,
        cwd,
      );
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      return {
        environmentId: scope.environmentId,
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions:
          knownOptions(
            inherited?.options,
            providers
              .find((provider) => provider.instanceId === inherited?.instanceId)
              ?.models.find((model) => model.slug === inherited?.model)?.capabilities
              ?.optionDescriptors,
          ) ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          // Snapshots list instances any project enables; delegate_task checks the caller's project.
          const enabledForCaller =
            parent === undefined ||
            resolveProjectProviderInstanceEnabled(
              settings,
              parent.thread.projectId,
              provider.instanceId,
            );
          const constraints = providerConstraints(
            enabledForCaller ? provider : { ...provider, enabled: false },
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
      yield* loadCaller(scope, []);
      return yield* experiments.readWork(input, workReader(scope)).pipe(Effect.mapError(workError));
    }),
    attachAgentSession: Effect.fn("OrchestratorMcpService.attachAgentSession")((scope, input) =>
      external.pipe(
        Effect.flatMap((service) =>
          service.attach(scope, input).pipe(Effect.mapError(externalFailure)),
        ),
      ),
    ),
    recordAgentOutcome: Effect.fn("OrchestratorMcpService.recordAgentOutcome")((scope, input) =>
      external.pipe(
        Effect.flatMap((service) =>
          service.recordOutcome(scope, input).pipe(Effect.mapError(externalFailure)),
        ),
      ),
    ),
    agentRoles: managedDelegation.agentRoles,
    delegateTask: managedDelegation.delegateTask,
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
            current.launchState !== "accepted" ||
            current.childThreadId === null
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
    cancelTask: managedDelegation.cancelTask,
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
        const cwd = yield* parentWorkspaceCwd(parent);
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
              // A retry replays the accepted creation, so it needs no reason again.
              if (!isRetryOfAcceptedCreation)
                yield* requireWhyNotDelegated(parent.thread, input.whyNotDelegated);
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
                cwd,
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
              const initialMessage =
                request.prompt === undefined
                  ? undefined
                  : {
                      senderThreadId: scope.thread.threadId,
                      messageId: stableMessageId({
                        scope,
                        requestKey: key,
                        index,
                      }),
                      text: request.prompt,
                      attachments: [],
                    };
              const created = yield* threadManagement
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
                  ...(parent.thread.linkOrigin === undefined
                    ? {}
                    : { linkOrigin: parent.thread.linkOrigin }),
                  ...(initialMessage === undefined ? {} : { initialMessage }),
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              // A replayed creation that carried no prompt has no run yet.
              if (
                initialMessage !== undefined &&
                !created.storedEvents.some(({ event }) => event.type === "run.created")
              ) {
                const currentParent = (yield* loadThreadRecords(scope.thread.threadId, [])).thread;
                const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
                yield* threadManagement
                  .dispatch({
                    ...initialMessage,
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
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.provideService(DispatchModeLimit, {
                      runtimeMode: currentParent.runtimeMode,
                      interactionMode: currentParent.interactionMode,
                      refused,
                    }),
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                          ),
                    ),
                    Effect.catch((error) =>
                      Effect.flatMap(Ref.get(refused), (refusal) =>
                        Effect.fail(
                          refusal === undefined
                            ? error
                            : failure(
                                refusal.mode === "runtime"
                                  ? "runtime_mode_escalation_denied"
                                  : "interaction_mode_escalation_denied",
                                `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's.`,
                              ),
                        ),
                      ),
                    ),
                  );
              }
              if (!isRetryOfAcceptedCreation)
                yield* logWhyNotDelegated({
                  launchedFrom: parent.thread.id,
                  threadId,
                  whyNotDelegated: input.whyNotDelegated,
                });
              const projection = yield* loadThreadRecords(threadId, ["runs"]);
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
                      `Unable to record thread ${index + 1} in the parent timeline: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                link: formatThreadLink(
                  { environmentId: scope.environmentId, threadId },
                  projection.thread.title,
                ),
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
      const { parent } = yield* loadCaller(scope, []);
      if (!input.allProjects && input.projectId !== undefined)
        yield* requireProject(input.projectId);
      const projectId = input.allProjects
        ? null
        : yield* resolveProjectTarget(
            parent,
            input.projectId,
            "Pass projectId, or allProjects: true for every project. This MCP client is not running inside a T3 thread.",
          );
      const listFailure = (error: unknown) =>
        failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`);
      const projectThreads = yield* threadManagement
        .listProjectThreads({
          projectId: projectId ?? undefined,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(Effect.mapError(listFailure));
      const nowMs = yield* Clock.currentTimeMillis;
      // An empty list is no filter: clients that fill every optional field send `[]`.
      const statuses =
        input.statuses === undefined || input.statuses.length === 0
          ? null
          : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      // A live status needs a source the index's mayBeLive covers, so a live-only filter
      // skips building shells for every thread that cannot match.
      const mayBeLiveIds =
        statuses !== null &&
        [...statuses].every((status) => LIVE_LISTED_THREAD_STATUSES.has(status))
          ? new Set(
              (yield* threadManagement
                .listActiveShellIndex()
                .pipe(Effect.mapError(listFailure))).flatMap((entry) =>
                entry.mayBeLive ? [entry.id] : [],
              ),
            )
          : null;
      const candidates = projectThreads
        .filter((thread) => canReadExternalWork(scope, thread))
        .filter((thread) => mayBeLiveIds === null || mayBeLiveIds.has(thread.id))
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        )
        // Only a snooze that ends later can hold, so the rest skip building a shell.
        .filter(
          (thread) =>
            input.snoozed !== true ||
            (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs),
        );
      // Shells are the costly part, so build them only for the threads the page needs.
      const shellsOf = (threads: ReadonlyArray<{ readonly id: ThreadId }>) =>
        threads.length === 0
          ? Effect.succeed([])
          : threadManagement
              .getShellSnapshot({ location: "active", threadIds: threads.map(({ id }) => id) })
              .pipe(
                Effect.map((snapshot) => {
                  const shellsById = new Map(snapshot.threads.map((shell) => [shell.id, shell]));
                  return threads.flatMap(({ id }) => shellsById.get(id) ?? []);
                }),
                Effect.mapError(listFailure),
              );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      let page: ReadonlyArray<OrchestrationV2ThreadShell>;
      let total: number;
      if (statuses === null && input.snoozed === undefined) {
        total = candidates.length;
        page = yield* shellsOf(candidates.slice(cursor, cursor + limit));
      } else {
        // Status and snooze state are derived from the shell.
        const filtered = (yield* shellsOf(candidates))
          .filter((thread) => statuses === null || statuses.has(listedThreadStatus(thread)))
          .filter(
            (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
          );
        total = filtered.length;
        page = filtered.slice(cursor, cursor + limit);
      }
      const nextCursor = cursor + limit < total ? cursor + limit : null;
      return {
        environmentId: scope.environmentId,
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(scope, shell, nowMs)),
        nextCursor,
        total,
        environments: [],
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const runLimit = input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT;
      const { parent, target, shell, runCount } = yield* loadReadableThread(
        scope,
        input.threadId,
        runLimit,
      );
      const view = input.view ?? "messages";
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      // Client callers (the CLI, older linked environments) page forward from a cursorless read.
      const newestFirst =
        input.beforePosition !== undefined ||
        (input.afterPosition === undefined && scope.thread !== undefined);
      const timeline = yield* threadManagement
        .getTimelinePage(input.threadId, {
          ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
          ...(newestFirst
            ? { beforePosition: input.beforePosition ?? Number.POSITIVE_INFINITY }
            : {}),
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of timeline.items) {
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
      const thread = threadDetail(
        scope,
        target,
        runCount,
        timeline.totalItems,
        shell,
        yield* Clock.currentTimeMillis,
        input.afterPosition === undefined &&
          input.beforePosition === undefined &&
          input.itemId === undefined,
      );
      const recentRuns = yield* managedDelegation.recentRunsWithHandoff(
        target,
        target.runs.toSorted((left, right) => right.ordinal - left.ordinal).slice(0, runLimit),
      );
      const { items, start } = timelineItemsWithinBudget(
        {
          environmentId: scope.environmentId,
          thread,
          recentRuns,
          nextPosition: null,
          hasMore: false,
          earlierPosition: null,
        },
        timeline.items.map((row) => ({
          row,
          maxChars,
          messagesByThreadId,
          ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
        })),
        newestFirst,
      );
      const page = timeline.items.slice(start, start + items.length);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined
          ? []
          : directAppOwnedChildTasks(
              {
                thread: parent.thread,
                subagents: yield* loadTasks(
                  parent.thread.id,
                  directChildTaskIds(target, returnedRunIds),
                ),
              },
              target,
              returnedRunIds,
            );
      // A read past the end of an item's text shows the agent nothing to acknowledge.
      const readPastEnd = (input.textOffset ?? 0) > 0 && items.every((item) => !item.text);
      if (parent !== undefined && scope.thread !== undefined && tasks.length > 0 && !readPastEnd) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent.thread.id, target, task);
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
              parentThreadId: parent.thread.id,
              items,
              task,
              target: { ...target, ...resultRecords },
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
      // Reading the result a wait would wake the caller with ends the wait, so the wake cannot
      // arrive after the caller has moved on.
      const callerWatches = parent?.thread.parkedWaits ?? [];
      const callerWatchesTarget = callerWatches.some(
        (watch) => watch.target.kind === "thread" && watch.target.threadId === target.thread.id,
      );
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        (input.textOffset ?? 0) === 0 &&
        (callerWatchesTarget ||
          (callerWatches.length > 0 &&
            queuedThreadWatchWakes(
              yield* loadThreadRecords(scope.thread.threadId, ["runs", "messages"], {
                messageRoles: ["user"],
              }),
              target.thread.id,
            ).length > 0))
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
            .getThreadRecords(target.thread.id, ["messages", "turnItems", "providerTurns"], {
              messageRoles: ["assistant"],
              messageRunIds: [decision.resultRun.id],
              turnItemRunIds: [decision.resultRun.id],
              turnItemTypes: ["assistant_message", "error"],
              providerTurnAttemptIds:
                decision.resultRun.activeAttemptId === null
                  ? []
                  : [decision.resultRun.activeAttemptId],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesRunResult({
              items,
              target: resultRecords,
              run: decision.resultRun,
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
        thread,
        recentRuns,
        items,
        nextPosition: items.at(-1)?.position ?? null,
        hasMore: timeline.hasMore || (!newestFirst && items.length < timeline.items.length),
        earlierPosition: timeline.hasEarlier || start > 0 ? (items[0]?.position ?? null) : null,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId, ["runs"]);
      yield* managedDelegation.assertMaySendToThread(scope, input.threadId, parent, limits, target);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* assertTargetWithinLimits(limits, target.thread);

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
          // A linked environment's agent has no thread here; the link names it.
          ...(parent === undefined && scope.client?.senderThread !== undefined
            ? { linkedSender: scope.client.senderThread }
            : {}),
          messageId,
          text: input.message,
          attachments: [],
          mode,
          ...(input.freshContext ? { freshContext: true } : {}),
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
        link: threadLinkFor(scope, input.threadId, target.thread.title),
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendResult;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { parent, target } = yield* loadScopedThread(scope, input.threadId, []);
      const result = yield* threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
          ...(input.untilDelegatedWorkSettled === true ? { untilDelegatedWorkSettled: true } : {}),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const status = result.run === null ? "idle" : runOutcome(result.run);
      const taskId = result.run?.delegatedTaskId;
      const ownedTask =
        result.timedOut &&
        status !== "waiting" &&
        parent !== undefined &&
        taskId !== undefined &&
        (yield* loadTasks(parent.thread.id, [taskId])).some(
          (task) =>
            task.id === taskId &&
            task.origin === "app_owned" &&
            task.threadId === parent.thread.id &&
            task.childThreadId === input.threadId &&
            task.completionDelivery?.state !== "disposed",
        );
      // A child waiting on a question or approval needs an answer, not a wake.
      const childRequests = ownedTask
        ? (yield* threadManagement
            .getThreadRecords(input.threadId, ["runtimeRequests"])
            .pipe(Effect.mapError(threadManagementFailure))).runtimeRequests
        : [];
      const wakesCaller =
        ownedTask && !childRequests.some((request) => request.status === "pending");
      // A thread waiting on itself is running by definition, so its own standing is not read.
      const standing =
        scope.thread?.threadId === input.threadId
          ? undefined
          : (yield* threadManagement
              .getThreadShell(input.threadId)
              .pipe(Effect.mapError(threadManagementFailure)))?.standing;
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status,
        ...(standing === undefined ? {} : { standing }),
        timedOut: result.timedOut,
        ...(wakesCaller ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : {}),
        ...(result.resultRun === undefined
          ? {}
          : {
              resultRun: { runId: result.resultRun.id, status: runOutcome(result.resultRun) },
            }),
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    watchThread: Effect.fn("OrchestratorMcpService.watchThread")(
      function* (scope, input, watching, remote) {
        yield* requireCapability(scope);
        const { thread } = yield* requireThreadScope(scope, watching ? "watch" : "unwatch");
        const watcher = yield* threadManagement
          .getThreadShell(thread.threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (watcher === null || watcher.deletedAt !== null) {
          return yield* failure("thread_not_found", `Thread ${thread.threadId} was not found.`);
        }
        const watchCommandId = stableCommandId({
          scope,
          requestKey: yield* requestKey(undefined),
          operation: watching ? "watch" : "unwatch",
        });
        const dispatchWatch = (command: Parameters<typeof threadManagement.dispatch>[0]) =>
          threadManagement
            .dispatch(command)
            .pipe(
              Effect.mapError((error) =>
                isThreadManagementError(error)
                  ? threadManagementFailure(error)
                  : failure(
                      "orchestration_error",
                      `Unable to update watch: ${errorMessage(error)}`,
                    ),
              ),
            );
        if (input.target.kind === "owner") {
          const question = input.target.question;
          yield* dispatchWatch({
            type: "thread.thread-watch",
            commandId: watchCommandId,
            threadId: watcher.id,
            target: { kind: "owner", ...(question === undefined ? {} : { question }) },
            watching,
          });
          return {
            target: { kind: "owner" as const, ...(question === undefined ? {} : { question }) },
            watching,
            wasWatching: watcher.ownerWait !== undefined,
          };
        }
        // A watch keeps the canonical number, however the agent named the item.
        const named = input.target;
        const resolveNumber = (reference: string) =>
          forgeWorkItems.resolve(reference).pipe(
            Effect.map((item) => item.number),
            Effect.mapError((error) => failure("invalid_request", error.message)),
          );
        // Stopping a watch never needs Weave for a number, and a ref is matched against the
        // watched items' cached refs first.
        const unwatchNumber = Effect.fnUntraced(function* (reference: string) {
          const parsed = parseForgeReference(reference);
          if (parsed?.kind === "number") return parsed.number;
          const watched = (watcher.parkedWaits ?? []).flatMap((watch) =>
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
        const target: OrchestrationV2ParkedWaitTarget =
          named.kind === "thread"
            ? {
                kind: "thread",
                threadId: named.threadId,
                // Naming this environment is naming no other.
                ...(named.environmentId === undefined || named.environmentId === scope.environmentId
                  ? {}
                  : { environmentId: named.environmentId }),
              }
            : named.kind !== "build_item"
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
        const wasWatching = (watcher.parkedWaits ?? []).some((wait) =>
          parkedWaitTargetsEqual(wait.target, target),
        );
        let title: string | undefined;
        let label: string | undefined;
        if (watching) {
          const refusal = threadWatchRefusal(
            watcher,
            target.kind === "thread" && target.environmentId === undefined
              ? target.threadId
              : undefined,
          );
          if (refusal !== undefined) return yield* failure("invalid_request", refusal);
          if (target.kind === "production") {
            const refusalOfProduction = yield* productionRefusal(watcher, target);
            if (refusalOfProduction !== undefined) {
              return yield* failure("invalid_request", refusalOfProduction);
            }
            title = yield* productionSubject(watcher.id, target.commitId);
          } else if (target.kind === "landing") {
            title = `Landing ${target.operationId}`;
          } else if (target.kind === "thread" && target.environmentId !== undefined) {
            if (remote === undefined)
              return yield* failure(
                "invalid_request",
                "A thread in another environment is watched through the watch tool.",
              );
            title = remote.title;
          } else if (target.kind === "thread") {
            const watched = yield* threadManagement
              .getThreadShell(target.threadId)
              .pipe(Effect.mapError(threadManagementFailure));
            if (watched === null || watched.deletedAt !== null) {
              return yield* failure(
                "thread_not_found",
                `Thread ${target.threadId} is not in this environment. To watch a thread in a linked environment, name it with environmentId.`,
              );
            }
          } else if (target.kind === "build_item") {
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
            // A wait's title is a subject clients set in "{title} is unblocked".
            if (view?.item?.ref != null) title = view.item.ref;
          }
        }
        const expectedMinutes =
          target.kind === "time" ? undefined : (input.expectedMinutes ?? DEFAULT_WAIT_MS / 60_000);
        yield* dispatchWatch({
          type: "thread.thread-watch",
          commandId: watchCommandId,
          threadId: watcher.id,
          target,
          ...(title === undefined ? {} : { title }),
          watching,
          ...(watching && expectedMinutes !== undefined
            ? { expectedMs: expectedMinutes * 60_000 }
            : {}),
          ...(watching && input.note !== undefined ? { note: input.note } : {}),
        });
        if (!watching) {
          return { target, ...(label === undefined ? {} : { label }), watching, wasWatching };
        }
        const after = yield* threadManagement
          .getThreadShell(watcher.id)
          .pipe(Effect.mapError(threadManagementFailure));
        const started = after?.parkedWaits?.find((wait) =>
          parkedWaitTargetsEqual(wait.target, target),
        );
        return {
          target,
          ...(label === undefined ? {} : { label }),
          watching,
          wasWatching,
          ...(started?.givesUpAt === undefined ? {} : { givesUpAt: started.givesUpAt }),
        };
      },
    ),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId, ["runs"]);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* assertTargetWithinLimits(limits, target.thread);
      const key = yield* requestKey(input.clientRequestId);
      // A peer from before `stop` drops it when decoding, so it interrupts
      // the run instead, as this call did then.
      if (input.stop === true) {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "thread-stop" });
        const reason = agentStopReason(input.reason);
        // The cause goes to the log; the caller learns only that the stop failed.
        const stopFailed = (error: unknown) =>
          Effect.logWarning("orchestrator-mcp.thread-stop-failed", {
            threadId: input.threadId,
            error,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                failure("orchestration_error", `Unable to stop thread ${input.threadId}.`),
              ),
            ),
          );
        const stopped = yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: input.threadId,
            reason,
          })
          .pipe(Effect.catch(stopFailed));
        // A retry with the same clientRequestId repeats only the stops that failed.
        yield* threadManagement
          .stopDelegatedTasks({ threadId: input.threadId, commandId, reason })
          .pipe(Effect.catch(stopFailed));
        // The run this stop interrupted, from its own events, so a retry
        // reports the same run even if another has started since. Stop also
        // holds queued runs and marks runs it could not interrupt, with no
        // provider turn; neither is the run it interrupted.
        const interrupted = stopped.storedEvents.find(
          ({ event }) =>
            (event.type === "run.updated" && event.payload.status === "interrupted") ||
            (event.type === "turn-item.updated" &&
              event.payload.type === "run_interrupt_request" &&
              event.payload.providerTurnId !== null),
        )?.event.runId;
        return {
          threadId: input.threadId,
          runId: interrupted ?? null,
          status: interrupted === undefined ? "no_active_run" : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
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
          reason: agentStopReason(input.reason),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
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
  return service;
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Digest.Digest
  | SecureRandom.SecureRandom
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
  | RemoteDelegation.RemoteDelegation
> = Layer.effect(OrchestratorMcpService, make).pipe(Layer.provide(ManagedTaskControl.layer));
