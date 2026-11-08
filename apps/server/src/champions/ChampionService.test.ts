// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - a real `docker` shim on PATH stands in for the target
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import * as Managed from "../agents/ManagedAgentService.ts";
import * as ProviderOverloads from "../provider/ProviderOverloads.ts";
import { snapshot as policySnapshot, codex, codexModel } from "../agents/agentPolicy.testkit.ts";
import * as ChampionHandlers from "../mcp/toolkits/champions/handlers.ts";
import { ChampionsToolkit } from "../mcp/toolkits/champions/tools.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Landings from "../project/SlipJayLandings.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { type CommandReceiptV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentTaskBinding,
  ChampionClasses,
  ChampionConfig as ChampionConfigSchema,
  MessageId,
  NodeId,
  type RuntimeMode,
  type ModelSelection,
  type ChampionInvestigationBranchAttempt,
  type ChampionLearningRecordInput,
  type ChampionLearningContributor,
  ChampionError,
  EnvironmentId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProviderThreadId,
  type ChampionConfig,
  type ChampionMetricInput,
  type ChampionSampleInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ConversationMessage,
  type ChampionFinding,
  type PreviewTaskResult,
  type ServerProvider,
  type Project,
  isToolListedForSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ChampionJourneys from "./ChampionJourneys.ts";
import * as JourneyBrowserPolicy from "../preview/JourneyBrowserPolicy.ts";
import * as Champions from "./ChampionService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const decodeBinding = Schema.decodeSync(AgentTaskBinding);
const decodeClasses = Schema.decodeEffect(ChampionClasses);
const decodeConfig = Schema.decodeEffect(ChampionConfigSchema);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("test-provider");
const projectId = ProjectId.make("project:champions");
const config: ChampionConfig = {
  id: "champion:quality",
  projectId,
  name: "Quality",
  purpose: "Keep errors low",
  schedule: { type: "interval", everyMs: 60_000 },
  setupModelSelection: { instanceId, model: "strong" },
  routineModelSelection: { instanceId, model: "cheap" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 2, instructions: "Repair bounded issues." },
};
const metric: ChampionMetricInput = {
  id: "errors",
  name: "Errors",
  description: "Error count",
  unit: "count",
  source: "logs",
  context: "production",
  direction: "lower",
  minimum: null,
  maximum: 2,
};
const sample: ChampionSampleInput = {
  metricId: "errors",
  version: 1,
  unit: "count",
  status: "measured",
  value: 3,
  observedAt: "1970-01-01T00:00:00.000Z",
  source: "logs",
  evidence: "Three observed errors",
  revision: "running-revision",
};

const fixture = Effect.fn("test.championFixture")(() =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:champions")),
          getDescriptor: Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
    );
    const sessions = yield* McpProviderSessions.McpProviderSessions.pipe(
      Effect.provide(McpProviderSessions.layer),
    );
    let credential: Effect.Success<ReturnType<typeof registry.issue>> | undefined;
    const bindCredential = Effect.fn("test.bindChampionCredential")(function* (threadId: ThreadId) {
      credential = yield* registry.issue({ threadId, providerInstanceId: instanceId });
      yield* sessions.set(credential.config);
      return credential;
    });
    let owner: ThreadId | undefined;
    let messageId = "";
    let launches = 0;
    let sends = 0;
    let instanceAvailable = true;
    let failOnce = false;
    let activeRun = true;
    let queuedRun = false;
    const launchRequests: Array<{
      commandId: string;
      messageId: string;
      model: string;
      text: string;
      createdBy: string;
      creationSource: string;
    }> = [];
    const children = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const childRuns = new Map<ThreadId, OrchestrationV2Run[]>();
    const dispatches: string[] = [];
    let ownerMode: RuntimeMode = "full-access";
    let providerOverride: ReadonlyArray<ServerProvider> | undefined;
    const disabledProviders = new Set<string>();
    const childTasks: OrchestrationV2Subagent[] = [];
    const threadMessages = new Map<ThreadId, OrchestrationV2ConversationMessage[]>();
    const receipts = new Map<string, CommandReceiptV2>();
    let landing: {
      status: string;
      stage: string;
      terminal: boolean;
      commitId?: string;
      finishedAt?: string;
      checks: [];
    } = { status: "running", stage: "gate", terminal: false, checks: [] };
    const sent: Array<{ commandId: string; messageId: string; text: string }> = [];
    let failSend = false;
    let landingLookup = Effect.void;
    let runId = RunId.make("run:check");
    const runHistory: OrchestrationV2Run[] = [];
    let restartSource: RunId | undefined;
    let selection = config.routineModelSelection;
    const providerThreadId = ProviderThreadId.make("provider-thread:check");
    const caller = () => ({
      threadId: owner!,
      providerInstanceId: instanceId,
      providerSessionId: credential!.config.providerSessionId,
    });
    // These are external thread/provider boundaries; the champion ledger and SQL remain real.
    let completedRun = false;
    let priorCompletedRun = false;
    let foreignProject = false;
    let foreignProviderThread = false;
    let overloadedRun = false;
    const shell = () =>
      ({
        id: owner,
        title: "Quality owner",
        projectId: foreignProject ? ProjectId.make("foreign-project") : projectId,
        providerInstanceId: instanceId,
        runtimeMode: ownerMode,
        modelSelection: config.routineModelSelection,
        interactionMode: "default",
        status: activeRun ? "running" : overloadedRun ? "failed" : "idle",
        activeRunId: activeRun ? runId : null,
        lastErrorCode: overloadedRun ? "overloaded" : null,
        activeProviderThreadId: providerThreadId,
        archivedAt: null,
        deletedAt: null,
        updatedAt: DateTime.makeUnsafe(0),
      }) as OrchestrationV2ThreadShell;
    const currentRun = () =>
      ({
        id: runId,
        ordinal: runHistory.length + 1,
        restartContinuationOfRunId: restartSource,
        status: queuedRun
          ? "queued"
          : overloadedRun
            ? "failed"
            : completedRun || !activeRun
              ? "completed"
              : "running",
        providerThreadId: foreignProviderThread
          ? ProviderThreadId.make("foreign-provider-thread")
          : providerThreadId,
        userMessageId: messageId,
        providerInstanceId: instanceId,
        modelSelection: selection,
      }) as OrchestrationV2Run;
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            launches += 1;
            owner = input.threadId;
            activeRun = true;
            messageId = input.initialMessage!.messageId!;
            yield* bindCredential(owner!);
            launchRequests.push({
              commandId: input.commandId,
              messageId,
              model: input.modelSelection.model,
              text: input.initialMessage!.text,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            });
            if (failOnce) {
              failOnce = false;
              return yield* new ThreadLaunch.ThreadLaunchError({
                commandId: input.commandId,
                projectId,
                operation: "dispatch-message",
                cause: "uncertain acceptance",
              });
            }
            return { threadId: owner!, projection: {} as never, resumed: launches > 1 };
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(owner === id ? shell() : (children.get(id) ?? null)),
        getThreadRecords: (id) =>
          Effect.succeed(
            (children.has(id)
              ? {
                  thread: children.get(id),
                  runs: childRuns.get(id) ?? [],
                  messages: threadMessages.get(id) ?? [],
                  subagents: [],
                  providerSessions: [],
                }
              : {
                  thread: shell(),
                  messages: threadMessages.get(id) ?? [],
                  runs: [
                    ...(priorCompletedRun
                      ? [
                          {
                            id: RunId.make("prior-completed-run"),
                            status: "completed",
                            userMessageId: messageId,
                          } as OrchestrationV2Run,
                        ]
                      : []),
                    ...runHistory,
                    currentRun(),
                  ],
                  providerThreads: [
                    {
                      id: providerThreadId,
                      providerSessionId: "provider-session:provider-instance:codex:shared",
                    } as OrchestrationV2ProviderThread,
                  ],
                  subagents: childTasks,
                }) as unknown as Effect.Success<
              ReturnType<ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]>
            >,
          ),
        getReceipt: (id) => Effect.succeed(Option.fromUndefinedOr(receipts.get(id))),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatches.push(command.type);
            return { sequence: 1 } as never;
          }),
        stopDelegatedTasks: () => Effect.void,
        isProviderInstanceEnabledForProject: ({ instanceId }) =>
          Effect.succeed(!disabledProviders.has(instanceId)),
        sendToThread: (input) =>
          Effect.suspend(() =>
            failSend
              ? Effect.fail(
                  new ThreadManagement.ThreadManagementThreadArchivedError({
                    threadId: input.threadId,
                  }),
                )
              : Effect.sync(() => {
                  sends += 1;
                  sent.push({
                    commandId: input.commandId,
                    messageId: input.messageId,
                    text: input.text,
                  });
                  activeRun = true;
                  overloadedRun = false;
                  messageId = input.messageId;
                  return {} as never;
                }),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.suspend(() =>
          Effect.succeed(
            instanceAvailable
              ? (providerOverride ?? [
                  {
                    instanceId,
                    models: [{ slug: "cheap" }, { slug: "strong" }],
                  } as unknown as ServerProvider,
                ])
              : [],
          ),
        ),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeedSome({ id: projectId, workspaceRoot: "/project/root" } as Project),
      }),
      Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      Layer.mock(Landings.SlipJayLandings)({
        repositoryOf: () => Effect.succeed("test/repo"),
        readDetail: () => landingLookup.pipe(Effect.andThen(Effect.sync(() => landing))),
      }),
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(McpProviderSessions.McpProviderSessions, sessions),
    );
    return {
      layer: Champions.layer.pipe(Layer.provide(dependencies)),
      dependencies,
      dispatches,
      providerAllowed: (instanceId: string, allowed: boolean) => {
        if (allowed) disabledProviders.delete(instanceId);
        else disabledProviders.add(instanceId);
      },
      setProviders: (providers: ReadonlyArray<ServerProvider>) => {
        providerOverride = providers;
      },
      ownerMode: (mode: RuntimeMode) => {
        ownerMode = mode;
      },
      installBranch: (
        attempt: ChampionInvestigationBranchAttempt,
        status: "running" | "completed" | "failed" | "cancelled",
        foreign = false,
      ) => {
        children.set(attempt.childThreadId, {
          id: attempt.childThreadId,
          projectId: foreign ? ProjectId.make("foreign") : projectId,
          agentTask: attempt.binding,
          runtimeMode: "full-access",
          interactionMode: "default",
          activeRunId: status === "running" ? RunId.make(attempt.id) : null,
          deletedAt: null,
        } as OrchestrationV2ThreadShell);
        const task = {
          id: attempt.taskId,
          threadId: owner,
          origin: "app_owned",
          childThreadId: attempt.childThreadId,
          status,
          result: status === "running" ? null : "Observed alternative evidence",
          runId: null,
        } as OrchestrationV2Subagent;
        const index = childTasks.findIndex((t) => t.id === task.id);
        if (index < 0) childTasks.push(task);
        else childTasks[index] = task;
        childRuns.set(attempt.childThreadId, [
          {
            id: RunId.make(attempt.id),
            status,
            userMessageId: attempt.messageId,
            modelSelection: attempt.resolvedSelection,
            delegatedTaskId: attempt.taskId,
            ordinal: 1,
          },
        ] as OrchestrationV2Run[]);
      },
      restartRun: (
        options: {
          selection?: ModelSelection;
          trusted?: boolean;
          source?: RunId;
          providerThreadId?: ProviderThreadId;
          providerInstanceId?: ProviderInstanceId;
        } = {},
      ) => {
        const previous = currentRun();
        runHistory.push({ ...previous, status: "cancelled" });
        runId = RunId.make(`run:restart:${runHistory.length}`);
        restartSource = options.trusted === false ? undefined : (options.source ?? previous.id);
        messageId = `message:restart-continuation:${previous.id}`;
        selection = options.selection ?? selection;
        runHistory[runHistory.length - 1] = {
          ...previous,
          status: "cancelled",
          providerThreadId: options.providerThreadId ?? previous.providerThreadId,
          providerInstanceId: options.providerInstanceId ?? previous.providerInstanceId,
        };
        activeRun = true;
        completedRun = false;
        return runId;
      },
      restoreRun: (id: RunId) => {
        const previous = runHistory.find((run) => run.id === id)!;
        runId = previous.id;
        messageId = previous.userMessageId;
        restartSource = previous.restartContinuationOfRunId;
        activeRun = true;
        completedRun = false;
      },
      caller,
      registry,
      sessions,
      /** An ordinary agent thread in the champion's project, not one of its own. */
      installAgentThread: (threadId: ThreadId, title: string) => {
        children.set(threadId, {
          id: threadId,
          title,
          projectId,
          modelSelection: { instanceId, model: "agent-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          activeRunId: null,
          archivedAt: null,
          deletedAt: null,
        } as unknown as OrchestrationV2ThreadShell);
      },
      addMessage: (
        threadId: ThreadId,
        text: string,
        provenance: Partial<OrchestrationV2ConversationMessage> = {},
      ) => {
        const messages = threadMessages.get(threadId) ?? [];
        messages.push({
          id: MessageId.make(`message:${threadId}:${messages.length}`),
          threadId,
          role: "user",
          text,
          createdBy: "user",
          creationSource: "web",
          createdAt: DateTime.makeUnsafe(0),
          ...provenance,
        } as OrchestrationV2ConversationMessage);
        threadMessages.set(threadId, messages);
      },
      callTool: Effect.fn("test.championTool")(function* <
        Name extends keyof typeof ChampionsToolkit.tools,
      >(service: Champions.ChampionService["Service"], name: Name, input: unknown) {
        const scope = yield* registry.resolve(
          credential!.config.authorizationHeader.slice("Bearer ".length),
        );
        assert.isDefined(scope);
        const deps = Layer.mergeAll(
          dependencies,
          Layer.succeed(Champions.ChampionService, service),
          Layer.succeed(McpInvocationContext.McpInvocationContext, scope!),
        );
        const toolkit = yield* ChampionsToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ChampionHandlers.layer).pipe(Layer.provide(deps)),
          ),
        );
        return yield* toolkit
          .handle(name, input as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.orDie);
      }),
      reportThroughTool: Effect.fn("test.championReportTool")(function* (
        service: Champions.ChampionService["Service"],
        input: Parameters<Champions.ChampionService["Service"]["report"]>[1],
      ) {
        const scope = yield* registry.resolve(
          credential!.config.authorizationHeader.slice("Bearer ".length),
        );
        assert.isDefined(scope);
        const deps = Layer.mergeAll(
          dependencies,
          Layer.succeed(Champions.ChampionService, service),
          Layer.succeed(McpInvocationContext.McpInvocationContext, scope!),
        );
        const toolkit = yield* ChampionsToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ChampionHandlers.layer).pipe(Layer.provide(deps)),
          ),
        );
        return yield* toolkit
          .handle("t3_champions_report", input)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.orDie);
      }),
      credential: () => credential!,
      rotateCredential: () => bindCredential(owner!),
      priorCompletedRun: () => {
        priorCompletedRun = true;
      },
      completeRun: (value: boolean) => {
        completedRun = value;
      },
      foreignProject: (value: boolean) => {
        foreignProject = value;
      },
      foreignProviderThread: (value: boolean) => {
        foreignProviderThread = value;
      },
      counts: () => ({ launches, sends }),
      launchRequests,
      endRun: () => {
        activeRun = false;
        queuedRun = false;
      },
      /** The owner woken in a new run by something other than its check message. */
      wakeOwner: () => {
        activeRun = true;
        queuedRun = false;
        messageId = MessageId.make("message:wake");
      },
      overloadRun: () => {
        activeRun = false;
        queuedRun = false;
        overloadedRun = true;
      },
      queueRun: () => {
        activeRun = false;
        queuedRun = true;
      },
      failNextLaunch: () => {
        failOnce = true;
      },
      wake: () => {
        messageId = "child-result-wakeup";
        restartSource = undefined;
      },
      sent,
      failDecisionSend: (value: boolean) => {
        failSend = value;
      },
      setReceipt: (id: string, status: "accepted" | "rejected") => {
        receipts.set(id, { status } as CommandReceiptV2);
      },
      blockLanding: (effect: Effect.Effect<void>) => {
        landingLookup = effect;
      },
      setLanding: (commitId: string, finishedAt: string) => {
        landing = {
          status: "landed",
          stage: "published",
          terminal: true,
          commitId,
          finishedAt,
          checks: [],
        };
      },
      /** A delegated replay that has finished and left this as its last message. */
      installReplay: (workId: string, attemptId: string, result: string, model: string) => {
        const childThreadId = ThreadId.make(`replay:${attemptId}`);
        children.set(childThreadId, {
          id: childThreadId,
          projectId,
          modelSelection: { instanceId, model },
          agentTask: { workId, attemptId, role: "browser" },
        } as unknown as OrchestrationV2ThreadShell);
        childTasks.push({
          childThreadId,
          origin: "app_owned",
          status: "completed",
          result,
        } as OrchestrationV2Subagent);
      },
      installChild: (
        finding: ChampionFinding,
        revision: string,
        role = "implementation-worker",
        status = "completed",
        workItem?: OrchestrationV2ThreadShell["workItem"],
        actualSelection?: ModelSelection,
      ) => {
        const childThreadId = ThreadId.make(`accepted:${role}`);
        children.set(childThreadId, {
          id: childThreadId,
          projectId,
          workItem,
          agentTask: { workId: finding.workId, attemptId: finding.attemptId, role },
        } as OrchestrationV2ThreadShell);
        if (actualSelection !== undefined)
          childRuns.set(childThreadId, [
            {
              id: RunId.make(`review-run:${role}`),
              status: "completed",
              ordinal: 1,
              modelSelection: actualSelection,
            },
          ] as OrchestrationV2Run[]);
        const index = childTasks.findIndex((t) => t.childThreadId === childThreadId);
        const task = {
          childThreadId,
          origin: "app_owned",
          status,
          result: `Handed back revision ${revision}`,
        } as OrchestrationV2Subagent;
        if (index < 0) childTasks.push(task);
        else childTasks[index] = task;
      },
      available: (value: boolean) => {
        instanceAvailable = value;
      },
    };
  }),
);
const withFixture = (
  body: (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
  ) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      yield* body(f, yield* Champions.ChampionService);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(Sqlite.layerMemory));
