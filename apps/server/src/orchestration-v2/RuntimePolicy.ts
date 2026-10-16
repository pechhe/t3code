import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import {
  ModelSelection,
  resolveProjectProviderInstanceEnabled,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";
import { pinsFollowupRevision } from "../agents/followup.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having T3 imitate it.
 */
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        if (input.thread.agentTask !== undefined) {
          const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
          if (Option.isNone(managed) || instance === undefined)
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
            });
          const owner = input.thread.agentTask.externalOwner;
          if (owner !== undefined) {
            const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
            if (
              owner.projectId !== input.thread.projectId ||
              Option.isNone(environment) ||
              (yield* environment.value.getEnvironmentId) !== owner.environmentId
            )
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
              });
          }
          const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
          if (
            Option.isNone(settings) ||
            !(yield* settings.value.getSettings.pipe(
              Effect.map((value) =>
                resolveProjectProviderInstanceEnabled(
                  value,
                  input.thread.projectId,
                  input.modelSelection.instanceId,
                ),
              ),
              Effect.orElseSucceed(() => false),
            ))
          )
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
            });
          // An isolated helper is the only thread in its workspace, so judged as that
          // workspace's own lead it would be refused as the lead's checkout. Its workspace is
          // checked as a separate workspace of the project's repository instead; the lead and
          // live occupants were checked when the task was admitted.
          const isolated = input.thread.agentTask.workspaceAssignment === "isolated";
          const leadless = isolated || input.thread.worktreePath === null;
          const projectRoot = isolated
            ? yield* projects.get(input.thread.projectId).pipe(
                Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
              )
            : cwd;
          yield* managed.value
            .validate({
              binding:
                input.thread.followupSourceRevision !== undefined &&
                pinsFollowupRevision(input.thread.agentTask)
                  ? {
                      ...input.thread.agentTask,
                      sourceRevision: input.thread.followupSourceRevision,
                    }
                  : input.thread.agentTask,
              selection: input.modelSelection,
              projectId: input.thread.projectId,
              providers: [yield* instance.snapshot.getSnapshot],
              ceiling: input.thread.runtimeMode,
              runtimeMode: input.thread.runtimeMode,
              workspacePath: isolated ? null : input.thread.worktreePath,
              ...(leadless && projectRoot !== undefined ? { projectRoot } : {}),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
          // A sandboxed isolated writer also writes the repository store it shares with every
          // other workspace, because committing and even reading history snapshot into it.
          const repositoryRoots =
            isolated &&
            input.thread.agentTask.sourceAccess !== "read-only" &&
            input.thread.agentTask.executionBoundary !== "trusted-host-access"
              ? yield* managed.value.repositoryRoots(input.thread.agentTask)
              : [];
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: input.thread.runtimeMode,
            interactionMode: "default",
            cwd,
            managedAgent: true,
            ...(input.thread.agentTask.toolProfile === "web-research" ? { webResearch: true } : {}),
            approvalPolicy: "never",
            sandboxPolicy:
              input.thread.agentTask.sourceAccess === "read-only"
                ? { type: "readOnly", networkAccess: false }
                : input.thread.agentTask.executionBoundary === "trusted-host-access"
                  ? { type: "dangerFullAccess" }
                  : {
                      type: "workspaceWrite",
                      writableRoots: [cwd, ...repositoryRoots],
                      networkAccess: false,
                      excludeTmpdirEnvVar: true,
                      excludeSlashTmp: true,
                    },
          });
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
