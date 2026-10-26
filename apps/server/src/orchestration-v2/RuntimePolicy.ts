import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
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
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";
import { pinnedBinding } from "../agents/followup.ts";

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

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

// The thread's `compactAt` rides on every policy built here. Only the Claude and Codex adapters
// read it: no other provider is known to compact natively, so the rest ignore it.
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
      ...(input.thread.compactAt == null ? {} : { compactAt: input.thread.compactAt }),
    }),
});

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
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerConfig.ServerConfig
  | Path.Path
  | Crypto.Crypto
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    /**
     * One managed task's temp root. Keyed by a digest of the thread, because a delegated id is
     * long and not path-safe; short keeps a tool's socket under macOS's 104-byte cap. The pid
     * keeps one server's roots apart, so a start sweeps only a dead server's.
     */
    const sandboxTempRootFor = Effect.fn("RuntimePolicyV2.sandboxTempRoot")(function* (thread: {
      readonly id: string;
    }) {
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(thread.id));
      return path.join(config.sandboxTempDir, `${process.pid}-${Hex.encode(digest).slice(0, 16)}`);
    });
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
        // The point set for this thread's model in the server settings.
        const modelCompactAt = yield* Effect.serviceOption(
          ServerSettings.ServerSettingsService,
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (service) =>
                service.getSettings.pipe(
                  Effect.map((value) => value.modelCompactAt[input.modelSelection.model] ?? null),
                  Effect.orElseSucceed(() => null),
                ),
            }),
          ),
        );
        // The thread's own point, else the one set for its model in the server settings.
        const compactAt = input.thread.compactAt ?? modelCompactAt;
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
              binding: pinnedBinding(input.thread.agentTask, input.thread.followupSourceRevision),
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
          // A sandboxed writer also writes the repository store it shares with every other
          // workspace, because committing and even reading history snapshot into it, and a temp
          // root of its own outside the workspace, so a build's temp files never land in the
          // checkout it reports.
          const sandboxedWriter =
            input.thread.agentTask.sourceAccess !== "read-only" &&
            input.thread.agentTask.executionBoundary !== "trusted-host-access";
          const repositoryRoots = sandboxedWriter
            ? yield* managed.value.repositoryRoots(input.thread.agentTask)
            : [];
          const sandboxTempRoot = sandboxedWriter
            ? yield* sandboxTempRootFor(input.thread).pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
              )
            : undefined;
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: input.thread.runtimeMode,
            interactionMode: "default",
            cwd,
            managedAgent: true,
            ...(sandboxTempRoot === undefined ? {} : { sandboxTempRoot }),
            ...(compactAt == null ? {} : { compactAt }),
            ...(modelCompactAt == null ? {} : { modelCompactAt }),
            ...(input.thread.agentTask.toolProfile === "web-research" ? { webResearch: true } : {}),
            approvalPolicy: "never",
            sandboxPolicy:
              input.thread.agentTask.sourceAccess === "read-only"
                ? { type: "readOnly", networkAccess: false }
                : input.thread.agentTask.executionBoundary === "trusted-host-access"
                  ? { type: "dangerFullAccess" }
                  : {
                      type: "workspaceWrite",
                      writableRoots: [
                        cwd,
                        ...repositoryRoots,
                        ...(sandboxTempRoot === undefined ? [] : [sandboxTempRoot]),
                      ],
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
          ...(compactAt == null ? {} : { compactAt }),
          ...(modelCompactAt == null ? {} : { modelCompactAt }),
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
