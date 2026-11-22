import * as ManagedTaskControl from "../agents/ManagedTaskControl.ts";
import * as Champions from "../champions/ChampionService.ts";
import * as DelegationModelShadow from "../agents/DelegationModelShadow.ts";
import * as Digest from "effect/crypto/Digest";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ExternalWork from "../agents/ExternalAgentWorkService.ts";
import { assertBelowDelegationLimit } from "./delegationLimits.ts";
import * as Hex from "effect/encoding/Hex";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { AgentRoleError } from "../agents/AgentRoleResolver.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import { derive as deriveIds } from "@t3tools/provider-core/server/IdAllocator";
import {
  type ExperimentWorkOwner,
  CommandId,
  type RunId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type AgentRolesInput,
  type AgentRolesResult,
  OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpResolvedDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type ProjectId,
  ProviderInstanceId,
  OrchestratorMcpRuntimeMode,
  type OrchestratorMcpThreadRun,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  AGENT_ROLE_COARSE_KIND,
  type AgentTaskCallerRequest,
  type AgentTaskRequest,
  isReviewerRole,
  isDelegatedAppThread,
  READ_ONLY_ROLES,
  isOrchestrationV2TaskClosed,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import { followupBinding, followupPrompt } from "../agents/followup.ts";
import { managedTaskTitle } from "../agents/taskTitle.ts";
import { threadOwner } from "../agents/workspaceIdentity.ts";
import { liveWorkspaceAttachments } from "@t3tools/shared/workspaceAttachments";
import { weaveRepositoryKeyOf } from "@t3tools/shared/projectIdentity";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode, taskPrompt } from "./delegatedTaskModes.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import { revalidateLinkedRole } from "../peer/LinkedRoleAdmission.ts";
import { withRetiredFields } from "../agents/retiredRequestFields.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import type { WorkspaceOccupant } from "../agents/ManagedAgentService.ts";

const isManagedAgentError = Schema.is(ManagedAgent.ManagedAgentError);

const encodeDelegateTaskFingerprint = Schema.encodeEffect(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
);

const namesWorkspace = (task: AgentTaskCallerRequest): task is AgentTaskRequest =>
  task.workspacePath !== undefined;
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

/**
 * Callers ask for one writing role: an `implementer` handed a Forge item owns that whole Spec,
 * which T3 runs, stores and labels as the internal role `lead`. A `lead` request still works.
 */
const asSpecOwner = (
  input: OrchestratorMcpResolvedDelegateTaskInput,
): OrchestratorMcpResolvedDelegateTaskInput =>
  input.agentTask?.role === "implementer" && input.forgeItem !== undefined
    ? { ...input, agentTask: { ...input.agentTask, role: "lead" } }
    : input;

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

const CLOSED_TASK_MESSAGE =
  "This task is closed: task_cancel ended it, or its thread is archived. Delegate a fresh task for new work.";

/** Cancelling a task closes its conversation; a Stop's disposal leaves it open to a follow-up. */
function closedTask(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  childThreadId: ThreadId | null,
): boolean {
  return subagents.some(
    (task) => task.childThreadId === childThreadId && isOrchestrationV2TaskClosed(task),
  );
}

type Failure = OrchestratorMcpFailure;

/** A caller may steer a running task it delegated; a finished one continues through delegate_task. */
function ownsRunningManagedTask(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents"> | undefined,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): boolean {
  return (
    parent !== undefined &&
    target.thread.agentTask !== undefined &&
    target.thread.lineage.parentThreadId === parent.thread.id &&
    target.thread.lineage.relationshipToParent === "subagent" &&
    ThreadManagementService.latestActiveRun(target) !== undefined &&
    parent.subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.threadId === parent.thread.id &&
        task.childThreadId === target.thread.id,
    )
  );
}

const isAgentRoleError = Schema.is(AgentRoleError);
/** Refusals that say a role has no model able to start now, not that the request was wrong. */
const ROLE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "no-eligible-model",
  "usage-limited",
]);
/** The workspace and revision a finished managed task handed back. */
// Untraced: runs inside its tool's span, as the inline code it replaced did.
export const managedTaskHandoff = Effect.fnUntraced(function* (input: {
  readonly binding:
    | Parameters<ManagedAgent.ManagedAgentService["Service"]["handoff"]>[0]
    | undefined;
  readonly settled: boolean;
  readonly threadId: Parameters<
    ManagedAgent.ManagedAgentService["Service"]["handoff"]
  >[1]["threadId"];
  readonly run: OrchestrationV2Run | undefined;
}) {
  const binding = input.binding;
  const managed =
    binding === undefined || !input.settled
      ? Option.none()
      : yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  if (binding === undefined || Option.isNone(managed) || input.run === undefined) return undefined;
  return yield* managed.value
    .handoff(binding, { threadId: input.threadId, runId: input.run.id })
    .pipe(
      Effect.orElseSucceed(() => ({
        workspacePath: binding.workspacePath,
        revision: null,
        quiescent: false,
      })),
    );
});

