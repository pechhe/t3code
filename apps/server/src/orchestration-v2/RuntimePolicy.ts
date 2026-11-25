import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { blackholeCompactPolicy } from "../blackhole/blackholeRuntimePolicy.ts";
import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  isLeafAgentTask,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";
import * as ManagedRuntimePolicy from "./ManagedRuntimePolicy.ts";

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

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
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
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
      ...(input.thread.compactAt == null ? {} : { compactAt: input.thread.compactAt }),
    });
  }),
});

export function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerConfig.ServerConfig
  | Path.Path
  | Digest.Digest
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const crypto = yield* Digest.Digest;
    /**
     * One managed task's temp root. Keyed by a digest of the thread, because a delegated id is
     * long and not path-safe; short keeps a tool's socket under macOS's 104-byte cap. The pid
     * keeps one server's roots apart, so a start sweeps only a dead server's.
     */
    const sandboxTempRootFor = Effect.fn("RuntimePolicyV2.sandboxTempRoot")(function* (thread: {
      readonly id: string;
    }) {
      const digest = yield* crypto.digest(Digest.sha256, new TextEncoder().encode(thread.id));
      return path.join(config.sandboxTempDir, `${process.pid}-${Hex.encode(digest).slice(0, 16)}`);
    });
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
        const supportedRuntimeModes = snapshot?.supportedRuntimeModes;
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
        const serverSettings = yield* Effect.serviceOption(
          ServerSettings.ServerSettingsService,
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (service) => service.getSettings.pipe(Effect.orElseSucceed(() => null)),
            }),
          ),
        );
        // The point set for this thread's model in the server settings.
        const modelCompactAt = serverSettings?.modelCompactAt[input.modelSelection.model] ?? null;
        const utilityModel = serverSettings === null ? undefined : utilityModelOf(serverSettings);
        // The thread's own point, else the one set for its model in the server settings; on a
        // thread Blackhole compacts, the native point is its backstop (fork: T3-916).
        const compactAt = blackholeCompactPolicy({
          blackhole: serverSettings?.blackhole,
          driver: instance?.driverKind,
          compactAt: input.thread.compactAt ?? modelCompactAt,
          windowTokens: snapshot?.models?.find((model) => model.slug === input.modelSelection.model)
            ?.contextWindowTokens,
        });
        // A Spec lead runs under a top-level thread's policy; its role was admitted at dispatch.
        if (input.thread.agentTask !== undefined && isLeafAgentTask(input.thread.agentTask))
          return yield* ManagedRuntimePolicy.resolve({
            thread: input.thread,
            agentTask: input.thread.agentTask,
            modelSelection: input.modelSelection,
            instance,
            cwd,
            projects,
            sandboxTempRootFor,
            compactAt,
            modelCompactAt,
            utilityModel,
            fail: (cause) =>
              new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                ...(cause === undefined ? {} : { cause }),
              }),
          });
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(compactAt == null ? {} : { compactAt }),
          ...(modelCompactAt == null ? {} : { modelCompactAt }),
          ...(utilityModel === undefined ? {} : { utilityModel }),
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
    });
  }),
);

function utilityModelOf(settings: ServerSettingsValue) {
  const selection = settings.textGenerationModelSelection;
  const instance = Object.hasOwn(settings.providerInstances, selection.instanceId)
    ? settings.providerInstances[selection.instanceId]
    : undefined;
  const thinking = getModelSelectionStringOptionValue(selection, "thinking");
  return {
    driver: instance?.driver ?? selection.instanceId,
    model: selection.model,
    ...(thinking === undefined ? {} : { thinking }),
  };
}

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
                ...(override.runtimeMode === undefined
                  ? {}
                  : { runtimeMode: override.runtimeMode }),
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
