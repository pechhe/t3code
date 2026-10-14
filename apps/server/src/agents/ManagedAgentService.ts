import {
  type AgentTaskRequest,
  type AgentTaskBinding,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Policy from "./AgentPolicyService.ts";
import * as Store from "./AgentPolicyStore.ts";
import * as Resolver from "./AgentRoleResolver.ts";
import * as ProcessRunner from "../processRunner.ts";

export class ManagedAgentError extends Schema.TaggedError<ManagedAgentError>()(
  "ManagedAgentError",
  {
    reason: Schema.Literals(["policy", "workspace", "source", "selection", "revoked"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed agent dispatch refused (${this.reason}).`;
  }
}
type Authority = {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly ceiling: RuntimeMode;
  readonly workspacePath: string | null;
};
export class ManagedAgentService extends Context.Service<
  ManagedAgentService,
  {
    readonly prepare: (
      input: Authority & {
        readonly request: AgentTaskRequest;
        readonly requestFingerprint: string;
        readonly recordedBinding?: AgentTaskBinding;
        readonly currentInstanceId?: ProviderInstanceId;
        readonly selection?: ModelSelection;
      },
    ) => Effect.Effect<{ binding: AgentTaskBinding; brief: string }, ManagedAgentError>;
    readonly validate: (
      input: Authority & {
        readonly binding: AgentTaskBinding;
        readonly selection: ModelSelection;
      },
    ) => Effect.Effect<void, ManagedAgentError>;
  }
>()("t3/agents/ManagedAgentService") {}

const make = Effect.gen(function* () {
  const policy = yield* Policy.AgentPolicyService;
  const store = yield* Store.AgentPolicyStore;
  const resolver = yield* Resolver.AgentRoleResolver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const currentPolicy = Effect.gen(function* () {
    // Explicit environment-local configuration; installing this feature activates no policy.
    const root = yield* Config.String("T3CODE_AGENT_POLICY_ROOT").pipe(
      Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })),
    );
    return yield* policy
      .snapshot(root)
      .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })));
  });
  const workspace = Effect.fn("ManagedAgentService.workspace")(function* (
    request: AgentTaskRequest,
    expected: string | null,
  ) {
    if (
      expected === null ||
      !path.isAbsolute(request.workspacePath) ||
      request.workspacePath !== expected
    )
      return yield* new ManagedAgentError({ reason: "workspace" });
    const actual = yield* fs
      .realPath(expected)
      .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "workspace", cause })));
    if (actual !== expected) return yield* new ManagedAgentError({ reason: "workspace" });
    const stat = yield* fs
      .stat(actual)
      .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "workspace", cause })));
    if (stat.type !== "Directory") return yield* new ManagedAgentError({ reason: "workspace" });
    if (request.sourceRevision !== undefined) {
      const jj = yield* fs
        .exists(path.join(actual, ".jj"))
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })));
      const output = yield* processes
        .run({
          command: jj ? "jj" : "git",
          args: jj ? ["log", "-r", "@", "--no-graph", "-T", "commit_id"] : ["rev-parse", "HEAD"],
          cwd: actual,
          timeout: "10 seconds",
          maxOutputBytes: 4096,
        })
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })));
      if (output.code !== 0 || output.stdout.trim() !== request.sourceRevision)
        return yield* new ManagedAgentError({ reason: "source" });
      if (!jj) {
        const dirty = yield* processes
          .run({
            command: "git",
            args: ["status", "--porcelain", "--untracked-files=normal"],
            cwd: actual,
            timeout: "10 seconds",
            maxOutputBytes: 4096,
          })
          .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })));
        if (dirty.code !== 0 || dirty.stdout.trim() !== "")
          return yield* new ManagedAgentError({ reason: "source" });
      }
    }
  });
  return ManagedAgentService.of({
    prepare: Effect.fn("ManagedAgentService.prepare")(function* (input) {
      yield* workspace(input.request, input.workspacePath);
      if (
        input.recordedBinding !== undefined &&
        input.recordedBinding.requestFingerprint !== input.requestFingerprint
      )
        return yield* new ManagedAgentError({ reason: "policy" });
      const snapshot =
        input.recordedBinding === undefined
          ? yield* currentPolicy
          : yield* store
              .get(input.recordedBinding.policyHash)
              .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })));
      const selection = yield* resolver
        .resolve({
          ...input,
          snapshot,
          ...(input.recordedBinding === undefined
            ? {}
            : { selection: input.recordedBinding.requested }),
        })
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "selection", cause })));
      yield* store
        .save(snapshot)
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })));
      const role = snapshot.manifest.roles[input.request.role];
      return {
        binding: input.recordedBinding ?? {
          ...input.request,
          requestFingerprint: input.requestFingerprint,
          policyHash: snapshot.hash,
          policyRevision: snapshot.sourceRevision,
          briefHash: snapshot.briefs[input.request.role].hash,
          sourceAccess: input.request.readOnly === true ? "read-only" : role.sourceAccess,
          toolProfile: input.request.readOnly === true ? "source-reader" : role.toolProfile,
          requested: selection,
          assigned: null,
          effective: selection,
        },
        brief: snapshot.briefs[input.request.role].text,
      };
    }),
    validate: Effect.fn("ManagedAgentService.validate")(function* (input) {
      yield* workspace(input.binding, input.workspacePath);
      const snapshot = yield* store
        .get(input.binding.policyHash)
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })));
      const recordedRole = snapshot.manifest.roles[input.binding.role];
      if (
        input.binding.sourceAccess !==
          (input.binding.readOnly === true ? "read-only" : recordedRole.sourceAccess) ||
        input.binding.toolProfile !==
          (input.binding.readOnly === true ? "source-reader" : recordedRole.toolProfile)
      )
        return yield* new ManagedAgentError({ reason: "policy" });
      if (snapshot.briefs[input.binding.role].hash !== input.binding.briefHash)
        return yield* new ManagedAgentError({ reason: "policy" });
      yield* resolver
        .resolve({ ...input, request: input.binding, snapshot })
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "selection", cause })));
      // Preserve the original effort and brief; current policy can revoke authority,
      // but a preference edit cannot rewrite the treatment of an accepted task.
      const current = yield* currentPolicy;
      const role = current.manifest.roles[input.binding.role];
      const allowed =
        role.restrictions[input.binding.taskClass] ?? current.manifest.pools[role.pool].allow;
      const provider = input.providers.find((p) => p.instanceId === input.selection.instanceId);
      if (
        !role.taskClasses.includes(input.binding.taskClass) ||
        (input.binding.sourceAccess === "scoped-write" && role.sourceAccess === "read-only") ||
        !allowed.some((alias) => {
          const model = current.manifest.models[alias];
          return model?.driverKind === provider?.driver && model?.model === input.selection.model;
        })
      )
        return yield* new ManagedAgentError({ reason: "revoked" });
    }),
  });
});
export const layer = Layer.effect(ManagedAgentService, make).pipe(
  Layer.provide(Policy.layer),
  Layer.provide(Store.layer),
  Layer.provide(Resolver.layer),
);
