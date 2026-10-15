import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import {
  type AgentTaskRequest,
  type AgentRolesInput,
  type AgentRolesResult,
  AgentExternalSession,
  type AgentPolicySnapshot,
  AuthSessionId,
  type AgentTaskBinding,
  type AgentTaskHandoff,
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
import * as Semaphore from "effect/Semaphore";
import * as Policy from "./AgentPolicyService.ts";
import * as Store from "./AgentPolicyStore.ts";
import * as Resolver from "./AgentRoleResolver.ts";
import * as ProcessRunner from "../processRunner.ts";
import { handoffRevision, repositoryStore } from "./workspaceIdentity.ts";

export const sourceRevisionGuidance =
  "The workspace is not at the stated sourceRevision, or its git tree is not clean. Pass the full commit id of the checkout: `jj log -r @ --no-graph -T commit_id` in a jj workspace, or `git rev-parse HEAD` in a clean git checkout.";

export class ManagedAgentError extends Schema.TaggedError<ManagedAgentError>()(
  "ManagedAgentError",
  {
    reason: Schema.Literals(["policy", "workspace", "source", "selection", "revoked"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const refusal = `Managed agent dispatch refused (${this.reason}).`;
    return this.reason === "source" ? `${refusal} ${sourceRevisionGuidance}` : refusal;
  }
}
/** A thread bound to some workspace; unmanaged threads count as writers. */
export type WorkspaceOccupant = {
  readonly workspacePath: string;
  /** The accountable lead: its root thread, or the external session key. */
  readonly owner: string;
  readonly workId: string | null;
  readonly attemptId: string | null;
  readonly writes: boolean;
  readonly running: boolean;
};
type Authority = {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly ceiling: RuntimeMode;
  /** The accountable lead's own workspace. */
  readonly workspacePath: string | null;
  /** The project's main checkout, which an isolated helper never uses. */
  readonly projectRoot?: string;
  /** Threads bound to workspaces, so an isolated one has one owner and one writer. */
  readonly occupants?: ReadonlyArray<WorkspaceOccupant>;
  /** The accountable lead requesting the work, in the same terms as an occupant's owner. */
  readonly owner?: string;
};
const decodeExternalSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentExternalSession),
);
export class ManagedAgentService extends Context.Service<
  ManagedAgentService,
  {
    readonly snapshot: () => Effect.Effect<AgentPolicySnapshot, ManagedAgentError>;
    readonly roles: (
      input: Omit<Authority, "workspacePath"> & {
        readonly request: AgentRolesInput;
        readonly currentInstanceId?: ProviderInstanceId;
      },
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
        /** A follow-up that stated no source revision; an advisor's workspace must then not be a repository. */
        readonly followupWithoutRevision?: boolean;
      },
    ) => Effect.Effect<void, ManagedAgentError>;
    /** Whether this environment names a policy, readable or not. */
    readonly configured: () => Effect.Effect<boolean>;
    /** Serialises isolated workspace checks with the launch they authorise, across routes. */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The finished source of an isolated scoped-write task, or none for other tasks. */
    readonly handoff: (
      binding: AgentTaskBinding,
    ) => Effect.Effect<AgentTaskHandoff | undefined, ManagedAgentError>;
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
  const workspaceError = (cause: unknown) => new ManagedAgentError({ reason: "workspace", cause });
  const local = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
    );
  const workspace = Effect.fn("ManagedAgentService.workspace")(function* (
    request: AgentTaskRequest,
    authority: Authority,
    writes: boolean,
  ) {
    // Root-bound conversations need no allocated checkout for read-only work.
    // Writers and isolated helpers still require the lead's explicit binding.
    const lead =
      authority.workspacePath ??
      (!writes && (request.workspaceAssignment ?? "lead") === "lead"
        ? authority.projectRoot
        : undefined);
    const expected = request.workspacePath;
    if (lead === undefined || !path.isAbsolute(expected))
      return yield* new ManagedAgentError({ reason: "workspace" });
    if ((request.workspaceAssignment ?? "lead") === "lead") {
      if (expected !== lead) return yield* new ManagedAgentError({ reason: "workspace" });
    } else {
      // An isolated helper gets its own registered workspace of the lead's repository on
      // this host: never the lead's checkout, the main checkout, a subdirectory, another
      // repository, or a workspace another thread is already writing in.
      if (expected === lead || expected === authority.projectRoot)
        return yield* new ManagedAgentError({ reason: "workspace" });
      const [leadStore, childStore] = yield* local(
        Effect.all([repositoryStore(lead), repositoryStore(expected)]),
      ).pipe(Effect.mapError(workspaceError));
      if (leadStore !== childStore) return yield* new ManagedAgentError({ reason: "workspace" });
      // A workspace bound to another lead is theirs even while idle. Under this lead, only
      // the same attempt may continue beside a live writer; a new attempt waits for it.
      if (
        (authority.occupants ?? []).some(
          (occupant) =>
            occupant.workspacePath === expected &&
            (occupant.owner !== authority.owner ||
              (occupant.running &&
                (writes || occupant.writes) &&
                (occupant.workId !== request.workId || occupant.attemptId !== request.attemptId))),
        )
      )
        return yield* new ManagedAgentError({ reason: "workspace" });
    }
    const actual = yield* fs.realPath(expected).pipe(Effect.mapError(workspaceError));
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
  const isolatedLaunches = yield* Semaphore.make(1);
  return ManagedAgentService.of({
    configured: () =>
      Config.option(Config.String("T3CODE_AGENT_POLICY_ROOT")).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      ),
    exclusive: (effect) => isolatedLaunches.withPermit(effect),
    handoff: (binding) =>
      binding.workspaceAssignment !== "isolated" || binding.sourceAccess !== "scoped-write"
        ? Effect.succeed(undefined)
        : local(handoffRevision(binding.workspacePath)).pipe(
            Effect.map((source) => ({ workspacePath: binding.workspacePath, ...source })),
            Effect.tapError((cause) =>
              Effect.logWarning("Unable to read an isolated task's handoff revision.", { cause }),
            ),
            Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })),
          ),
    snapshot: () =>
      currentPolicy.pipe(
        Effect.tap((snapshot) =>
          store
            .save(snapshot)
            .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause }))),
        ),
      ),
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
                ...(input.currentInstanceId === undefined
                  ? {}
                  : { currentInstanceId: input.currentInstanceId }),
                request: {
                  ...input.request,
                  role,
                  workId: "capability-discovery",
                  attemptId: "capability-discovery",
                  workspacePath: "/capability-discovery",
                  ...(role !== "reviewer"
                    ? {}
                    : {
                        review: {
                          scope: input.request.reviewScope ?? "change",
                          baseRevision: "capability-discovery",
                          includedChanges: ["capability-discovery"],
                          specRef: "capability-discovery",
                          specRevision: "capability-discovery",
                          coverage: "complete" as const,
                        },
                      }),
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
      const role = snapshot.manifest.roles[input.request.role];
      yield* workspace(
        input.request,
        input,
        input.request.readOnly !== true && role.sourceAccess === "scoped-write",
      );
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
      yield* workspace(input.binding, input, input.binding.sourceAccess === "scoped-write");
      // An advisor reads a stated revision of a repository; only outside one may it go without.
      if (input.followupWithoutRevision === true && input.binding.role === "advisor") {
        const repository = yield* local(repositoryStore(input.binding.workspacePath)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (repository) return yield* new ManagedAgentError({ reason: "source" });
      }
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
