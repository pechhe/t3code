import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AgentExternalSession,
  type AgentTaskOutcomeInput,
  type ExperimentDefinition,
  type OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as External from "./ExternalAgentWorkService.ts";
import * as Managed from "./ManagedAgentService.ts";
import { snapshot, request, codex, claude, changeReview } from "./agentPolicy.testkit.ts";

const environmentId = EnvironmentId.make("environment:external-agent-test");
const projectId = ProjectId.make("project:external-agent-test");
const policy = snapshot();

interface LaunchState {
  readonly sourceRevision?: string;
  readonly rejectNextStop?: Deferred.Deferred<void> | undefined;
  readonly calls: ReadonlyArray<Parameters<Launch.ThreadLaunchService["Service"]["launch"]>[0]>;
  readonly activeThreads: ReadonlySet<string>;
  readonly sends?:
    | ReadonlyArray<Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0]>
    | undefined;
  readonly failNextLaunch: boolean;
  readonly queueNextLaunch: boolean;
  /** Threads whose run finished, for reading a terminal result and its handoff. */
  readonly completedThreads?: ReadonlySet<string>;
}

type FixtureEnvironment =
  | ServerSettings.ServerSettingsService
  | AuthSessions.AuthSessionRepository
  | External.ExternalAgentWorkService
  | Experiments.ExperimentService
  | Managed.ManagedAgentService;

const processRunner = (state: Ref.Ref<LaunchState>) =>
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.map(Ref.get(state), (current) => ({
        stdout:
          input.args[0] === "status"
            ? ""
            : `${current.sourceRevision ?? "fixture-source-revision"}\n`,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      })),
  });

const makeTestLayer = (
  state: Ref.Ref<LaunchState>,
  projectRoot: string,
  invalidation: Deferred.Deferred<void>,
  watcherStarted: Deferred.Deferred<void>,
  stopped: Deferred.Deferred<void>,
  persistence: ReturnType<typeof Sqlite.layerFromPath> = Sqlite.layerMemory,
) => {
  const sessionStore = Layer.mock(SessionStore.SessionStore)({
    cookieName: "fixture-session",
    legacyCookieName: undefined,
    awaitInvalidation: () =>
      Deferred.succeed(watcherStarted, undefined).pipe(
        Effect.andThen(Deferred.await(invalidation)),
      ),
  });
  const projects = Layer.succeed(
    Projects.ProjectService,
    Projects.ProjectService.of({
      getById: () =>
        Effect.succeed(Option.some({ id: projectId, workspaceRoot: projectRoot } as never)),
    } as unknown as Projects.ProjectService["Service"]),
  );
  const providers = Layer.succeed(
    Providers.ProviderRegistry,
    Providers.ProviderRegistry.of({
      getProviders: Effect.succeed([codex, claude]),
    } as unknown as Providers.ProviderRegistry["Service"]),
  );
  const threads = Layer.succeed(
    Threads.ThreadManagementService,
    Threads.ThreadManagementService.of({
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      getThreadShell: (threadId: ThreadId) =>
        Effect.map(Ref.get(state), (current) =>
          current.activeThreads.has(threadId) || current.completedThreads?.has(threadId)
            ? ({ id: threadId, threadId, projectId } as never)
            : null,
        ),
      getThreadRecords: (threadId: ThreadId) =>
        Effect.map(
          Ref.get(state),
          (current) =>
            ({
              thread: {
                advisorClosedAt: undefined,
                agentTask: current.calls.find((call) => call.threadId === threadId)?.agentTask,
              },
              runs: [
                ...current.calls
                  .filter((call) => call.threadId === threadId)
                  .map((call) => ({
                    id: RunId.make(`run:${threadId}`),
                    ordinal: 1,
                    userMessageId: call.initialMessage?.messageId,
                    status: current.completedThreads?.has(threadId)
                      ? "completed"
                      : current.activeThreads.has(threadId)
                        ? "running"
                        : "completed",
                    rootNodeId: `node:${threadId}`,
                  })),
                ...(current.sends ?? [])
                  .filter((send) => send.threadId === threadId)
                  .map((send, index) => ({
                    id: RunId.make(`run:followup:${index}`),
                    ordinal: index + 2,
                    userMessageId: send.messageId,
                    status:
                      current.activeThreads.has(threadId) &&
                      index === (current.sends?.length ?? 0) - 1
                        ? "running"
                        : "completed",
                    rootNodeId: `node:followup:${index}`,
                  })),
              ],
              messages: [],
              turnItems: [],
              subagents: [],
            }) as never,
        ),
      dispatch: (command: Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0]) =>
        Effect.gen(function* () {
          if (command.type === "advisor.result.observe") return;
          const current = yield* Ref.get(state);
          if (current.rejectNextStop !== undefined) {
            yield* Ref.update(state, (value) => ({ ...value, rejectNextStop: undefined }));
            yield* Deferred.succeed(current.rejectNextStop, undefined);
            return yield* new External.ExternalAgentWorkError({ reason: "storage" });
          }
          return yield* Ref.update(state, (current) => ({
            ...current,
            activeThreads: new Set(
              [...current.activeThreads].filter(
                (id) => !("threadId" in command) || id !== command.threadId,
              ),
            ),
          })).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)));
        }),
      sendToThread: (
        input: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0],
      ) =>
        Ref.update(state, (current) => ({
          ...current,
          sends: (current.sends ?? []).some((send) => send.commandId === input.commandId)
            ? current.sends
            : [...(current.sends ?? []), input],
          activeThreads: new Set([...current.activeThreads, input.threadId]),
        })).pipe(Effect.as({} as never)),
      stopDelegatedTasks: () => Effect.void,
      listProjectThreads: () =>
        Effect.map(Ref.get(state), (current) =>
          current.calls
            .filter((call) => current.activeThreads.has(call.threadId!))
            .map(
              (call) =>
                ({
                  worktreePath:
                    call.workspaceStrategy?.type === "existing_worktree"
                      ? call.workspaceStrategy.worktreePath
                      : null,
                  status: "running",
                  agentTask: call.agentTask,
                }) as never,
            ),
        ),
    } as unknown as Threads.ThreadManagementService["Service"]),
  );
  const launch = Layer.succeed(
    Launch.ThreadLaunchService,
    Launch.ThreadLaunchService.of({
      launch: (input: Parameters<Launch.ThreadLaunchService["Service"]["launch"]>[0]) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* Ref.update(state, (value) => ({
            ...value,
            calls: [...value.calls, input],
            failNextLaunch: false,
            queueNextLaunch: false,
            activeThreads:
              current.failNextLaunch || current.queueNextLaunch
                ? current.activeThreads
                : new Set([...current.activeThreads, input.threadId!]),
          }));
          if (current.failNextLaunch)
            return yield* Effect.fail(new Error("lost launch response") as never);
          return { threadId: input.threadId!, projection: {} as never, resumed: false };
        }),
    } as unknown as Launch.ThreadLaunchService["Service"]),
  );
  const projectionPersistence = ProjectionStore.layer.pipe(Layer.provideMerge(persistence));
  const persistenceAndAuth = AuthSessions.layer.pipe(Layer.provideMerge(projectionPersistence));
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    processRunner(state),
    persistenceAndAuth,
    sessionStore,
    projects,
    providers,
    threads,
    launch,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const managedServices = Layer.mergeAll(Managed.layer, Experiments.layer).pipe(
    Layer.provideMerge(dependencies),
  );
  return External.layer.pipe(Layer.provideMerge(managedServices));
};