const definitions = Effect.fn("test.championDefinitions")(function* (
  service: Champions.ChampionService["Service"],
) {
  yield* service.upsert(config);
  yield* service.propose({ id: config.id, metrics: [metric], reason: "Measure errors" });
  return yield* service.accept({ id: config.id });
});
const unquotedAgent = { threadId: undefined, quote: undefined };
const refusedWith = <A>(effect: Effect.Effect<A, ChampionError>, detail: string) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        assert.isTrue(isChampionError(error));
        assert.include(error.message, detail);
      },
      onSuccess: () => {
        assert.fail(`Expected a refusal naming: ${detail}`);
      },
    }),
  );
const isChampionError = Schema.is(ChampionError);
const refused = <A>(effect: Effect.Effect<A, ChampionError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        assert.isTrue(isChampionError(error));
      },
      onSuccess: () => {
        assert.fail("Expected the champion operation to refuse.");
      },
    }),
  );

it.effect(
  "authenticates registry-issued credentials independently of runtime session IDs and rejects stale or foreign bindings",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* service.upsert(config);
        yield* service.setup({ id: config.id });
        const initial = f.credential();
        const token = initial.config.authorizationHeader.slice("Bearer ".length);
        const scope = yield* f.registry.resolve(token);
        assert.isDefined(scope);
        assert.notEqual(
          scope!.thread.providerSessionId,
          "provider-session:provider-instance:codex:shared",
        );
        assert.equal((yield* service.checkContext(scope!.thread)).champion.champion.id, config.id);
        const proposal = { metrics: [metric], reason: "Authenticated setup" };
        yield* service.proposeFromSetup(scope!.thread, proposal);
        yield* service.accept({ id: config.id });
        yield* service.runCheck({ id: config.id });
        const prior = f.caller();
        yield* f.rotateCredential();
        yield* refused(service.checkContext(prior));
        const current = f.caller();
        yield* service.checkContext(current);
        const bound = f.credential().config;
        yield* f.sessions.set({
          ...bound,
          providerInstanceId: ProviderInstanceId.make("foreign-instance"),
        });
        yield* refused(service.checkContext(current));
        yield* f.sessions.set(bound);
        yield* refused(
          service.checkContext({
            ...current,
            providerInstanceId: ProviderInstanceId.make("foreign-instance"),
          }),
        );
        yield* refused(
          service.checkContext({ ...current, threadId: ThreadId.make("foreign-thread") }),
        );
        f.completeRun(true);
        yield* refused(service.checkContext(current));
        f.completeRun(false);
        f.foreignProviderThread(true);
        yield* refused(service.checkContext(current));
        f.foreignProviderThread(false);
        f.foreignProject(true);
        yield* refused(service.checkContext(current));
        f.foreignProject(false);
        f.wake();
        yield* refused(service.checkContext(current));
        f.endRun();
        yield* service.runCheck({ id: config.id });
        const issued = f.credential();
        const liveToken = issued.config.authorizationHeader.slice("Bearer ".length);
        const liveScope = yield* f.registry.resolve(liveToken);
        assert.isDefined(liveScope);
        yield* service.report(liveScope!.thread, {
          samples: [sample],
          findings: [],
          summary: "Authenticated report",
        });
        yield* f.registry.revokeProviderSession(issued.config.providerSessionId);
        assert.isUndefined(yield* f.registry.resolve(liveToken));
        yield* refused(service.checkContext((yield* f.registry.resolve(liveToken))?.thread));
        yield* f.sessions.clear(current.threadId);
        yield* refused(service.checkContext(current));
      }),
    ),
);

it.effect(
  "explains frozen source mismatches through the report tool and accepts an exact source",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        for (const source of ["logs (counted errors)", "Error count from logs"]) {
          const result = yield* f.reportThroughTool(service, {
            samples: [{ ...sample, source }],
            findings: [],
            summary: "Observed errors",
          });
          assert.match(
            JSON.stringify(result.at(-1)?.result),
            /source.*exactly.*t3_champions_check_context/,
          );
          assert.equal((yield* service.history({ id: config.id })).samples.length, 0);
        }
        const accepted = yield* f.reportThroughTool(service, {
          samples: [sample],
          findings: [],
          summary: "Observed errors",
        });
        assert.isFalse(accepted.at(-1)!.isFailure);
        assert.equal((yield* service.history({ id: config.id })).samples.length, 1);
      }),
    ),
);

it.effect("reports collection failure honestly as a null error sample", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      const result = yield* f.reportThroughTool(service, {
        samples: [
          {
            ...sample,
            status: "error",
            value: null,
            evidence: "Collection command failed; logs unavailable",
          },
        ],
        findings: [],
        summary: "Collection failed",
      });
      assert.isFalse(result.at(-1)!.isFailure);
      const history = yield* service.history({ id: config.id });
      assert.equal(history.samples[0]!.status, "error");
      assert.isNull(history.samples[0]!.value);
    }),
  ),
);

it.effect("ignores a terminal run associated with a different message", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      f.wake();
      f.completeRun(true);
      f.endRun();
      yield* service.runDue;
      assert.isFalse(
        (yield* service.get({ id: config.id })).champion.attention.some((a) =>
          a.includes("ended without"),
        ),
      );
    }),
  ),
);

it.effect(
  "surfaces completed unreported checks promptly and retries their claim without duplicating live checks",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const initial = yield* service.runCheck({ id: config.id });
        const context = yield* service.checkContext(f.caller());
        f.priorCompletedRun();
        yield* service.runDue;
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().sends, 0);
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        const ended = yield* service.get({ id: config.id });
        assert.isTrue(
          ended.champion.attention.some(
            (a) => a.includes("ended without") && a.includes("Check now"),
          ),
        );
        assert.equal(ended.champion.outstandingCheckId, initial.champion.outstandingCheckId);
        assert.equal((yield* service.history({ id: config.id })).samples.length, 0);
        yield* service.runCheck({ id: config.id });
        f.completeRun(false);
        assert.equal(f.counts().sends, 1);
        const retry = yield* service.checkContext(f.caller());
        assert.equal(retry.checkId, context.checkId);
        assert.notEqual(retry.messageId, context.messageId);
        assert.deepEqual(retry.metrics, context.metrics);
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
        yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Retried measurement",
        });
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
        assert.equal((yield* service.history({ id: config.id })).samples.length, 1);
      }),
    ),
);

it.effect(
  "does not flag completed setup proposals or no-change completion as missing reports",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* service.upsert(config);
        yield* service.setup({ id: config.id });
        yield* service.proposeFromSetup(f.caller(), {
          metrics: [metric],
          reason: "Initial measurement",
        });
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
        f.completeRun(false);
        yield* service.setup({ id: config.id });
        yield* service.completeSetup(f.caller(), { summary: "No changes needed" });
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
      }),
    ),
);

it.effect(
  "preserves a metric series for wording/target changes and starts a new series for source/unit/context/direction changes",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const first = yield* definitions(service);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, name: "Observed errors", maximum: 1 }],
          reason: "Tighter target",
        });
        const wording = yield* service.accept({ id: config.id });
        assert.equal(wording.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
        assert.equal(wording.metrics[0]!.version, 2);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Use error rate",
        });
        const unit = yield* service.accept({ id: config.id });
        assert.notEqual(unit.metrics[0]!.seriesId, wording.metrics[0]!.seriesId);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, source: "synthetic" }],
          reason: "Change measurement source",
        });
        const source = yield* service.accept({ id: config.id });
        assert.notEqual(source.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
      }),
    ),
);

it.effect("retains setup authentication through repeated verified server restarts", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* service.upsert(config);
      const pending = yield* service.setup({ id: config.id });
      const first = yield* service.checkContext(f.caller());
      f.endRun();
      yield* service.runDue;
      assert.isTrue(
        (yield* service.get({ id: config.id })).champion.attention.some((a) =>
          a.includes("ended without"),
        ),
      );
      f.restartRun();
      f.restartRun();
      yield* service.runDue;
      const context = yield* service.checkContext(f.caller());
      assert.equal(context.checkId, first.checkId);
      assert.equal(context.messageId, first.messageId);
      assert.isFalse(
        (yield* service.get({ id: config.id })).champion.attention.some((a) =>
          a.includes("ended without"),
        ),
      );
      const result = yield* service.completeSetup(f.caller(), {
        summary: "Resumed setup completed",
      });
      assert.isNull(result.champion.outstandingSetupId);
      yield* service.completeSetup(f.caller(), { summary: "Replay" });
      assert.isNotNull(pending.champion.outstandingSetupId);
      assert.deepEqual(f.counts(), { launches: 1, sends: 0 });
    }),
  ),
);

it.effect("reports a restarted check once with the authenticated current run provenance", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      const first = yield* service.checkContext(f.caller());
      const originalAttempt = (yield* service.runtimeState({ id: config.id })).attempts[0]!;
      f.restartRun();
      const selection = { ...config.routineModelSelection, model: "strong" };
      const runId = f.restartRun({ selection });
      yield* service.runDue;
      const input = { samples: [sample], findings: [], summary: "Resumed report" };
      yield* service.report(f.caller(), input);
      yield* service.report(f.caller(), input);
      const history = yield* service.history({ id: config.id });
      assert.equal(history.samples.length, 1);
      assert.equal(history.samples[0]!.checkId, first.checkId);
      assert.equal(history.samples[0]!.runId, runId);
      assert.deepEqual(history.samples[0]!.modelSelection, selection);
      const attempts = (yield* service.runtimeState({ id: config.id })).attempts;
      assert.deepEqual(attempts, [{ ...originalAttempt, actualSelection: selection }]);
      f.restartRun({ selection: config.routineModelSelection });
      yield* service.report(f.caller(), input);
      assert.deepEqual((yield* service.runtimeState({ id: config.id })).attempts, attempts);
      assert.equal((yield* service.history({ id: config.id })).samples.length, 1);
      assert.deepEqual(f.counts(), { launches: 1, sends: 0 });
    }),
  ),
);

it.effect.each([
  "untrusted",
  "missing-source",
  "cycle",
  "foreign-provider-thread",
  "foreign-provider-instance",
] as const)("rejects restarted Champion authentication with %s ancestry", (boundary) =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      f.restartRun({
        ...(boundary === "untrusted" ? { trusted: false } : {}),
        ...(boundary === "missing-source" ? { source: RunId.make("missing") } : {}),
        ...(boundary === "cycle" ? { source: RunId.make("run:restart:1") } : {}),
        ...(boundary === "foreign-provider-thread"
          ? { providerThreadId: ProviderThreadId.make("foreign") }
          : {}),
        ...(boundary === "foreign-provider-instance"
          ? { providerInstanceId: ProviderInstanceId.make("foreign") }
          : {}),
      });
      yield* refused(service.checkContext(f.caller()));
      yield* service.runDue;
      assert.isTrue(
        (yield* service.get({ id: config.id })).champion.attention.some((a) =>
          a.includes("ended without"),
        ),
      );
    }),
  ),
);

it.effect("preserves live caller guards on restart continuations and rejects unrelated wakes", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      f.restartRun();
      yield* refused(service.checkContext({ ...f.caller(), threadId: ThreadId.make("foreign") }));
      yield* refused(service.checkContext({ ...f.caller(), providerSessionId: "foreign" }));
      yield* refused(
        service.checkContext({
          ...f.caller(),
          providerInstanceId: ProviderInstanceId.make("foreign"),
        }),
      );
      f.foreignProject(true);
      yield* refused(service.checkContext(f.caller()));
      f.foreignProject(false);
      f.foreignProviderThread(true);
      yield* refused(service.checkContext(f.caller()));
      f.foreignProviderThread(false);
      const stale = f.caller();
      yield* f.rotateCredential();
      yield* refused(service.checkContext(stale));
      yield* service.checkContext(f.caller());
      f.wake();
      yield* refused(service.checkContext(f.caller()));
    }),
  ),
);

it.effect("rejects restart ancestors superseded by manual retry and cancelled setup claims", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      f.restartRun();
      f.restartRun();
      f.endRun();
      yield* service.runCheck({ id: config.id });
      yield* service.checkContext(f.caller());
      f.restoreRun(RunId.make("run:restart:1"));
      yield* refused(service.checkContext(f.caller()));
      yield* service.setup({ id: config.id });
      f.restartRun();
      yield* service.cancelSetup({ id: config.id });
      yield* refused(service.completeSetup(f.caller(), { summary: "Stale cancelled setup" }));
    }),
  ),
);

it.effect(
  "binds reports to authenticated live caller/run/message, freezes definitions, dedupes replays and reconciles qualitative paraphrases",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        yield* refused(
          service.report(undefined, { samples: [sample], findings: [], summary: "spoof" }),
        );
        yield* refused(
          service.report(
            { ...f.caller(), providerSessionId: "other" },
            { samples: [sample], findings: [], summary: "spoof" },
          ),
        );
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Change later checks",
        });
        yield* service.accept({ id: config.id });
        assert.equal((yield* service.checkContext(f.caller())).metrics[0]!.unit, "count");
        const input = {
          samples: [sample],
          findings: [{ title: "Slow database queries", evidence: "Observed query backlog" }],
          summary: "Error budget breached",
        };
        const reported = yield* service.report(f.caller(), input);
        yield* service.report(f.caller(), input);
        assert.equal(reported.findings.length, 2);
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples.length, 1);
        assert.equal(history.samples[0]!.threadId, f.caller().threadId);
        assert.equal(history.samples[0]!.modelSelection.model, "cheap");
        assert.equal(history.samples[0]!.provenance, "agent-reported");
        yield* service.runCheck({ id: config.id });
        const next = yield* service.report(f.caller(), {
          samples: [{ ...sample, version: 2, unit: "percent" }],
          findings: [{ title: "Database queries are slow", evidence: "Same backlog" }],
          summary: "Still slow",
        });
        assert.equal(next.findings.filter((finding) => finding.metricId === null).length, 1);
      }),
    ),
);

it.effect(
  "pauses scheduling, allows measure-only manual checks, resumes without backfill, and retains unresolved history on retirement",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runDue;
        assert.equal(f.counts().launches, 0);
        yield* service.runCheck({ id: config.id });
        assert.isTrue((yield* service.checkContext(f.caller())).measureOnly);
        const reported = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Paused measurement",
        });
        const finding = reported.findings[0]!;
        const pausedRefusal = yield* service
          .guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "repair:test",
            request: {
              role: "implementation-worker",
              taskClass: "non-ui",
              workId: finding.workId,
              attemptId: finding.attemptId,
              workspacePath: "/isolated",
              workspaceAssignment: "isolated",
            },
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: () => assert.fail("Expected a paused champion to refuse delegation."),
            }),
          );
        // The agent reads this message; a bare "unauthorized" sent Bug Hunter chasing the wrong cause.
        assert.include(pausedRefusal, "paused");
        yield* TestClock.adjust("1 day");
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runDue;
        assert.equal(f.counts().launches, 1);
        yield* service.setLifecycle({ id: config.id, lifecycle: "retired" });
        yield* refused(service.runCheck({ id: config.id }));
        assert.equal((yield* service.get({ id: config.id })).findings.length, 1);
      }),
    ),
);

it.effect("retries the durable check claim after model refusal without selecting a fallback", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      f.available(false);
      yield* service.runCheck({ id: config.id });
      assert.equal(f.counts().launches, 0);
      const first = yield* service.get({ id: config.id });
      assert.isNotNull(first.champion.outstandingCheckId);
      f.available(true);
      yield* service.runDue;
      assert.equal(f.counts().launches, 1);
      assert.equal(f.counts().sends, 0);
      assert.equal(
        (yield* service.get({ id: config.id })).champion.outstandingCheckId,
        first.champion.outstandingCheckId,
      );
    }),
  ),
);

it.effect(
  "replays an uncertain launch using its original launch command and message rather than sending a second message",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        f.failNextLaunch();
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().launches, 1);
        assert.isNotNull((yield* service.get({ id: config.id })).champion.outstandingCheckId);
        yield* service.runDue;
        assert.equal(f.counts().launches, 2);
        assert.equal(f.counts().sends, 0);
        assert.deepEqual(f.launchRequests[0], f.launchRequests[1]);
        assert.isNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      }),
    ),
);

