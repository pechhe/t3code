import {
  type AgentTaskBinding,
  type ModelSelection,
  type OrchestrationV2AppThread,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { pinnedBinding } from "../agents/followup.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ProjectStore from "./ProjectStore.ts";
import type { RuntimePolicyResolveError } from "./RuntimePolicy.ts";

type ProviderInstance = Effect.Success<
  ReturnType<ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]["getInstance"]>
>;

/**
 * The runtime policy of a managed task (not a Spec lead): its role's sandbox, approvals and
 * tools, after checking the binding still holds. `fail` builds RuntimePolicy's resolve error.
 */
export const resolve = Effect.fn("RuntimePolicyV2.resolveManaged")(function* <E>(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly agentTask: AgentTaskBinding;
  readonly modelSelection: ModelSelection;
  readonly instance: ProviderInstance;
  readonly cwd: string;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly sandboxTempRootFor: (thread: { readonly id: string }) => Effect.Effect<string, E>;
  readonly compactAt: number | null | undefined;
  readonly modelCompactAt: number | null;
  readonly utilityModel: ProviderAdapter.ProviderAdapterV2RuntimePolicy["utilityModel"];
  readonly fail: (cause?: unknown) => RuntimePolicyResolveError;
}) {
  const { thread, agentTask, modelSelection, instance, cwd, projects, sandboxTempRootFor, fail } =
    input;
  const { compactAt, modelCompactAt, utilityModel } = input;
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  if (Option.isNone(managed) || instance === undefined) return yield* fail();
  const owner = agentTask.externalOwner;
  if (owner !== undefined) {
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    if (
      owner.projectId !== thread.projectId ||
      Option.isNone(environment) ||
      (yield* environment.value.getEnvironmentId) !== owner.environmentId
    )
      return yield* fail();
  }
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const currentSettings = Option.isNone(settings)
    ? undefined
    : yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (
    currentSettings === undefined ||
    !resolveProjectProviderInstanceEnabled(
      currentSettings,
      thread.projectId,
      modelSelection.instanceId,
    )
  )
    return yield* fail();
  // An isolated helper is the only thread in its workspace, so judged as that
  // workspace's own lead it would be refused as the lead's checkout. Its workspace is
  // checked as a separate workspace of the project's repository instead; the lead and
  // live occupants were checked when the task was admitted.
  const isolated = agentTask.workspaceAssignment === "isolated";
  const leadless = isolated || thread.worktreePath === null;
  const projectRoot = isolated
    ? yield* projects.get(thread.projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
        Effect.mapError((cause) => fail(cause)),
      )
    : cwd;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  // Merged snapshots retain cached per-model options (such as Antigravity thought_level) and peer
  // accounts for pooled models; the raw instance snapshot lacks both until each model runs live.
  const registryProviders = Option.isSome(registry)
    ? (yield* registry.value.getProviders.pipe(
        Effect.provideService(ProviderRegistry.ProviderUsageWithoutScan, true),
      )).filter((provider) =>
        resolveProjectProviderInstanceEnabled(
          currentSettings,
          thread.projectId,
          provider.instanceId,
        ),
      )
    : [];
  const providers = registryProviders.some(
    (provider) => provider.instanceId === modelSelection.instanceId,
  )
    ? registryProviders
    : [...registryProviders, yield* instance.snapshot.getSnapshot];
  yield* managed.value
    .validate({
      binding: pinnedBinding(agentTask, thread.followupSourceRevision),
      selection: modelSelection,
      projectId: thread.projectId,
      providers,
      ceiling: thread.runtimeMode,
      runtimeMode: thread.runtimeMode,
      workspacePath: isolated ? null : thread.worktreePath,
      ...(leadless && projectRoot !== undefined ? { projectRoot } : {}),
    })
    .pipe(Effect.mapError((cause) => fail(cause)));
  // A sandboxed writer also writes the repository store it shares with every other
  // workspace, because committing and even reading history snapshot into it, and a temp
  // root of its own outside the workspace, so a build's temp files never land in the
  // checkout it reports.
  const sandboxedWriter =
    agentTask.sourceAccess !== "read-only" && agentTask.executionBoundary !== "trusted-host-access";
  const repositoryRoots = sandboxedWriter ? yield* managed.value.repositoryRoots(agentTask) : [];
  const sandboxTempRoot = sandboxedWriter
    ? yield* sandboxTempRootFor(thread).pipe(Effect.mapError((cause) => fail(cause)))
    : undefined;
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: thread.runtimeMode,
    interactionMode: "default",
    cwd,
    managedAgent: true,
    ...(sandboxTempRoot === undefined ? {} : { sandboxTempRoot }),
    ...(compactAt == null ? {} : { compactAt }),
    ...(modelCompactAt == null ? {} : { modelCompactAt }),
    ...(utilityModel === undefined ? {} : { utilityModel }),
    ...(agentTask.toolProfile === "web-research" ? { webResearch: true } : {}),
    ...(agentTask.sourceAccess === "read-only" &&
    (agentTask.toolProfile === "source-reader" || agentTask.toolProfile === "web-research")
      ? { readOnlyShell: true }
      : {}),
    approvalPolicy: "never",
    sandboxPolicy:
      agentTask.sourceAccess === "read-only"
        ? { type: "readOnly", networkAccess: true }
        : agentTask.executionBoundary === "trusted-host-access"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [
                cwd,
                ...repositoryRoots,
                ...(sandboxTempRoot === undefined ? [] : [sandboxTempRoot]),
              ],
              // An explicitly sandboxed writer still reaches the network for DNS,
              // credentials and installs; its writes stay inside writableRoots.
              networkAccess: true,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
  });
});