const withFixture = <A, E>(
  use: (fixture: ReturnType<typeof buildFixture>) => Effect.Effect<A, E, FixtureEnvironment>,
  /** Register the project at this subdirectory of its checkout instead of the checkout root. */
  projectSubdirectory?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "external-agent-work-test-" }),
      );
      const projectRoot = `${root}/project`;
      const workspacePath = `${projectRoot}/workspace`;
      const foreignWorkspace = `${root}/foreign-workspace`;
      const sharedStore = `${root}/shared-store`;
      const otherStore = `${root}/other-store`;
      yield* fs.makeDirectory(`${projectRoot}/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${workspacePath}/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${foreignWorkspace}/.jj`, { recursive: true });
      yield* fs.makeDirectory(sharedStore);
      yield* fs.makeDirectory(otherStore);
      yield* fs.writeFileString(`${projectRoot}/.jj/repo`, "../../shared-store\n");
      yield* fs.writeFileString(`${workspacePath}/.jj/repo`, "../../../shared-store\n");
      yield* fs.writeFileString(`${foreignWorkspace}/.jj/repo`, "../other-store\n");

      const policyRoot = `${root}/policy`;
      yield* fs.makeDirectory(`${policyRoot}/roles`, { recursive: true });
      yield* fs.writeFileString(`${policyRoot}/roles/policy.json`, JSON.stringify(policy.manifest));
      for (const role of Object.values(policy.manifest.roles)) {
        yield* fs.writeFileString(`${policyRoot}/${role.brief}`, `Test brief for ${role.brief}\n`);
      }

      const state = yield* Ref.make<LaunchState>({
        calls: [],
        activeThreads: new Set(),
        failNextLaunch: false,
        queueNextLaunch: false,
      });
      const invalidation = yield* Deferred.make<void>();
      const watcherStarted = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const fixture = buildFixture({
        fs,
        root,
        projectRoot,
        workspacePath,
        foreignWorkspace,
        sharedStore,
        otherStore,
        policyRoot,
        state,
        invalidation,
        watcherStarted,
        stopped,
      });
      const registeredRoot =
        projectSubdirectory === undefined ? projectRoot : `${projectRoot}/${projectSubdirectory}`;
      yield* fs.makeDirectory(registeredRoot, { recursive: true });
      return yield* use(fixture).pipe(
        Effect.provide(makeTestLayer(state, registeredRoot, invalidation, watcherStarted, stopped)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: policyRoot }),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

