import * as PhiBrowser from "../preview/PhiBrowser.ts";
import * as Settings from "../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { defaultChildMode, exceedsCaller } from "./delegationRuntime.ts";
import { checkWriterWorkspace } from "./writerWorkspacePreflight.ts";
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
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  isReviewerRole,
  readOnlyToolProfile,
  REVIEWER_SCOPE,
  usesPhi,
  type AgentToolProfile,
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
import {
  checkoutRoot,
  containingRepositoryStore,
  handoffRevision,
  repositoryStore,
  repositoryWriteRoots,
} from "./workspaceIdentity.ts";

export const sourceRevisionGuidance =
  "The workspace is not at the stated sourceRevision, or its git tree is not clean. Pass the full commit id of the checkout: `jj log -r @ --no-graph -T commit_id` in a jj workspace, or `git rev-parse HEAD` in a clean git checkout.";

const isAgentRoleError = Schema.is(Resolver.AgentRoleError);

export class ManagedAgentError extends Schema.TaggedError<ManagedAgentError>()(
  "ManagedAgentError",
  {
    reason: Schema.Literals(["policy", "workspace", "source", "selection", "revoked", "hard-link"]),
    path: Schema.optional(Schema.String),
    /** Which workspace rule refused, so the caller can correct the request. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "hard-link")
      return `Managed writer refused: regular file has multiple hard links: ${this.path}.`;
    const detail = isAgentRoleError(this.cause)
      ? `: ${this.cause.reason}${this.cause.candidates === undefined ? "" : ` (${[...new Set(this.cause.candidates.map((candidate) => candidate.reason))].join(", ")})`}`
      : this.detail === undefined
        ? ""
        : `: ${this.detail}`;
    const refusal = `Managed agent dispatch refused (${this.reason}${detail}).`;
    return this.reason === "source" ? `${refusal} ${sourceRevisionGuidance}` : refusal;
  }
}
/** Only an isolated writer hands back source for the lead to adopt. */
const handsBack = (binding: AgentTaskBinding) =>
  binding.workspaceAssignment === "isolated" && binding.sourceAccess === "scoped-write";

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
  /** The calling project, whose browser settings decide whether a Phi role may start. */
  readonly projectId?: ProjectId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly ceiling: RuntimeMode;
  readonly runtimeMode?: RuntimeMode;
  /** The accountable lead's own workspace. */
  readonly workspacePath: string | null;
  /** The project's main checkout, which an isolated helper never uses. */
  readonly projectRoot?: string;
  /**
   * The task works in another registered project's repository, where the caller holds no
   * checkout: only pinned readers and isolated writers go there, and even that project's main
   * checkout is checked for live writers.
   */
  readonly foreignProject?: boolean;
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
        readonly callerModel?: string;
        readonly selection?: Resolver.RequestedModel;
      },
    ) => Effect.Effect<Omit<AgentRolesResult, "environmentId">, ManagedAgentError>;
    readonly prepare: (
      input: Authority & {
        readonly request: AgentTaskRequest;
        readonly requestFingerprint: string;
        readonly recordedBinding?: AgentTaskBinding;
        readonly policyHash?: string;
        readonly callerModel?: string;
        readonly selection?: Resolver.RequestedModel;
      },
    ) => Effect.Effect<{ binding: AgentTaskBinding; brief: string }, ManagedAgentError>;
    readonly validate: (
      input: Authority & {
        readonly binding: AgentTaskBinding;
        readonly selection: ModelSelection;
      },
    ) => Effect.Effect<void, ManagedAgentError>;
    /**
     * The registered project whose repository holds a task's workspace: the named one, else the
     * caller's own when the path is in its repository, else the one registered project whose
     * repository holds it. A path in no registered repository stays with the caller, whose
     * workspace rules then refuse it; a path several projects share needs an explicit project.
     */
    readonly targetProject: <E>(input: {
      readonly request: Pick<AgentTaskRequest, "workspacePath" | "projectId">;
      readonly callerProjectId: ProjectId;
      /** The caller's own checkout, which settles the common case without listing projects. */
      readonly callerCheckout: string | null;
      readonly projects: Effect.Effect<
        ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>,
        E
      >;
    }) => Effect.Effect<ProjectId, ManagedAgentError | E>;
    /** Whether this environment names a policy, readable or not. */
    readonly configured: () => Effect.Effect<boolean>;
    /** Serialises workspace occupancy checks with the launch they authorise, across routes. */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * What an isolated writer's sandbox may write besides its workspace: the repository store
     * shared by all workspaces, so it can commit and read its own history. None for other
     * tasks, and none when the workspace has no readable store.
     */
    readonly repositoryRoots: (binding: AgentTaskBinding) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * Records the source an isolated scoped-write task's run hands back as the run ends.
     * The first record stands, so a repeated finalisation cannot replace it.
     */
    readonly recordHandoff: (
      binding: AgentTaskBinding,
      run: { readonly threadId: ThreadId; readonly runId: RunId },
    ) => Effect.Effect<void, ManagedAgentError>;
    /**
     * The source an isolated scoped-write task's run handed back, or none for other tasks.
     * A run that recorded nothing, as one that failed before it started, has no revision.
     */
    readonly handoff: (
      binding: AgentTaskBinding,
      run: { readonly threadId: ThreadId; readonly runId: RunId },
    ) => Effect.Effect<AgentTaskHandoff | undefined, ManagedAgentError>;
    /**
     * The commit a pinned task's workspace now shows, when it no longer shows the pin:
     * none while the pin still holds or the checkout has no clean commit to pin.
     */
    readonly movedRevision: (
      binding: AgentTaskBinding & { readonly sourceRevision: string },
    ) => Effect.Effect<string | undefined, ManagedAgentError>;
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
  const execution = Effect.fn(function* (
    input: { ceiling: RuntimeMode; runtimeMode?: RuntimeMode },
    request: AgentTaskRequest,
    legacy = false,
    readOnly = request.readOnly === true,
  ) {
    const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
    const configured = Option.isSome(settings)
      ? yield* settings.value.getSettings.pipe(
          Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })),
        )
      : undefined;
    const mode =
      input.runtimeMode ??
      defaultChildMode(input.ceiling, configured?.delegation.defaultChildRuntimeMode ?? "inherit");
    if (exceedsCaller(mode, input.ceiling))
      return yield* new ManagedAgentError({ reason: "policy" });
    const trustedEnabled = configured?.delegation.allowTrustedClaudeWriters === true;
    // Boundary-less historical bindings never carry consent to the broader route.
    const requirement = readOnly
      ? "sandbox-required"
      : ((legacy && (!("executionBoundary" in request) || request.executionBoundary === undefined)
          ? undefined
          : request.executionRequirement) ??
        (!legacy && trustedEnabled && mode === "full-access"
          ? "trusted-host-allowed"
          : "sandbox-required"));

    return {
      ceiling: input.ceiling,
      runtimeMode: mode,
      allowTrustedClaudeWriters: trustedEnabled,
      request: { ...request, executionRequirement: requirement },
    };
  });
  /**
   * Whether a Phi role may start: the project still allows agent browsing and Phi, the skill is
   * installed and Phi answers. Discovery accepts a recent answer; a launch asks Phi now; a
   * resumed task is checked by its own tools on every call, so a brief outage cannot strand it.
   */
  const browserRoute = Effect.fn("ManagedAgentService.browserRoute")(function* (
    toolProfile: AgentToolProfile,
    projectId: ProjectId | undefined,
    when: "discovery" | "launch" | "resume",
  ) {
    if (!usesPhi(toolProfile)) return undefined;
    if (when === "resume") return { refusal: null };
    const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
    const configured = Option.isSome(settings)
      ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (configured === undefined) return { refusal: "browser-access-off" as const };
    const effective =
      projectId === undefined
        ? {
            enableAgentBrowserAccess: configured.enableAgentBrowserAccess,
            agentBrowserBackends: configured.agentBrowserBackends,
          }
        : resolveProjectSettings(configured, projectId).settings;
    if (!effective.enableAgentBrowserAccess) return { refusal: "browser-access-off" as const };
    if (!effective.agentBrowserBackends.enabled.includes("phi"))
      return { refusal: "phi-disabled" as const };
    const phi = yield* Effect.serviceOption(PhiBrowser.PhiBrowser);
    if (Option.isNone(phi)) return { refusal: "phi-unreachable" as const };
    const availability = yield* phi.value.availability({
      skillDirectory: configured.phiBrowserSkillDirectory,
      probe: when === "launch",
    });
    return {
      refusal:
        availability === "skill-missing"
          ? ("phi-skill-missing" as const)
          : availability === "unreachable"
            ? ("phi-unreachable" as const)
            : null,
    };
  });
  const refuse = (detail: string, cause?: unknown) =>
    new ManagedAgentError({ reason: "workspace", detail, cause });
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
    const assignment = request.workspaceAssignment ?? "lead";
    // A pinned reader cannot change a checkout and is proven below to see exactly the pinned
    // source, so it may use any workspace of the lead's repository, including one a
    // root-bound lead allocated for itself. Writers and unpinned readers keep the binding.
    const pinnedReader = !writes && request.sourceRevision !== undefined;
    // A root-bound lead works from the project's main checkout: read-only work may use it,
    // and an isolated helper may use another workspace of its repository. Only a writer
    // sharing the lead's own checkout needs a lead bound to an allocated workspace.
    const lead =
      authority.workspacePath ??
      (assignment === "isolated" || (!writes && (pinnedReader || assignment === "lead"))
        ? authority.projectRoot
        : undefined);
    const expected = request.workspacePath;
    if (!path.isAbsolute(expected))
      return yield* refuse(`workspacePath must be absolute, got ${expected}`);
    // Another project holds no checkout of the caller's, so only pinned readers and isolated
    // writers go there.
    if (authority.foreignProject === true && assignment === "lead" && !pinnedReader)
      return yield* refuse(
        'this thread has no workspace of its own in that project; pin sourceRevision for read-only work there, or pass workspaceAssignment "isolated" with a separately allocated workspace',
      );
    if (lead === undefined)
      return yield* refuse(
        'this thread has no workspace of its own for a writer to share; pass workspaceAssignment "isolated" with a separately allocated workspace',
      );
    const notInRepository = `${expected} is not a checkout of the project's repository`;
    const sameRepository = Effect.fn("ManagedAgentService.sameRepository")(function* () {
      // The project, not the lead's current checkout, decides the repository: SlipJay may
      // have released the lead's workspace while the lead still works from it.
      const [projectStore, childStore] = yield* local(
        // A project may be registered in a repository subdirectory.
        Effect.all([
          containingRepositoryStore(authority.projectRoot ?? lead),
          repositoryStore(expected),
        ]),
      ).pipe(Effect.mapError((cause) => refuse(notInRepository, cause)));
      if (projectStore !== childStore) return yield* refuse(notInRepository);
    });
    const occupied = `another thread is working in ${expected}`;
    if (pinnedReader) {
      // In another workspace, a live writer would change the files under the reader after the
      // pin was checked. The lead's own checkout is always occupied by the lead, which may read
      // it beside its own work exactly as an unpinned reader does; another project's main
      // checkout is never the lead's.
      if (expected !== lead || authority.foreignProject === true) {
        yield* sameRepository();
        if (
          (authority.occupants ?? []).some(
            (occupant) =>
              occupant.workspacePath === expected && occupant.running && occupant.writes,
          )
        )
          return yield* refuse(occupied);
      }
    } else if (assignment === "lead") {
      if (expected !== lead)
        return yield* refuse(
          `a task sharing the lead's workspace must use ${lead}; pin sourceRevision for read-only work elsewhere, or pass workspaceAssignment "isolated" with a separately allocated workspace`,
        );
    } else {
      // An isolated helper gets its own registered workspace of the lead's repository on
      // this host: never the lead's checkout, the main checkout, a subdirectory, another
      // repository, or a workspace another thread is already writing in.
      const ownCheckout =
        "an isolated task needs its own allocated workspace, not the lead's or the project's main checkout";
      if (expected === lead || expected === authority.projectRoot)
        return yield* refuse(ownCheckout);
      // A lead or project registered in a subdirectory still owns the checkout containing it.
      // A root in no resolvable checkout contains none; the repository check below still holds.
      const owned = yield* local(
        Effect.forEach(
          authority.projectRoot === undefined ? [lead] : [lead, authority.projectRoot],
          (root) => checkoutRoot(root).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
      if (owned.includes(expected)) return yield* refuse(ownCheckout);
      yield* sameRepository();
      // Only live work holds a workspace: SlipJay reassigns workspaces whose earlier threads
      // stay unarchived. Another lead's live thread keeps it; under this lead, only the same
      // attempt may continue beside a live writer, and a new attempt waits for it.
      if (
        (authority.occupants ?? []).some(
          (occupant) =>
            occupant.workspacePath === expected &&
            occupant.running &&
            (occupant.owner !== authority.owner ||
              ((writes || occupant.writes) &&
                (occupant.workId !== request.workId || occupant.attemptId !== request.attemptId))),
        )
      )
        return yield* refuse(occupied);
    }
    const missing = `${expected} does not exist`;
    const actual = yield* fs
      .realPath(expected)
      .pipe(Effect.mapError((cause) => refuse(missing, cause)));
    if (actual !== expected)
      return yield* refuse(`workspacePath must be the real path ${actual}, without symlinks`);
    const stat = yield* fs.stat(actual).pipe(Effect.mapError((cause) => refuse(missing, cause)));
    if (stat.type !== "Directory") return yield* refuse(`${expected} is not a directory`);
    if (writes)
      yield* local(checkWriterWorkspace(actual)).pipe(
        Effect.mapError((cause) =>
          cause.reason === "hard-link"
            ? new ManagedAgentError({ reason: "hard-link", path: cause.path, cause })
            : refuse(`could not read ${cause.path} to check the workspace for a writer`, cause),
        ),
      );
    if (request.sourceRevision !== undefined) {
      const revisions = yield* pinnableRevisions(actual);
      if (!revisions.includes(request.sourceRevision))
        return yield* new ManagedAgentError({ reason: "source" });
    }
  });
  /**
   * The commits a pinned reader in this checkout sees: the working copy, or also the single
   * parent of an empty jj working copy, the state `jj commit` leaves. A dirty git tree sees none.
   */
  const pinnableRevisions = Effect.fn("ManagedAgentService.pinnableRevisions")(function* (
    actual: string,
  ) {
    const jj = yield* fs
      .exists(path.join(actual, ".jj"))
      .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })));
    const output = yield* processes
      .run({
        command: jj ? "jj" : "git",
        args: jj
          ? [
              "log",
              "-r",
              "@",
              "--no-graph",
              "-T",
              'commit_id ++ if(empty, " " ++ parents.map(|c| c.commit_id()).join(" "))',
            ]
          : ["rev-parse", "HEAD"],
        cwd: actual,
        timeout: "10 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })));
    if (output.code !== 0) return [];
    const [current = "", ...parents] = output.stdout.trim().split(" ");
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
      if (dirty.code !== 0 || dirty.stdout.trim() !== "") return [];
    }
    return parents.length === 1 ? [current, parents[0]!] : [current];
  });
  const isolatedLaunches = yield* Semaphore.make(1);
  return ManagedAgentService.of({
    targetProject: Effect.fn("ManagedAgentService.targetProject")(function* ({
      request,
      callerProjectId,
      callerCheckout,
      projects: listProjects,
    }) {
      if (request.projectId !== undefined) {
        if (!(yield* listProjects).some((project) => project.id === request.projectId))
          return yield* new ManagedAgentError({
            reason: "workspace",
            detail: `project ${request.projectId} is not registered`,
          });
        return request.projectId;
      }
      const store = (directory: string) =>
        local(containingRepositoryStore(directory)).pipe(Effect.orElseSucceed(() => undefined));
      const target = yield* store(request.workspacePath);
      if (target === undefined) return callerProjectId;
      if (callerCheckout !== null && (yield* store(callerCheckout)) === target)
        return callerProjectId;
      const projects = yield* listProjects;
      const caller = projects.find((project) => project.id === callerProjectId);
      if (caller !== undefined && (yield* store(caller.workspaceRoot)) === target)
        return callerProjectId;
      const matches = yield* Effect.filter(
        projects.filter((project) => project.id !== callerProjectId),
        (project) => store(project.workspaceRoot).pipe(Effect.map((found) => found === target)),
      );
      if (matches.length > 1)
        return yield* new ManagedAgentError({
          reason: "workspace",
          detail: `${request.workspacePath} is in a repository several projects are registered in (${matches.map((project) => project.id).join(", ")}); pass agentTask.projectId`,
        });
      return matches[0]?.id ?? callerProjectId;
    }),
    configured: () =>
      Config.option(Config.String("T3CODE_AGENT_POLICY_ROOT")).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      ),
    exclusive: (effect) => isolatedLaunches.withPermit(effect),
    repositoryRoots: (binding) =>
      handsBack(binding)
        ? local(repositoryWriteRoots(binding.workspacePath)).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Unable to resolve an isolated writer's repository store.", {
                cause,
              }),
            ),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          )
        : Effect.succeed([]),
    recordHandoff: Effect.fn("ManagedAgentService.recordHandoff")(
      function* (binding, run) {
        if (!handsBack(binding)) return;
        const source = yield* local(handoffRevision(binding.workspacePath));
        yield* sql`INSERT INTO agent_task_handoffs (thread_id, run_id, revision, quiescent)
          VALUES (${run.threadId}, ${run.runId}, ${source.revision}, ${source.quiescent ? 1 : 0})
          ON CONFLICT DO NOTHING`;
      },
      Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })),
    ),
    handoff: Effect.fn("ManagedAgentService.handoff")(
      function* (binding, run) {
        if (!handsBack(binding)) return undefined;
        const [row] = yield* sql<{
          revision: string | null;
          quiescent: number;
        }>`SELECT revision, quiescent FROM agent_task_handoffs WHERE thread_id = ${run.threadId} AND run_id = ${run.runId}`;
        return {
          workspacePath: binding.workspacePath,
          revision: row?.revision ?? null,
          quiescent: row?.quiescent === 1,
        };
      },
      Effect.mapError((cause) => new ManagedAgentError({ reason: "source", cause })),
    ),
    movedRevision: (binding) =>
      pinnableRevisions(binding.workspacePath).pipe(
        // An empty jj working copy's id changes on every snapshot; its parent is the commit.
        Effect.map((revisions) =>
          revisions.includes(binding.sourceRevision) ? undefined : revisions.at(-1),
        ),
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
      // Only the roles this policy configures; an optional role it leaves out is not offered.
      const configured = Object.entries(snapshot.manifest.roles).flatMap(([name, policy]) => {
        const role = name as AgentTaskRequest["role"];
        const brief = snapshot.briefs[role];
        return policy === undefined || brief === undefined ? [] : [{ role, policy, brief }];
      });
      const roles = yield* Effect.forEach(configured, ({ role, policy, brief }) =>
        Effect.gen(function* () {
          const context = yield* execution(
            {
              ...input,
              ...(input.request.runtimeMode === undefined
                ? {}
                : { runtimeMode: input.request.runtimeMode }),
            },
            {
              ...input.request,
              role,
              workId: "capability-discovery",
              attemptId: "capability-discovery",
              workspacePath: "/capability-discovery",
            },
            false,
            policy.sourceAccess === "read-only" || input.request.readOnly === true,
          );
          const browser = yield* browserRoute(policy.toolProfile, input.projectId, "discovery");
          const result = yield* resolver.preview({
            ...context,
            snapshot,
            ...(browser === undefined ? {} : { browser }),
            providers: input.providers,
            ...(input.selection === undefined ? {} : { selection: input.selection }),
            ...(input.callerModel === undefined ? {} : { callerModel: input.callerModel }),
            request: {
              ...context.request,
              ...(!isReviewerRole(role)
                ? {}
                : {
                    review: {
                      scope: REVIEWER_SCOPE[role],
                      baseRevision: "capability-discovery",
                      includedChanges: ["capability-discovery"],
                      specRef: "capability-discovery",
                      specRevision: "capability-discovery",
                      coverage: "complete" as const,
                    },
                  }),
            },
          });
          const usageLimited = result.candidates.filter(
            (candidate) => candidate.reason === "usage-limited",
          );
          return {
            role,
            briefHash: brief.hash,
            sourceAccess:
              input.request.readOnly === true ? ("read-only" as const) : policy.sourceAccess,
            toolProfile:
              input.request.readOnly === true
                ? readOnlyToolProfile(policy.toolProfile)
                : policy.toolProfile,
            executionRequirement: context.request.executionRequirement,
            ...(result.executionBoundary === undefined
              ? {}
              : { executionBoundary: result.executionBoundary }),
            selection: result.selection,
            refusal: result.refusal,
            ...(usageLimited.length === 0 ? {} : { usageLimited }),
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
      const brief = snapshot.briefs[input.request.role];
      if (role === undefined || brief === undefined)
        return yield* new ManagedAgentError({
          reason: "selection",
          cause: new Resolver.AgentRoleError({ reason: "role-not-configured" }),
        });
      yield* workspace(
        input.request,
        input,
        input.request.readOnly !== true && role.sourceAccess === "scoped-write",
      );
      const context = yield* execution(
        input,
        input.recordedBinding ?? input.request,
        input.recordedBinding !== undefined,
        role.sourceAccess === "read-only" || input.request.readOnly === true,
      );
      const browser = yield* browserRoute(
        role.toolProfile,
        input.projectId,
        input.recordedBinding === undefined ? "launch" : "resume",
      );
      const selection = yield* resolver
        .resolve({
          ...input,
          ...context,
          snapshot,
          ...(browser === undefined ? {} : { browser }),
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
          ...context.request,
          executionBoundary:
            context.request.readOnly === true || role.sourceAccess === "read-only"
              ? "read-only"
              : input.providers.find((p) => p.instanceId === selection.instanceId)?.driver ===
                  "claudeAgent"
                ? "trusted-host-access"
                : "workspace-sandbox",
          requestFingerprint: input.requestFingerprint,
          policyHash: snapshot.hash,
          policyRevision: snapshot.sourceRevision,
          briefHash: brief.hash,
          sourceAccess: input.request.readOnly === true ? "read-only" : role.sourceAccess,
          toolProfile:
            input.request.readOnly === true
              ? readOnlyToolProfile(role.toolProfile)
              : role.toolProfile,
          requested: selection,
          assigned: null,
          effective: selection,
        },
        brief: brief.text,
      };
    }),
    validate: Effect.fn("ManagedAgentService.validate")(function* (input) {
      yield* workspace(input.binding, input, input.binding.sourceAccess === "scoped-write");
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
          exceedsCaller(input.ceiling, owner.ceiling)
        )
          return yield* new ManagedAgentError({ reason: "revoked" });
      }
      const snapshot = yield* store
        .get(input.binding.policyHash)
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "policy", cause })));
      const recordedRole = snapshot.manifest.roles[input.binding.role];
      if (
        recordedRole === undefined ||
        input.binding.sourceAccess !==
          (input.binding.readOnly === true ? "read-only" : recordedRole.sourceAccess) ||
        input.binding.toolProfile !==
          (input.binding.readOnly === true
            ? readOnlyToolProfile(recordedRole.toolProfile)
            : recordedRole.toolProfile)
      )
        return yield* new ManagedAgentError({ reason: "policy" });
      if (snapshot.briefs[input.binding.role]?.hash !== input.binding.briefHash)
        return yield* new ManagedAgentError({ reason: "policy" });
      const context = yield* execution(
        input,
        input.binding,
        true,
        input.binding.sourceAccess === "read-only",
      );
      const provider = input.providers.find((p) => p.instanceId === input.selection.instanceId);
      const boundary =
        input.binding.sourceAccess === "read-only"
          ? "read-only"
          : provider?.driver === "claudeAgent"
            ? "trusted-host-access"
            : "workspace-sandbox";
      if (
        input.binding.executionBoundary !== undefined &&
        input.binding.executionBoundary !== boundary
      )
        return yield* new ManagedAgentError({ reason: "selection" });
      const browser = yield* browserRoute(recordedRole.toolProfile, input.projectId, "resume");
      yield* resolver
        .resolve({ ...input, ...context, snapshot, ...(browser === undefined ? {} : { browser }) })
        .pipe(Effect.mapError((cause) => new ManagedAgentError({ reason: "selection", cause })));
      // Preserve the original effort and brief; current policy can revoke authority,
      // but a preference edit cannot rewrite the treatment of an accepted task.
      const current = yield* currentPolicy;
      const role = current.manifest.roles[input.binding.role];
      if (role === undefined) return yield* new ManagedAgentError({ reason: "revoked" });
      const allowed = (current.manifest.lists[role.list] ?? []).map((entry) => entry.model);
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