it.effect(
  "guards repair identity/project/isolation/concurrency, binds accepted children and requires comparable delivered-revision evidence",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        const result = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [{ title: "Slow queries", evidence: "Observed backlog" }],
          summary: "Two repairs",
        });
        const finding = result.findings[0]!;
        const request = {
          role: "implementation-worker" as const,
          taskClass: "non-ui" as const,
          workId: finding.workId,
          attemptId: finding.attemptId,
          workspacePath: "/isolated",
          workspaceAssignment: "isolated" as const,
        };
        const guard = (overrides = {}) =>
          service.guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "repair:first",
            request: { ...request, ...overrides },
          });
        yield* refused(guard({ workId: "invented" }));
        const refusal = (effect: ReturnType<typeof guard>) =>
          effect.pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: () => assert.fail("Expected the delegation to be refused."),
            }),
          );
        assert.include(
          yield* refusal(guard({ projectId: ProjectId.make("another-project") })),
          "own project",
        );
        assert.include(
          yield* refusal(guard({ workspaceAssignment: "lead" })),
          "isolated workspace",
        );
        yield* guard();
        yield* guard();
        yield* refused(
          service.guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "duplicate-child",
            request,
          }),
        );
        yield* refused(
          guard({ workId: result.findings[1]!.workId, attemptId: result.findings[1]!.attemptId }),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "handed_back",
            revision: "abc123",
            evidence: "Model claim without accepted child",
          }),
        );
        f.installChild(finding, "abc123");
        f.wake();
        yield* refused(
          service.report(f.caller(), {
            samples: [sample],
            findings: [],
            summary: "Wrong message claim",
          }),
        );
        const delivered = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "abc123",
          evidence: "Accepted child returned revision",
        });
        assert.equal(
          delivered.findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "abc123",
            evidence: "No actual landing operation",
          }),
        );
        f.installChild(finding, "review clean", "reviewer");
        f.setLanding("abc123", "1970-01-01T00:00:00.000Z");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "delivered",
          operationId: "op_confirmed",
          revision: "abc123",
          evidence: "SlipJay confirmed publication",
        });
        const inconclusive = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "No later measurement on delivered revision",
        });
        assert.equal(inconclusive.findings[0]!.status, "inconclusive");
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, maximum: 4 }],
          reason: "Relax target without changing series",
        });
        yield* service.accept({ id: config.id });
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              version: 2,
              value: 3.5,
              revision: "abc123",
              observedAt: "1970-01-01T00:00:01.000Z",
            },
          ],
          findings: [],
          summary: "Target relaxed but product worsened",
        });
        const unchanged = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Do not confuse a relaxed target with improvement",
        });
        assert.equal(unchanged.findings[0]!.status, "inconclusive");
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              version: 2,
              value: 1,
              revision: "abc123",
              observedAt: "1970-01-01T00:00:02.000Z",
            },
          ],
          findings: [],
          summary: "Improved on delivered revision",
        });
        const verified = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Comparable delivered-revision measurement",
        });
        assert.equal(verified.findings.find((f) => f.id === finding.id)!.status, "verified");
      }),
    ),
);

it.effect(
  "records explicit null observations and rejects misleading or nonfinite measurements",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        for (const invalid of [
          { ...sample, value: null },
          { ...sample, value: Number.NaN },
          { ...sample, status: "unknown" as const },
          { ...sample, version: 999 },
        ])
          yield* refused(
            service.report(f.caller(), { samples: [invalid], findings: [], summary: "Invalid" }),
          );
        const result = yield* service.report(f.caller(), {
          samples: [{ ...sample, value: null, status: "insufficient" }],
          findings: [],
          summary: "No trustworthy observation",
        });
        assert.equal(result.findings.length, 0);
        assert.isTrue(result.champion.attention.some((a) => a.includes("insufficient")));
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples[0]!.value, null);
        assert.equal(history.samples[0]!.status, "insufficient");
      }),
    ),
);

it.effect(
  "recovers pending claims after service reconstruction and preserves the owner namespace",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const original = yield* definitions(service);
        f.failNextLaunch();
        const pending = yield* service.runCheck({ id: config.id });
        yield* Effect.gen(function* () {
          const recovered = yield* Champions.ChampionService;
          yield* recovered.runDue;
          const doc = yield* recovered.get({ id: config.id });
          assert.equal(doc.champion.ownerThreadId, original.champion.ownerThreadId);
          assert.equal(doc.champion.outstandingCheckId, pending.champion.outstandingCheckId);
          assert.deepEqual(f.launchRequests[0], f.launchRequests[1]);
        }).pipe(Effect.provide(Layer.fresh(f.layer)));
      }),
    ),
);

it.effect(
  "keeps setup separate from the routine owner and preserves pending user acceptance without freezing the routine check",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const routine = yield* service.runCheck({ id: config.id });
        const setup = yield* service.setup({ id: config.id });
        assert.equal(setup.champion.outstandingCheckId, routine.champion.outstandingCheckId);
        assert.isNotNull(setup.champion.outstandingSetupId);
        assert.notEqual(setup.champion.setupThreadId, setup.champion.ownerThreadId);
        assert.equal(f.launchRequests[0]!.model, "cheap");
        assert.equal(f.launchRequests[1]!.model, "strong");
        const proposal = yield* service.proposeFromSetup(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "Stronger setup proposes a tighter goal",
        });
        assert.isTrue(proposal.champion.pendingProposal);
        assert.isNull(proposal.champion.outstandingSetupId);
        assert.equal(proposal.champion.outstandingCheckId, routine.champion.outstandingCheckId);
        assert.equal(proposal.metrics[0]!.maximum, 2);
      }),
    ),
);

it.effect(
  "lets an explicit manual retry recover an ended run without claiming the dispatch succeeded",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const pending = yield* service.runCheck({ id: config.id });
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().sends, 0);
        f.endRun();
        const retried = yield* service.runCheck({ id: config.id });
        assert.equal(retried.champion.ownerThreadId, pending.champion.ownerThreadId);
        assert.equal(retried.champion.outstandingCheckId, pending.champion.outstandingCheckId);
        assert.equal(f.counts().sends, 1);
        assert.isNull(retried.champion.lastCheckAt);
        const report = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Retry produced an authenticated observation",
        });
        assert.isNull(report.champion.outstandingCheckId);
        assert.isNotNull(report.champion.lastCheckAt);
      }),
    ),
);

it.effect(
  "retries a check that failed on a provider overload by itself, at most three times per claim",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const pending = yield* service.runCheck({ id: config.id });
        const claim = pending.champion.outstandingCheckId;
        for (let retry = 1; retry <= 3; retry++) {
          f.overloadRun();
          yield* service.runDue;
          assert.equal(f.counts().sends, retry);
          const retried = yield* service.get({ id: config.id });
          assert.equal(retried.champion.outstandingCheckId, claim);
          assert.isFalse(retried.champion.attention.some((a) => a.includes("exhausted")));
        }
        f.overloadRun();
        yield* service.runDue;
        assert.equal(f.counts().sends, 3);
        const exhausted = yield* service.get({ id: config.id });
        assert.isTrue(
          exhausted.champion.attention.some(
            (a) => a.includes("automatic retries exhausted") && a.includes("Check now"),
          ),
        );
        // A person can still retry by hand once the automatic retries are spent.
        const manual = yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().sends, 4);
        assert.isFalse(manual.champion.attention.some((a) => a.includes("automatic retr")));
        const report = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Measured on the fallback model",
        });
        assert.isNull(report.champion.outstandingCheckId);
      }),
    ),
);

it.effect("leaves a check that ended without a report for any other reason to a person", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      f.completeRun(true);
      f.endRun();
      yield* service.runDue;
      assert.equal(f.counts().sends, 0);
    }),
  ),
);

const activeFinding = Effect.fn("test.activeChampionFinding")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
) {
  yield* definitions(service);
  yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  yield* service.runCheck({ id: config.id });
  const report = yield* service.report(f.caller(), {
    samples: [sample],
    findings: [],
    summary: "An ordinary repair",
  });
  assert.deepEqual(report.champion.attention, []);
  return report.findings[0]!;
});
const repair = (finding: ChampionFinding) => ({
  role: "implementation-worker" as const,
  taskClass: "non-ui" as const,
  workId: finding.workId,
  attemptId: finding.attemptId,
  workspacePath: "/isolated",
  workspaceAssignment: "isolated" as const,
});

it.effect(
  "keeps healthy repair and ordinary inconclusive verification quiet, while decisions resolve once and wake the owner",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const request = repair(finding);
        yield* service.guardDelegation({
          ownerThreadId: f.caller().threadId,
          request,
          clientRequestId: "implementation",
        });
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        f.installChild(finding, "handoff");
        yield* service.runDue;
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "inconclusive",
          evidence: "Not enough comparable data yet",
        });
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        const requested = yield* service.findingAction(
          {
            id: config.id,
            findingId: finding.id,
            action: "decision",
            reason: "Should this target include weekends?",
            proposal: {
              action: "Include weekends.",
              why: "Weekend traffic is a third of reads.",
              otherOptions: "Weekdays only (misses weekend regressions)",
            },
          },
          unquotedAgent,
        );
        const decision = requested.findings.find((x) => x.id === finding.id)!.decision!;
        assert.equal(decision.status, "requested");
        assert.equal(decision.proposal?.action, "Include weekends.");
        assert.isTrue(requested.champion.attention.some((a) => a.startsWith("Decision:")));
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Checks continue while a decision waits",
        });
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId: decision.id,
          reason: "Include weekends.",
        };
        yield* refused(service.findingAction(answer, unquotedAgent));
        const resolved = yield* service.findingAction(answer);
        assert.equal(
          resolved.findings.find((x) => x.id === finding.id)!.decision!.answer,
          "Include weekends.",
        );
        assert.deepEqual(resolved.champion.attention, []);
        yield* service.findingAction(answer);
        assert.equal(
          f.sent.filter((x) => x.commandId === `champion-decision:${decision.id}`).length,
          1,
        );
      }),
    ),
);

it.effect(
  "persists a resolved decision through an uncertain owner send and retries its deterministic delivery",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const doc = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "decision",
          reason: "Use a tighter limit?",
        });
        const decisionId = doc.findings[0]!.decision!.id;
        f.failDecisionSend(true);
        const pending = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision",
          decisionId,
          reason: "Keep the existing limit.",
        });
        assert.equal(pending.findings[0]!.decision!.status, "resolved");
        assert.isTrue(pending.champion.attention.some((a) => a.includes("delivery pending")));
        f.failDecisionSend(false);
        yield* service.runDue;
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        assert.equal(f.sent.at(-1)!.commandId, `champion-decision:${decisionId}`);
      }),
    ),
);

it.effect(
  "releases refused reservations, preserves uncertainty and permits only the same dispatch identity to replay",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const input = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "repair-stable",
        };
        yield* service.guardDelegation(input);
        yield* service.delegationOutcome({ ...input, state: "failed" });
        const rejected = yield* service.get({ id: config.id });
        assert.equal(rejected.findings[0]!.status, "open");
        assert.isTrue(rejected.champion.attention.some((a) => a.includes("refused")));
        yield* service.guardDelegation(input);
        const commandId = CommandId.make("repair-command");
        yield* service.delegationOutcome({ ...input, state: "started", commandId });
        yield* service.delegationOutcome({ ...input, state: "failed" });
        assert.isTrue(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("uncertain"),
          ),
        );
        yield* refused(service.guardDelegation({ ...input, clientRequestId: "duplicate" }));
        yield* service.guardDelegation(input);
        f.setReceipt(commandId, "rejected");
        yield* service.runDue;
        yield* service.guardDelegation(input);
        f.installChild(finding, "abc123");
        yield* service.delegationOutcome({ ...input, state: "started", commandId });
        f.setReceipt(commandId, "accepted");
        yield* service.delegationOutcome({ ...input, state: "failed" });
        yield* service.runDue;
        assert.equal(
          (yield* service.get({ id: config.id })).findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
      }),
    ),
);

it.effect(
  "supports implementation, independent review and fix followups without duplicating implementers or replacing handoff ownership",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const ownerThreadId = f.caller().threadId;
        const implement = { ownerThreadId, request: repair(finding), clientRequestId: "implement" };
        yield* service.guardDelegation(implement);
        f.installChild(finding, "author-commit");
        yield* service.delegationOutcome({ ...implement, state: "finished" });
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "author-commit",
          evidence: "Worker returned its pinned contribution",
        });
        const review = {
          ownerThreadId,
          clientRequestId: "review",
          request: {
            ...repair(finding),
            role: "reviewer" as const,
            readOnly: true,
            sourceRevision: "author-commit",
            review: {
              scope: "change" as const,
              baseRevision: "base",
              includedChanges: ["author-commit"],
              coverage: "complete" as const,
            },
          },
        };
        yield* service.guardDelegation(review);
        f.installChild(finding, "Needs one fix", "reviewer");
        yield* service.delegationOutcome({ ...review, state: "finished" });
        yield* service.guardDelegation({
          ...implement,
          followup: true,
          clientRequestId: "fix-followup",
        });
        f.installChild(finding, "fixed-commit");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "fixed-commit",
          evidence: "Fix returned on same implementation child",
        });
        yield* service.guardDelegation({
          ...review,
          followup: true,
          clientRequestId: "review-followup",
        });
        f.installChild(finding, "Clean review", "reviewer");
        yield* service.runDue;
        assert.equal(
          (yield* service.get({ id: config.id })).findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "fixed-commit",
            evidence: "A returned author commit alone is not landing",
          }),
        );
        f.setLanding("integration-commit", "1970-01-01T00:00:01.000Z");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "delivered",
          revision: "integration-commit",
          operationId: "op_real_landing",
          evidence: "Owner adopted and landed through SlipJay",
        });
        yield* TestClock.adjust("2 seconds");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1, revision: "integration-commit" }],
          findings: [],
          summary: "Cached pre-delivery observation",
        });
        const stale = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Cache is not improvement evidence",
        });
        assert.equal(stale.findings.find((x) => x.id === finding.id)!.status, "inconclusive");
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              value: 1,
              revision: "integration-commit",
              observedAt: "1970-01-01T00:00:03.000Z",
            },
          ],
          findings: [],
          summary: "Fresh running-revision observation",
        });
        const verified = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Fresh comparable evidence",
        });
        assert.equal(verified.findings.find((x) => x.id === finding.id)!.status, "verified");
      }),
    ),
);

it.effect(
  "routes advice to the explicit stronger selection and permits the normal Forge Spec lead workspace allocation contract",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const ownerThreadId = f.caller().threadId;
        const advisor = {
          ownerThreadId,
          clientRequestId: "advice",
          request: {
            ...repair(finding),
            role: "advisor" as const,
            readOnly: true,
            sourceRevision: "base",
          },
        };
        const selection = yield* service.guardDelegation(advisor);
        assert.equal(selection?.model, "strong");
        f.installChild(finding, "Challenge recorded", "advisor");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "spec",
          specUrl: "https://weave.example/forge/6366",
          evidence: "Advisor challenge shaped the Spec",
        });
        const leadRequest = {
          ...repair(finding),
          role: "lead" as const,
          workspacePath: "/project/root",
          workspaceAssignment: undefined,
        };
        yield* refused(
          service.guardDelegation({ ownerThreadId, clientRequestId: "lead", request: leadRequest }),
        );
        yield* service.guardDelegation({
          ownerThreadId,
          clientRequestId: "lead",
          request: leadRequest,
          forgeItem: 6366,
        });
        yield* refused(
          service.guardDelegation({
            ownerThreadId,
            clientRequestId: "lead",
            request: { ...leadRequest, workspaceAssignment: "isolated" },
            forgeItem: 6366,
          }),
        );
        const continuation = {
          ownerThreadId,
          request: leadRequest,
          followup: true,
          clientRequestId: "lead-continuation",
          childThreadId: ThreadId.make("accepted:lead"),
        };
        f.installChild(finding, "lead-result", "lead", "completed", {
          number: 6366,
          itemId: "spec-id",
          origin: "https://weave.example",
        });
        yield* service.guardDelegation(continuation);
        yield* refused(
          service.guardDelegation({
            ...continuation,
            childThreadId: ThreadId.make("foreign-child"),
          }),
        );
        f.installChild(finding, "lead-result", "lead", "completed", {
          number: 6367,
          itemId: "another-spec",
          origin: "https://weave.example",
        });
        yield* refused(service.guardDelegation(continuation));
        assert.isNull((yield* service.get({ id: config.id })).findings[0]!.childThreadId);
      }),
    ),
);

it.effect(
  "publishes accepted definitions and reports only after committed data is visible to a real subscriber",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* service.upsert(config);
        const queue = yield* Queue.unbounded<void>();
        yield* service.subscribe({}).pipe(
          Stream.runForEach(() => Queue.offer(queue, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(queue);
        yield* service.propose({
          id: config.id,
          metrics: [metric],
          reason: "Accept these metrics",
        });
        yield* Queue.take(queue);
        yield* service.accept({ id: config.id });
        yield* Queue.take(queue);
        assert.equal((yield* service.get({ id: config.id })).metrics[0]!.version, 1);
        yield* service.runCheck({ id: config.id });
        yield* Queue.take(queue);
        yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Committed report",
        });
        yield* Queue.take(queue);
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples[0]!.value, 3);
        assert.isNotNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      }),
    ),
);

it.effect(
  "bounds current findings and evidence while retaining older settled findings in paged history",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* refused(
          service.report(f.caller(), {
            samples: [{ ...sample, evidence: "x".repeat(8001) }],
            findings: [],
            summary: "Oversized observation",
          }),
        );
        const first = yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 0 }],
          findings: Array.from({ length: 20 }, (_, i) => ({
            title: `Problem-${i}`,
            evidence: "Observed once",
          })),
          summary: "Batch 0",
        });
        for (const finding of first.findings)
          yield* service.findingAction({
            id: config.id,
            findingId: finding.id,
            action: "dismiss",
            reason: "Resolved by owner",
          });
        for (let batch = 1; batch < 6; batch += 1) {
          yield* TestClock.adjust("1 second");
          yield* service.runCheck({ id: config.id });
          const report = yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 0 }],
            findings: Array.from({ length: 20 }, (_, i) => ({
              title: `Problem-${batch * 20 + i}`,
              evidence: "Observed once",
            })),
            summary: `Batch ${batch}`,
          });
          for (const finding of report.findings.filter((x) => x.status === "open"))
            yield* service.findingAction({
              id: config.id,
              findingId: finding.id,
              action: "dismiss",
              reason: "Resolved by owner",
            });
        }
        assert.equal((yield* service.get({ id: config.id })).findings.length, 100);
        const old = yield* service.history({
          id: config.id,
          before: "1970-01-01T00:00:00.001Z",
          limit: 100,
        });
        assert.equal(old.findings?.length, 20);
        assert.isTrue(old.samples.every((x) => x.evidence.length <= 8000));
      }),
    ),
);