function buildFixture(input: {
  readonly fs: FileSystem.FileSystem;
  readonly root: string;
  readonly projectRoot: string;
  readonly workspacePath: string;
  readonly foreignWorkspace: string;
  readonly sharedStore: string;
  readonly otherStore: string;
  readonly policyRoot: string;
  readonly state: Ref.Ref<LaunchState>;
  readonly invalidation: Deferred.Deferred<void>;
  readonly watcherStarted: Deferred.Deferred<void>;
  readonly stopped: Deferred.Deferred<void>;
}) {
  const {
    fs,
    root,
    projectRoot,
    workspacePath,
    foreignWorkspace,
    sharedStore,
    otherStore,
    policyRoot,
    state,
    invalidation,
    watcherStarted,
    stopped,
  } = input;
  const issueSession = (
    id: string,
    options?: { readonly expired?: boolean; readonly revoked?: boolean },
  ) =>
    Effect.gen(function* () {
      const auth = yield* AuthSessions.AuthSessionRepository;
      const now = yield* DateTime.now;
      const sessionId = AuthSessionId.make(id);
      yield* auth.create({
        sessionId,
        subject: "mcp-client",
        scopes: ["orchestration:read", "orchestration:operate"],
        method: "bearer-access-token",
        client: {
          label: id,
          ipAddress: null,
          userAgent: null,
          deviceType: "bot",
          os: null,
          browser: null,
        },
        issuedAt: now,
        expiresAt: options?.expired
          ? DateTime.subtract(now, { days: 1 })
          : DateTime.add(now, { hours: 1 }),
      });
      if (options?.revoked) yield* auth.revoke({ sessionId, revokedAt: now });
      return sessionId;
    });
  const readAuthSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const auth = yield* AuthSessions.AuthSessionRepository;
      return yield* auth.getById({ sessionId });
    });
  const attachInput = (workspace = workspacePath) => ({
    environmentId,
    projectId,
    workspacePath: workspace,
    externalSessionId: "external-cli-session",
  });
  const scope = (sessionId: AuthSessionId, environment = environmentId) => ({
    environmentId: environment,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: `client:${sessionId}`,
    thread: undefined,
    client: { sessionId, label: "fixture external client", access: "full-access" as const },
  });
  const attach = (client: AuthSessionId, value = attachInput(), environment = environmentId) =>
    Effect.gen(function* () {
      const service = yield* External.ExternalAgentWorkService;
      return yield* service.attach(scope(client, environment), value);
    });
  const session = (client: AuthSessionId, key: string) =>
    Effect.gen(function* () {
      const service = yield* External.ExternalAgentWorkService;
      return yield* service.session(scope(client), key);
    });
  const submit = (client: AuthSessionId, value: OrchestratorMcpDelegateTaskInput) =>
    Effect.gen(function* () {
      const service = yield* External.ExternalAgentWorkService;
      return yield* service.submit(scope(client), value);
    });
  const status = (
    client: AuthSessionId,
    taskId: Parameters<External.ExternalAgentWorkService["Service"]["status"]>[1],
  ) =>
    Effect.gen(function* () {
      const service = yield* External.ExternalAgentWorkService;
      return yield* service.status(scope(client), taskId);
    });
  const cancel = (
    client: AuthSessionId,
    taskId: Parameters<External.ExternalAgentWorkService["Service"]["cancel"]>[1]["taskId"],
  ) =>
    Effect.gen(function* () {
      const service = yield* External.ExternalAgentWorkService;
      return yield* service.cancel(scope(client), { taskId });
    });
  const submitInput = (
    external: AgentExternalSession,
    overrides: Partial<OrchestratorMcpDelegateTaskInput> = {},
  ) =>
    ({
      externalSessionKey: external.key,
      agentTask: request({ workspacePath }),
      task: "Implement the requested change.",
      clientRequestId: "request-one",
      ...overrides,
    }) satisfies OrchestratorMcpDelegateTaskInput;
  const startModelExperiment = (id: string) =>
    Effect.gen(function* () {
      const experiments = yield* Experiments.ExperimentService;
      const definition: ExperimentDefinition = {
        id,
        title: "External task model selection",
        question: "Does the alternate eligible model improve task completion?",
        lever: "delegation",
        primaryOutcome: "Verified completion",
        variants: [
          {
            id: "codex",
            label: "Codex",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-test"),
              model: "gpt-sol-test",
              options: [],
            },
          },
          {
            id: "claude",
            label: "Claude",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude-test"),
              model: "claude-sonnet-test",
              options: [],
            },
          },
        ],
        eligibility: {
          projectIds: [projectId],
          models: [],
          taskCategories: ["implementation"],
        },
        maxAssignments: 100,
        endsAt: "2999-01-01T00:00:00Z",
        stopConditions: [],
        codeRevision: null,
        briefRevision: null,
      };
      yield* experiments.create(definition);
      return yield* experiments.transition({ experimentId: id, status: "running" });
    });
  return {
    fs,
    root,
    projectRoot,
    workspacePath,
    foreignWorkspace,
    sharedStore,
    otherStore,
    policyRoot,
    state,
    invalidation,
    watcherStarted,
    stopped,
    issueSession,
    readAuthSession,
    attachInput,
    scope,
    attach,
    session,
    submit,
    status,
    cancel,
    submitInput,
    startModelExperiment,
  };
}

it.effect("attaches for a project registered in a subdirectory of its repository", () =>
  withFixture(
    (f) =>
      Effect.gen(function* () {
        const client = yield* f.issueSession("client-subdirectory");
        yield* f.attach(client);
        const foreign = yield* f
          .attach(client, f.attachInput(f.foreignWorkspace))
          .pipe(Effect.flip);
        expect(foreign.reason).toBe("workspace");
      }),
    "apps/web",
  ),
);

it.effect("requires the explicit host/environment identity", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-host-mismatch");
      const failure = yield* f
        .attach(client, f.attachInput(), EnvironmentId.make("environment:other-host"))
        .pipe(Effect.flip);
      expect(failure.reason).toBe("environment");
    }),
  ),
);

it.effect("attaches idempotently only to the project's exact JJ repository workspace", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-workspace");
      const first = yield* f.attach(client);
      expect(yield* f.attach(client)).toEqual(first);
      const foreign = yield* f.attach(client, f.attachInput(f.foreignWorkspace)).pipe(Effect.flip);
      expect(foreign.reason).toBe("workspace");
      const alias = `${f.root}/workspace-alias`;
      yield* f.fs.symlink(f.workspacePath, alias);
      const symlink = yield* f.attach(client, f.attachInput(alias)).pipe(Effect.flip);
      expect(symlink.reason).toBe("workspace");
    }),
  ),
);

it.effect("isolates session, status and cancellation to the owning OAuth client", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const owner = yield* f.issueSession("client-owner");
      const other = yield* f.issueSession("client-other");
      const session = yield* f.attach(owner);
      const task = yield* f.submit(owner, f.submitInput(session));
      expect((yield* f.session(other, session.key).pipe(Effect.flip)).reason).toBe("session");
      expect((yield* f.status(other, task.taskId).pipe(Effect.flip)).reason).toBe("session");
      expect((yield* f.cancel(other, task.taskId).pipe(Effect.flip)).reason).toBe("session");
    }),
  ),
);

it.effect(
  "deduplicates same work and content across transport request IDs and rejects content reuse",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const client = yield* f.issueSession("client-idempotent");
        const session = yield* f.attach(client);
        const first = yield* f.submit(client, f.submitInput(session));
        const retry = yield* f.submit(
          client,
          f.submitInput(session, { clientRequestId: "request-two" }),
        );
        expect(retry.taskId).toBe(first.taskId);
        expect((yield* Ref.get(f.state)).calls).toHaveLength(1);
        const reused = yield* f
          .submit(
            client,
            f.submitInput(session, { task: "Different content", clientRequestId: "request-one" }),
          )
          .pipe(Effect.flip);
        expect(reused.reason).toBe("conflict");
      }),
    ),
);

it.effect("rejects a new attempt while the prior attempt still has an active writer", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-active-writer");
      const session = yield* f.attach(client);
      yield* f.submit(client, f.submitInput(session));
      const next = f.submitInput(session, {
        clientRequestId: "request-attempt-two",
        agentTask: request({ workspacePath: f.workspacePath, attemptId: "attempt-two" }),
      });
      expect((yield* f.submit(client, next).pipe(Effect.flip)).reason).toBe("conflict");
      expect((yield* Ref.get(f.state)).calls).toHaveLength(1);
    }),
  ),
);

