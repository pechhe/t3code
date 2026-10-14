import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import {
  type AgentTaskRequest,
  type AgentRolesInput,
  type AgentRolesResult,
  AgentExternalSession,
  AuthSessionId,
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
const decodeExternalSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentExternalSession),
);
export class ManagedAgentService extends Context.Service<
  ManagedAgentService,
  {
    readonly roles: (
      input: Omit<Authority, "workspacePath"> & { readonly request: AgentRolesInput },
    ) => Effect.Effect<Omit<AgentRolesResult, "environmentId">, ManagedAgentError>;
    readonly prepare: (
      input: Authority & {
        readonly request: AgentTaskRequest;
        readonly requestFingerprint: string;
        readonly recordedBinding?: AgentTaskBinding;
        readonly policyHash?: string;
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
  const sql = yield* SqlClient.SqlClient;
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
    roles: Effect.fn("ManagedAgentService.roles")(function* (input) {
      const snapshot = yield* currentPolicy;
      const roles = yield* Effect.forEach(
        Object.entries(snapshot.manifest.roles),
        ([name, policy]) =>
          Effect.gen(function* () {
            const role = name as AgentTaskRequest["role"];
            const result = yield* Effect.result(
              resolver.resolve({
                snapshot,
                providers: input.providers,
                ceiling: input.ceiling,
                request: {
                  ...input.request,
                  role,
                  workId: "capability-discovery",
                  attemptId: "capability-discovery",
                  workspacePath: "/capability-discovery",
                },
              }),
            );
            return {
              role,
              briefHash: snapshot.briefs[role].hash,
              sourceAccess:
                input.request.readOnly === true ? ("read-only" as const) : policy.sourceAccess,
              toolProfile:
                input.request.readOnly === true ? ("source-reader" as const) : policy.toolProfile,
              selection: result._tag === "Success" ? result.success : null,
              refusal: result._tag === "Failure" ? result.failure.reason : null,
            };
          }),
      );
      return { policyHash: snapshot.hash, policyRevision: snapshot.sourceRevision, roles };
    }),
    prepare: Effect.fn("ManagedAgentService.prepare")(function* (input) {
      yield* workspace(input.request, input.workspacePath);
      if (
        input.recordedBinding !== undefined &&
        input.recordedBinding.requestFingerprint !== input.requestFingerprint
      )
        return yield* new ManagedAgentError({ reason: "policy" });
      const snapshot =
        input.recordedBinding === undefined && input.policyHash === undefined
          ? yield* currentPolicy
          : yield* store
              .get(input.recordedBinding?.policyHash ?? input.policyHash!)
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
      const owner = input.binding.externalOwner;
      if (owner !== undefined) {
        const auth = yield* Effect.serviceOption(AuthSessions.AuthSessionRepository);
        if (Option.isNone(auth)) return yield* new ManagedAgentError({ reason: "revoked" });
        const session = yield* auth.value
          .getById({ sessionId: AuthSessionId.make(owner.clientSessionId) })
          .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "revoked", cause })));
        const now = yield* DateTime.now;
        if (
          Option.isNone(session) ||
          session.value.subject !== "mcp-client" ||
          session.value.revokedAt !== null ||
          session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
          !session.value.scopes.includes("orchestration:operate")
        )
          return yield* new ManagedAgentError({ reason: "revoked" });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM external_agent_sessions WHERE session_key = ${owner.externalSessionKey}`.pipe(
          Effect.mapError((cause) => new ManagedAgentError({ reason: "revoked", cause })),
        );
        if (rows[0] === undefined) return yield* new ManagedAgentError({ reason: "revoked" });
        const registered = yield* decodeExternalSession(rows[0].payload_json).pipe(
          Effect.mapError((cause) => new ManagedAgentError({ reason: "revoked", cause })),
        );
        if (
          registered.clientSessionId !== owner.clientSessionId ||
          registered.environmentId !== owner.environmentId ||
          registered.projectId !== owner.projectId ||
          registered.ceiling !== owner.ceiling ||
          registered.workspacePath !== input.workspacePath ||
          input.ceiling !== owner.ceiling
        )
          return yield* new ManagedAgentError({ reason: "revoked" });
      }
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
