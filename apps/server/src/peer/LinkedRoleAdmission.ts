import {
  type AgentTaskBinding,
  type AgentTaskLinkedRequest,
  AgentTaskRequest,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RequestedModel } from "../agents/AgentRoleResolver.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { occupantsEverywhere } from "../agents/workspaceIdentity.ts";
import { resolveRuntimeMode } from "../mcp/delegatedTaskModes.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(AgentTaskRequest));

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** The providers the project enables here, which a role may run on. */
const providersFor = Effect.fn("LinkedRoleAdmission.providersFor")(function* (
  projectId: ProjectId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* Effect.filter(
    yield* (yield* ProviderRegistry.ProviderRegistry).getProviders,
    (provider) =>
      threads.isProviderInstanceEnabledForProject({ projectId, instanceId: provider.instanceId }),
  );
});

/** A role a linked environment asked for, bound here and ready to launch. */
export interface AdmittedLinkedRole {
  readonly binding: AgentTaskBinding;
  readonly brief: string;
  readonly runtimeMode: RuntimeMode;
  /** The models this environment's policy offered the role, for the shadow pick (T3-574). */
  readonly eligible: ReadonlyArray<{ readonly model: string; readonly note?: string | undefined }>;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  /** Settles the workspace allocation once the launch has bound it, or gives it back on failure. */
  readonly settle: (launched: boolean) => Effect.Effect<void>;
}

/**
 * Resolves a linked environment's role with the local resolver, capped by the link caller's mode.
 * The caller names no workspace: a reader works in the project's checkout, a writer in one
 * allocated here. Everything that can refuse is checked before that allocation.
 */