it.effect("retries a lost launch response with the same command and thread IDs", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-lost-launch");
      const session = yield* f.attach(client);
      yield* Ref.update(f.state, (current) => ({ ...current, failNextLaunch: true }));
      const input = f.submitInput(session);
      expect((yield* f.submit(client, input).pipe(Effect.flip)).reason).toBe("launch");
      const retried = yield* f.submit(client, input);
      const calls = (yield* Ref.get(f.state)).calls;
      expect(retried.launchState).toBe("accepted");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.commandId).toEqual(calls[1]?.commandId);
      expect(calls[0]?.threadId).toEqual(calls[1]?.threadId);
    }),
  ),
);

it.effect("cancels queued and active work owned by the authenticated client", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-cancel");
      const session = yield* f.attach(client);
      yield* Ref.update(f.state, (current) => ({ ...current, queueNextLaunch: true }));
      const queued = yield* f.submit(client, f.submitInput(session));
      expect(queued.status).toBe("queued");
      const launched = yield* f.submit(
        client,
        f.submitInput(session, {
          clientRequestId: "request-active",
          agentTask: request({ workspacePath: f.workspacePath, workId: "active-work" }),
        }),
      );
      expect((yield* f.cancel(client, queued.taskId)).status).toBe("cancelled");
      expect((yield* f.cancel(client, launched.taskId)).status).toBe("cancelled");
    }),
  ),
);

it.effect("rejects revoked and expired AuthSession records", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const revoked = yield* f.issueSession("client-revoked", { revoked: true });
      const expired = yield* f.issueSession("client-expired", { expired: true });
      const expiredRecord = Option.getOrThrow(yield* f.readAuthSession(expired));
      expect(expiredRecord.expiresAt.epochMilliseconds).toBeLessThan(
        (yield* DateTime.now).epochMilliseconds,
      );
      expect((yield* f.attach(revoked).pipe(Effect.flip)).reason).toBe("authority");
      expect((yield* f.attach(expired).pipe(Effect.flip)).reason).toBe("authority");
    }),
  ),
);

it.effect("stops an active task when the owning OAuth subscription reports invalidation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-invalidated");
      const session = yield* f.attach(client);
      const task = yield* f.submit(client, f.submitInput(session));
      yield* Deferred.succeed(f.invalidation, undefined);
      yield* Deferred.await(f.stopped);
      expect((yield* f.status(client, task.taskId)).status).toBe("cancelled");
    }),
  ),
);

it.effect("launches a direct external task without a paid parent model", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-no-parent");
      const session = yield* f.attach(client);
      yield* f.submit(client, f.submitInput(session));
      const call = (yield* Ref.get(f.state)).calls[0]!;
      expect(call.createdBy).toBe("agent");
      expect(call.projectId).toBe(projectId);
      expect(String(call.threadId).startsWith("thread:external-work:")).toBe(true);
      expect("parentThreadId" in call).toBe(false);
    }),
  ),
);

it.effect("retries invalidation cancellation after a transient stop failure", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-stop-retry");
      const session = yield* f.attach(client);
      const task = yield* f.submit(client, f.submitInput(session));
      const refused = yield* Deferred.make<void>();
      yield* Ref.update(f.state, (current) => ({ ...current, rejectNextStop: refused }));
      yield* Deferred.succeed(f.invalidation, undefined);
      yield* Deferred.await(refused);
      // Advance the retry schedule after observing its failed stop; no wall-clock wait.
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(f.stopped);
      expect((yield* f.status(client, task.taskId)).status).toBe("cancelled");
    }),
  ),
);