it.effect(
  "does not decode unrelated champion documents while authorizing an ordinary unrelated thread",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO champions(id,project_id,document_json) VALUES ('unrelated','project', '{"champion":{"ownerThreadId":"unrelated-owner","setupThreadId":null},"findings":"corrupt history"}')`.pipe(
          Effect.orDie,
        );
        yield* service.guardDelegation({
          ownerThreadId: ThreadId.make("ordinary-thread"),
          request: undefined,
          clientRequestId: undefined,
        });
      }),
    ),
);

it.effect(
  "exposes compact latest readings independent of activity pagination and never marks stale or older-definition readings healthy",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Healthy current observation",
        });
        const first = (yield* service.list({})).champions[0]!.latestSamples![0]!;
        assert.equal(first.health, "healthy");
        assert.isFalse("evidence" in first);
        yield* TestClock.adjust("3 minutes");
        assert.equal((yield* service.list({})).champions[0]!.latestSamples![0]!.health, "stale");
        assert.equal((yield* service.get({ id: config.id })).latestSamples![0]!.health, "stale");
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, required: false, baseline: 5, staleAfterMs: 1000 }],
          reason: "Optional goal with an explicit baseline",
        });
        yield* service.accept({ id: config.id });
        assert.equal((yield* service.get({ id: config.id })).latestSamples![0]!.health, "unknown");
        yield* service.runCheck({ id: config.id });
        const optional = yield* service.report(f.caller(), {
          samples: [],
          findings: [],
          summary: "No optional observation this time",
        });
        assert.deepEqual(optional.champion.attention, []);
        assert.equal(optional.metrics[0]!.baseline, 5);
        assert.equal(optional.metrics[0]!.required, false);
      }),
    ),
);

it.effect(
  "discards proposals without changing accepted versions and completes or cancels setup without fabricating a proposal",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const accepted = yield* definitions(service);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, maximum: 1 }],
          reason: "Pending tighter goal",
        });
        const discarded = yield* service.discardProposal({ id: config.id });
        assert.isNull(discarded.proposal);
        assert.deepEqual(discarded.metrics, accepted.metrics);
        const setup = yield* service.setup({ id: config.id });
        assert.isNotNull(setup.champion.outstandingSetupId);
        const complete = yield* service.completeSetup(f.caller(), {
          summary: "Existing accepted definitions remain appropriate.",
        });
        assert.isNull(complete.champion.outstandingSetupId);
        assert.isNull(complete.proposal);
        assert.deepEqual(complete.metrics, accepted.metrics);
        yield* service.setup({ id: config.id });
        const cancelled = yield* service.cancelSetup({ id: config.id });
        assert.isNull(cancelled.champion.outstandingSetupId);
        assert.deepEqual(cancelled.metrics, accepted.metrics);
        yield* refused(
          service.proposeFromSetup(f.caller(), {
            metrics: [metric],
            reason: "Old cancelled caller",
          }),
        );
        yield* service.setup({ id: config.id });
        const proposed = yield* service.proposeFromSetup(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "A later setup may propose again",
        });
        assert.isNotNull(proposed.proposal);
        assert.deepEqual(proposed.metrics, accepted.metrics);
      }),
    ),
);

it.effect(
  "keeps failed preflight followups from rewriting an existing phase and exposes the stable identity of an uncertain followup",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const initial = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "first-implementation",
        };
        yield* service.guardDelegation(initial);
        f.installChild(finding, "first-commit");
        yield* service.delegationOutcome({ ...initial, state: "finished" });
        yield* service.runDue;
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "first-commit",
          evidence: "Initial handoff",
        });
        const followup = { ...initial, followup: true, clientRequestId: "fix-followup" };
        yield* service.guardDelegation(followup);
        yield* service.delegationOutcome({ ...followup, state: "failed" });
        assert.equal((yield* service.get({ id: config.id })).findings[0]!.status, "handed_back");
        const commandId = CommandId.make("followup-command");
        yield* service.delegationOutcome({ ...followup, state: "started", commandId });
        f.installChild(finding, "", "implementation-worker", "running");
        yield* service.delegationOutcome({ ...followup, state: "failed" });
        const uncertain = yield* service.get({ id: config.id });
        assert.isTrue(uncertain.champion.attention.some((a) => a.includes("fix-followup")));
        yield* service.delegationOutcome({
          ...initial,
          clientRequestId: "unrelated-rejected-request",
          state: "failed",
        });
        assert.deepEqual(
          (yield* service.get({ id: config.id })).champion.attention,
          uncertain.champion.attention,
        );
        f.installChild(finding, "fixed-commit");
        f.setReceipt(commandId, "accepted");
        yield* service.runDue;
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        const handedBack = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "fixed-commit",
          evidence: "Same implementation child returned the fix",
        });
        assert.isNull(handedBack.findings[0]!.delivery);
      }),
    ),
);

it.effect(
  "refreshes expired readings for a paused subscriber without inventing inbox attention, and cancels setup before dispatch begins",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Paused manual reading",
        });
        const queue = yield* Queue.unbounded<void>();
        yield* service.subscribe({}).pipe(
          Stream.runForEach(() => Queue.offer(queue, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(queue);
        yield* TestClock.adjust("3 minutes");
        yield* service.runDue;
        yield* Queue.take(queue);
        const stale = (yield* service.list({})).champions[0]!;
        assert.equal(stale.latestSamples![0]!.health, "stale");
        assert.deepEqual(stale.attention, []);
        f.available(false);
        const draft = yield* service.setup({ id: config.id });
        assert.isNotNull(draft.champion.outstandingSetupId);
        const cancelled = yield* service.cancelSetup({ id: config.id });
        assert.isNull(cancelled.champion.outstandingSetupId);
      }),
    ),
);

it.effect("rejects incompatible measured sources without changing history or health", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      yield* service.runCheck({ id: config.id });
      yield* refused(
        service.report(f.caller(), {
          samples: [{ ...sample, source: "synthetic", value: 0 }],
          findings: [],
          summary: "Wrong source",
        }),
      );
      assert.deepEqual((yield* service.history({ id: config.id })).samples, []);
      assert.isNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      const accepted = yield* service.report(f.caller(), {
        samples: [{ ...sample, evidence: "https://evidence.example/logs" }],
        findings: [],
        summary: "Real logs",
      });
      assert.equal((yield* service.history({ id: config.id })).samples[0]!.source, "logs");
      assert.equal(accepted.findings.length, 1);
    }),
  ),
);

it.effect.each(["failed", "cancelled", "interrupted"])(
  "charges an accepted %s repair against the daily budget after reconciliation",
  (status) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        yield* service.upsert({ ...config, charter: { ...config.charter, maxRepairsPerDay: 1 } });
        const input = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "first",
        };
        yield* service.guardDelegation(input);
        yield* service.delegationOutcome({ ...input, state: "finished" });
        f.installChild(finding, "failed-revision", "implementation-worker", status);
        yield* service.runDue;
        const reopened = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "reopen",
          reason: "Retry",
        });
        yield* refused(
          service.guardDelegation({
            ...input,
            request: repair(reopened.findings[0]!),
            clientRequestId: "second",
          }),
        );
      }),
    ),
);

it.effect.each(["reopen", "decision"] as const)(
  "fetches landing evidence outside the mutation lock and rejects a concurrent %s",
  (action) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        f.installChild(finding, "delivered-revision");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "delivered-revision",
          evidence: "Child handoff",
        });
        f.setLanding("delivered-revision", "1970-01-01T00:00:01.000Z");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.blockLanding(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const delivery = yield* service
          .updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "delivered-revision",
            operationId: "operation",
            evidence: "Runner evidence",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.upsert({ ...config, name: "Updated during lookup" });
        yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action,
          reason: "New attempt",
        });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(delivery);
        assert.equal(result._tag, "Failure");
        const current = yield* service.get({ id: config.id });
        assert.equal(current.champion.name, "Updated during lookup");
        assert.equal(current.findings[0]!.status, action === "reopen" ? "open" : "handed_back");
        assert.isNull(current.findings[0]!.delivery);
      }),
    ),
);

it.effect("charges uncertainty, releases genuine refusals and counts stable replays once", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const first = yield* activeFinding(f, service);
      yield* service.upsert({
        ...config,
        charter: { ...config.charter, maxConcurrentRepairs: 3, maxRepairsPerDay: 1 },
      });
      yield* service.runCheck({ id: config.id });
      const report = yield* service.report(f.caller(), {
        samples: [sample],
        findings: [{ title: "Database backlog", evidence: "Observed" }],
        summary: "More work",
      });
      const second = report.findings.find((finding) => finding.id !== first.id)!;
      const initial = {
        ownerThreadId: f.caller().threadId,
        request: repair(first),
        clientRequestId: "first",
      };
      const next = { ...initial, request: repair(second), clientRequestId: "second" };
      yield* service.guardDelegation(initial);
      yield* service.delegationOutcome({
        ...initial,
        state: "started",
        commandId: CommandId.make("uncertain"),
      });
      yield* refused(service.guardDelegation(next));
      f.setReceipt("uncertain", "rejected");
      yield* service.delegationOutcome({
        ...initial,
        state: "failed",
        commandId: CommandId.make("uncertain"),
      });
      yield* service.guardDelegation(next);
      yield* service.delegationOutcome({ ...next, state: "finished" });
      yield* service.guardDelegation(next);
      yield* service.delegationOutcome({ ...next, state: "finished" });
      yield* refused(service.guardDelegation(initial));
      yield* service.upsert({
        ...config,
        charter: { ...config.charter, maxConcurrentRepairs: 3, maxRepairsPerDay: 2 },
      });
      yield* service.guardDelegation(initial);
    }),
  ),
);

const learning = (id = "learning:errors"): ChampionLearningRecordInput => ({
  id: config.id,
  learningId: id,
  expectedCurrentId: null,
  reason: "Observed comparison",
  topic: "errors",
  plainSummary: "One error collector catches more problems than the others.",
  question: "Which collector detects errors?",
  conclusion: "Use the structured collector",
  attempts: [
    {
      attemptId: "observed-attempt",
      outcome: "inconclusive",
      evidence: "No confident improvement",
    },
  ],
  evidence: [
    {
      source: "fixture-observation",
      evidence: "Recorded error counts",
      observedAt: "1970-01-01T00:00:00.000Z",
    },
  ],
  components: [{ component: "collector", version: "1", observedAt: "1970-01-01T00:00:00.000Z" }],
  environment: "Isolated fixture",
  applicability: "Small projects",
  tradeoffs: "No browser coverage",
  reviewAt: "1970-01-02T00:00:00.000Z",
  reviewConditions: ["Requirements change"],
  versionConditions: [{ component: "collector", comparison: "changed", version: "1" }],
});
const investigationFixture = Effect.fn("test.championInvestigation")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
  name = "investigation:errors",
) {
  yield* definitions(service);
  yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  yield* service.runCheck({ id: config.id });
  const detail = yield* service.report(f.caller(), {
    samples: [sample],
    findings: [],
    summary: "Metric breached",
  });
  const receipt = yield* service.learningQuery({
    id: config.id,
    topic: "errors",
    observations: [],
  });
  const investigation = yield* service.startInvestigation({
    id: config.id,
    findingId: detail.findings[0]!.id,
    investigationId: name,
    question: "Compare error collectors",
    topic: "errors",
    retrievalReceiptId: receipt.receiptId,
    alternatives: [
      { id: "a", role: "advisor", hypothesis: "Structured logs", evidenceNeeds: "Error counts" },
      {
        id: "b",
        role: "advisor",
        hypothesis: "Runtime counters",
        evidenceNeeds: "Counter quality",
      },
      { id: "c", role: "scout", hypothesis: "Existing collector", evidenceNeeds: "Coverage gaps" },
    ],
  });
  const admission = (
    branchIndex = 0,
    requestId = `branch:${branchIndex}`,
    followup = false,
    childId?: ThreadId,
  ) => {
    const branch = investigation.branches[branchIndex]!;
    const binding = decodeBinding({
      ...branch,
      role: branch.role,
      taskClass: "non-ui",
      readOnly: true,
      workspacePath: "/project/root",
      executionBoundary: "read-only",
      executionRequirement: "sandbox-required",
      sourceAccess: "read-only",
      toolProfile: "source-reader",
      requestFingerprint: "c".repeat(64),
      policyHash: "a".repeat(64),
      policyRevision: "policy-one",
      briefHash: "b".repeat(64),
      requested: config.setupModelSelection,
      assigned: null,
      effective: config.setupModelSelection,
    });
    return {
      ownerThreadId: detail.champion.ownerThreadId,
      parentRunId: RunId.make("run:check"),
      binding,
      projectId,
      workspacePath: binding.workspacePath,
      selection: binding.effective,
      commandId: CommandId.make(`command:${requestId}`),
      taskId: NodeId.make(`task:${requestId}`),
      childThreadId: childId ?? ThreadId.make(`child:${requestId}`),
      messageId: MessageId.make(`message:${requestId}`),
      clientRequestId: requestId,
      followup,
    };
  };
  return { investigation, detail, admission };
});

it.effect("keeps class defaults additive and preserves migrated classes on old-client edits", () =>
  withFixture((_f, service) =>
    Effect.gen(function* () {
      const classes = yield* decodeClasses({}).pipe(Effect.orDie);
      assert.deepEqual(classes, {
        setup: { role: "advisor", taskClass: "non-ui" },
        routine: { role: "chore-worker", taskClass: "non-ui" },
      });
      assert.isUndefined((yield* decodeConfig(config).pipe(Effect.orDie)).classes);
      const unavailable = yield* service.classChoices({ projectId });
      assert.isNotNull(unavailable.refusal);
      assert.deepEqual(unavailable.roles, []);
      yield* refused(service.upsert({ ...config, classes }));
      yield* service.upsert(config);
      yield* service.upsert({ ...config, classes });
      const updated = yield* service.upsert({ ...config, name: "Old-client edit" });
      assert.deepEqual(updated.champion.classes, classes);
      yield* refused(service.setup({ id: config.id }));
      assert.deepEqual((yield* service.runtimeState({ id: config.id })).attempts, []);
    }),
  ),
);

it.effect(
  "reserves exact independent advisor branches atomically, holds unknown capacity and charges admitted failures",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { admission, investigation } = yield* investigationFixture(f, service);
        const sql = yield* SqlClient.SqlClient;
        const wrong = admission();
        yield* refused(
          service.admitInvestigation({ ...wrong, projectId: ProjectId.make("wrong-project") }),
        );
        assert.equal(
          (yield* sql`SELECT id FROM champion_branch_attempts`.pipe(Effect.orDie)).length,
          0,
        );
        yield* Effect.all(
          [service.admitInvestigation(admission(0)), service.admitInvestigation(admission(1))],
          { concurrency: "unbounded" },
        );
        yield* service.admitInvestigation(admission(0));
        yield* refused(service.admitInvestigation(admission(2)));
        yield* service.delegationOutcome({
          ownerThreadId: wrong.ownerThreadId,
          request: wrong.binding,
          clientRequestId: wrong.clientRequestId,
          state: "failed",
          commandId: wrong.commandId,
        });
        yield* service.runDue;
        let state = (yield* service.runtimeState({ id: config.id })).investigations[0]!;
        assert.equal(state.attempts.length, 2);
        assert.isTrue(state.attempts.every((a) => a.state === "unknown"));
        yield* refused(
          service.findingAction({
            id: config.id,
            findingId: investigation.findingId,
            action: "dismiss",
            reason: "Cannot detach",
          }),
        );
        const first = state.attempts.find((a) => a.branchId === "a")!;
        f.setReceipt(first.commandId, "rejected");
        yield* service.runDue;
        yield* service.admitInvestigation(admission(0, "retry-a"));
        state = (yield* service.runtimeState({ id: config.id })).investigations[0]!;
        assert.equal(state.attempts.length, 3);
        assert.equal(state.attempts.find((a) => a.id === first.id)!.admittedAt, first.admittedAt);
        assert.equal(state.attempts.find((a) => a.id === first.id)!.state, "failed");
        yield* refused(service.admitInvestigation(admission(2)));
        yield* service.setLifecycle({ id: config.id, lifecycle: "paused" });
        yield* service.admitInvestigation(admission(0, "retry-a"));
      }),
    ),
);

it.effect(
  "charges follow-ups once, preserves bindings and enforces six investigation and rolling daily attempts",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { admission } = yield* investigationFixture(f, service);
        yield* service.admitInvestigation(admission());
        let attempt = (yield* service.runtimeState({ id: config.id })).investigations[0]!
          .attempts[0]!;
        const initialChild = attempt.childThreadId;
        for (let index = 1; index < 6; index++) {
          f.installBranch(attempt, "completed");
          yield* service.runDue;
          const next = admission(0, `followup:${index}`, true, initialChild);
          yield* service.admitInvestigation(next);
          yield* service.admitInvestigation(next);
          attempt = (yield* service.runtimeState({
            id: config.id,
          })).investigations[0]!.attempts.find((a) => a.clientRequestId === next.clientRequestId)!;
          assert.equal(attempt.binding.policyHash, "a".repeat(64));
        }
        f.installBranch(attempt, "completed");
        yield* service.runDue;
        yield* refused(service.admitInvestigation(admission(0, "seventh", true, initialChild)));
        assert.equal(
          (yield* service.runtimeState({ id: config.id })).investigations[0]!.attempts.length,
          6,
        );
      }),
    ),
);

it.effect(
  "recovers persisted cancellation without an MCP caller, respects narrowed permissions and never releases unknown or foreign children",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { admission, investigation } = yield* investigationFixture(f, service);
        yield* service.admitInvestigation(admission());
        const attempt = (yield* service.runtimeState({ id: config.id })).investigations[0]!
          .attempts[0]!;
        f.installBranch(attempt, "running");
        yield* service.cancelInvestigation({
          id: config.id,
          investigationId: investigation.investigationId,
          requestId: "cancel-once",
          reason: "Stop comparison",
        });
        f.ownerMode("approval-required");
        const restart = Effect.gen(function* () {
          const recovered = yield* Champions.ChampionService;
          yield* recovered.runDue;
          return yield* recovered.runtimeState({ id: config.id });
        });
        let recovered = yield* restart.pipe(Effect.provide(f.layer));
        assert.isFalse(f.dispatches.includes("thread.stop"));
        assert.equal(recovered.investigations[0]!.status, "cancel_requested");
        assert.include(recovered.investigations[0]!.attention!, "capacity remains held");
        f.ownerMode("full-access");
        f.installBranch(attempt, "running", true);
        recovered = yield* restart.pipe(Effect.provide(f.layer));
        assert.isFalse(f.dispatches.includes("thread.stop"));
        assert.equal(recovered.investigations[0]!.attempts[0]!.state, "unknown");
        f.installBranch(attempt, "running");
        recovered = yield* restart.pipe(Effect.provide(f.layer));
        assert.isTrue(f.dispatches.includes("thread.stop"));
        assert.equal(recovered.investigations[0]!.status, "cancel_requested");
        f.installBranch(attempt, "cancelled");
        recovered = yield* restart.pipe(Effect.provide(f.layer));
        assert.equal(recovered.investigations[0]!.status, "cancelled");
        f.installBranch(attempt, "completed");
        yield* service.runDue;
        assert.equal(
          (yield* service.runtimeState({ id: config.id })).investigations[0]!.status,
          "cancelled",
        );
      }),
    ),
);

it.effect(
  "retains versioned learning across restart with bounded topic/due pages, observed-version invalidation and concurrent supersession",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        const first = yield* service.recordLearning(f.caller(), learning());
        const query = { id: config.id, topic: "errors", observations: [] };
        assert.equal(
          (yield* service.learningQuery(query)).revisions[0]!.applicabilityState,
          "current",
        );
        yield* TestClock.adjust("1 second");
        assert.equal(
          (yield* service.learningQuery({
            ...query,
            observations: [
              { component: "unrelated", version: "2", observedAt: "1970-01-01T00:00:01.000Z" },
            ],
          })).revisions[0]!.applicabilityState,
          "current",
        );
        assert.equal(
          (yield* service.learningQuery({
            ...query,
            observations: [
              { component: "collector", version: null, observedAt: "1970-01-01T00:00:01.000Z" },
            ],
          })).revisions[0]!.applicabilityState,
          "current",
        );
        assert.equal(
          (yield* service.learningQuery({
            ...query,
            due: true,
            observations: [
              { component: "collector", version: "2", observedAt: "1970-01-01T00:00:01.000Z" },
            ],
          })).revisions[0]!.applicabilityState,
          "uncertain",
        );
        const input = {
          ...learning(),
          expectedCurrentId: first.id,
          conclusion: "Revised after evidence",
        };
        const outcomes = yield* Effect.all(
          [
            Effect.exit(service.recordLearning(f.caller(), input)),
            Effect.exit(
              service.recordLearning(f.caller(), {
                ...input,
                conclusion: "A different concurrent conclusion",
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(outcomes.filter((e) => e._tag === "Success").length, 1);
        yield* service.recordLearning(f.caller(), learning("learning:second"));
        const history = yield* service.learningQuery({
          ...query,
          includeSuperseded: true,
          limit: 1,
        });
        assert.equal(history.revisions.length, 1);
        assert.isNotNull(history.nextCursor);
        const restarted = yield* Effect.gen(function* () {
          return yield* (yield* Champions.ChampionService).learningQuery(query);
        }).pipe(Effect.provide(f.layer));
        assert.equal(restarted.revisions.length, 2);
        assert.deepEqual(
          (yield* service.learningQuery({ ...query, topic: "unrelated" })).revisions,
          [],
        );
        yield* TestClock.adjust("2 days");
        assert.isTrue(
          (yield* service.learningQuery({ ...query, due: true })).revisions.every(
            (r) => r.applicabilityState === "uncertain",
          ),
        );
        yield* refused(
          service.recordLearning(f.caller(), {
            ...learning("too-large"),
            conclusion: "x".repeat(25_000),
          }),
        );
      }),
    ),
);

const peachLive = (threadId: string, role: ChampionLearningContributor["role"] = "lead") =>
  ({
    environmentId: EnvironmentId.make("peach-live"),
    environmentLabel: "peach-live",
    linkSessionId: "link-session",
    threadId,
    threadTitle: "Spec lead",
    role,
  }) satisfies ChampionLearningContributor;

it.effect(
  "searches learnings by their words without writing receipts, and keeps a contribution in history once the Champion confirms or supersedes it",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const receipts = () =>
          sql<{ n: number }>`SELECT COUNT(*) AS n FROM champion_learning_receipts`.pipe(
            Effect.map((rows) => rows[0]!.n),
            Effect.orDie,
          );
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.recordLearning(f.caller(), learning());
        yield* TestClock.adjust("1 second");
        const contributed = yield* service.contributeLearning(peachLive("thread:lead"), {
          ...learning("learning:prefetch"),
          topic: "latency",
          plainSummary: "Warming the cache first makes the first screen quicker.",
          conclusion: "Prefetching the manifest halves cold start.",
          reviewAt: "1970-03-01T00:00:00.000Z",
        });
        assert.deepEqual(contributed.contribution, peachLive("thread:lead"));

        const before = yield* receipts();
        const found = yield* service.learningSearch({ query: "manifest halves" });
        assert.deepEqual(
          found.learnings.map((entry) => entry.revision.learningId),
          ["learning:prefetch"],
        );
        assert.equal(found.learnings[0]!.plainSummary, contributed.plainSummary);
        const all = yield* service.learningSearch({});
        assert.deepEqual(
          all.learnings.map((entry) => entry.revision.learningId),
          ["learning:prefetch", "learning:errors"],
        );
        assert.deepEqual(
          (yield* service.learningSearch({ filter: "contributed" })).learnings.map(
            (entry) => entry.revision.learningId,
          ),
          ["learning:prefetch"],
        );
        // learning() is due a day after the epoch; the contribution is not.
        yield* TestClock.adjust("2 days");
        assert.deepEqual(
          (yield* service.learningSearch({ filter: "due" })).learnings.map(
            (entry) => entry.revision.learningId,
          ),
          ["learning:errors"],
        );
        assert.deepEqual(
          (yield* service.learningTopics({})).topics.map((topic) => topic.topic).sort(),
          ["errors", "latency"],
        );
        assert.equal(yield* receipts(), before);

        // The Champion reviews it: a confirmation adds no revision, and the review queue empties.
        assert.deepEqual(
          (yield* service.learningSearch({ filter: "needs-review" })).learnings.map(
            (entry) => entry.revision.learningId,
          ),
          ["learning:prefetch"],
        );
        const confirmInput = {
          id: config.id,
          learningId: "learning:prefetch",
          revisionId: contributed.id,
          note: "Matches the cold-start readings",
        };
        yield* refused(service.confirmLearning(undefined, confirmInput));
        const confirmed = yield* service.confirmLearning(f.caller(), confirmInput);
        assert.equal(confirmed.revision.id, contributed.id);
        assert.equal(confirmed.confirmation?.note, "Matches the cold-start readings");
        assert.deepEqual((yield* service.learningSearch({ filter: "needs-review" })).learnings, []);

        const superseded = yield* service.recordLearning(f.caller(), {
          ...learning("learning:prefetch"),
          topic: "latency",
          expectedCurrentId: contributed.id,
          reason: "Later readings show a smaller gain",
          conclusion: "Prefetching the manifest saves a fifth of cold start.",
        });
        const read = yield* service.learningRead({
          id: config.id,
          learningId: "learning:prefetch",
        });
        assert.equal(read.current.revision.id, superseded.id);
        assert.isUndefined(read.current.revision.contribution);
        assert.deepEqual(
          read.history.map((revision) => [revision.id, revision.isCurrent]),
          [
            [superseded.id, true],
            [contributed.id, false],
          ],
        );
        assert.equal(read.current.earlierRevisions, 1);
        assert.equal(read.confirmations.length, 1);
      }),
    ),
);

it.effect(
  "holds contributions to the Champion's own rules and adds plain notes without a new revision",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        const reasonOf = <A>(effect: Effect.Effect<A, ChampionError>) =>
          effect.pipe(
            Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "recorded" }),
          );
        const invalid = (input: ChampionLearningRecordInput) =>
          reasonOf(service.contributeLearning(peachLive("thread:lead"), input));
        const noReview = {
          ...learning("learning:no-review"),
          reviewAt: null,
          reviewConditions: [],
          versionConditions: [],
          components: [],
        };
        assert.equal(yield* invalid(noReview), "invalid");
        assert.equal(yield* reasonOf(service.recordLearning(f.caller(), noReview)), "invalid");
        const { plainSummary: _, ...withoutPlain } = learning("learning:no-plain");
        assert.equal(yield* invalid(withoutPlain), "invalid");
        // The Champion's own thread records its learning directly.
        yield* refused(
          service.contributeLearning(
            { ...peachLive(f.caller().threadId), linkSessionId: null, environmentLabel: null },
            learning("learning:own"),
          ),
        );

        const recorded = yield* service.recordLearning(f.caller(), learning());
        // A contributor adds learnings or revises its own contribution, never the Champion's.
        assert.equal(
          yield* reasonOf(
            service.contributeLearning(peachLive("thread:lead"), {
              ...learning(),
              expectedCurrentId: recorded.id,
              reason: "Disagree",
            }),
          ),
          "unauthorized",
        );
        const contributed = yield* service.contributeLearning(
          peachLive("thread:lead"),
          learning("learning:contributed"),
        );
        assert.equal(
          yield* reasonOf(
            service.contributeLearning(peachLive("thread:lead"), {
              ...learning("learning:contributed"),
              expectedCurrentId: contributed.id,
              reason: "Better evidence",
              conclusion: "Revised by its contributor",
            }),
          ),
          "recorded",
        );
        // A plain sentence goes only where the revision has none of its own.
        yield* refused(
          service.noteLearning(f.caller(), {
            id: config.id,
            learningId: "learning:errors",
            revisionId: recorded.id,
            plainSummary: "Another plain sentence.",
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        const legacy = { ...recorded, plainSummary: undefined };
        yield* sql`UPDATE champion_learning_revisions SET document_json = ${JSON.stringify(legacy)} WHERE id = ${recorded.id}`.pipe(
          Effect.orDie,
        );
        const signature = () =>
          sql<{ n: number }>`SELECT COUNT(*) AS n FROM champion_learning_revisions`.pipe(
            Effect.map((rows) => rows[0]!.n),
            Effect.orDie,
          );
        const revisionsBefore = yield* signature();
        assert.isNull(
          (yield* service.learningRead({ id: config.id, learningId: "learning:errors" })).current
            .plainSummary,
        );
        const noted = yield* service.noteLearning(f.caller(), {
          id: config.id,
          learningId: "learning:errors",
          revisionId: recorded.id,
          plainSummary: "One error collector catches more problems.",
        });
        assert.equal(noted.revision.id, recorded.id);
        assert.equal(noted.plainSummary, "One error collector catches more problems.");
        assert.equal(yield* signature(), revisionsBefore);
      }),
    ),
);

it.effect(
  "binds immutable recommendations to scope and finding attempt, rejects stale decisions and delivers one replayable owner message",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { investigation, admission } = yield* investigationFixture(f, service);
        yield* service.admitInvestigation(admission());
        f.installBranch(
          (yield* service.runtimeState({ id: config.id })).investigations[0]!.attempts[0]!,
          "completed",
        );
        yield* service.runDue;
        const input = {
          id: config.id,
          investigationId: investigation.investigationId,
          recommendationId: "recommendation:one",
          expectedCurrentId: null,
          proposedScope: "Change the error collector only",
          summary: "Compare collector choices",
          alternatives: "Logs versus counters",
          benefits: "Better evidence",
          tradeoffs: "Collector cost",
          uncertainty: "Small sample",
          recommendation: "Use structured logs",
        };
        yield* service.synthesize(f.caller(), input);
        yield* service.synthesize(f.caller(), input);
        const first = (yield* service.get({ id: config.id })).findings[0]!.decision!;
        assert.equal(first.proposedScope, input.proposedScope);
        yield* service.synthesize(f.caller(), {
          ...input,
          recommendationId: "recommendation:two",
          expectedCurrentId: input.recommendationId,
          proposedScope: "Measure counters first",
        });
        yield* refused(
          service.findingAction({
            id: config.id,
            findingId: investigation.findingId,
            action: "resolve_decision",
            decisionId: first.id,
            reason: "Approved",
          }),
        );
        const decision = (yield* service.get({ id: config.id })).findings[0]!.decision!;
        const answer = {
          id: config.id,
          findingId: investigation.findingId,
          action: "resolve_decision" as const,
          decisionId: decision.id,
          reason: "Approved within stated scope",
        };
        f.failDecisionSend(true);
        yield* service.findingAction(answer);
        yield* service.synthesize(f.caller(), {
          ...input,
          recommendationId: "recommendation:two",
          expectedCurrentId: input.recommendationId,
          proposedScope: "Measure counters first",
        });
        const replayed = (yield* service.get({ id: config.id })).findings[0]!.decision!;
        assert.equal(replayed.id, decision.id);
        assert.equal(replayed.status, "resolved");
        assert.equal(replayed.answer, answer.reason);
        f.failDecisionSend(false);
        yield* service.runDue;
        yield* service.findingAction(answer);
        assert.equal(
          f.sent.filter((s) => s.commandId === `champion-decision:${decision.id}`).length,
          1,
        );
        assert.include(f.sent.at(-1)!.text, "Measure counters first");
        yield* service.synthesize(f.caller(), {
          ...input,
          recommendationId: "recommendation:three",
          expectedCurrentId: "recommendation:two",
          proposedScope: "Measure a second collector",
        });
        const replacement = (yield* service.get({ id: config.id })).findings[0]!.decision!;
        assert.notEqual(replacement.id, decision.id);
        assert.equal(replacement.status, "requested");
        assert.isNull(replacement.answer);
        yield* refused(service.findingAction(answer));
        yield* service.findingAction({
          id: config.id,
          findingId: investigation.findingId,
          action: "reopen",
          reason: "New finding attempt",
        });
        assert.isNull((yield* service.get({ id: config.id })).findings[0]!.decision);
        yield* refused(service.findingAction(answer));
      }),
    ),
);

it.effect("reads an evicted pending decision recommendation by exact bounded scope", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const { investigation, admission } = yield* investigationFixture(f, service);
      yield* service.admitInvestigation(admission());
      f.installBranch(
        (yield* service.runtimeState({ id: config.id })).investigations[0]!.attempts[0]!,
        "completed",
      );
      yield* service.runDue;
      const retained = yield* service.synthesize(f.caller(), {
        id: config.id,
        investigationId: investigation.investigationId,
        recommendationId: "old-pending",
        expectedCurrentId: null,
        proposedScope: "Collector only",
        summary: "Choose a collector",
        alternatives: "Logs or counters",
        benefits: "Evidence",
        tradeoffs: "Cost",
        uncertainty: "Small sample",
        recommendation: "Use logs.",
      });
      const decision = (yield* service.get({ id: config.id })).findings[0]!.decision!;
      const sql = yield* SqlClient.SqlClient;
      for (let i = 0; i < 22; i++) {
        const newer = {
          ...retained,
          recommendationId: `newer:${i}`,
          findingId: "another-finding",
          recordedAt: "2026-11-05T12:00:00.000Z",
        };
        yield* sql`INSERT INTO champion_recommendations (id,champion_id,investigation_id,at,document_json) VALUES (${newer.recommendationId},${config.id},${investigation.investigationId},${newer.recordedAt},${JSON.stringify(newer)})`.pipe(
          Effect.orDie,
        );
      }
      const recent = yield* service.runtimeState({ id: config.id });
      assert.lengthOf(recent.recommendations, 20);
      assert.isFalse(
        recent.recommendations.some((r) => r.recommendationId === retained.recommendationId),
      );
      const query = {
        id: config.id,
        findingId: retained.findingId,
        findingAttemptId: retained.findingAttemptId,
        recommendationId: retained.recommendationId,
      };
      assert.deepEqual(yield* service.recommendation(query), retained);
      assert.isBelow(
        new TextEncoder().encode(JSON.stringify(yield* service.recommendation(query))).length,
        24_001,
      );
      yield* refused(service.recommendation({ ...query, id: "foreign" }));
      yield* refused(service.recommendation({ ...query, findingId: "another-finding" }));
      yield* refused(service.recommendation({ ...query, findingAttemptId: "prior-attempt" }));
      yield* refused(service.recommendation({ ...query, recommendationId: "unknown" }));
      yield* sql`UPDATE champion_recommendations SET document_json = ${JSON.stringify({ ...retained, recommendation: "x".repeat(24_001) })} WHERE id = ${retained.recommendationId}`.pipe(
        Effect.orDie,
      );
      yield* refused(service.recommendation(query));
      yield* sql`UPDATE champion_recommendations SET document_json = ${JSON.stringify(retained)} WHERE id = ${retained.recommendationId}`.pipe(
        Effect.orDie,
      );
      yield* service.findingAction({
        id: config.id,
        findingId: retained.findingId,
        action: "resolve_decision",
        decisionId: decision.id,
        reason: "Approved",
      });
      assert.equal(
        (yield* service.get({ id: config.id })).findings[0]!.decision!.answer,
        "Approved",
      );
    }),
  ),
);

it.effect(
  "resolves real managed policy per new owner attempt while uncertain replay and queued acceptance retain frozen selections",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "champion-policy-" });
      yield* fs.makeDirectory(`${root}/roles`);
      const manifest = policySnapshot().manifest;
      const write = (value: typeof manifest) =>
        fs.writeFileString(`${root}/roles/policy.json`, json(value));
      yield* write(manifest);
      for (const role of Object.values(manifest.roles))
        yield* fs.writeFileString(`${root}/${role.brief}`, "Fixture role brief");
      const managed = yield* Managed.ManagedAgentService.pipe(Effect.provide(Managed.layer));
      const f = yield* fixture();
      f.setProviders([codex]);
      yield* Effect.gen(function* () {
        const service = yield* Champions.ChampionService;
        const classes = yield* decodeClasses({}).pipe(Effect.orDie);
        const preview = yield* service.classChoices({ projectId });
        assert.isNull(preview.refusal);
        assert.equal(
          preview.roles.find((role) => role.role === "advisor")!.selection!.model,
          "gpt-astra-test",
        );
        const draft = yield* service.upsert({
          ...config,
          classes,
          setupModelSelection: { instanceId: codex.instanceId, model: "historical-model" },
        });
        assert.deepEqual(
          draft.champion.setupModelSelection,
          preview.roles.find((role) => role.role === "advisor")!.selection,
        );
        assert.deepEqual(
          draft.champion.routineModelSelection,
          preview.roles.find((role) => role.role === "chore-worker")!.selection,
        );
        f.failNextLaunch();
        yield* service.setup({ id: config.id });
        const first = (yield* service.runtimeState({ id: config.id })).attempts[0]!;
        assert.equal(first.resolvedSelection.model, "gpt-astra-test");
        assert.deepEqual(
          first.resolvedSelection,
          preview.roles.find((role) => role.role === "advisor")!.selection,
        );
        assert.equal(first.policyHash, preview.policyHash);
        yield* refused(
          service.classChoices({
            projectId: ProjectId.make("wrong-project"),
            championId: config.id,
          }),
        );
        const incompatible = yield* service.classChoices({ projectId, taskClass: "ui" });
        assert.isNotNull(incompatible.roles.find((role) => role.role === "chore-worker")!.refusal);
        f.ownerMode("approval-required");
        const narrowed = yield* service.classChoices({
          projectId,
          championId: config.id,
          phase: "setup",
        });
        assert.isNull(narrowed.roles.find((role) => role.role === "chore-worker")!.selection);
        f.ownerMode("full-access");
        f.providerAllowed(codex.instanceId, false);
        assert.isTrue(
          (yield* service.classChoices({ projectId })).roles.every(
            (role) => role.selection === null,
          ),
        );
        f.providerAllowed(codex.instanceId, true);
        assert.isNull(first.actualSelection);
        assert.equal(first.selectionClass!.role, "advisor");
        yield* write({
          ...manifest,
          lists: { ...manifest.lists, advisor: [{ model: "sol", effort: "medium" }] },
          roles: { ...manifest.roles, advisor: { ...manifest.roles.advisor!, callers: {} } },
        });
        yield* service.runDue;
        assert.equal(f.launchRequests[0]!.model, f.launchRequests[1]!.model);
        assert.equal(f.launchRequests[0]!.commandId, f.launchRequests[1]!.commandId);
        f.queueRun();
        yield* service.setup({ id: config.id });
        assert.equal((yield* service.runtimeState({ id: config.id })).attempts.length, 1);
        f.endRun();
        yield* service.setup({ id: config.id });
        const attempts = (yield* service.runtimeState({ id: config.id })).attempts;
        assert.equal(attempts.length, 2);
        const second = attempts.find((a) => a.id !== first.id)!;
        assert.equal(second.resolvedSelection.model, codexModel);
        assert.notEqual(second.policyHash, first.policyHash);
        assert.notEqual(second.commandId, first.commandId);
        assert.equal(second.threadId, first.threadId);
        assert.deepEqual(second.resolvedSelection.options, [{ id: "reasoning", value: "medium" }]);
        yield* write({
          ...manifest,
          lists: { ...manifest.lists, advisor: [{ model: "sol", effort: "medium" }] },
          roles: { ...manifest.roles, advisor: { ...manifest.roles.advisor!, callers: {} } },
          models: {
            ...manifest.models,
            sol: { ...manifest.models.sol!, model: "unavailable-model" },
          },
        });
        f.endRun();
        const unavailable = yield* service.classChoices({ projectId });
        assert.isNull(unavailable.roles.find((role) => role.role === "advisor")!.selection);
        assert.isNotNull(unavailable.roles.find((role) => role.role === "advisor")!.refusal);
        yield* refused(service.upsert({ ...config, id: "new-unavailable-draft", classes }));
        yield* refused(service.setup({ id: config.id }));
        assert.equal((yield* service.runtimeState({ id: config.id })).attempts.length, 2);
        assert.equal(
          (yield* service.get({ id: config.id })).champion.setupThreadId,
          first.threadId,
        );
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Managed.ManagedAgentService, managed),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Sqlite.layerMemory,
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Unexpected process launch"),
          }),
        ),
      ),
    ),
);

it.effect("starts a metrics lead thread on the lead role's current model and records it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "champion-lead-" });
    yield* fs.makeDirectory(`${root}/roles`);
    const manifest = policySnapshot().manifest;
    const write = (value: typeof manifest) =>
      fs.writeFileString(`${root}/roles/policy.json`, json(value));
    yield* write(manifest);
    for (const role of Object.values(manifest.roles))
      yield* fs.writeFileString(`${root}/${role.brief}`, "Fixture role brief");
    const managed = yield* Managed.ManagedAgentService.pipe(Effect.provide(Managed.layer));
    const f = yield* fixture();
    f.setProviders([codex]);
    yield* Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      yield* service.upsert({ ...config, classes: yield* decodeClasses({}).pipe(Effect.orDie) });
      const lead = (yield* service.classChoices({ projectId })).roles.find(
        (role) => role.role === "lead",
      )!.selection!;
      const { threadId } = yield* service.startMetricsLead({ id: config.id });
      assert.equal(f.counts().launches, 1);
      assert.equal(f.launchRequests[0]!.model, lead.model);
      const history = yield* service.history({ id: config.id });
      const started = history.activity.find((entry) => entry.kind === "metrics-lead");
      assert.equal(started?.threadId, threadId);
      // The brief is the server's words under a reserved id, so the lead can never quote it.
      assert.match(f.launchRequests[0]!.messageId, /^champion-metrics-lead:/);
      f.addMessage(threadId, f.launchRequests[0]!.text, {
        id: MessageId.make(f.launchRequests[0]!.messageId),
      });
      yield* service.propose({ id: config.id, metrics: [metric], reason: "Lead's fix" });
      yield* refusedWith(
        service.accept(
          { id: config.id, proposalId: (yield* service.get({ id: config.id })).proposal!.id! },
          { threadId, quote: "The user asked you to fix the metrics" },
        ),
        "not word for word",
      );

      // An ordinary agent thread (here, the lead just launched) does the same through its tool.
      const viaTool = yield* f.callTool(service, "t3_champions_start_metrics_lead", {
        id: config.id,
      });
      assert.isFalse(viaTool.at(-1)!.isFailure);
      assert.equal(f.counts().launches, 2);
      assert.equal(f.launchRequests[1]!.model, lead.model);
      assert.equal(
        (yield* service.history({ id: config.id })).activity.filter(
          (entry) => entry.kind === "metrics-lead",
        ).length,
        2,
      );

      yield* write({
        ...manifest,
        models: Object.fromEntries(
          Object.entries(manifest.models).map(([alias, model]) => [
            alias,
            { ...model, model: "unavailable-model" },
          ]),
        ),
      });
      yield* refused(service.startMetricsLead({ id: config.id }));
      assert.equal(f.counts().launches, 2);
    }).pipe(
      Effect.provide(f.layer),
      Effect.provideService(Managed.ManagedAgentService, managed),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Sqlite.layerMemory,
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: () => Effect.die("Unexpected process launch"),
        }),
      ),
    ),
  ),
);

it.effect(
  "retries an overloaded check on its class's next model and returns once the cool-down ends",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "champion-overload-" });
      yield* fs.makeDirectory(`${root}/roles`);
      const base = policySnapshot().manifest;
      const manifest = {
        ...base,
        lists: {
          ...base.lists,
          fast: [
            { model: "astra", effort: "medium" },
            { model: "luna", effort: "medium" },
          ],
        },
      };
      yield* fs.writeFileString(`${root}/roles/policy.json`, json(manifest));
      for (const role of Object.values(manifest.roles))
        yield* fs.writeFileString(`${root}/${role.brief}`, "Fixture role brief");
      const overloads = yield* ProviderOverloads.ProviderOverloads.pipe(
        Effect.provide(ProviderOverloads.layer),
      );
      const managed = yield* Managed.ManagedAgentService.pipe(
        Effect.provide(
          Managed.layer.pipe(
            Layer.provide(Layer.succeed(ProviderOverloads.ProviderOverloads, overloads)),
          ),
        ),
      );
      const f = yield* fixture();
      f.setProviders([codex]);
      yield* Effect.gen(function* () {
        const service = yield* Champions.ChampionService;
        yield* service.upsert({ ...config, classes: yield* decodeClasses({}).pipe(Effect.orDie) });
        yield* service.propose({ id: config.id, metrics: [metric], reason: "Measure errors" });
        yield* service.accept({ id: config.id });
        const resolved = Effect.gen(function* () {
          const attempts = (yield* service.runtimeState({ id: config.id })).attempts;
          return attempts.filter((a) => a.kind === "check").map((a) => a.resolvedSelection.model);
        });
        yield* service.runCheck({ id: config.id });
        assert.deepEqual(yield* resolved, ["gpt-astra-test"]);

        yield* overloads.mark({ instanceId: codex.instanceId, model: "gpt-astra-test" });
        f.overloadRun();
        yield* service.runDue;
        assert.deepEqual((yield* resolved).toSorted(), ["gpt-astra-test", "gpt-luna-test"]);

        yield* TestClock.adjust(ProviderOverloads.PROVIDER_OVERLOAD_COOLDOWN_MS + 1_000);
        f.overloadRun();
        yield* service.runDue;
        const models = yield* resolved;
        assert.equal(models.length, 3);
        assert.equal(models.filter((model) => model === "gpt-astra-test").length, 2);

        // A retry that cannot start says so instead of failing quietly.
        f.providerAllowed(codex.instanceId, false);
        f.overloadRun();
        yield* service.runDue;
        assert.isTrue(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("automatic retry after a provider overload could not start"),
          ),
        );
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Managed.ManagedAgentService, managed),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Sqlite.layerMemory,
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Unexpected process launch"),
          }),
        ),
      ),
    ),
);

it.effect(
  "requires current learning receipts and keeps paged multi-byte evidence responses within the byte ceiling",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        const detail = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Measured",
        });
        const empty = yield* service.learningQuery({
          id: config.id,
          topic: "errors",
          observations: [],
        });
        const first = yield* service.recordLearning(f.caller(), {
          ...learning(),
          conclusion: "界".repeat(7000),
        });
        const input = {
          id: config.id,
          findingId: detail.findings[0]!.id,
          investigationId: "receipt-investigation",
          question: "Compare",
          topic: "errors",
          retrievalReceiptId: empty.receiptId,
          alternatives: [
            { id: "a", role: "advisor" as const, hypothesis: "Logs", evidenceNeeds: "Counters" },
          ],
        };
        yield* refused(service.startInvestigation(input));
        yield* refused(service.recordLearning(undefined, learning("unauthenticated")));
        yield* service.recordLearning(f.caller(), {
          ...learning("second-large"),
          conclusion: "界".repeat(7000),
        });
        yield* service.recordLearning(f.caller(), {
          ...learning("third-large"),
          conclusion: "界".repeat(7000),
        });
        const query = { id: config.id, topic: "errors", observations: [] };
        const page = yield* service.learningQuery(query);
        assert.isAtMost(new TextEncoder().encode(json(page)).length, 64_000);
        assert.equal(page.revisions.length, 2);
        assert.isNotNull(page.nextCursor);
        const next = yield* service.learningQuery({ ...query, cursor: page.nextCursor! });
        assert.equal(next.revisions.length, 1);
        assert.isNull(next.nextCursor);
        assert.equal(new Set([...page.revisions, ...next.revisions].map((r) => r.id)).size, 3);
        const considered = yield* service.startInvestigation({
          ...input,
          retrievalReceiptId: page.receiptId,
        });
        assert.deepEqual(
          considered.consideredLearningIds,
          page.revisions.map((r) => r.id),
        );
        assert.isTrue([...page.revisions, ...next.revisions].some((r) => r.id === first.id));
      }),
    ),
);

it.effect(
  "requires observed review model evidence and rejects identical code-review and UI-verification models",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { detail, admission } = yield* investigationFixture(f, service);
        const finding = detail.findings[0]!;
        const proof = admission();
        const binding = {
          ...proof.binding,
          role: "ui-verifier" as const,
          taskClass: "ui" as const,
          workId: finding.workId,
          attemptId: finding.attemptId,
        };
        f.installChild(finding, "Reviewed", "reviewer");
        yield* refused(service.admitInvestigation({ ...proof, binding }));
        f.installChild(
          finding,
          "Reviewed",
          "reviewer",
          "completed",
          undefined,
          config.setupModelSelection,
        );
        yield* refused(
          service.admitInvestigation({ ...proof, binding, selection: config.setupModelSelection }),
        );
        yield* service.admitInvestigation({
          ...proof,
          binding,
          selection: config.routineModelSelection,
        });
        f.installChild(
          finding,
          "Verified",
          "ui-verifier",
          "completed",
          undefined,
          config.routineModelSelection,
        );
        yield* refused(
          service.admitInvestigation({
            ...proof,
            binding: { ...binding, role: "reviewer" },
            selection: config.routineModelSelection,
          }),
        );
      }),
    ),
);

it.effect(
  "records human learning activity atomically and once, expands its exact historical revision and refuses filtered admission receipts",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        const detail = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Measured",
        });
        const input = learning();
        const first = yield* service.recordLearning(f.caller(), input);
        const replay = yield* service.recordLearning(f.caller(), input);
        assert.equal(replay.id, first.id);
        let history = yield* service.history({ id: config.id });
        let rows = history.activity.filter((event) => event.kind === "learning-recorded");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.text, input.plainSummary);
        assert.deepEqual(rows[0]!.learningRef, {
          learningId: first.learningId,
          revisionId: first.id,
          topic: first.topic,
        });
        const second = yield* service.recordLearning(f.caller(), {
          ...input,
          expectedCurrentId: first.id,
          conclusion: "Use counters after further evidence",
        });
        const lateReplay = yield* service.recordLearning(f.caller(), {
          ...input,
          evidence: input.evidence.map(({ source, evidence, observedAt }) => ({
            observedAt,
            evidence,
            source,
          })),
        });
        assert.equal(lateReplay.id, first.id);
        assert.isFalse(lateReplay.isCurrent);
        const exact = yield* service.learningQuery({
          id: config.id,
          topic: input.topic,
          revisionId: first.id,
          observations: [],
        });
        assert.equal(exact.revisions.length, 1);
        assert.equal(exact.revisions[0]!.id, first.id);
        assert.isFalse(exact.revisions[0]!.isCurrent);
        assert.equal(exact.revisions[0]!.applicabilityState, "uncertain");
        assert.isFalse(exact.admissibleForInvestigation);
        assert.deepEqual(
          (yield* service.learningQuery({
            id: config.id,
            topic: "another-topic",
            revisionId: first.id,
            observations: [],
          })).revisions,
          [],
        );
        yield* service.upsert({ ...config, id: "another-champion" });
        assert.deepEqual(
          (yield* service.learningQuery({
            id: "another-champion",
            topic: input.topic,
            revisionId: first.id,
            observations: [],
          })).revisions,
          [],
        );
        assert.isAtMost(new TextEncoder().encode(json(exact)).length, 64_000);
        const investigation = {
          id: config.id,
          findingId: detail.findings[0]!.id,
          investigationId: "filtered-receipt",
          question: "Compare collectors",
          topic: input.topic,
          retrievalReceiptId: exact.receiptId,
          alternatives: [
            { id: "a", role: "advisor" as const, hypothesis: "Logs", evidenceNeeds: "Counters" },
          ],
        };
        yield* refused(service.startInvestigation(investigation));
        const dueOnly = yield* service.learningQuery({
          id: config.id,
          topic: input.topic,
          due: true,
          observations: [],
        });
        assert.deepEqual(dueOnly.revisions, []);
        assert.isFalse(dueOnly.admissibleForInvestigation);
        yield* refused(
          service.startInvestigation({ ...investigation, retrievalReceiptId: dueOnly.receiptId }),
        );
        const current = yield* service.learningQuery({
          id: config.id,
          topic: input.topic,
          observations: [],
        });
        assert.isTrue(current.admissibleForInvestigation);
        assert.deepEqual(
          (yield* service.startInvestigation({
            ...investigation,
            retrievalReceiptId: current.receiptId,
          })).consideredLearningIds,
          [second.id],
        );
        history = yield* service.history({ id: config.id });
        rows = history.activity.filter((event) => event.kind === "learning-recorded");
        assert.equal(rows.length, 2);
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .unsafe(
            "CREATE TRIGGER reject_learning_activity BEFORE INSERT ON champion_activity WHEN json_extract(NEW.document_json, '$.kind') = 'learning-recorded' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END",
          )
          .pipe(Effect.orDie);
        yield* refused(service.recordLearning(f.caller(), learning("atomic-failure")));
        assert.equal(
          (yield* sql`SELECT id FROM champion_learning_revisions WHERE learning_id = 'atomic-failure'`.pipe(
            Effect.orDie,
          )).length,
          0,
        );
      }),
    ),
);

/** A finding implemented and reviewed on "strong", with managed role discovery offering `eligible`. */
const reviewedFinding = (
  body: (input: {
    readonly f: Effect.Success<ReturnType<typeof fixture>>;
    readonly service: Champions.ChampionService["Service"];
    readonly verification: (
      role: "browser" | "ui-verifier",
      clientRequestId: string,
    ) => Parameters<Champions.ChampionService["Service"]["guardDelegation"]>[0];
    readonly finding: ChampionFinding;
    readonly eligible: Set<string>;
    readonly asked: Array<string>;
  }) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const eligible = new Set(["cheap", "strong"]);
    const asked: Array<string> = [];
    const managed = {
      roles: (input: {
        readonly request: { readonly role?: string };
        readonly selection?: { readonly model?: string };
      }) =>
        Effect.sync(() => {
          const model = input.selection?.model ?? "";
          asked.push(model);
          const offered = eligible.has(model);
          return {
            policyHash: "a".repeat(64),
            policyRevision: "test",
            roles: [
              {
                role: input.request.role,
                selection: offered ? { instanceId, model } : null,
                refusal: offered ? null : "no-eligible-model",
              },
            ],
          };
        }),
    } as unknown as Managed.ManagedAgentService["Service"];
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      const finding = yield* activeFinding(f, service);
      const ownerThreadId = f.caller().threadId;
      const implement = { ownerThreadId, request: repair(finding), clientRequestId: "implement" };
      yield* service.guardDelegation(implement);
      f.installChild(finding, "author-commit");
      yield* service.delegationOutcome({ ...implement, state: "finished" });
      const review = {
        ownerThreadId,
        clientRequestId: "review",
        request: {
          ...repair(finding),
          role: "reviewer" as const,
          readOnly: true,
          sourceRevision: "author-commit",
          review: {
            scope: "change" as const,
            baseRevision: "base",
            includedChanges: ["author-commit"],
            coverage: "complete" as const,
          },
        },
      };
      yield* service.guardDelegation(review);
      f.installChild(finding, "Reviewed", "reviewer", "completed", undefined, {
        instanceId,
        model: "strong",
      });
      yield* service.delegationOutcome({ ...review, state: "finished" });
      yield* body({
        f,
        service,
        finding,
        eligible,
        asked,
        verification: (role, clientRequestId) => ({
          ownerThreadId,
          clientRequestId,
          request: {
            role,
            taskClass: "ui",
            workId: finding.workId,
            attemptId: finding.attemptId,
            workspacePath: "/project/root",
            readOnly: true,
          },
        }),
      });
    }).pipe(Effect.provide(f.layer), Effect.provideService(Managed.ManagedAgentService, managed));
  }).pipe(Effect.provide(Sqlite.layerMemory));

it.effect(
  "verifies a UI finding on the browser role, with device tools and a model other than the reviewer's",
  () =>
    reviewedFinding(({ service, verification, eligible, asked }) =>
      Effect.gen(function* () {
        // Only the reviewing model is eligible: refused as unavailable, as before.
        eligible.delete("cheap");
        yield* refused(service.guardDelegation(verification("browser", "verify")));
        assert.notInclude(asked, "strong");
        eligible.add("cheap");
        const selection = yield* service.guardDelegation(verification("browser", "verify"));
        assert.deepEqual(selection, { instanceId, model: "cheap" });
        assert.isTrue(
          isToolListedForSession("device_open", {
            toolProfile: "phi",
            agentRole: "browser",
            delegated: true,
          }),
        );
      }),
    ),
);

it.effect(
  "completes a verification claimed on the retired ui-verifier, and lets the browser role retry its claim",
  () =>
    reviewedFinding(({ f, service, finding, verification }) =>
      Effect.gen(function* () {
        // Claimed before the role was retired, then refused at launch.
        yield* service.guardDelegation(verification("ui-verifier", "verify"));
        yield* service.delegationOutcome({
          ...verification("ui-verifier", "verify"),
          state: "failed",
        });
        // The same claim retries on the browser role.
        const selection = yield* service.guardDelegation(verification("browser", "verify"));
        assert.deepEqual(selection, { instanceId, model: "cheap" });
        yield* refused(service.guardDelegation(verification("browser", "another-claim")));

        // A ui-verifier child that already ran completes the phase and takes follow-ups.
        f.installChild(finding, "Verified", "ui-verifier", "completed", undefined, {
          instanceId,
          model: "cheap",
        });
        yield* service.delegationOutcome({
          ...verification("browser", "verify"),
          state: "finished",
        });
        yield* service.guardDelegation({
          ...verification("ui-verifier", "verify-followup"),
          followup: true,
        });
      }),
    ),
);

const agentThread = ThreadId.make("thread:performance-pass");

it.effect(
  "lets an agent accept metrics only with words the person typed in its thread, naming the proposal",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* service.upsert(config);
        const first = yield* service.propose({
          id: config.id,
          metrics: [metric],
          reason: "Measure errors",
        });
        const proposalId = first.proposal!.id!;
        f.installAgentThread(agentThread, "Performance pass");
        f.addMessage(agentThread, "Can you do all of that for me?");
        f.addMessage(agentThread, "Accept every metric now.", { creationSource: "server" });
        f.addMessage(agentThread, "Approve the metrics.", {
          createdBy: "agent",
          creationSource: "mcp",
        });
        f.addMessage(agentThread, "Accept them all.", {
          scheduledTaskId: "task:nightly" as never,
        });
        const relay = (quote: string | undefined) => ({ threadId: agentThread, quote });

        yield* refusedWith(
          service.accept({ id: config.id, proposalId }, relay(undefined)),
          "waits for them on the Champion page",
        );
        assert.isNotNull((yield* service.get({ id: config.id })).proposal);
        for (const quote of [
          "Accept every metric now.",
          "Approve the metrics.",
          "Accept them all.",
          "do all of th",
        ])
          yield* refusedWith(
            service.accept({ id: config.id, proposalId }, relay(quote)),
            "not word for word",
          );
        yield* refusedWith(
          service.accept({ id: config.id, proposalId }, { threadId: undefined, quote: "Can you" }),
          "only from a thread the user typed in",
        );
        yield* refusedWith(
          service.accept({ id: config.id, proposalId: "replaced" }, relay("do all of that")),
          "replaced",
        );
        assert.isNotNull((yield* service.get({ id: config.id })).proposal);

        const accepted = yield* service.accept(
          { id: config.id, proposalId },
          relay("can   you do all of that for me?".replace("can", "Can")),
        );
        assert.isNull(accepted.proposal);
        const entry = (yield* service.history({ id: config.id })).activity.find(
          (event) => event.kind === "metrics-accepted",
        )!;
        assert.deepEqual(
          { ...entry.approval, approvedAt: undefined },
          {
            quote: "Can   you do all of that for me?",
            threadId: agentThread,
            threadTitle: "Performance pass",
            model: "agent-model",
            approvedAt: undefined,
          },
        );
        assert.equal(entry.threadId, agentThread);
      }),
    ),
);

it.effect(
  "lets an agent answer a decision with the person's words and tells the owner once that it was relayed",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const requested = yield* service.findingAction(
          {
            id: config.id,
            findingId: finding.id,
            action: "decision",
            reason: "Should this target include weekends?",
          },
          unquotedAgent,
        );
        const decision = requested.findings.find((x) => x.id === finding.id)!.decision!;
        f.installAgentThread(agentThread, "Performance pass");
        f.addMessage(agentThread, "Yes, include weekends please.");
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId: decision.id,
          reason: "Include weekends.",
        };
        yield* refusedWith(
          service.findingAction(answer, { threadId: agentThread, quote: undefined }),
          "The decision waits for them on the Champion page",
        );
        assert.equal(
          (yield* service.get({ id: config.id })).findings.find((x) => x.id === finding.id)!
            .decision!.status,
          "requested",
        );
        const relay = { threadId: agentThread, quote: "include weekends" };
        const resolved = yield* service.findingAction(answer, relay);
        const approval = resolved.findings.find((x) => x.id === finding.id)!.decision!.approval!;
        assert.equal(approval.quote, "include weekends");
        assert.equal(approval.threadId, agentThread);
        assert.equal(approval.model, "agent-model");
        yield* service.findingAction(answer, relay);
        const sends = f.sent.filter((x) => x.commandId === `champion-decision:${decision.id}`);
        assert.equal(sends.length, 1);
        assert.include(sends[0]!.text, `relayed by an agent in thread ${agentThread}`);
        assert.include(sends[0]!.text, '"include weekends"');
      }),
    ),
);

it.effect("lets a routine check file a metric proposal that waits for the person", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* activeFinding(f, service);
      yield* service.runCheck({ id: config.id });
      const proposed = yield* service.proposeFromSetup(f.caller(), {
        metrics: [{ ...metric, name: "Errors people see" }],
        reason: "Clearer name",
      });
      const firstId = proposed.proposal!.id!;
      assert.include(proposed.champion.attention, "Metric proposal awaits acceptance.");
      yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "Measured" });
      assert.isNotNull((yield* service.get({ id: config.id })).proposal);
      const replaced = yield* service.propose({
        id: config.id,
        metrics: [{ ...metric, name: "Visible errors" }],
        reason: "Edited by you.",
      });
      yield* refusedWith(service.accept({ id: config.id, proposalId: firstId }), "replaced");
      const accepted = yield* service.accept({
        id: config.id,
        proposalId: replaced.proposal!.id!,
      });
      assert.equal(accepted.metrics[0]!.name, "Visible errors");
    }),
  ),
);

it.effect("marks the messages the server writes so they can never be quoted as the person's", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const finding = yield* activeFinding(f, service);
      const requested = yield* service.findingAction(
        { id: config.id, findingId: finding.id, action: "decision", reason: "Ship it?" },
        unquotedAgent,
      );
      const decisionId = requested.findings[0]!.decision!.id;
      yield* service.findingAction({
        id: config.id,
        findingId: finding.id,
        action: "resolve_decision",
        decisionId,
        reason: "Yes, ship it.",
      });
      const delivery = f.sent.find((x) => x.commandId === `champion-decision:${decisionId}`)!;
      yield* service.propose({ id: config.id, metrics: [metric], reason: "Retune" });
      const proposalId = (yield* service.get({ id: config.id })).proposal!.id!;
      f.installAgentThread(agentThread, "Fix metrics: Quality");
      // The decision delivery and a check prompt, as the server writes them into a thread.
      // The delivery keeps client provenance, so it still resumes a held queue.
      f.addMessage(agentThread, delivery.text, {
        id: MessageId.make(delivery.messageId),
        creationSource: "web",
      });
      f.addMessage(agentThread, "Accept the proposal.", {
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* refusedWith(
        service.accept(
          { id: config.id, proposalId },
          { threadId: agentThread, quote: "Yes, ship it." },
        ),
        "not word for word",
      );
      yield* refusedWith(
        service.accept(
          { id: config.id, proposalId },
          { threadId: agentThread, quote: "Accept the proposal." },
        ),
        "not word for word",
      );
    }),
  ),
);

it.effect("names the cause of each refused champion delegation", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const first = yield* activeFinding(f, service);
      yield* service.runCheck({ id: config.id });
      const report = yield* service.report(f.caller(), {
        samples: [sample],
        findings: [{ title: "Database backlog", evidence: "Observed" }],
        summary: "More work",
      });
      const second = report.findings.find((finding) => finding.id !== first.id)!;
      const ownerThreadId = f.caller().threadId;
      const initial = { ownerThreadId, request: repair(first), clientRequestId: "first" };
      yield* service.guardDelegation(initial);
      yield* refusedWith(
        service.guardDelegation({ ...initial, clientRequestId: "again" }),
        "already requested as clientRequestId first",
      );
      yield* refusedWith(
        service.guardDelegation({
          ...initial,
          request: { ...repair(first), role: "chore-worker" as never },
        }),
        "already requested for the implementation-worker role",
      );
      yield* refusedWith(
        service.guardDelegation({
          ownerThreadId,
          request: repair(second),
          clientRequestId: "second",
        }),
        "allows 1 repair at once",
      );
      yield* refusedWith(
        service.guardDelegation({
          ownerThreadId,
          request: {
            ...repair(first),
            role: "reviewer" as const,
            readOnly: true,
            workspaceAssignment: undefined,
          },
          clientRequestId: "review",
        }),
        "Review starts only after",
      );
      yield* refusedWith(
        service.guardDelegation({
          ownerThreadId,
          request: { ...repair(first), role: "lead" as const, workspaceAssignment: undefined },
          clientRequestId: "lead",
          forgeItem: 1,
        }),
        "A lead runs only for a finding with a Forge Spec",
      );
      f.installChild(first, "handoff", "implementation-worker", "running");
      yield* refusedWith(
        service.guardDelegation({
          ...initial,
          followup: true,
          childThreadId: ThreadId.make("someone-else"),
        }),
        "not this finding attempt's current implementation task",
      );
      yield* service.upsert({
        ...config,
        charter: { ...config.charter, maxConcurrentRepairs: 3, maxRepairsPerDay: 1 },
      });
      yield* service.delegationOutcome({ ...initial, state: "finished" });
      yield* refusedWith(
        service.guardDelegation({
          ownerThreadId,
          request: repair(second),
          clientRequestId: "second",
        }),
        "allows 1 repair a day",
      );
    }),
  ),
);

const screenAndToolOutcome = (viaTool: boolean) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    return yield* Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      yield* activeFinding(f, service);
      const steps = [
        ["t3_champions_lifecycle", { id: config.id, lifecycle: "paused" }],
        ["t3_champions_lifecycle", { id: config.id, lifecycle: "active" }],
        ["t3_champions_run_check", { id: config.id }],
      ] as const;
      for (const [tool, input] of steps) {
        if (viaTool) assert.isFalse((yield* f.callTool(service, tool, input)).at(-1)!.isFailure);
        else if (tool === "t3_champions_run_check") yield* service.runCheck(input);
        else yield* service.setLifecycle(input as { id: string; lifecycle: "paused" | "active" });
      }
      const detail = yield* service.get({ id: config.id });
      const activity = (yield* service.history({ id: config.id })).activity;
      return {
        lifecycle: detail.champion.lifecycle,
        attention: detail.champion.attention,
        outstanding: detail.champion.outstandingCheckId !== null,
        // Entries made in the same test instant order by random id, so compare them as a set.
        activity: activity.map((entry) => `${entry.kind}: ${entry.text}`).toSorted(),
      };
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(Sqlite.layerMemory));

it.effect(
  "gives pause, resume and Check now the same outcome from an agent tool as from the screen",
  () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* screenAndToolOutcome(true), yield* screenAndToolOutcome(false));
    }),
);

it.effect(
  "refuses an approval typed before its request was filed, and a proposal without an id",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        f.installAgentThread(agentThread, "Performance pass");
        f.addMessage(agentThread, "Yes, go ahead.");
        yield* TestClock.adjust("1 minute");
        const requested = yield* service.findingAction(
          { id: config.id, findingId: finding.id, action: "decision", reason: "Ship it?" },
          unquotedAgent,
        );
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId: requested.findings[0]!.decision!.id,
          reason: "Ship it.",
        };
        const relay = { threadId: agentThread, quote: "Yes, go ahead." };
        yield* refusedWith(service.findingAction(answer, relay), "before this request was filed");
        f.addMessage(agentThread, "Yes, go ahead.", { createdAt: DateTime.makeUnsafe(120_000) });
        yield* service.findingAction(answer, relay);

        yield* service.propose({ id: config.id, metrics: [metric], reason: "Older proposal" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE champions SET document_json = json_remove(document_json, '$.proposal.id') WHERE id = ${config.id}`.pipe(
          Effect.orDie,
        );
        yield* refusedWith(
          service.accept({ id: config.id, proposalId: "anything" }, relay),
          "filed before proposals had ids",
        );
        assert.isNull((yield* service.accept({ id: config.id })).proposal);
      }),
    ),
);