/** What agent_roles and delegate_task borrow from OrchestratorMcpService's callers and task reads. */
export interface ManagedDelegationDeps {
  readonly failure: (code: Failure["code"], message: string) => Failure;
  readonly errorMessage: (error: unknown) => string;
  readonly threadManagementFailure: (error: unknown) => Failure;
  readonly isThreadManagementError: (
    error: unknown,
  ) => error is ThreadManagementService.ThreadManagementError;
  readonly stableCommandId: (input: {
    readonly scope: McpInvocationScope;
    readonly requestKey: string;
    readonly operation: string;
    readonly index?: number;
  }) => CommandId;
  readonly stableOperationMessageId: (input: {
    readonly scope: McpInvocationScope;
    readonly requestKey: string;
    readonly operation: string;
  }) => MessageId;
  readonly defaultWaitTimeoutMs: number;
  readonly maxWaitTimeoutMs: number;
  readonly assertLiveCaller: (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => Effect.Effect<void, Failure>;
  readonly awaitTask: (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    wakePolicyRequestKey: string,
    requestedTimeoutMs: number | undefined,
    restore?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, Failure>;
  /** A background subagent's delegations join the latest run its thread had once the turn settled. */
  readonly backgroundSubagentRun: (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2Run | undefined, Failure>;
  readonly parentWorkspaceCwd: (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) => Effect.Effect<string | undefined>;
  readonly external: Effect.Effect<ExternalWork.ExternalAgentWorkService["Service"], Failure>;
  readonly externalFailure: (error: ExternalWork.ExternalAgentWorkError) => Failure;
  readonly internalWorkOwner: (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) => Effect.Effect<ExperimentWorkOwner, Failure>;
  readonly listProjects: Effect.Effect<
    Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listShells"]>>,
    Failure
  >;
  readonly loadProjection: (
    threadId: ThreadId,
    includeUserMessages?: boolean,
    subagentIds?: ReadonlyArray<NodeId>,
  ) => Effect.Effect<
    ProjectionRecords<
      | "runs"
      | "subagents"
      | "messages"
      | "providerThreads"
      | "providerTurns"
      | "runtimeRequests"
      | "contextTransfers"
      | "turnItems"
    >,
    Failure
  >;
  readonly loadProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly loadTasks: (
    threadId: ThreadId,
    taskIds: ReadonlyArray<NodeId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, Failure>;
  readonly loadCaller: (
    scope: McpInvocationScope,
    fields: ReadonlyArray<never>,
  ) => Effect.Effect<
    {
      readonly parent: ProjectionRecords<never> | undefined;
      readonly limits: { readonly runtimeMode: RuntimeMode };
    },
    Failure
  >;
  readonly loadThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, Failure>;
  readonly directChildTaskIds: (
    target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
    returnedRunIds: ReadonlySet<RunId | null>,
  ) => ReadonlyArray<NodeId>;
  readonly threadRun: (
    projection: Pick<OrchestrationV2ThreadProjection, "providerTurns">,
    run: OrchestrationV2Run,
  ) => OrchestratorMcpThreadRun;
  readonly loadCallerRecords: <K extends "runs">(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
  ) => Effect.Effect<ProjectionRecords<K>, Failure>;
  readonly loadThreadCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<
    { readonly scope: McpThreadInvocationScope; readonly parent: ProjectionRecords<"runs"> },
    Failure
  >;
  readonly occupantsEverywhere: Effect.Effect<Array<WorkspaceOccupant>, Failure>;
  readonly readTask: (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut?: boolean,
    acknowledgeTerminal?: boolean,
    acknowledgementOperation?: string,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, Failure>;
  readonly requestKey: (clientRequestId: string | undefined) => Effect.Effect<string>;
  readonly requireCapability: (scope: McpInvocationScope) => Effect.Effect<void, Failure>;
  readonly requireProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option.Value<
      Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["getById"]>>
    >,
    Failure
  >;
  readonly resolveTargetRechecking: (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /** The folder whose own provider config can add models. */
    readonly cwd: string | undefined;
    readonly skipProjectEnablementFilter?: boolean;
    readonly roleSelection?: boolean;
    readonly pinned?: boolean;
  }) => Effect.Effect<
    {
      readonly modelSelection: ModelSelection;
      readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
    },
    Failure
  >;
  readonly waitForTask: (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    timeoutMs: number,
  ) => Effect.Effect<Option.Option<OrchestratorMcpDelegateTaskResult>, Failure>;
  readonly workError: () => Failure;
}

/**
 * The fork's agent_roles and delegate_task: roles, follow-ups, advice, review, Champions
 * guards and external callers, in front of the orchestrator's delegated-task command.
 */
export const make = Effect.fn("ManagedDelegation.make")(function* (deps: ManagedDelegationDeps) {
  const {
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
  } = deps;
  const forgeWorkItems = yield* ForgeWorkItems.ForgeWorkItems;
  const experiments = yield* Experiments.ExperimentService;
  const digest = yield* Digest.Digest;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const champions = yield* Effect.serviceOption(Champions.ChampionService);
  const modelShadow = yield* Effect.serviceOption(DelegationModelShadow.DelegationModelShadow);
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;
  const projects = yield* ProjectService.ProjectService;
  const taskControl = yield* ManagedTaskControl.ManagedTaskControl;

  /** A task that names no workspace works in its caller's own, in the task's project. */
  const withTaskWorkspace = Effect.fn("OrchestratorMcpService.withTaskWorkspace")(function* (
    callerScope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) {
    const { agentTask, ...rest } = input;
    const done = (task?: AgentTaskRequest): OrchestratorMcpResolvedDelegateTaskInput =>
      task === undefined ? rest : { ...rest, agentTask: task };
    if (agentTask === undefined) return done();
    if (namesWorkspace(agentTask)) return done(agentTask);
    const resolved = (workspacePath: string) => done({ ...agentTask, workspacePath });
    // A Spec lead is never isolated; its own check names that fix.
    if (agentTask.workspaceAssignment === "isolated" && input.forgeItem === undefined)
      return yield* failure(
        "invalid_request",
        "An isolated task names its own allocated workspace: pass it as agentTask.workspacePath.",
      );
    if (callerScope.thread === undefined) {
      if (callerScope.client === undefined || input.externalSessionKey === undefined)
        return yield* failure(
          "invalid_request",
          "An outside client delegates within its session: pass the externalSessionKey from `t3 agent attach`.",
        );
      const session = yield* (yield* external)
        .session(callerScope, input.externalSessionKey)
        .pipe(Effect.mapError(externalFailure));
      return resolved(session.workspacePath);
    }
    const { parent } = yield* loadThreadCaller(callerScope, "delegate_task");
    // A linked environment's task carries no path or project across the link.
    const linked =
      input.target?.environmentId !== undefined &&
      PeerForwarding.remoteTarget(callerScope, input.target.environmentId) !== undefined;
    const projectId = (linked ? undefined : agentTask.projectId) ?? parent.thread.projectId;
    return resolved(
      callerCheckoutIn(parent.thread, projectId) ??
        (yield* requireProject(projectId)).workspaceRoot,
    );
  });

  const delegateTask = Effect.fn("OrchestratorMcpService.delegateTask")(
    function* (
      callerScope: McpInvocationScope,
      requested: OrchestratorMcpDelegateTaskInput,
    ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
      let input = asSpecOwner(yield* withTaskWorkspace(callerScope, requested));
      if (input.task === undefined && input.followup === undefined)
        return yield* failure(
          "invalid_request",
          "Pass `task` with the work to start, or `followup` with a taskId and changes to continue that conversation.",
        );
      if (
        input.followup !== undefined &&
        (input.agentTask !== undefined ||
          input.target !== undefined ||
          input.isolation !== undefined ||
          input.forgeItem !== undefined ||
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
      if (
        input.followup === undefined &&
        callerScope.endpointKey === "reader" &&
        (input.target?.environmentId !== undefined ||
          input.agentTask === undefined ||
          (!READ_ONLY_ROLES.has(input.agentTask.role) && input.agentTask.readOnly !== true))
      )
        return yield* failure(
          "capability_denied",
          "A read-only agent may delegate only read-only roles, in this environment. Say in your result what an editor should do.",
        );
      // Managed work binds and validates its checkout before launch, so it names one
      // through workspaceAssignment rather than a worktree T3 creates afterwards.
      if (input.agentTask !== undefined && input.isolation === "worktree")
        return yield* failure(
          "invalid_request",
          'isolation "worktree" applies only to a delegation without agentTask; managed work uses agentTask.workspaceAssignment "isolated".',
        );
      const specLead = input.agentTask?.role === "lead";
      if (specLead !== (input.forgeItem !== undefined))
        return yield* failure(
          "invalid_request",
          specLead
            ? "A Spec owner needs its Spec: pass the Forge item as forgeItem, with agentTask role `implementer`."
            : "forgeItem hands a whole Spec to agentTask role `implementer`; other roles take none.",
        );
      if (specLead && input.agentTask?.workspaceAssignment === "isolated")
        return yield* failure(
          "invalid_request",
          "An implementer given a forgeItem works in that Spec's own workspace: omit workspaceAssignment.",
        );
      if (callerScope.client !== undefined && callerScope.thread === undefined) {
        const service = yield* external;
        const accepted = yield* service
          .submit(callerScope, input)
          .pipe(Effect.mapError(externalFailure));
        if (input.mode !== "wait" || accepted.workState === "result_available") return accepted;
        if (accepted.childThreadId === null) return accepted;
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
      const { scope, parent: parentContext } = yield* loadThreadCaller(
        callerScope,
        "delegate_task",
      );
      const key = yield* requestKey(input.clientRequestId);
      const commandId = stableCommandId({
        scope,
        requestKey: key,
        operation: input.followup === undefined ? "delegate-task" : "followup",
      });
      const parent = {
        ...parentContext,
        subagents: yield* loadTasks(scope.thread.threadId, [
          deriveIds.delegatedTaskNode({ commandId }),
          ...(input.followup === undefined ? [] : [input.followup.taskId]),
        ]),
      };
      // A Spec owner is a top-level thread's to hand out; a delegated task never starts one.
      if (
        specLead &&
        (parent.thread.agentTask !== undefined || isDelegatedAppThread(parent.thread))
      )
        return yield* failure(
          "capability_denied",
          "Only a top-level thread hands out a whole Spec, and this thread is itself a delegated task. Build the work yourself, or hand out a piece as an `implementer` without forgeItem.",
        );
      if (input.followup === undefined && input.agentTask !== undefined) {
        const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        if (Option.isSome(managed))
          yield* managed.value
            .assertDelegationAllowed({ thread: parent.thread, request: input.agentTask })
            .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
      }
      let championManagedLaunch = false;
      if (Option.isSome(champions)) {
        let request = input.agentTask;
        let childThreadId: ThreadId | undefined;
        if (input.followup !== undefined) {
          const task = yield* readTask(scope, input.followup.taskId);
          const child =
            task.childThreadId === null
              ? null
              : yield* threadManagement
                  .getThreadShell(task.childThreadId)
                  .pipe(Effect.mapError(threadManagementFailure));
          request = child?.agentTask;
          childThreadId = task.childThreadId ?? undefined;
        }
        const championSelection = yield* champions.value
          .guardDelegation({
            ownerThreadId: parent.thread.id,
            request,
            clientRequestId: input.clientRequestId,
            followup: input.followup !== undefined,
            task: input.task,
            forgeItem: input.forgeItem,
            remote:
              input.target?.environmentId !== undefined &&
              PeerForwarding.remoteTarget(callerScope, input.target.environmentId) !== undefined,
            childThreadId,
          })
          .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
        if (championSelection !== undefined) {
          championManagedLaunch = true;
          const explicit = input.target;
          const selectedProvider = (yield* providerRegistry.getProviders).find(
            (p) => p.instanceId === championSelection.instanceId,
          );
          if (
            (explicit?.model !== undefined && explicit.model !== championSelection.model) ||
            (explicit?.providerInstanceId !== undefined &&
              explicit.providerInstanceId !== championSelection.instanceId) ||
            (explicit?.driverKind !== undefined &&
              explicit.driverKind !== selectedProvider?.driver) ||
            (explicit?.options !== undefined &&
              (explicit.options.length !== (championSelection.options?.length ?? 0) ||
                explicit.options.some(
                  (o) =>
                    !championSelection.options?.some((v) => v.id === o.id && v.value === o.value),
                )))
          )
            return yield* failure(
              "capability_denied",
              "Champion delegation requires the eligible class selection and independent review model; no fallback is allowed.",
            );
          input = {
            ...input,
            target: {
              providerInstanceId: championSelection.instanceId,
              model: championSelection.model,
              options: championSelection.options,
            },
          };
        }
      }

      if (parent.thread.agentTask?.externalOwner !== undefined)
        return yield* failure(
          "capability_denied",
          "Work owned by an outside client can't delegate. Do the work yourself.",
        );
      if (input.followup === undefined)
        yield* assertBelowDelegationLimit(threadManagement, parent.thread);
      // A lead re-reading its Arc after a restart cannot tell a Spec lead it started from one it
      // only planned, so a second start of the same Spec answers with the one already open.
      if (specLead && input.agentTask !== undefined && input.followup === undefined) {
        const { subagents } = yield* threadManagement
          .getThreadRecords(scope.thread.threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (
            task.origin !== "app_owned" ||
            task.childThreadId === null ||
            !isOrchestrationV2WorkActive(task.status)
          ) {
            continue;
          }
          const { thread: child } = yield* threadManagement
            .getThreadRecords(task.childThreadId, [])
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            child.agentTask?.role === "lead" &&
            child.agentTask.workId === input.agentTask.workId
          ) {
            return yield* readTask(scope, task.id, false, false);
          }
        }
      }
      // A Spec lead starts in its parent's own mode, as a thread it launched would.
      const childRuntimeDefault = specLead
        ? Effect.succeed<OrchestratorMcpRuntimeMode>("inherit")
        : serverSettings.getSettings.pipe(
            Effect.map((settings) => settings.delegation.defaultChildRuntimeMode),
            Effect.mapError(() =>
              failure("orchestration_error", "Unable to read delegation settings."),
            ),
          );
      // Role resolution holds a managed task to the same rule, here or at a linked destination.
      if (
        input.agentTask === undefined &&
        input.offPolicyReason !== undefined &&
        input.target?.model !== undefined
      ) {
        const policyService = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        const refusal = Option.isSome(policyService)
          ? yield* policyService.value.offListRefusal(input.target.model)
          : undefined;
        if (refusal !== undefined) return yield* failure("capability_denied", refusal);
      }
      const environmentId =
        input.target === undefined
          ? undefined
          : PeerForwarding.remoteTarget(callerScope, input.target.environmentId);
      if (input.target !== undefined && environmentId !== undefined) {
        yield* requireCapability(callerScope);
        const scope = yield* requireThreadScope(callerScope, "delegate_task");
        // The task's child runs as an ordinary thread there; this thread keeps the task.
        const { taskId } = yield* remoteDelegation.delegate(scope, {
          ...input,
          target: { ...input.target, environmentId },
        });
        return yield* input.mode === "wait"
          ? awaitTask(scope, taskId, taskId, input.timeoutMs)
          : readTask(scope, taskId, false, true);
      }
      if (
        input.target?.projectId !== undefined &&
        input.target.projectId !== parent.thread.projectId
      ) {
        return yield* failure(
          "invalid_request",
          "A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project.",
        );
      }
      const parentRun =
        ThreadManagementService.latestActiveRun(parent) ??
        (yield* backgroundSubagentRun(scope, parent.thread.id));
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
        const remoteTask = parent.subagents.find(
          (task) => task.id === followup.taskId && task.remoteChild !== undefined,
        );
        if (remoteTask !== undefined) {
          const { taskId } = yield* remoteDelegation.followup(scope, remoteTask, {
            text: followupPrompt(followup, input.task),
            clientRequestId: key,
            mode: input.mode,
          });
          return yield* input.mode === "wait"
            ? awaitTask(scope, taskId, taskId, input.timeoutMs)
            : readTask(scope, taskId, false, true);
        }
        if (current.childThreadId === null)
          return yield* failure(
            "invalid_request",
            "A linked task cannot continue as a local managed task.",
          );
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
          (priorTask.childThreadId !== current.childThreadId ||
            // Retention emptied an expired parent's prompt; the child's message is checked below.
            (priorTask.detailRemoved === undefined && priorTask.prompt !== text))
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
        if (closedTask(parent.subagents, current.childThreadId) || child.thread.archivedAt !== null)
          return yield* failure("invalid_request", CLOSED_TASK_MESSAGE);
        if (
          current.workState !== "result_available" ||
          // Status may derive a terminal child result before parent publication.
          // Orchestration creates a consultation task only after that publication.
          !parent.subagents.some((task) => task.id === followup.taskId && task.result !== null) ||
          current.hasPendingChildRuns
        )
          return yield* failure(
            "invalid_request",
            "The agent is busy or awaiting result publication. Retry after publication.",
          );
        const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        if (Option.isNone(managed))
          return yield* failure("capability_denied", "Managed agent policy is unavailable.");
        const consultation = Effect.gen(function* () {
          const refreshed = yield* readTask(scope, followup.taskId);
          const owned = yield* loadProjection(parent.thread.id, true, [
            followup.taskId,
            deriveIds.delegatedTaskNode({ commandId }),
          ]);
          yield* assertLiveCaller(scope, owned);
          if (closedTask(owned.subagents, current.childThreadId))
            return yield* failure("invalid_request", CLOSED_TASK_MESSAGE);
          if (
            refreshed.hasPendingChildRuns ||
            !owned.subagents.some((task) => task.id === followup.taskId && task.result !== null)
          )
            return yield* failure(
              "invalid_request",
              "The agent is busy or awaiting result publication. Retry after publication.",
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
              retainsWorkspace: true,
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
          if (Option.isSome(champions))
            yield* champions.value
              .admitInvestigation({
                ownerThreadId: parent.thread.id,
                parentRunId: parentRun.id,
                binding: followupTarget,
                projectId: taskProjectId,
                workspacePath: followupTarget.workspacePath,
                selection: binding.effective,
                commandId,
                taskId: deriveIds.delegatedTaskNode({ commandId }),
                childThreadId: child.thread.id,
                messageId,
                clientRequestId: input.clientRequestId ?? key,
                followup: true,
              })
              .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
          if (Option.isSome(champions))
            yield* champions.value
              .delegationOutcome({
                ownerThreadId: parent.thread.id,
                request: binding,
                followup: true,
                clientRequestId: input.clientRequestId,
                state: "started",
                commandId,
              })
              .pipe(Effect.mapError((e) => failure("orchestration_error", e.message)));
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
              Effect.tap(() =>
                Option.isSome(champions)
                  ? champions.value
                      .delegationOutcome({
                        ownerThreadId: parent.thread.id,
                        request: binding,
                        clientRequestId: input.clientRequestId,
                        state: "finished",
                        commandId,
                      })
                      .pipe(Effect.mapError((e) => failure("orchestration_error", e.message)))
                  : Effect.void,
              ),
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
      const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
      if (input.agentTask !== undefined && input.clientRequestId === undefined)
        return yield* failure("invalid_request", "Managed work requires a stable clientRequestId.");
      if (
        input.agentTask !== undefined &&
        input.offPolicyReason !== undefined &&
        input.target?.model === undefined
      )
        return yield* failure(
          "invalid_request",
          "offPolicyReason with agentTask requires target.model to name the alternate model.",
        );
      // Managed identity is required by child capabilities, including native Weave access,
      // unless the caller supplies an explicit offPolicyReason explaining why no role fits.
      if (
        input.agentTask === undefined &&
        input.offPolicyReason === undefined &&
        !isRetryOfAcceptedDelegation
      ) {
        const policyService = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
        // A named but unreadable policy still refuses: an outage must not open free choice.
        const configured =
          Option.isSome(policyService) && (yield* policyService.value.configured());
        if (configured)
          return yield* failure(
            "invalid_request",
            "A role policy is configured: call agent_roles, then delegate_task with agentTask (role, taskClass, workId, attemptId). Supply offPolicyReason only if the user forces an off-list model or no configured role fits.",
          );
      }
      // A path the server filled in is not the caller's request: a retry after the caller's
      // checkout moved is still the same request.
      const namedPath = requested.agentTask?.workspacePath !== undefined;
      const callerTask: AgentTaskCallerRequest | undefined =
        input.agentTask === undefined || namedPath
          ? input.agentTask
          : { ...input.agentTask, workspacePath: undefined };
      const fingerprintText = yield* encodeDelegateTaskFingerprint({
        ...input,
        agentTask: callerTask,
        mode: undefined,
        timeoutMs: undefined,
      }).pipe(Effect.orDie);
      const fingerprints = yield* Effect.forEach(withRetiredFields(fingerprintText), (text) =>
        digest
          .digest(Digest.sha256, new TextEncoder().encode(text))
          .pipe(Effect.map(Hex.encode), Effect.orDie),
      );
      const requestFingerprint = fingerprints[0]!;
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
          !fingerprints.includes(prior.requestFingerprint) ||
          prior.workId !== input.agentTask?.workId ||
          prior.attemptId !== input.agentTask?.attemptId ||
          prior.role !== input.agentTask?.role ||
          prior.taskClass !== input.agentTask?.taskClass ||
          (namedPath && prior.workspacePath !== input.agentTask?.workspacePath) ||
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
                    isManagedAgentError(error)
                      ? failure("capability_denied", error.message)
                      : error,
                  ),
                );
      // The caller's checkout in the task's project: its primary workspace at home, or a live
      // attachment elsewhere. Without one, the task never shares a workspace there.
      const leadCheckout = callerCheckoutIn(parent.thread, taskProjectId);
      const foreign = leadCheckout === undefined;
      // A Spec lead runs in its Forge item's own workspace, so the item names the project its
      // child belongs to, whichever project the caller's workspace path pointed at.
      if (specLead && input.forgeItem !== undefined && !isRetryOfAcceptedDelegation) {
        const itemProject = yield* forgeWorkItems.projectOf(input.forgeItem);
        const taskProject = yield* requireProject(taskProjectId);
        const taskRepository = weaveRepositoryKeyOf(taskProject);
        // An unreadable item, or a project T3 knows no repository for, cannot be told apart;
        // only a project the item itself names differently is refused.
        if (
          Option.isSome(itemProject) &&
          taskRepository !== null &&
          itemProject.value.toLowerCase() !== taskRepository.toLowerCase()
        )
          return yield* failure(
            "capability_denied",
            `Forge item ${typeof input.forgeItem === "number" ? `#${input.forgeItem}` : input.forgeItem} belongs to ${itemProject.value}, but this task would run in ${taskProject.title} (${taskRepository}): a \`lead\` task runs in its item's own project, so pass a workspacePath or agentTask.projectId there, or correct this project's Weave repository in its settings if that is what is wrong.`,
          );
      }
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
      let recordedBinding =
        (Option.isSome(champions)
          ? yield* champions.value
              .recordedInvestigationBinding(parent.thread.id, input.clientRequestId)
              .pipe(Effect.mapError((error) => failure("capability_denied", error.message)))
          : undefined) ??
        priorAssignments.find((assignment) => assignment.agentTask !== undefined)?.agentTask;
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
      // A task saved before `demanding` was retired keeps the fingerprint it was bound with.
      const boundFingerprint =
        recordedBinding !== undefined && fingerprints.includes(recordedBinding.requestFingerprint)
          ? recordedBinding.requestFingerprint
          : requestFingerprint;
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
        input.agentTask === undefined
          ? undefined
          : {
              ...input.agentTask,
              ...(taskProjectId === parent.thread.projectId ? {} : { projectId: taskProjectId }),
              ...(input.offPolicyReason === undefined
                ? {}
                : { offPolicyReason: input.offPolicyReason }),
            };
      const prepared =
        managedService === undefined || agentTask === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                input.runtimeMode,
                undefined,
                yield* childRuntimeDefault,
              );
              const observeRole = (available: boolean) =>
                managedService.observeRoleAvailability({
                  threadId: parent.thread.id,
                  context: {
                    projectId: taskProjectId,
                    taskClass: agentTask.taskClass,
                    ceiling: parent.thread.runtimeMode,
                    runtimeMode,
                    ...(agentTask.readOnly === undefined ? {} : { readOnly: agentTask.readOnly }),
                    ...(agentTask.browser === undefined ? {} : { browser: agentTask.browser }),
                    callerModel: parent.thread.modelSelection.model,
                    caller: parent.thread.modelSelection,
                  },
                  roles: [{ role: agentTask.role, available }],
                });
              const candidates = eligibleProviders.filter(
                (provider) =>
                  (input.target?.providerInstanceId === undefined ||
                    provider.instanceId === input.target.providerInstanceId) &&
                  (input.target?.driverKind === undefined ||
                    provider.driver === input.target.driverKind),
              );
              return yield* managedService
                .prepare({
                  runtimeMode,
                  projectId: taskProjectId,
                  request: agentTask,
                  requestFingerprint: boundFingerprint,
                  ...(workUnit === undefined ? {} : { policyHash: workUnit.policyHash }),
                  ...(recordedBinding === undefined ? {} : { recordedBinding }),
                  providers: candidates,
                  ceiling: parent.thread.runtimeMode,
                  workspacePath: leadCheckout ?? null,
                  ...workspaceAuthority,
                  // A Spec lead's item worktree is allocated in the task's project, which
                  // may be another registered one the caller holds no checkout in.
                  ...(specLead ? { allocatesWorkspace: true } : {}),
                  callerModel: parent.thread.modelSelection.model,
                  caller: parent.thread.modelSelection,
                  requireExplicitSelection: true,
                  ...selectionOf(input.target),
                })
                .pipe(
                  Effect.tapError((error) => {
                    const targetPinned =
                      input.target?.model !== undefined ||
                      input.target?.providerInstanceId !== undefined ||
                      input.target?.driverKind !== undefined;
                    return !targetPinned &&
                      error.reason === "selection" &&
                      isAgentRoleError(error.cause) &&
                      ROLE_UNAVAILABLE_REASONS.has(error.cause.reason)
                      ? observeRole(false)
                      : Effect.void;
                  }),
                  Effect.tap(() => observeRole(true)),
                  Effect.mapError((error) => failure("capability_denied", error.message)),
                );
            });
      let target = yield* resolveTargetRechecking({
        parent,
        cwd: yield* parentWorkspaceCwd(parent),
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
        ...(prepared === undefined ? {} : { pinned: prepared.binding.requested.pinned === true }),
      });
      const experimentUnitId =
        prepared === undefined
          ? deriveIds.delegatedTaskNode({ commandId })
          : Experiments.experimentTaskUnitId({
              binding: prepared.binding,
              parentThreadId: parent.thread.id,
              workItemNumber: parent.thread.workItem?.number ?? parent.thread.workspaceIssue,
            });
      const taskAssignments = yield* (
        isRetryOfAcceptedDelegation
          ? experiments.assignments({ unitId: experimentUnitId })
          : experiments.assignForTask({
              ...(prepared === undefined ? {} : { agentTask: prepared.binding }),
              threadId: deriveIds.delegatedTaskThread({ commandId }),
              projectId: taskProjectId,
              modelSelection: target.modelSelection,
              unitId: experimentUnitId,
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
          cwd: yield* parentWorkspaceCwd(parent),
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
        yield* childRuntimeDefault,
      ).pipe(Effect.tapError((error) => recordExperimentFailure(error.message)));
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        input.interactionMode,
      ).pipe(Effect.tapError((error) => recordExperimentFailure(error.message)));
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
      if (input.forgeItem !== undefined && !isRetryOfAcceptedDelegation) {
        // SlipJay's attach-issue always receives the canonical number, so a ref is resolved first.
        const forgeItem =
          typeof input.forgeItem === "string"
            ? (yield* forgeWorkItems.resolve(input.forgeItem).pipe(
                Effect.mapError((error) => failure("invalid_request", error.message)),
                Effect.tapError((error) => recordExperimentFailure(error.message)),
              )).number
            : input.forgeItem;
        workspaceStrategy = { type: "worktree", baseRef: "HEAD", forgeItem };
      }
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
      const launch = Effect.fn("ManagedDelegation.launch")(function* (
        restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
      ) {
        if (prepared !== undefined && managedService !== undefined) {
          // Nothing is committed yet, so a caller that goes away can still stop here.
          yield* restore(
            managedService
              .validate({
                binding: prepared.binding,
                runtimeMode,
                selection: target.modelSelection,
                ...(experimentSelection === undefined ? {} : { treatment: experimentSelection }),
                projectId: taskProjectId,
                providers: eligibleProviders,
                ceiling: parent.thread.runtimeMode,
                workspacePath: leadCheckout ?? null,
                ...(yield* readWorkspaceAuthority),
                ...(specLead ? { allocatesWorkspace: true } : {}),
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
              ),
          );
        }
        if (prepared !== undefined && Option.isSome(champions))
          yield* champions.value
            .admitInvestigation({
              ownerThreadId: parent.thread.id,
              parentRunId: parentRun.id,
              binding: prepared.binding,
              projectId: taskProjectId,
              workspacePath: prepared.binding.workspacePath,
              selection: target.modelSelection,
              commandId,
              taskId: deriveIds.delegatedTaskNode({ commandId }),
              childThreadId: deriveIds.delegatedTaskThread({ commandId }),
              messageId: deriveIds.delegatedTaskMessage({ commandId }),
              clientRequestId: input.clientRequestId ?? key,
              followup: false,
            })
            .pipe(Effect.mapError((error) => failure("capability_denied", error.message)));
        // ThreadManagementService.dispatch is the chokepoint for this command
        // type's own enablement check, using the same command id and its
        // receipt-replay exemption, so no separate assert runs here.
        if (Option.isSome(champions))
          yield* champions.value
            .delegationOutcome({
              ownerThreadId: parent.thread.id,
              request: input.agentTask,
              clientRequestId: input.clientRequestId,
              state: "started",
              commandId,
            })
            .pipe(Effect.mapError((e) => failure("orchestration_error", e.message)));
        return yield* threadManagement
          .dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            parentThreadId: scope.thread.threadId,
            parentRunId: parentRun.id,
            parentNodeId,
            requestFingerprint: boundFingerprint,
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
            Effect.tap(() =>
              Option.isSome(champions)
                ? champions.value
                    .delegationOutcome({
                      ownerThreadId: parent.thread.id,
                      request: input.agentTask,
                      clientRequestId: input.clientRequestId,
                      state: "finished",
                      commandId,
                    })
                    .pipe(Effect.mapError((e) => failure("orchestration_error", e.message)))
                : Effect.void,
            ),
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
                    `Unable to create delegated task: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                  ),
            ),
          );
      });
      // The command commits the child's preparing run, which only this call prepares, so a caller
      // that goes away must not stop it between the dispatch and prepareRun. Waiting for the lock
      // below and the validation before the dispatch stay interruptible.
      let committedTaskId: NodeId | undefined;
      const commit = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* launch(restore);
          if (workUnit !== undefined)
            yield* experiments
              .recordWorkTaskLaunch({
                taskId: deriveIds.delegatedTaskNode({ commandId }),
                state: "accepted",
              })
              .pipe(Effect.mapError(workError));
          if (
            Option.isSome(modelShadow) &&
            managedService !== undefined &&
            prepared !== undefined &&
            !isRetryOfAcceptedDelegation &&
            input.followup === undefined
          ) {
            const { binding } = prepared;
            // Off the request path: nothing waits on it. The eligible list is read in the fork a moment
            // after the launch, so it can differ from the agent's only if a model's availability flips between.
            yield* modelShadow.value.observe({
              threadId: deriveIds.delegatedTaskThread({ commandId }),
              projectId: taskProjectId,
              role: binding.role,
              taskClass: binding.taskClass,
              eligible: DelegationModelShadow.eligibleModels(
                managedService,
                {
                  projectId: taskProjectId,
                  providers: eligibleProviders,
                  ceiling: parent.thread.runtimeMode,
                },
                {
                  role: binding.role,
                  taskClass: binding.taskClass,
                  ...(binding.browser === undefined ? {} : { browser: binding.browser }),
                  ...(binding.executionRequirement === undefined
                    ? {}
                    : { executionRequirement: binding.executionRequirement }),
                  ...(binding.readOnly === undefined ? {} : { readOnly: binding.readOnly }),
                  ...(binding.authorModel === undefined
                    ? {}
                    : { authorModel: binding.authorModel }),
                },
              ),
              chosenModel: target.modelSelection.model,
              reassigned: experimentSelection !== undefined,
              taskText: taskPrompt(input),
            });
          }
          const taskEvent = result.storedEvents.find(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.origin === "app_owned",
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
            (stored) =>
              stored.event.type === "run.created" && stored.event.threadId === childThreadId,
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

          committedTaskId = taskId;
          return taskId;
        }),
      );
      // Isolated writers and pinned readers share one lock, held through prepareRun, so neither
      // launches into a workspace the other just claimed. One mask spans the lock wait to the
      // await, so a caller that leaves after the run commits still reaches the wake upgrade;
      // only the lock wait and the await itself stay interruptible.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const launched = yield* Effect.exit(
            restore(
              (elsewhere || championManagedLaunch) && managedService !== undefined
                ? managedService.exclusive(commit)
                : commit,
            ),
          );
          // An interrupt that lands as the lock is released must not drop a committed run.
          if (committedTaskId === undefined) {
            yield* launched;
            return yield* failure("orchestration_error", "The delegated task was not committed.");
          }
          const taskId = committedTaskId;
          return yield* input.mode === "wait"
            ? awaitTask(scope, taskId, key, input.timeoutMs, restore)
            : restore(readTask(scope, taskId, false, true));
        }),
      );
    },
    (effect, callerScope, input) =>
      effect.pipe(
        Effect.tapError(() => {
          if (Option.isNone(champions) || callerScope.thread === undefined) return Effect.void;
          const ownerThreadId = callerScope.thread.threadId;
          return Effect.gen(function* () {
            let request = (yield* withTaskWorkspace(callerScope, input)).agentTask;
            if (input.followup !== undefined) {
              const records = yield* threadManagement.getThreadRecords(ownerThreadId, [
                "subagents",
              ]);
              const task = records.subagents.find((t) => t.id === input.followup?.taskId);
              if (task?.childThreadId !== null && task?.childThreadId !== undefined)
                request = (yield* threadManagement.getThreadShell(task.childThreadId))?.agentTask;
            }
            yield* champions.value.delegationOutcome({
              ownerThreadId,
              request,
              clientRequestId: input.clientRequestId,
              state: "failed",
              followup: input.followup !== undefined,
            });
          }).pipe(Effect.ignore);
        }),
      ),
  );

  const agentRoles = Effect.fn("OrchestratorMcpService.agentRoles")(function* (
    scope: McpInvocationScope,
    input: AgentRolesInput & { readonly projectId?: ProjectId | undefined },
  ): Effect.fn.Return<AgentRolesResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
    if (Option.isNone(managed))
      return yield* failure("capability_denied", "Managed role policy is unavailable.");
    const { parent, limits } = yield* loadCaller(scope, []);
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
    // A linked environment names the project its task would run in here.
    const { projectId: requestedProject, ...request } = input;
    const projectId = requestedProject ?? session?.projectId ?? parent?.thread.projectId;
    if (projectId === undefined)
      return yield* failure(
        "invalid_request",
        "Pass projectId, or attach an external agent session before discovering roles.",
      );
    if (requestedProject !== undefined) yield* requireProject(requestedProject);
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
        request,
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
    if (parent !== undefined) {
      const pinned = input.model !== undefined || input.providerInstanceId !== undefined;
      const observedRoles = result.roles
        .filter((entry) => entry.role !== "lead")
        .map((entry) => ({
          role: entry.role,
          available: entry.models.some((model) => model.available),
        }))
        .filter((entry) => !pinned || entry.available);
      if (observedRoles.length > 0)
        yield* managed.value.observeRoleAvailability({
          threadId: parent.thread.id,
          context: {
            projectId,
            taskClass: input.taskClass,
            ceiling: limits.runtimeMode,
            ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
            ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
            ...(input.browser === undefined ? {} : { browser: input.browser }),
            callerModel: parent.thread.modelSelection.model,
            caller: parent.thread.modelSelection,
          },
          roles: observedRoles,
        });
    }
    const stance =
      parent === undefined
        ? undefined
        : yield* managed.value
            .resolveStance({ thread: parent.thread })
            .pipe(Effect.mapError(threadManagementFailure));
    return {
      ...result,
      // A Spec owner is asked for as `implementer` with forgeItem; its `lead` row picks the model.
      roles: result.roles.filter((entry) => entry.role !== "lead"),
      ...(stance === undefined ? {} : { stance }),
      environmentId: scope.environmentId,
    };
  });

  /**
   * Runs as a thread read reports them, each with the workspace and revision the run of an
   * isolated writer a linked environment delegated here handed back.
   */
  const recentRunsWithHandoff = Effect.fn("OrchestratorMcpService.recentRunsWithHandoff")(
    function* (
      target: Pick<OrchestrationV2ThreadProjection, "thread" | "providerTurns">,
      runs: ReadonlyArray<OrchestrationV2Run>,
    ) {
      const binding = target.thread.agentTask;
      // Only a task a linked environment delegated here has its caller read it this way.
      const managed =
        target.thread.delegatedFrom != null &&
        binding?.workspaceAssignment === "isolated" &&
        binding.sourceAccess === "scoped-write"
          ? yield* Effect.serviceOption(ManagedAgent.ManagedAgentService)
          : Option.none();
      return yield* Effect.forEach(runs, (run) => {
        const reported = threadRun(target, run);
        if (Option.isNone(managed) || binding === undefined || run.completedAt === null)
          return Effect.succeed(reported);
        return managed.value.handoff(binding, { threadId: target.thread.id, runId: run.id }).pipe(
          Effect.map((handoff) => (handoff === undefined ? reported : { ...reported, handoff })),
          Effect.orElseSucceed(() => reported),
        );
      });
    },
  );

  /** A thread message reaches a managed task only from its owner while it runs, or from the link that delegated it. */
  // Untraced: runs inside its tool's span, as the inline code it replaced did.
  const assertMaySendToThread = Effect.fnUntraced(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
    parent: ProjectionRecords<"runs"> | undefined,
    limits: { readonly runtimeMode: RuntimeMode },
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ): Effect.fn.Return<void, OrchestratorMcpFailure> {
    const managedTarget =
      target.thread.agentTask === undefined || parent === undefined
        ? undefined
        : yield* loadThreadRecords(threadId, ["runs"]);
    const managedParent =
      managedTarget === undefined || parent === undefined
        ? undefined
        : {
            thread: parent.thread,
            subagents: yield* loadTasks(
              parent.thread.id,
              directChildTaskIds(managedTarget, new Set(managedTarget.runs.map((run) => run.id))),
            ),
          };
    // A link continues the managed task it delegated here, as delegate_task's followup does.
    const linkedFollowup =
      parent === undefined &&
      target.thread.agentTask !== undefined &&
      target.thread.delegatedFrom != null &&
      scope.client?.linked === true &&
      target.thread.linkOrigin?.sessionId === scope.client.sessionId;
    if (linkedFollowup) {
      const { runs } = yield* loadThreadRecords(threadId, ["runs"]);
      if (runs.some(ThreadManagementService.isActiveRun))
        return yield* failure(
          "invalid_request",
          "The task is still running here. Retry once its result is published.",
        );
      yield* revalidateLinkedRole({
        thread: { ...target.thread, agentTask: target.thread.agentTask! },
        ceiling: limits.runtimeMode,
      }).pipe(
        Effect.provideService(ProjectService.ProjectService, projects),
        Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistry),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
      );
    } else if (
      target.thread.agentTask !== undefined &&
      (managedTarget === undefined || !ownsRunningManagedTask(managedParent, managedTarget))
    )
      return yield* failure(
        "invalid_request",
        "Use delegate_task with followup to continue a finished managed task, or a fresh managed task for a new independent review round.",
      );
  });

  const cancelTask = Effect.fn("OrchestratorMcpService.cancelTask")(function* (
    callerScope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ): Effect.fn.Return<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure> {
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
      const childThreadId = current.childThreadId;
      if (childThreadId === null) {
        // The task runs in a linked environment: its thread there is stopped through the link.
        const subagents = yield* loadTasks(scope.thread.threadId, [input.taskId]);
        const remoteTask = subagents.find(
          (task) =>
            task.id === input.taskId &&
            task.origin === "app_owned" &&
            task.remoteChild !== undefined,
        );
        if (remoteTask === undefined) {
          return yield* failure(
            "task_not_found",
            `Delegated task ${input.taskId} does not belong to thread ${scope.thread.threadId}.`,
          );
        }
        return yield* remoteDelegation.cancel(scope, remoteTask, input);
      }

      const owner = yield* threadManagement
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (owner === null)
        return yield* failure("task_not_found", "Cancellation owner is unavailable.");
      return yield* taskControl.cancelWithinExclusive(
        {
          ownerThreadId: scope.thread.threadId,
          projectId: owner.projectId,
          taskId: input.taskId,
          childThreadId,
          requestId: yield* requestKey(input.clientRequestId),
          requestNamespace: scope.requestNamespace,
          runtimeMode: owner.runtimeMode,
          interactionMode: owner.interactionMode,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        current,
      );
    });
    return yield* Option.isSome(policy) ? policy.value.exclusive(cancel) : cancel;
  });

  return { agentRoles, assertMaySendToThread, cancelTask, delegateTask, recentRunsWithHandoff };
});