it.effect("restores persisted ownership and the invalidation watcher after service reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "external-agent-reconnect-test-" }),
      );
      const projectRoot = `${root}/project`;
      const workspacePath = `${projectRoot}/workspace`;
      const foreignWorkspace = `${root}/foreign-workspace`;
      const sharedStore = `${root}/shared-store`;
      const otherStore = `${root}/other-store`;
      yield* fs.makeDirectory(`${projectRoot}/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${workspacePath}/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${foreignWorkspace}/.jj`, { recursive: true });
      yield* fs.makeDirectory(sharedStore);
      yield* fs.makeDirectory(otherStore);
      yield* fs.writeFileString(`${projectRoot}/.jj/repo`, "../../shared-store\n");
      yield* fs.writeFileString(`${workspacePath}/.jj/repo`, "../../../shared-store\n");
      yield* fs.writeFileString(`${foreignWorkspace}/.jj/repo`, "../other-store\n");

      const policyRoot = `${root}/policy`;
      yield* fs.makeDirectory(`${policyRoot}/roles`, { recursive: true });
      yield* fs.writeFileString(`${policyRoot}/roles/policy.json`, JSON.stringify(policy.manifest));
      for (const role of Object.values(policy.manifest.roles)) {
        yield* fs.writeFileString(`${policyRoot}/${role.brief}`, `Test brief for ${role.brief}\n`);
      }
      const state = yield* Ref.make<LaunchState>({
        calls: [],
        activeThreads: new Set(),
        failNextLaunch: false,
        queueNextLaunch: false,
      });
      const invalidation = yield* Deferred.make<void>();
      const watcherStarted = yield* Deferred.make<void>();
      const watcherStartedAfterReconnect = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const persistence = Sqlite.layerFromPath(`${root}/external-agent.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const fixture = buildFixture({
        fs,
        root,
        projectRoot,
        workspacePath,
        foreignWorkspace,
        sharedStore,
        otherStore,
        policyRoot,
        state,
        invalidation,
        watcherStarted,
        stopped,
      });
      const testLayer = (watcher: Deferred.Deferred<void>) =>
        makeTestLayer(state, projectRoot, invalidation, watcher, stopped, persistence);
      const withService = <A, E>(
        watcher: Deferred.Deferred<void>,
        use: (
          context: Context.Context<Layer.Success<ReturnType<typeof testLayer>>>,
        ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof testLayer>>>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const serviceScope = yield* Effect.scope;
            return yield* Layer.buildWithScope(testLayer(watcher), serviceScope).pipe(
              Effect.flatMap((context) => Effect.provideContext(use(context), context)),
            );
          }),
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: policyRoot }),
          ),
        );

      const client = yield* withService(watcherStarted, (context) =>
        Effect.gen(function* () {
          const sessionId = yield* fixture
            .issueSession("client-reconnect")
            .pipe(Effect.provideContext(context));
          const auth = Context.get(context, AuthSessions.AuthSessionRepository);
          expect(Option.isSome(yield* auth.getById({ sessionId }))).toBe(true);
          const service = Context.get(context, External.ExternalAgentWorkService);
          const attached = yield* service
            .attach(fixture.scope(sessionId), fixture.attachInput())
            .pipe(Effect.provideContext(context));
          const submitted = yield* service
            .submit(
              fixture.scope(sessionId),
              fixture.submitInput(attached, {
                agentTask: request({ role: "advisor", workspacePath }),
              }),
            )
            .pipe(Effect.provideContext(context));
          expect(submitted.launchState).toBe("accepted");
          yield* Deferred.await(watcherStarted);
          yield* Ref.update(state, (current) => ({
            ...current,
            activeThreads: new Set<string>(),
            completedThreads: new Set([submitted.childThreadId]),
            sourceRevision: "revision-two",
          }));
          const input = {
            externalSessionKey: attached.key,
            clientRequestId: "durable-advice",
            task: "Next question",
            followup: {
              taskId: submitted.taskId,
              sourceRevision: "revision-two",
              changes: "Updated source",
            },
          };
          const consultation = yield* service.submit(fixture.scope(sessionId), input);
          return { sessionId, attached, submitted: consultation, input };
        }),
      );
      expect((yield* Ref.get(state)).calls).toHaveLength(1);

      yield* withService(watcherStartedAfterReconnect, (context) =>
        Effect.gen(function* () {
          const service = Context.get(context, External.ExternalAgentWorkService);
          const restored = yield* service
            .session(fixture.scope(client.sessionId), client.attached.key)
            .pipe(Effect.provideContext(context));
          expect(restored).toEqual(client.attached);
          const retry = yield* service
            .submit(fixture.scope(client.sessionId), client.input)
            .pipe(Effect.provideContext(context));
          expect(retry.taskId).toBe(client.submitted.taskId);
          expect((yield* Ref.get(state)).calls).toHaveLength(1);
          expect((yield* Ref.get(state)).sends).toHaveLength(1);
          yield* Deferred.await(watcherStartedAfterReconnect);
          yield* Deferred.succeed(invalidation, undefined);
          yield* Deferred.await(stopped);
          expect((yield* Ref.get(state)).activeThreads.has(client.submitted.childThreadId)).toBe(
            false,
          );
        }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "limits recorded outcomes to owned task assignments and marks external reports as self-reported",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.startModelExperiment("external-outcome-models");
        const owner = yield* f.issueSession("client-outcome-owner");
        const foreign = yield* f.issueSession("client-outcome-foreign");
        const session = yield* f.attach(owner);
        const task = yield* f.submit(owner, f.submitInput(session));
        const foreignSession = yield* f.attach(foreign);
        const foreignTask = yield* f.submit(
          foreign,
          f.submitInput(foreignSession, {
            clientRequestId: "foreign-client-request",
            agentTask: request({ workspacePath: f.workspacePath, workId: "foreign-client-work" }),
          }),
        );
        const assignmentId = task.assignmentIds?.[0];
        const foreignAssignment = foreignTask.assignmentIds?.[0];
        expect(assignmentId).toBeDefined();
        expect(foreignAssignment).toBeDefined();
        const outcomeInput = (assignment: string, runId: RunId | null): AgentTaskOutcomeInput => ({
          taskId: task.taskId,
          outcome: {
            id: `outcome:${assignment}`,
            assignmentId: assignment,
            runId,
            kind: "verified-completion",
            source: "independent-evidence",
            evidence: ["external-review:passed"],
            note: "The external parent reports completion.",
            actualModelSelection: null,
            fallbackReason: null,
          },
        });
        const service = yield* External.ExternalAgentWorkService;
        expect(
          (yield* service
            .recordOutcome(f.scope(owner), outcomeInput(foreignAssignment!, null))
            .pipe(Effect.flip)).reason,
        ).toBe("authority");
        expect(
          (yield* service
            .recordOutcome(
              f.scope(owner),
              outcomeInput(assignmentId!, RunId.make("run:foreign-attempt")),
            )
            .pipe(Effect.flip)).reason,
        ).toBe("authority");
        expect(
          (yield* service
            .recordOutcome(f.scope(foreign), outcomeInput(assignmentId!, null))
            .pipe(Effect.flip)).reason,
        ).toBe("session");
        const recorded = yield* service.recordOutcome(
          f.scope(owner),
          outcomeInput(assignmentId!, null),
        );
        expect(recorded.source).toBe("self-report");
        expect(recorded.assignmentId).toBe(assignmentId);
      }),
    ),
);

it.effect(
  "allows a new attempt after cancellation while retaining its pinned policy and assignment",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.startModelExperiment("external-retry-models");
        const owner = yield* f.issueSession("client-retry-after-cancel");
        const session = yield* f.attach(owner);
        const first = yield* f.submit(owner, f.submitInput(session));
        expect(first.assignmentIds).toHaveLength(1);
        const pinned = first.agentTask!;
        expect(pinned.policyHash).toBeDefined();
        expect(pinned.briefHash).toBeDefined();
        expect((yield* f.cancel(owner, first.taskId)).status).toBe("cancelled");

        yield* f.fs.writeFileString(
          `${f.policyRoot}/roles/implementation-worker.md`,
          "Changed brief after the first attempt was assigned.\n",
        );
        const retryInput = f.submitInput(session, {
          clientRequestId: "request-attempt-after-cancel",
          agentTask: request({ workspacePath: f.workspacePath, attemptId: "attempt-after-cancel" }),
        });
        const retry = yield* f.submit(owner, retryInput);
        expect(retry.taskId).not.toBe(first.taskId);
        expect(retry.agentTask!.policyHash).toBe(pinned.policyHash);
        expect(retry.agentTask!.briefHash).toBe(pinned.briefHash);
        expect(retry.agentTask!.executionRequirement).toBe(pinned.executionRequirement);
        expect(retry.agentTask!.executionBoundary).toBe(pinned.executionBoundary);
        yield* f.cancel(owner, retry.taskId);
        const widening = yield* f
          .submit(
            owner,
            f.submitInput(session, {
              clientRequestId: "attempt-widening",
              agentTask: request({
                workspacePath: f.workspacePath,
                attemptId: "attempt-widening",
                executionRequirement: "trusted-host-allowed",
              }),
            }),
          )
          .pipe(Effect.flip);
        expect(widening.reason).toBe("conflict");
        expect(retry.assignmentIds).toEqual(first.assignmentIds);
      }),
    ),
);

it.effect(
  "pins enrolled external work before launch without a delegated model treatment or fake parent",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const client = yield* f.issueSession("mcp-client:work-policy");
        const session = yield* f.attach(client);
        const managed = yield* Managed.ManagedAgentService;
        const pinned = yield* managed.snapshot();
        const experiments = yield* Experiments.ExperimentService;
        const selection = {
          instanceId: ProviderInstanceId.make("codex-test"),
          model: "gpt-sol-test",
        };
        yield* experiments.create({
          id: "external-policy",
          title: "Allocation",
          question: "Inline or delegated?",
          lever: "orchestration-policy",
          primaryOutcome: "Independent acceptance",
          orchestrationControls: {
            orchestratorSelection: selection,
            policyHash: pinned.hash,
            reviewerPolicyRevision: "review-r1",
            verificationRevision: "checks-r1",
            concurrency: 2,
          },
          variants: [
            { id: "inline", label: "Inline", allocationPolicy: "inline-first" },
            { id: "delegated", label: "Delegated", allocationPolicy: "delegate-earlier" },
          ],
          eligibility: { projectIds: [projectId], models: [], taskCategories: [] },
          maxAssignments: 20,
          endsAt: "2999-01-01T00:00:00Z",
          stopConditions: [],
          codeRevision: null,
          briefRevision: null,
        });
        yield* experiments.transition({ experimentId: "external-policy", status: "running" });
        const owner = {
          environmentId,
          projectId,
          workspacePath: session.workspacePath,
          parentThreadId: null,
          externalSessionKey: session.key,
          clientSessionId: client,
        };
        const unit = yield* experiments.enrollWork({
          request: {
            workId: "external-ticket",
            description: "A coherent implementation",
            taskCategory: "implementation",
          },
          owner,
          orchestratorSelection: selection,
          modelSource: "self-report",
          policyHash: pinned.hash,
          policyRevision: pinned.sourceRevision,
          alreadyStarted: false,
        });
        expect(unit.assignedPolicies).toHaveLength(1);
        expect(unit.owner.parentThreadId).toBeNull();
        const task = { ...request({ workspacePath: session.workspacePath }), workUnitId: unit.id };
        const before = yield* f
          .submit(client, f.submitInput(session, { agentTask: task }))
          .pipe(Effect.flip);
        expect(before.reason).toBe("policy");
        yield* experiments.allocateWork(
          {
            id: "external-allocation",
            workUnitId: unit.id,
            allocation: "delegated",
            reason: "An independent bounded responsibility",
            deviationReason: "An explicit specialist handoff",
          },
          { environmentId, clientSessionId: client },
        );
        yield* f.fs.writeFileString(
          `${f.policyRoot}/roles/policy.json`,
          JSON.stringify({ ...policy.manifest, revision: "new-current-policy" }),
        );
        const input = f.submitInput(session, { agentTask: task });
        const launched = yield* f.submit(client, input);
        expect(launched.agentTask?.policyHash).toBe(pinned.hash);
        expect(launched.assignmentIds).toEqual(unit.assignmentIds);
        expect((yield* f.submit(client, input)).taskId).toBe(launched.taskId);
        expect((yield* Ref.get(f.state)).calls).toHaveLength(1);
        const report = yield* experiments.readWork(
          { workUnitId: unit.id },
          { environmentId, clientSessionId: client },
        );
        expect(report.tasks[0]?.binding.workUnitId).toBe(unit.id);
        expect(report.childCoverage).toBe("unavailable");
        expect(report.parentCoverage).toBe("unavailable");
        expect(report.usage.inputTokens).toBeNull();
        const external = yield* External.ExternalAgentWorkService;
        const outcome = yield* external.recordOutcome(f.scope(client), {
          taskId: launched.taskId,
          outcome: {
            id: "external-unit-claim",
            assignmentId: unit.assignmentIds[0]!,
            runId: null,
            kind: "verified-completion",
            source: "independent-evidence",
            evidence: ["claimed-check"],
            note: "Parent claim",
            actualModelSelection: null,
            fallbackReason: null,
          },
        });
        expect(outcome.source).toBe("self-report");
        expect(
          (yield* experiments.readWork(
            { workUnitId: unit.id },
            { environmentId, clientSessionId: client },
          )).independentlySupportedAcceptance,
        ).toBe(false);
        yield* f.cancel(client, launched.taskId);
        const afterCancel = yield* experiments.report(
          { experimentId: "external-policy" },
          { environmentId, clientSessionId: client },
        );
        expect(afterCancel.policySummary?.reduce((n, arm) => n + arm.cancellationCount, 0)).toBe(1);
        const foreignClient = yield* f.issueSession("mcp-client:work-policy-foreign");
        const foreignSession = yield* f.attach(foreignClient);
        const foreign = yield* f
          .submit(foreignClient, f.submitInput(foreignSession, { agentTask: task }))
          .pipe(Effect.flip);
        expect(foreign.reason).toBe("authority");
      }),
    ),
);

it.effect(
  "records a refused external child on its own task, never as a failure of the whole work unit",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const client = yield* f.issueSession("mcp-client:work-refusal");
        const session = yield* f.attach(client);
        const managed = yield* Managed.ManagedAgentService;
        const pinned = yield* managed.snapshot();
        const experiments = yield* Experiments.ExperimentService;
        const selection = {
          instanceId: ProviderInstanceId.make("codex-test"),
          model: "gpt-sol-test",
        };
        yield* experiments.create({
          id: "external-refusal",
          title: "Allocation",
          question: "Inline or delegated?",
          lever: "orchestration-policy",
          primaryOutcome: "Independent acceptance",
          orchestrationControls: {
            orchestratorSelection: selection,
            policyHash: pinned.hash,
            reviewerPolicyRevision: "review-r1",
            verificationRevision: "checks-r1",
            concurrency: 2,
          },
          variants: [
            { id: "inline", label: "Inline", allocationPolicy: "inline-first" },
            { id: "delegated", label: "Delegated", allocationPolicy: "delegate-earlier" },
          ],
          eligibility: { projectIds: [projectId], models: [], taskCategories: [] },
          maxAssignments: 20,
          endsAt: "2999-01-01T00:00:00Z",
          stopConditions: [],
          codeRevision: null,
          briefRevision: null,
        });
        yield* experiments.transition({ experimentId: "external-refusal", status: "running" });
        const owner = {
          environmentId,
          projectId,
          workspacePath: session.workspacePath,
          parentThreadId: null,
          externalSessionKey: session.key,
          clientSessionId: client,
        };
        const unit = yield* experiments.enrollWork({
          request: {
            workId: "external-refused-ticket",
            description: "A coherent implementation",
            taskCategory: "implementation",
          },
          owner,
          orchestratorSelection: selection,
          modelSource: "self-report",
          policyHash: pinned.hash,
          policyRevision: pinned.sourceRevision,
          alreadyStarted: false,
        });
        expect(unit.assignedPolicies).toHaveLength(1);
        expect(unit.owner.parentThreadId).toBeNull();
        const task = { ...request({ workspacePath: session.workspacePath }), workUnitId: unit.id };
        const before = yield* f
          .submit(client, f.submitInput(session, { agentTask: task }))
          .pipe(Effect.flip);
        expect(before.reason).toBe("policy");
        yield* experiments.allocateWork(
          {
            id: "external-refused-allocation",
            workUnitId: unit.id,
            allocation: "delegated",
            reason: "An independent bounded responsibility",
            deviationReason: "An explicit specialist handoff",
          },
          { environmentId, clientSessionId: client },
        );
        // The policy becomes unreadable between acceptance of the unit and dispatch.
        yield* f.fs.writeFileString(`${f.policyRoot}/roles/policy.json`, "not json");
        const refused = yield* f.submit(client, f.submitInput(session, { agentTask: task }));
        expect(refused.launchState).toBe("refused");
        expect((yield* Ref.get(f.state)).calls).toHaveLength(0);
        const report = yield* experiments.report(
          { experimentId: "external-refusal" },
          { environmentId, clientSessionId: client },
        );
        const outcomes = report.assignments.flatMap((entry) => entry.outcomes);
        expect(outcomes.filter((outcome) => outcome.kind === "failure")).toHaveLength(0);
      }),
    ),
);

it.effect("runs an isolated helper under the same lead session and hands back its source", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const client = yield* f.issueSession("client-isolated");
      const lead = yield* f.attach(client);
      const helper = `${f.root}/helper-workspace`;
      const second = `${f.root}/second-helper`;
      for (const path of [helper, second]) {
        yield* f.fs.makeDirectory(`${path}/.jj`, { recursive: true });
        yield* f.fs.writeFileString(`${path}/.jj/repo`, `${f.sharedStore}\n`);
      }
      const isolated = (path: string, workId: string, attemptId = "attempt-1") =>
        f.submitInput(lead, {
          clientRequestId: `${workId}-${attemptId}`,
          agentTask: request({
            workspacePath: path,
            workspaceAssignment: "isolated",
            workId,
            attemptId,
          }),
        });
      const task = yield* f.submit(client, isolated(helper, "importer"));
      const call = (yield* Ref.get(f.state)).calls[0]!;
      expect(call.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: helper });
      // The child stays accountable to the attached lead session, not a second lease.
      expect(task.agentTask?.externalOwner?.externalSessionKey).toBe(lead.key);
      expect(task.handoff).toBeUndefined();
      // A second writer in the same workspace, or one in another repository, is refused.
      expect((yield* Effect.flip(f.submit(client, isolated(helper, "other-work")))).reason).toBe(
        "policy",
      );
      expect(
        (yield* Effect.flip(f.submit(client, isolated(f.foreignWorkspace, "foreign")))).reason,
      ).toBe("policy");
      // A new attempt resumes the same work in its workspace, not a different one.
      yield* f.cancel(client, task.taskId);
      expect(
        (yield* Effect.flip(f.submit(client, isolated(second, "importer", "attempt-2")))).reason,
      ).toBe("conflict");
      // A finished helper reports the exact revision for the lead to adopt.
      const finished = yield* f.submit(client, isolated(second, "exporter"));
      yield* Ref.update(f.state, (current) => ({
        ...current,
        activeThreads: new Set<string>(),
        completedThreads: new Set([String(finished.childThreadId)]),
      }));
      // The run records what it hands back as it settles, as run execution does.
      const settled = yield* f.status(client, finished.taskId);
      yield* (yield* Managed.ManagedAgentService).recordHandoff(settled.agentTask!, {
        threadId: settled.childThreadId,
        runId: settled.latestTerminalRunId!,
      });
      const handedBack = {
        workspacePath: second,
        revision: "fixture-source-revision",
        quiescent: true,
      };
      expect((yield* f.status(client, finished.taskId)).handoff).toEqual(handedBack);
      // Later work in the workspace does not change what the finished helper handed back.
      yield* Ref.update(f.state, (current) => ({ ...current, sourceRevision: "later-revision" }));
      expect((yield* f.status(client, finished.taskId)).handoff).toEqual(handedBack);
    }),
  ),
);

it.effect(
  "reuses an external advisor with stable consultations and closes its whole conversation",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const client = yield* fixture.issueSession("advisor-owner");
        const attached = yield* fixture.attach(client);
        const initial = yield* fixture.submit(client, {
          externalSessionKey: attached.key,
          clientRequestId: "advisor-open",
          task: "Learn the current work",
          agentTask: request({
            role: "advisor",
            workId: "advisor-work",
            sourceRevision: "fixture-source-revision",
            workspacePath: fixture.workspacePath,
          }),
        });
        const followup = {
          externalSessionKey: attached.key,
          clientRequestId: "advisor-question-2",
          task: "Does this fix the defect?",
          followup: {
            taskId: initial.taskId,
            sourceRevision: "fixture-source-revision-two",
            changes: "Replaced the faulty calculation.",
          },
        };
        expect((yield* fixture.submit(client, followup).pipe(Effect.flip)).reason).toBe("conflict");
        yield* Ref.update(fixture.state, (state) => ({
          ...state,
          activeThreads: new Set<string>(),
          completedThreads: new Set([initial.childThreadId]),
          sourceRevision: "fixture-source-revision-two",
        }));
        const badPin = yield* fixture
          .submit(client, {
            ...followup,
            clientRequestId: "advisor-bad-source-pin",
            followup: { ...followup.followup, sourceRevision: "wrong-source" },
          })
          .pipe(Effect.flip);
        expect(badPin.reason).toBe("source");
        expect(badPin.message).toContain("jj log -r @ --no-graph -T commit_id");
        expect(badPin.message).toContain("git rev-parse HEAD");
        expect(badPin.message).not.toContain("wrong-source");
        const second = yield* fixture.submit(client, followup);
        expect(second.taskId).not.toBe(initial.taskId);
        expect(second.childThreadId).toBe(initial.childThreadId);
        expect(second.agentTask).toEqual(initial.agentTask);
        expect(second.childRunId).not.toBe(initial.childRunId);
        const retry = yield* fixture.submit(client, followup);
        expect(retry.taskId).toBe(second.taskId);
        expect((yield* Ref.get(fixture.state)).sends).toHaveLength(1);
        expect((yield* Ref.get(fixture.state)).sends?.[0]?.externalWorkOwner).toEqual(
          initial.agentTask?.externalOwner,
        );
        expect((yield* fixture.status(client, initial.taskId)).status).toBe("completed");
        expect(
          (yield* fixture
            .submit(client, { ...followup, task: "different question" })
            .pipe(Effect.flip)).reason,
        ).toBe("conflict");
        const other = yield* fixture.issueSession("advisor-foreign");
        expect((yield* fixture.submit(other, followup).pipe(Effect.flip)).reason).toBe("session");
        yield* Ref.update(fixture.state, (state) => ({
          ...state,
          activeThreads: new Set<string>(),
        }));
        const third = yield* fixture.submit(client, {
          ...followup,
          clientRequestId: "advisor-question-3",
          followup: {
            ...followup.followup,
            taskId: second.taskId,
            sourceRevision: "fixture-source-revision-two",
          },
        });
        expect(third.childThreadId).toBe(initial.childThreadId);
        expect((yield* Ref.get(fixture.state)).calls).toHaveLength(1);
        expect((yield* Ref.get(fixture.state)).sends).toHaveLength(2);
        const service = yield* External.ExternalAgentWorkService;
        yield* service.cancel(fixture.scope(client), { taskId: second.taskId });
        expect(
          (yield* fixture
            .submit(client, { ...followup, clientRequestId: "advisor-after-close" })
            .pipe(Effect.flip)).reason,
        ).toBe("conflict");
      }),
    ),
);

it.effect("continues an external worker with a correction in its conversation", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const client = yield* fixture.issueSession("worker-owner");
      const attached = yield* fixture.attach(client);
      const initial = yield* fixture.submit(client, {
        externalSessionKey: attached.key,
        clientRequestId: "worker-open",
        task: "Implement the change",
        agentTask: request({
          role: "implementation-worker",
          workId: "worker-work",
          workspacePath: fixture.workspacePath,
        }),
      });
      yield* Ref.update(fixture.state, (state) => ({
        ...state,
        activeThreads: new Set<string>(),
        completedThreads: new Set([initial.childThreadId]),
      }));
      const correction = yield* fixture.submit(client, {
        externalSessionKey: attached.key,
        clientRequestId: "worker-correction",
        task: "Rename the helper as discussed.",
        followup: {
          taskId: initial.taskId,
          sourceRevision: "fixture-source-revision",
          changes: "Reviewed the first pass.",
        },
      });
      expect(correction.taskId).not.toBe(initial.taskId);
      expect(correction.childThreadId).toBe(initial.childThreadId);
      expect(correction.agentTask).toEqual(initial.agentTask);
      const sent = (yield* Ref.get(fixture.state)).sends ?? [];
      expect(sent).toHaveLength(1);
      expect(sent[0]!.followupSourceRevision).toBe("fixture-source-revision");
      expect(sent[0]!.text).toContain("Rename the helper as discussed.");
    }),
  ),
);

it.effect("refuses continuing an external reviewer", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const client = yield* fixture.issueSession("reviewer-owner");
      const attached = yield* fixture.attach(client);
      const initial = yield* fixture.submit(client, {
        externalSessionKey: attached.key,
        clientRequestId: "review-open",
        task: "Review",
        agentTask: request({
          role: "ticket-reviewer",
          workspacePath: fixture.workspacePath,
          sourceRevision: "fixture-source-revision",
          review: changeReview,
        }),
      });
      expect(
        (yield* fixture
          .submit(client, {
            externalSessionKey: attached.key,
            clientRequestId: "review-reuse",
            task: "Again",
            followup: {
              taskId: initial.taskId,
              sourceRevision: "new-revision",
              changes: "Updated",
            },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("authority");
    }),
  ),
);

it.effect(
  "applies server child defaults without widening external callers or changing running children",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const client = yield* f.issueSession("client-default-child");
        const session = yield* f.attach(client);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          delegation: {
            defaultChildRuntimeMode: "approval-required",
            advisorIdleCloseMinutes: null,
          },
        });
        const first = yield* f.submit(client, f.submitInput(session));
        expect((yield* Ref.get(f.state)).calls[0]?.runtimeMode).toBe("approval-required");
        yield* settings.updateSettings({
          delegation: { defaultChildRuntimeMode: "inherit", advisorIdleCloseMinutes: null },
        });
        expect((yield* Ref.get(f.state)).calls[0]?.runtimeMode).toBe("approval-required");
        yield* f.submit(client, f.submitInput(session));
        expect((yield* Ref.get(f.state)).calls).toHaveLength(1);
        expect(first.childThreadId).toBe((yield* Ref.get(f.state)).calls[0]?.threadId);
      }),
    ),
);