export const admitLinkedRole = Effect.fn("LinkedRoleAdmission.admit")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly request: AgentTaskLinkedRequest;
  /** The link caller's mode, already narrowed to the link's access. */
  readonly ceiling: RuntimeMode;
  readonly runtimeMode: RuntimeMode | undefined;
}) {
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  if (Option.isNone(managed) || !(yield* managed.value.configured()))
    return yield* refuse(
      "This environment has no role policy, so it cannot run a managed role. Delegate without agentTask, or run the role in your own environment.",
    );
  const policy = managed.value;
  if (input.request.role === "lead")
    return yield* refuse(
      "A `lead` runs only in its own environment. Delegate the Spec lead here, or launch a thread there with t3_thread_launch.",
    );
  const project = yield* (yield* ProjectService.ProjectService).getById(input.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (project === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Project ${input.projectId} was not found here. t3_project_list lists this environment's projects.`,
    });
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* providersFor(input.projectId);
  const { selection, ...role } = input.request;
  const requested: RequestedModel = {
    ...(selection?.instanceId === undefined ? {} : { instanceId: selection.instanceId }),
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.options === undefined ? {} : { options: selection.options }),
  };
  const requestedSelection: { readonly selection?: RequestedModel } =
    Object.keys(requested).length === 0 ? {} : { selection: requested };
  const failed = (error: { readonly message: string }) => refuse(error.message);
  // The role's row as discovery here reports it: a missing role, no eligible model or a model
  // the role's list lacks is refused here, before any workspace is allocated.
  const roles = yield* policy
    .roles({
      projectId: input.projectId,
      providers,
      ceiling: input.ceiling,
      request: {
        taskClass: role.taskClass,
        ...(role.browser === undefined ? {} : { browser: role.browser }),
        ...(role.executionRequirement === undefined
          ? {}
          : { executionRequirement: role.executionRequirement }),
        ...(role.readOnly === undefined ? {} : { readOnly: role.readOnly }),
        ...(role.authorModel === undefined ? {} : { authorModel: role.authorModel }),
        ...(selection?.instanceId === undefined
          ? {}
          : { providerInstanceId: selection.instanceId }),
        ...(selection?.model === undefined ? {} : { model: selection.model }),
      },
      ...requestedSelection,
    })
    .pipe(Effect.mapError(failed));
  const row = roles.roles.find((candidate) => candidate.role === role.role);
  if (row === undefined)
    return yield* refuse(
      `This environment's role policy has no \`${role.role}\` role. agent_roles with this environmentId lists the roles here.`,
    );
  const offPolicyWithModel = role.offPolicyReason !== undefined && selection?.model !== undefined;
  if (
    selection?.model !== undefined &&
    role.offPolicyReason === undefined &&
    !row.models.some((m) => m.model === selection.model)
  )
    return yield* refuse(
      `${selection.model} is not on this environment's list for \`${role.role}\` (${row.models.map((m) => m.model).join(", ") || "none"}). Omit target.model to let it choose, or pick one agent_roles with this environmentId lists.`,
    );
  if (!offPolicyWithModel && (row.refusal !== null || row.selection === null))
    return yield* refuse(
      `This environment cannot start \`${role.role}\` now: ${row.refusal ?? "no eligible model"}. agent_roles with this environmentId says why.`,
    );
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Unable to read delegation settings.",
        }),
    ),
  );
  const runtimeMode = yield* resolveRuntimeMode(
    input.ceiling,
    input.runtimeMode,
    undefined,
    settings.delegation.defaultChildRuntimeMode,
  );
  const writes = row.sourceAccess === "scoped-write" && role.readOnly !== true;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  let allocation: { readonly workspacePath: string; readonly attemptId: string } | undefined;
  if (writes) {
    if ((yield* workspaces.resolve(project.workspaceRoot)) !== "slipjay")
      return yield* refuse(
        `A writing role here needs its own workspace, which this environment allocates only in a SlipJay project, and ${project.title} is not one. Send a read-only role, or a writer to a SlipJay project there.`,
      );
    allocation = yield* workspaces
      .allocate({
        projectRoot: project.workspaceRoot,
        task: input.title,
        owner: { kind: "thread-launch", ref: input.threadId },
        ...(project.weaveRepositoryKey ? { forgeProject: project.weaveRepositoryKey } : {}),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Unable to allocate a workspace here: ${error.message}`,
            }),
        ),
      );
  }
  const workspacePath = allocation?.workspacePath ?? project.workspaceRoot;
  const request: AgentTaskRequest = {
    ...role,
    workspacePath,
    ...(writes ? { workspaceAssignment: "isolated" as const } : {}),
  };
  const authority = {
    projectId: input.projectId,
    providers,
    ceiling: input.ceiling,
    runtimeMode,
    workspacePath: null,
    projectRoot: project.workspaceRoot,
    owner: input.threadId,
    occupants: yield* occupantsEverywhere(yield* ProjectService.ProjectService, threads).pipe(
      Effect.orElseSucceed(() => []),
    ),
  };
  const digest = yield* Digest.Digest;
  const encoded = yield* encodeRequest(request).pipe(Effect.orDie);
  const requestFingerprint = Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(encoded)).pipe(Effect.orDie),
  );
  const giveBack = (launched: boolean) =>
    allocation === undefined
      ? Effect.void
      : launched
        ? workspaces.settled(allocation.attemptId)
        : workspaces.abandon(allocation.attemptId);
  const prepared = yield* policy
    .prepare({
      ...authority,
      request,
      requestFingerprint,
      requireExplicitSelection: true,
      ...requestedSelection,
    })
    .pipe(
      Effect.tap((prepared) =>
        policy.validate({
          ...authority,
          binding: prepared.binding,
          selection: prepared.binding.effective,
        }),
      ),
      Effect.mapError(failed),
      Effect.tapError(() => giveBack(false)),
    );
  return {
    binding: prepared.binding,
    brief: prepared.brief,
    runtimeMode,
    eligible: row.models
      .filter((entry) => entry.available)
      .map(({ model, note }) => ({ model, note })),
    workspaceStrategy:
      allocation === undefined
        ? { type: "root" }
        : { type: "existing_worktree", worktreePath: allocation.workspacePath },
    settle: giveBack,
  } satisfies AdmittedLinkedRole;
});

/**
 * A follow-up a link sends to the managed task it started here: the same binding must still
 * pass this environment's policy, in the workspace it was given, within the caller's mode.
 */
export const revalidateLinkedRole = Effect.fn("LinkedRoleAdmission.revalidate")(function* (input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly runtimeMode: RuntimeMode;
    readonly agentTask: AgentTaskBinding;
  };
  readonly ceiling: RuntimeMode;
}) {
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  if (Option.isNone(managed))
    return yield* refuse("This environment's role policy is unavailable.");
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(input.thread.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* providersFor(input.thread.projectId);
  yield* resolveRuntimeMode(input.ceiling, input.thread.runtimeMode);
  yield* managed.value
    .validate({
      binding: input.thread.agentTask,
      selection: input.thread.agentTask.effective,
      projectId: input.thread.projectId,
      providers,
      ceiling: input.ceiling,
      runtimeMode: input.thread.runtimeMode,
      workspacePath: null,
      ...(project === undefined ? {} : { projectRoot: project.workspaceRoot }),
      owner: input.thread.id,
      retainsWorkspace: true,
      occupants: yield* occupantsEverywhere(projects, threads, input.thread.id).pipe(
        Effect.orElseSucceed(() => []),
      ),
    })
    .pipe(Effect.mapError((error) => refuse(error.message)));
});