describe("a journey check", () => {
  const journeysConfig = (
    directory: string,
    overrides: Partial<NonNullable<ChampionConfig["journeys"]>> = {},
  ): ChampionConfig => ({
    ...config,
    charter: { ...config.charter, maxConcurrentRepairs: 0, maxRepairsPerDay: 0 },
    journeys: {
      provision: ["sh", NodePath.join(directory, "provision.sh"), "{shards}"],
      teardown: ["sh", "-c", `echo '{"id":"{id}","status":"down"}'`],
      capture: [
        "sh",
        "-c",
        `echo '{"packets":10,"peers":2,"subnet":"172.20.0.0/16","outside":[]}'`,
      ],
      shards: 1,
      journeysPerShard: 8,
      decisionCap: 4,
      loadLimit: 1_000_000,
      ...overrides,
    },
  });
  let shardPort = 0;
  const manifest = (id: string, commit: string, overrides: Record<string, unknown> = {}) => ({
    schema: 1,
    id,
    app: "weave",
    commit,
    build: "0123456789abcdef",
    patched: false,
    synthetic: true,
    network: `ys-attack-${id}`,
    capture: "/tmp/capture",
    startedAt: "2026-11-08T00:00:00.000Z",
    expiresAt: "2026-11-08T04:00:00.000Z",
    startSeconds: 1,
    shards: [
      {
        id: "s1",
        origin: "http://localhost:1",
        signInPath: "/dev/agent-login?as=admin&next=/",
        database: "scratch_0123abcd",
        container: "shard",
      },
    ],
    ...overrides,
  });
  /** `docker` as a target's shard answers it, and a provision command that prints each manifest in turn. */
  const withTarget = (
    manifests: ReadonlyArray<unknown>,
    body: (
      directory: string,
    ) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
    container: Record<string, unknown> = {},
  ) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const shard = NodeHttp.createServer((_request, response) => response.end("ok"));
        await new Promise<void>((resolve) => shard.listen(0, "127.0.0.1", resolve));
        shardPort = (shard.address() as NodeNet.AddressInfo).port;
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "journey-target-"));
        const inspect = JSON.stringify([
          {
            Config: {
              Env: ["NODE_ENV=production", "DATABASE_URL=postgres://r:p@db:5432/scratch_0123abcd"],
            },
            State: { Running: true },
            NetworkSettings: { Networks: { "ys-attack": {} } },
            ...container,
          },
        ]);
        NodeFS.writeFileSync(
          NodePath.join(directory, "docker"),
          `#!/bin/sh\nif [ "$1" = network ]; then echo true; else cat <<'JSON'\n${inspect}\nJSON\nfi\n`,
          { mode: 0o755 },
        );
        manifests.forEach((entry, index) =>
          NodeFS.writeFileSync(
            NodePath.join(directory, `m${index}`),
            JSON.stringify(entry).replaceAll("localhost:1", `localhost:${shardPort}`),
          ),
        );
        NodeFS.writeFileSync(
          NodePath.join(directory, "provision.sh"),
          `n=$(cat "${directory}/count" 2>/dev/null || echo 0); echo $((n+1)) > "${directory}/count"; cat "${directory}/m$n"\n`,
        );
        const path = process.env.PATH;
        process.env.PATH = `${directory}:${path}`;
        return { directory, path, shard };
      }),
      ({ directory }) => body(directory),
      ({ directory, path, shard }) =>
        Effect.sync(() => {
          shard.closeAllConnections();
          shard.close();
          process.env.PATH = path;
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
    );
  const quietSample = { ...sample, value: 1 };
  const activate = Effect.fn("test.activateJourneys")(function* (
    service: Champions.ChampionService["Service"],
    draft: ChampionConfig,
  ) {
    yield* service.upsert(draft);
    yield* service.propose({ id: config.id, metrics: [metric], reason: "Measure errors" });
    yield* service.accept({ id: config.id });
  });
  const walk = Effect.fn("test.walkJourney")(function* (
    policy: JourneyBrowserPolicy.JourneyBrowserPolicy["Service"],
    threadId: ThreadId,
    tabId: string,
    url: string,
  ) {
    const grant = (yield* policy.forThread(threadId))!;
    const admitted = yield* policy.admitTask({ grant, tabId });
    assert.equal(admitted._tag, "admitted");
    yield* policy.recordTask({
      grant,
      tabId,
      goal: "Try to break it",
      startedAt: "2026-11-08T00:00:00.000Z",
      endedAt: "2026-11-08T00:00:01.000Z",
      result: {
        status: "passed",
        decisions: 2,
        usage: { usd: 0.01, unreportedCalls: 1 },
        evidence: { url: `http://localhost:${shardPort}${url}` },
      } as unknown as PreviewTaskResult,
      steps: [
        {
          id: "P1",
          kind: "page",
          operation: "click",
          target: { role: "button", name: "Save" },
          description: 'button "Save"',
          option: null,
          value: null,
          url: `http://localhost:${shardPort}${url}`,
          state: "completed",
          at: "2026-11-08T00:00:00.500Z" as never,
          ms: 40,
        },
      ],
    });
  });
  const verdict = (word: string, reason: string) =>
    `Done.\nVERDICT: ${word}\nREASON: ${reason}\nSCREENSHOT: /tmp/shot.png`;
  const withPolicy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(ChampionJourneys.layerBrowserPolicy));

  it.effect("keeps a candidate from everyone, and only a replay makes it a finding", () =>
    withFixture((f, service) =>
      withTarget(
        [
          manifest("aaaaaaaa", "commit-1"),
          manifest("bbbbbbbb", "commit-1"),
          manifest("cccccccc", "commit-1"),
        ],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            const plan = yield* service.journeysStart(f.caller());
            assert.equal(plan.journeyLimit, 8);
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            const owner = f.caller().threadId;
            assert.deepEqual((yield* policy.forThread(owner))?.allow, [
              `localhost:${shardPort}`,
              `127.0.0.1:${shardPort}`,
            ]);
            yield* walk(policy, owner, "tab-one", "/tasks");
            yield* walk(policy, owner, "tab-two", "/books");
            yield* walk(policy, owner, "tab-three", "/docs");

            const shared = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-one",
              title: "Save fails",
              expected: "It saves",
              observed: "An error page",
            });
            const real = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-two",
              title: "Save fails",
              expected: "It saves",
              observed: "An error page",
            });
            const quiet = yield* service.get({ id: config.id });
            assert.equal(quiet.findings.length, 0);
            assert.equal(quiet.champion.openFindingCount, 0);
            assert.isFalse(
              (yield* service.history({ id: config.id })).activity.some((a) =>
                a.text.includes("Save fails"),
              ),
            );

            const first = yield* service.candidateReplay(f.caller(), {
              candidateId: shared.candidateId,
            });
            assert.include(first.brief, 'click the button named "Save"');
            assert.include(first.brief, "/tasks");
            f.installReplay(
              first.workId,
              first.attemptId,
              verdict("not-reproduced", "It saved on a fresh database."),
              "strong",
            );
            const rejected = yield* service.candidateSettle(f.caller(), {
              candidateId: shared.candidateId,
            });
            assert.equal(rejected.status, "rejected");
            assert.equal((yield* service.get({ id: config.id })).findings.length, 0);

            const second = yield* service.candidateReplay(f.caller(), {
              candidateId: real.candidateId,
            });
            f.installReplay(
              second.workId,
              second.attemptId,
              verdict("reproduced", "The error page came back."),
              "strong",
            );
            const confirmed = yield* service.candidateSettle(f.caller(), {
              candidateId: real.candidateId,
            });
            assert.equal(confirmed.status, "confirmed");
            const found = (yield* service.get({ id: config.id })).findings;
            assert.equal(found.length, 1);
            assert.include(found[0]!.evidence, "Steps to reproduce");
            assert.include(found[0]!.evidence, "/tmp/shot.png");

            yield* service.report(f.caller(), {
              samples: [quietSample],
              findings: [],
              summary: "Three journeys, one bug.",
              journeys: { started: 3, passed: 1, failed: 2, stopped: 0 },
            });
            const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
            assert.equal(record.status, "complete");
            assert.deepEqual(record.journeys, {
              started: 3,
              passed: 1,
              failed: 2,
              stopped: 0,
              running: 0,
              stoppedByLimit: 0,
            });
            assert.equal(record.decisions, 6);
            assert.equal(record.unpricedCalls, 3);
            assert.equal(record.spendLimitDecisions, 32);
            assert.deepEqual(record.candidates.rejectionReasons, ["It saved on a fresh database."]);
            assert.equal(record.candidates.confirmed, 1);
            // The owner's browser reaches nothing once its check has ended.
            assert.deepEqual((yield* policy.forThread(owner))?.allow, []);
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect(
    "lets a paused journey Champion with no accepted metrics measure, and nothing more",
    () =>
      withFixture((f, service) =>
        withTarget([manifest("aaaaaaaa", "commit-1")], (directory) =>
          Effect.gen(function* () {
            yield* service.upsert(journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            const plan = yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            yield* walk(policy, f.caller().threadId, "tab-one", "/tasks");
            yield* service.report(f.caller(), {
              samples: [],
              findings: [],
              summary: "One journey.",
              journeys: { started: 1, passed: 1, failed: 0, stopped: 0 },
            });
            const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
            assert.equal(record.status, "complete");
            const detail = yield* service.get({ id: config.id });
            assert.equal(detail.champion.lifecycle, "paused");
            yield* refusedWith(service.setLifecycle({ id: config.id, lifecycle: "active" }), "");
          }).pipe(withPolicy),
        ),
      ),
  );

  it.effect("keeps a check open to its owner when a replay wakes it in a new run", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1"), manifest("bbbbbbbb", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            const plan = yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            yield* walk(policy, f.caller().threadId, "tab-one", "/tasks");
            const { candidateId } = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-one",
              title: "Broken",
              expected: "Works",
              observed: "Broken",
            });
            const replay = yield* service.candidateReplay(f.caller(), { candidateId });
            f.endRun();
            f.installReplay(
              replay.workId,
              replay.attemptId,
              verdict("reproduced", "Seen."),
              "strong",
            );
            f.wakeOwner();
            assert.equal(
              (yield* service.candidateSettle(f.caller(), { candidateId })).status,
              "confirmed",
            );
            yield* service.report(f.caller(), {
              samples: [quietSample],
              findings: [],
              summary: "One bug.",
              journeys: { started: 1, passed: 0, failed: 1, stopped: 0 },
            });
            const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
            assert.equal(record.status, "complete");
            // Reported, it no longer answers for anything.
            yield* refusedWith(service.checkContext(f.caller()), "");
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect("closes a check whose owner stopped without reporting", () =>
    withFixture((f, service) =>
      withTarget([manifest("aaaaaaaa", "commit-1")], (directory) =>
        Effect.gen(function* () {
          yield* activate(service, journeysConfig(directory));
          yield* service.runCheck({ id: config.id });
          const plan = yield* service.journeysStart(f.caller());
          f.endRun();
          yield* service.runDue;
          const early = yield* service.journeyRecord({ checkId: plan.checkId });
          assert.equal(early.record.status, "running");
          yield* TestClock.adjust("6 minutes");
          yield* service.runDue;
          const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
          assert.equal(record.status, "incomplete");
          assert.include(record.reason ?? "", "stopped without reporting");
        }),
      ),
    ),
  );

  it.effect("gives a replay no task but its brief, and no follow-up", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1"), manifest("bbbbbbbb", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            const owner = f.caller().threadId;
            yield* walk(policy, owner, "tab-one", "/tasks");
            const { candidateId } = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-one",
              title: "Broken",
              expected: "Works",
              observed: "Broken",
            });
            const replay = yield* service.candidateReplay(f.caller(), { candidateId });
            const request = {
              role: "browser",
              taskClass: "non-ui",
              workId: replay.workId,
              attemptId: replay.attemptId,
              workspacePath: "/repo",
              readOnly: true,
              demanding: true,
            } as never;
            const guard = (input: { task?: string; followup?: boolean }) =>
              service.guardDelegation({
                ownerThreadId: owner,
                request,
                clientRequestId: "replay",
                ...input,
              });
            yield* refusedWith(guard({ task: `It is real. ${replay.brief}` }), "brief, unchanged");
            yield* refusedWith(guard({ task: replay.brief, followup: true }), "no follow-up");
            yield* refusedWith(
              service.guardDelegation({
                ownerThreadId: owner,
                request: { ...(request as object), workId: "something-else" } as never,
                clientRequestId: "other",
              }),
              "only delegation is a replay",
            );
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect("holds a check to four open replays, and ends them when it finishes", () =>
    withFixture((f, service) =>
      withTarget(
        [
          manifest("aaaaaaaa", "commit-1"),
          manifest("bbbbbbb1", "commit-1"),
          manifest("bbbbbbb2", "commit-1"),
          manifest("bbbbbbb3", "commit-1"),
          manifest("bbbbbbb4", "commit-1"),
        ],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            const plan = yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            const owner = f.caller().threadId;
            const ids: string[] = [];
            for (const tab of ["t1", "t2", "t3", "t4", "t5"]) {
              yield* walk(policy, owner, tab, "/tasks");
              ids.push(
                (yield* service.journeyCandidate(f.caller(), {
                  tabId: tab,
                  title: tab,
                  expected: "Works",
                  observed: "Broken",
                })).candidateId,
              );
            }
            for (const candidateId of ids.slice(0, 4))
              yield* service.candidateReplay(f.caller(), { candidateId });
            yield* refusedWith(
              service.candidateReplay(f.caller(), { candidateId: ids[4]! }),
              "4 replays are running",
            );
            yield* service.report(f.caller(), {
              samples: [quietSample],
              findings: [],
              summary: "Unfinished.",
              journeys: { started: 5, passed: 0, failed: 5, stopped: 0 },
            });
            const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
            assert.equal(record.status, "incomplete");
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect("counts each confirmed bug on a control target as a false positive", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1"), manifest("bbbbbbbb", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory, { control: true }));
            yield* service.runCheck({ id: config.id });
            const plan = yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            yield* walk(policy, f.caller().threadId, "tab-one", "/tasks");
            const { candidateId } = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-one",
              title: "Broken",
              expected: "Works",
              observed: "Broken",
            });
            const replay = yield* service.candidateReplay(f.caller(), { candidateId });
            f.installReplay(
              replay.workId,
              replay.attemptId,
              verdict("reproduced", "Seen."),
              "strong",
            );
            yield* service.candidateSettle(f.caller(), { candidateId });
            yield* service.candidateSettle(f.caller(), { candidateId });
            assert.equal((yield* service.get({ id: config.id })).findings.length, 1);
            yield* service.report(f.caller(), {
              samples: [quietSample],
              findings: [],
              summary: "One.",
              journeys: { started: 1, passed: 0, failed: 1, stopped: 0 },
            });
            assert.equal(
              (yield* service.journeyRecord({ checkId: plan.checkId })).record.falsePositives,
              1,
            );
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect("refuses a verdict from the check's own model", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1"), manifest("bbbbbbbb", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            yield* service.journeysStart(f.caller());
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            yield* walk(policy, f.caller().threadId, "tab-one", "/tasks");
            const { candidateId } = yield* service.journeyCandidate(f.caller(), {
              tabId: "tab-one",
              title: "Broken",
              expected: "Works",
              observed: "Broken",
            });
            const replay = yield* service.candidateReplay(f.caller(), { candidateId });
            f.installReplay(
              replay.workId,
              replay.attemptId,
              verdict("reproduced", "Seen."),
              config.routineModelSelection.model,
            );
            const settled = yield* service.candidateSettle(f.caller(), { candidateId });
            assert.equal(settled.status, "inconclusive");
            assert.equal((yield* service.get({ id: config.id })).findings.length, 0);
          }).pipe(withPolicy),
      ),
    ),
  );

  it.effect("records a check incomplete when its counts disagree, whatever its owner said", () =>
    withFixture((f, service) =>
      withTarget([manifest("aaaaaaaa", "commit-1")], (directory) =>
        Effect.gen(function* () {
          yield* activate(service, journeysConfig(directory));
          yield* service.runCheck({ id: config.id });
          const plan = yield* service.journeysStart(f.caller());
          const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
          yield* walk(policy, f.caller().threadId, "tab-one", "/tasks");
          const detail = yield* service.report(f.caller(), {
            samples: [quietSample],
            findings: [],
            summary: "All 32 passed.",
            journeys: { started: 32, passed: 32, failed: 0, stopped: 0 },
          });
          const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
          assert.equal(record.status, "incomplete");
          assert.include(record.reason, "32 started");
          assert.isTrue(detail.champion.attention.some((a) => a.includes("did not finish")));
        }).pipe(withPolicy),
      ),
    ),
  );

  it.effect(
    "closes a confirmed bug when its replay passes on a later build, with no metric or delivery",
    () =>
      withFixture((f, service) =>
        withTarget(
          [
            manifest("aaaaaaaa", "commit-1"),
            manifest("bbbbbbbb", "commit-1"),
            manifest("cccccccc", "commit-2"),
            manifest("dddddddd", "commit-2"),
          ],
          (directory) =>
            Effect.gen(function* () {
              yield* activate(service, journeysConfig(directory));
              yield* service.runCheck({ id: config.id });
              yield* service.journeysStart(f.caller());
              const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
              const owner = f.caller().threadId;
              yield* walk(policy, owner, "tab-one", "/tasks");
              const { candidateId } = yield* service.journeyCandidate(f.caller(), {
                tabId: "tab-one",
                title: "Broken",
                expected: "Works",
                observed: "Broken",
              });
              const replay = yield* service.candidateReplay(f.caller(), { candidateId });
              f.installReplay(
                replay.workId,
                replay.attemptId,
                verdict("reproduced", "Seen."),
                "strong",
              );
              yield* service.candidateSettle(f.caller(), { candidateId });
              yield* service.report(f.caller(), {
                samples: [quietSample],
                findings: [],
                summary: "One bug.",
                journeys: { started: 1, passed: 0, failed: 1, stopped: 0 },
              });
              const finding = (yield* service.get({ id: config.id })).findings[0]!;
              assert.equal(finding.status, "open");

              f.endRun();
              yield* service.runCheck({ id: config.id });
              const second = yield* service.journeysStart(f.caller());
              assert.deepEqual(second.retests, [{ findingId: finding.id, title: "Broken" }]);
              assert.deepEqual(second.covered[0]?.urls, ["/tasks"]);
              yield* walk(policy, owner, "tab-two", "/books");
              const retest = yield* service.candidateReplay(f.caller(), { findingId: finding.id });
              f.installReplay(
                retest.workId,
                retest.attemptId,
                verdict("not-reproduced", "Fixed."),
                "strong",
              );
              const settled = yield* service.candidateSettle(f.caller(), {
                candidateId: retest.candidateId,
              });
              assert.equal(settled.status, "fixed");
              const closed = (yield* service.get({ id: config.id })).findings.find(
                (f) => f.id === finding.id,
              );
              assert.equal(closed?.status, "verified");
              assert.equal(closed?.seriesId, null);
              const detail = yield* service.report(f.caller(), {
                samples: [quietSample],
                findings: [],
                summary: "Nothing new.",
                journeys: { started: 1, passed: 1, failed: 0, stopped: 0 },
              });
              assert.deepEqual(detail.champion.attention, []);
            }).pipe(withPolicy),
        ),
      ),
  );

  it.effect("refuses an ineligible target before any browser can start", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            yield* refusedWith(service.journeysStart(f.caller()), "credentials: OPENAI_API_KEY");
            const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
            assert.deepEqual((yield* policy.forThread(f.caller().threadId))?.allow, []);
          }).pipe(withPolicy),
        {
          Config: {
            Env: ["OPENAI_API_KEY=real", "DATABASE_URL=postgres://r:p@db:5432/scratch_0123abcd"],
          },
        },
      ),
    ),
  );

  it.effect("defers while the machine is busy and starts nothing", () =>
    withFixture((f, service) =>
      withTarget([manifest("aaaaaaaa", "commit-1")], (directory) =>
        Effect.gen(function* () {
          yield* activate(service, journeysConfig(directory, { loadLimit: -1 }));
          yield* refusedWith(service.runCheck({ id: config.id }), "Check deferred");
          assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
        }),
      ),
    ),
  );

  it.effect("tells a check to report, not repair", () =>
    withFixture((f, service) =>
      withTarget([], (directory) =>
        Effect.gen(function* () {
          yield* activate(service, journeysConfig(directory));
          yield* service.runCheck({ id: config.id });
          const text = f.launchRequests.at(-1)!.text;
          assert.include(text, "YOU DO NOT REPAIR");
          assert.notInclude(text, "Own bounded improvements");
          assert.notInclude(text, "Bounded repair");
        }),
      ),
    ),
  );
});
