// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - a real `docker` shim on PATH stands in for the target
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import * as Managed from "../agents/ManagedAgentService.ts";
import { engines as decisionEngines } from "../decisions/adapters.ts";
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
  MessageId,
  NodeId,
  type RuntimeMode,
  type ModelSelection,
  type ChampionMeasurement,
  type ChampionLearningRecordInput,
  type ChampionLearningContributor,
  ChampionError,
  ProviderDriverKind,
  EnvironmentId,
  type RepositoryIdentity,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProviderThreadId,
  type ChampionConfig,
  type ChampionFinding,
  type ChampionMetricInput,
  type ChampionSampleInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ConversationMessage,
  ChampionReportInput,
  DEFAULT_CHAMPION_INSTRUCTIONS,
  type PreviewTaskResult,
  type ServerProvider,
  type Project,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ChampionJourneys from "./ChampionJourneys.ts";
import * as JourneyBrowserPolicy from "../preview/JourneyBrowserPolicy.ts";
import * as Champions from "./ChampionService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { renderChampionFolder, type ChampionFolder } from "./folders/championFolderCodec.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountAvailability from "../provider/AccountAvailability.ts";
import * as ServerConfig from "../config.ts";
import * as ChampionModels from "./ChampionModels.ts";
import { readChampionShellRows, readEscalationBrief, withChampions } from "./championShell.ts";
import { CASE_WORKSPACE_RULE } from "./championEscalation.ts";

const decodeBinding = Schema.decodeSync(AgentTaskBinding);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("test-provider");
const projectId = ProjectId.make("project:champions");
const config: ChampionConfig = {
  id: "champion:quality",
  projectId,
  name: "Quality",
  purpose: "Keep errors low",
  schedule: { type: "interval", everyMs: 60_000 },
  charter: { instructions: "Watch the error budget closely." },
};
/** The machine defaults the harness sets: checks run on `cheap`, setup and advice on `strong`. */
const routineSelection: ModelSelection = { instanceId, model: "cheap" };
const setupSelection: ModelSelection = { instanceId, model: "strong" };
const defaultModels = { checks: { model: routineSelection }, advice: { model: setupSelection } };
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
      credential = yield* registry.issue({ threadId, providerInstanceId: runInstance });
      yield* sessions.set(credential.config);
      return credential;
    });
    const settings = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(ServerSettings.layerTest({})),
    );
    let owner: ThreadId | undefined;
    let messageId = "";
    let launches = 0;
    let sends = 0;
    let instanceAvailable = true;
    let workspaceRoot = "/project/root";
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
    const unreadableShells = new Set<ThreadId>();
    /** Cases the server opened (started when launched with a first message), and every command it dispatched. */
    const escalationLaunches: Array<{
      threadId: ThreadId;
      title: string;
      model: string;
      started: boolean;
      text: string | undefined;
    }> = [];
    const commands: Array<{ type: string; threadId?: ThreadId }> = [];
    /** One-shot barriers on the owner's thread reads: the first matching read waits to be released. */
    const holds: Array<{
      readonly matches: (kinds: ReadonlyArray<string>) => boolean;
      readonly reached: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    }> = [];
    const holdOwner = <A, E, R>(
      id: ThreadId,
      kinds: ReadonlyArray<string>,
      read: () => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const index = id === owner ? holds.findIndex((hold) => hold.matches(kinds)) : -1;
      if (index < 0) return Effect.suspend(read);
      const [hold] = holds.splice(index, 1);
      return Deferred.succeed(hold!.reached, undefined).pipe(
        Effect.andThen(Deferred.await(hold!.release)),
        Effect.andThen(Effect.suspend(read)),
      );
    };
    const childRuns = new Map<ThreadId, OrchestrationV2Run[]>();
    const dispatches: string[] = [];
    const scheduled = new Map<string, Effect.Effect<void>>();
    let ownerMode: RuntimeMode = "full-access";
    let providerOverride: ReadonlyArray<ServerProvider> | undefined;
    const disabledProviders = new Set<string>();
    const childTasks: OrchestrationV2Subagent[] = [];
    const threadMessages = new Map<ThreadId, OrchestrationV2ConversationMessage[]>();
    const receipts = new Map<string, CommandReceiptV2>();
    const sent: Array<{
      threadId: ThreadId;
      commandId: string;
      messageId: string;
      text: string;
      model?: string;
      freshContext?: boolean;
    }> = [];
    let failSend = false;
    let runId = RunId.make("run:check");
    const runHistory: OrchestrationV2Run[] = [];
    let restartSource: RunId | undefined;
    let selection = routineSelection;
    let providerThreadId = ProviderThreadId.make("provider-thread:check");
    /** The account the live run is on: a failover moves it, and the owner's credential with it. */
    let runInstance: ProviderInstanceId = instanceId;
    let runThread: ThreadId | undefined;
    let continuationOf: RunId | undefined;
    const caller = () => ({
      threadId: owner!,
      providerInstanceId: runInstance,
      providerSessionId: credential!.config.providerSessionId,
    });
    // These are external thread/provider boundaries; the champion ledger and SQL remain real.
    let completedRun = false;
    let priorCompletedRun = false;
    let foreignProject = false;
    let foreignProviderThread = false;
    let overloadedRun = false;
    let limitedUntil: string | undefined;
    let limitFailure = { errorClass: "usage_limit", message: "usage limit reached" };
    const shell = () =>
      ({
        id: owner,
        title: "Quality owner",
        lineage: { rootThreadId: owner, parentThreadId: null, relationshipToParent: null },
        projectId: foreignProject ? ProjectId.make("foreign-project") : projectId,
        providerInstanceId: instanceId,
        runtimeMode: ownerMode,
        modelSelection: routineSelection,
        interactionMode: "default",
        status: activeRun
          ? "running"
          : overloadedRun || limitedUntil !== undefined
            ? "failed"
            : "idle",
        activeRunId: activeRun ? runId : null,
        latestRunId: runId,
        lastErrorCode: overloadedRun ? "overloaded" : null,
        ...(limitedUntil === undefined
          ? {}
          : {
              lastErrorClass: limitFailure.errorClass,
              lastError: limitFailure.message,
              usageLimitResetAt: limitedUntil,
            }),
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
          : overloadedRun || limitedUntil !== undefined
            ? "failed"
            : completedRun || !activeRun
              ? "completed"
              : "running",
        threadId: runThread ?? owner,
        ...(continuationOf === undefined ? {} : { manualContinuationOfRunId: continuationOf }),
        providerThreadId: foreignProviderThread
          ? ProviderThreadId.make("foreign-provider-thread")
          : providerThreadId,
        userMessageId: messageId,
        providerInstanceId: runInstance,
        modelSelection: selection,
      }) as OrchestrationV2Run;
    const availability = Context.get(
      yield* Layer.build(AccountAvailability.layer),
      AccountAvailability.AccountAvailability,
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(AccountAvailability.AccountAvailability, availability),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            if (input.commandId.startsWith("champion-escalation:")) {
              const escalationId =
                input.threadId ??
                ThreadId.make(`escalation:${launches}:${escalationLaunches.length}`);
              const started = input.initialMessage !== undefined;
              escalationLaunches.push({
                threadId: escalationId,
                title: input.title ?? "",
                model: input.modelSelection.model,
                started,
                text: input.initialMessage?.text,
              });
              children.set(escalationId, {
                id: escalationId,
                title: input.title,
                projectId,
                archivedAt: null,
                deletedAt: null,
                settledOverride: null,
                latestRunId: started ? RunId.make(`run:${escalationId}`) : null,
              } as unknown as OrchestrationV2ThreadShell);
              return { threadId: escalationId, projection: {} as never, resumed: false };
            }
            launches += 1;
            owner = input.threadId;
            activeRun = true;
            limitedUntil = undefined;
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
        getThreadShell: (id) =>
          unreadableShells.has(id)
            ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id }))
            : Effect.succeed(owner === id ? shell() : (children.get(id) ?? null)),
        getThreadRecords: (id, kinds) =>
          holdOwner(id, kinds, () =>
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
          ),
        getReceipt: (id) => Effect.succeed(Option.fromUndefinedOr(receipts.get(id))),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatches.push(command.type);
            commands.push({
              type: command.type,
              ...("threadId" in command ? { threadId: command.threadId } : {}),
            });
            const child = "threadId" in command ? children.get(command.threadId) : undefined;
            if (child !== undefined && command.type === "thread.settle")
              children.set(child.id, { ...child, settledOverride: "settled" });
            if (child !== undefined && command.type === "thread.unsettle")
              children.set(child.id, { ...child, settledOverride: null });
            if (child !== undefined && command.type === "thread.unarchive")
              children.set(child.id, { ...child, archivedAt: null });
            return { sequence: 1 } as never;
          }),
        cancelDelegatedTask: (input) =>
          Effect.sync(() => {
            dispatches.push(input.command.type);
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
                  const child = input.threadId === owner ? undefined : children.get(input.threadId);
                  sent.push({
                    threadId: input.threadId,
                    commandId: input.commandId,
                    messageId: input.messageId,
                    text: input.text,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { model: input.modelSelection.model }),
                    ...(input.freshContext === true ? { freshContext: true } : {}),
                  });
                  // A message to a case starts its run; the owner's state is its own.
                  if (child !== undefined) {
                    children.set(child.id, {
                      ...child,
                      latestRunId: RunId.make(`run:${child.id}`),
                    });
                    return {} as never;
                  }
                  sends += 1;
                  activeRun = true;
                  overloadedRun = false;
                  limitedUntil = undefined;
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
                    driver: ProviderDriverKind.make("claudeAgent"),
                    models: [
                      { slug: "cheap", name: "cheap" },
                      { slug: "strong", name: "strong" },
                    ],
                  } as unknown as ServerProvider,
                ])
              : [],
          ),
        ),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: () => Effect.succeedSome({ id: projectId, workspaceRoot } as Project),
      }),
      Layer.mock(Scheduler.Scheduler)({
        register: <E, R>(name: string, task: Effect.Effect<void, E, R>) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            scheduled.set(name, task.pipe(Effect.provideContext(context), Effect.orDie));
          }),
      }),
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(McpProviderSessions.McpProviderSessions, sessions),
      Layer.succeed(ServerSettings.ServerSettingsService, settings),
    );
    return {
      /** The machine's settings: pooled model keys, as the usage-limit routing reads them. */
      settings,
      /** The server's memory of failed runs on accounts. */
      availability,
      layer: Champions.layer.pipe(Layer.provide(dependencies)),
      dependencies,
      dispatches,
      /** Work registered with the scheduler, by name. */
      scheduled,
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
      /** Holds the next read of the owner's thread records that asks for exactly these kinds. */
      holdOwnerRead: Effect.fn("test.holdOwnerRead")(function* (
        match: (kinds: ReadonlyArray<string>) => boolean,
      ) {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        holds.push({ matches: match, reached, release });
        return { reached, release };
      }),
      installMeasurement: (
        measurement: ChampionMeasurement,
        status: "running" | "completed" | "failed" | "cancelled",
      ) => {
        const admission = measurement.admission!;
        children.set(admission.childThreadId, {
          id: admission.childThreadId,
          projectId,
          agentTask: admission.binding,
          runtimeMode: "full-access",
          interactionMode: "default",
          activeRunId: status === "running" ? RunId.make(measurement.measurementId) : null,
          deletedAt: null,
        } as OrchestrationV2ThreadShell);
        const task = {
          id: admission.taskId,
          threadId: owner,
          origin: "app_owned",
          childThreadId: admission.childThreadId,
          status,
          result: status === "running" ? null : "Observed rendered evidence",
          runId: null,
        } as OrchestrationV2Subagent;
        const index = childTasks.findIndex((t) => t.id === task.id);
        if (index < 0) childTasks.push(task);
        else childTasks[index] = task;
        childRuns.set(admission.childThreadId, [
          {
            id: RunId.make(measurement.measurementId),
            status,
            userMessageId: admission.messageId,
            modelSelection: admission.resolvedSelection,
            delegatedTaskId: admission.taskId,
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
      /**
       * The server's account failover: the failed run's work continues on another account's provider thread, in
       * a run whose message names the failed run. `message` and `thread` break the shape on purpose.
       */
      failoverRun: Effect.fn("test.failoverRun")(function* (
        options: { message?: string; thread?: ThreadId } = {},
      ) {
        const failed = currentRun();
        runHistory.push({ ...failed, status: "failed" });
        runId = RunId.make(`run:failover:${runHistory.length}`);
        restartSource = undefined;
        continuationOf = failed.id;
        runThread = options.thread ?? owner;
        messageId = options.message ?? `limit-pool-switch:${runThread}:${failed.id}`;
        runInstance = ProviderInstanceId.make("account-b");
        providerThreadId = ProviderThreadId.make("provider-thread:account-b");
        activeRun = true;
        completedRun = false;
        limitedUntil = undefined;
        yield* bindCredential(owner!);
      }),
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
        input: Parameters<Champions.ChampionService["Service"]["submitReport"]>[1],
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
          .handle("t3_champions_report", JSON.parse(JSON.stringify(input)))
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
      /** A real directory, for a test whose metric commands run in the project root. */
      realProjectRoot: () => {
        workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "champion-collect-"));
        return workspaceRoot;
      },
      launchRequests,
      escalationLaunches,
      commands,
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
      /** The owner's run ends on its model's usage limit, which the provider says lifts at `resetAt`. */
      limitRun: (
        resetAt: string,
        failure: { errorClass: string; message: string } = {
          errorClass: "usage_limit",
          message: "usage limit reached",
        },
      ) => {
        limitFailure = failure;
        activeRun = false;
        queuedRun = false;
        limitedUntil = resetAt;
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
      /** Changes a case thread, as a person archiving or deleting it would. */
      updateCase: (threadId: ThreadId, patch: Partial<OrchestrationV2ThreadShell>) => {
        children.set(threadId, { ...children.get(threadId)!, ...patch });
      },
      caseShell: (threadId: ThreadId) => children.get(threadId),
      /** The thread's shell read fails, as a broken projection would. */
      breakShell: (threadId: ThreadId) => {
        unreadableShells.add(threadId);
      },
      /** The owner's live run is the one a given message started. */
      runMessage: (id: string) => {
        messageId = id;
        activeRun = true;
        completedRun = false;
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
      const service = yield* Champions.ChampionService;
      yield* service.setModels(defaultModels);
      yield* body(f, service);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(Sqlite.layerMemory));
const definitions = Effect.fn("test.championDefinitions")(function* (
  service: Champions.ChampionService["Service"],
) {
  yield* service.upsert(config);
  return yield* service.changeMetrics({
    id: config.id,
    metrics: [metric],
    reason: "Measure errors",
  });
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
        yield* service.changeMetricsFromCheck(scope!.thread, proposal);
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
        yield* runDueThroughReprompt(f, service);
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
        assert.equal(f.counts().sends, 2);
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

it.effect("does not flag completed setup changes or no-change completion as missing reports", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* service.upsert(config);
      yield* service.setup({ id: config.id });
      yield* service.changeMetricsFromCheck(f.caller(), {
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
        const wording = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, name: "Observed errors", maximum: 1 }],
          reason: "Tighter target",
        });
        assert.equal(wording.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
        assert.equal(wording.metrics[0]!.version, 2);
        const unit = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Use error rate",
        });
        assert.notEqual(unit.metrics[0]!.seriesId, wording.metrics[0]!.seriesId);
        const source = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, source: "synthetic" }],
          reason: "Change measurement source",
        });
        assert.notEqual(source.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
      }),
    ),
);

it.effect(
  "a metric change applies at once, keeps metrics it leaves out and retires only those it names",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const latency = { ...metric, id: "latency", name: "Latency", unit: "ms", maximum: 500 };
        yield* service.upsert(config);
        const before = yield* service.changeMetrics({
          id: config.id,
          metrics: [metric, latency],
          reason: "Start",
        });
        assert.notInclude(before.champion.attention, "Add metrics before enabling checks.");
        const crashes = { ...metric, id: "crashes", name: "Crashes" };
        const added = yield* service.changeMetrics(
          { id: config.id, metrics: [crashes], reason: "Add crashes" },
          ThreadId.make("work-thread"),
        );
        assert.deepEqual(
          added.metrics.map(({ id, version, seriesId }) => ({ id, version, seriesId })),
          [
            ...before.metrics.map(({ id, version, seriesId }) => ({ id, version, seriesId })),
            { id: "crashes", version: 1, seriesId: added.metrics[2]!.seriesId },
          ],
        );
        assert.isDefined(added.metrics[2]!.definedAt);
        const announced = (yield* service.history({ id: config.id })).activity.find(
          (event) => event.kind === "metrics-changed" && event.text.includes("Add crashes"),
        );
        assert.equal(announced?.text, "Added Crashes. Add crashes");
        assert.equal(announced?.threadId, "work-thread");

        const retired = yield* service.changeMetrics({
          id: config.id,
          metrics: [],
          retires: ["latency"],
          reason: "Latency is measured elsewhere",
        });
        assert.deepEqual(
          retired.metrics.map(({ id, version }) => ({ id, version })),
          [
            { id: "errors", version: 1 },
            { id: "crashes", version: 1 },
          ],
        );
        yield* refusedWith(
          service.changeMetrics({
            id: config.id,
            metrics: [],
            retires: ["latency"],
            reason: "Again",
          }),
          "not a tracked metric",
        );

        const back = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...latency, name: "Page latency" }],
          reason: "Bring latency back",
        });
        const latencyBack = back.metrics.find((m) => m.id === "latency")!;
        assert.equal(latencyBack.seriesId, before.metrics[1]!.seriesId);
        assert.equal(latencyBack.version, 2);
      }),
    ),
);

it.effect("refuses a change that would track more than 32 metrics and applies exactly 32", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const numbered = (n: number) => ({ ...metric, id: `m${n}`, name: `Metric ${n}` });
      yield* service.upsert(config);
      yield* service.changeMetrics({
        id: config.id,
        metrics: Array.from({ length: 31 }, (_, n) => numbered(n)),
        reason: "Start",
      });
      yield* refusedWith(
        service.changeMetrics({
          id: config.id,
          metrics: [numbered(31), numbered(32)],
          reason: "Two",
        }),
        "at most 32",
      );
      const full = yield* service.changeMetrics({
        id: config.id,
        metrics: [numbered(31)],
        reason: "One more",
      });
      assert.equal(full.metrics.length, 32);
      yield* refusedWith(
        service.changeMetrics({ id: config.id, metrics: [numbered(32)], reason: "Too many" }),
        "at most 32",
      );
      const swapped = yield* service.changeMetrics({
        id: config.id,
        metrics: [numbered(32)],
        retires: ["m0"],
        reason: "Swap",
      });
      assert.equal(swapped.metrics.length, 32);
      yield* service.runCheck({ id: config.id });
      yield* service.report(f.caller(), {
        samples: Array.from({ length: 32 }, (_, n) => ({
          ...sample,
          metricId: `m${n + 1}`,
          value: 1,
        })),
        findings: [],
        summary: "All 32 measured",
      });
      const read = yield* service.get({ id: config.id });
      assert.equal(read.metrics.length, 32);
      assert.equal(read.champion.latestSamples?.length, 32);
    }),
  ),
);

const node = (script: string, ...args: string[]) => [process.execPath, "-e", script, ...args];
const printsFile = (path: string) =>
  node("process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", path);
const collectedMetric = (collect: ReadonlyArray<string>, id = "errors"): ChampionMetricInput => ({
  ...metric,
  id,
  name: id,
  collect,
});
const accepted = Effect.fn("test.championAccepted")(function* (
  service: Champions.ChampionService["Service"],
  metrics: ReadonlyArray<ChampionMetricInput>,
  champion = config,
) {
  yield* service.upsert(champion);
  // Unproved, as a command that worked when added can break later.
  return yield* service.changeMetrics({ id: champion.id, metrics, reason: "Measure" }, undefined, {
    prove: false,
  });
});

it.effect(
  "reads a new or changed command once before a metric change applies and refuses the whole change when it fails",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const reading = NodePath.join(f.realProjectRoot(), "reading");
        yield* service.upsert(config);
        yield* refusedWith(
          service.changeMetrics({
            id: config.id,
            metrics: [
              metric,
              collectedMetric(node("console.error('no table');process.exit(2)"), "rows"),
            ],
            reason: "Add rows",
          }),
          "rows: Collection failed: the command exited with 2. no table",
        );
        assert.deepEqual((yield* service.get({ id: config.id })).metrics, []);

        NodeFS.writeFileSync(reading, "7");
        yield* service.changeMetrics({
          id: config.id,
          metrics: [collectedMetric(printsFile(reading), "rows")],
          reason: "Add rows",
        });
        const added = (yield* service.history({ id: config.id })).activity.find(
          (event) => event.kind === "metrics-changed",
        );
        assert.equal(added?.text, "Added rows (read 7 count when added). Add rows");

        // An unchanged command is not read again, so a change elsewhere never waits on it.
        NodeFS.rmSync(reading);
        const renamed = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...collectedMetric(printsFile(reading), "rows"), name: "Rows stored" }],
          reason: "Clearer name",
        });
        assert.equal(renamed.metrics[0]!.name, "Rows stored");
      }),
    ),
);

it.effect("starts a new champion once setup adds its first metrics", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(config);
      assert.deepEqual(created.champion.attention, ["Add metrics before enabling checks."]);
      yield* service.setup({ id: config.id });
      const started = yield* service.changeMetricsFromCheck(f.caller(), {
        metrics: [metric],
        reason: "Initial measurement",
      });
      assert.equal(started.champion.lifecycle, "active");
      assert.isNotNull(started.champion.nextCheckAt);
      assert.isNull(started.champion.outstandingSetupId);
      assert.deepEqual(started.champion.attention, []);
    }),
  ),
);

it.effect("applies a metric change left waiting for acceptance when the service starts", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      const sql = yield* SqlClient.SqlClient;
      const waiting = JSON.stringify({
        id: "proposal-1",
        proposedAt: "1970-01-01T00:00:00.000Z",
        metrics: [{ ...metric, maximum: 1 }],
        retires: [],
        reason: "Tighter goal",
      });
      yield* sql`UPDATE champions SET document_json = json_set(document_json, '$.proposal', json(${waiting}), '$.champion.pendingProposal', json('true'), '$.champion.attention', json('["Metric proposal awaits acceptance."]')) WHERE id = ${config.id}`.pipe(
        Effect.orDie,
      );
      const restarted = yield* Effect.gen(function* () {
        return yield* (yield* Champions.ChampionService).get({ id: config.id });
      }).pipe(Effect.provide(Layer.fresh(f.layer)));
      assert.equal(restarted.metrics[0]!.maximum, 1);
      assert.equal(restarted.metrics[0]!.version, 2);
      assert.deepEqual(restarted.champion.attention, []);
      const stored = yield* sql<{
        waiting: number;
      }>`SELECT json_type(document_json, '$.proposal') IS NOT NULL AS waiting FROM champions WHERE id = ${config.id}`.pipe(
        Effect.orDie,
      );
      assert.equal(stored[0]!.waiting, 0);
    }),
  ),
);

it.effect(
  "finishes a check whose metrics are all read by command and in target without an agent, and runs the next one normally",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* accepted(service, [
          collectedMetric(node("console.log(1)")),
          collectedMetric(
            node(`console.log(JSON.stringify({value:2,revision:"abc",evidence:"two"}))`),
            "detailed",
          ),
        ]);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        f.available(false);
        const done = yield* service.runCheck({ id: config.id });
        assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
        assert.isNull(done.champion.outstandingCheckId);
        assert.isNotNull(done.champion.lastCheckAt);
        assert.isNotNull(done.champion.nextCheckAt);
        assert.deepEqual(done.champion.attention, []);
        assert.deepEqual(
          done.champion.latestSamples?.map((latest) => latest.health),
          ["healthy", "healthy"],
        );
        const first = (yield* service.history({ id: config.id })).samples;
        assert.deepEqual(
          first.map(
            ({ metricId, value, evidence, revision, provenance, runId, modelSelection }) => ({
              metricId,
              value,
              evidence,
              revision,
              provenance,
              runId,
              modelSelection,
            }),
          ),
          [
            {
              metricId: "errors",
              value: 1,
              evidence: "1",
              revision: null,
              provenance: "server-collected",
              runId: null,
              modelSelection: null,
            },
            {
              metricId: "detailed",
              value: 2,
              evidence: "two",
              revision: "abc",
              provenance: "server-collected",
              runId: null,
              modelSelection: null,
            },
          ],
        );
        yield* TestClock.adjust("1 second");
        const again = yield* service.runCheck({ id: config.id });
        assert.isNull(again.champion.outstandingCheckId);
        assert.equal((yield* service.history({ id: config.id })).samples.length, 4);
        assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
      }),
    ),
);

it.effect(
  "records a failing command and unreadable output as failed collections and finishes the run without an agent",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* accepted(service, [
          collectedMetric(node("console.error('disk gone');process.exit(3)"), "fails"),
          collectedMetric(node("console.log('plenty')"), "words"),
        ]);
        const reported = yield* service.runCheck({ id: config.id });
        assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
        assert.isNull(reported.champion.outstandingCheckId);
        const samples = (yield* service.history({ id: config.id })).samples;
        assert.deepEqual(
          samples
            .map(({ metricId, value, status }) => ({ metricId, value, status }))
            .toSorted((a, b) => a.metricId.localeCompare(b.metricId)),
          [
            { metricId: "fails", value: null, status: "error" },
            { metricId: "words", value: null, status: "error" },
          ],
        );
        assert.isTrue(samples.some((x) => x.evidence.includes("exited with 3. disk gone")));
        assert.isTrue(
          samples.some((x) => x.evidence.includes("neither a number nor a JSON reading")),
        );
        assert.deepEqual(reported.champion.attention, [
          "Some measurements are unknown, insufficient, or failed.",
        ]);
        assert.deepEqual(
          reported.champion.latestSamples?.map((latest) => latest.health),
          ["error", "error"],
        );
      }),
    ),
);

it.effect(
  "starts a fresh check on the accepted definitions when the outstanding one was claimed before they changed and its run has ended",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* definitions(service);
        const stuck = yield* service.runCheck({ id: config.id });
        f.endRun();
        yield* accepted(service, [collectedMetric(node("console.log(1)"))]);
        const done = yield* service.runCheck({ id: config.id });
        assert.deepEqual(f.counts(), { launches: 1, sends: 0 });
        assert.isNull(done.champion.outstandingCheckId);
        assert.deepEqual(
          (yield* service.history({ id: config.id })).samples.map((s) => [
            s.version,
            s.value,
            s.provenance,
          ]),
          [[2, 1, "server-collected"]],
        );
        // The superseded claim's agent can no longer report against it.
        assert.isNotNull(stuck.champion.outstandingCheckId);
        yield* refused(
          service.report(f.caller(), { samples: [sample], findings: [], summary: "Too late" }),
        );
      }),
    ),
);

it.effect("does not hold one champion's check behind another champion's slow command", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const marker = NodePath.join(f.realProjectRoot(), "second-ran");
      const slow = { ...config, id: "champion:slow", name: "Slow" };
      const quick = { ...config, id: "champion:quick", name: "Quick" };
      yield* accepted(
        service,
        [
          collectedMetric(
            node(
              "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);console.log(1)}},10)",
              marker,
            ),
          ),
        ],
        slow,
      );
      yield* accepted(
        service,
        [
          collectedMetric(
            node("require('fs').writeFileSync(process.argv[1],'');console.log(1)", marker),
          ),
        ],
        quick,
      );
      for (const champion of [slow, quick])
        yield* service.setLifecycle({ id: champion.id, lifecycle: "active" });
      yield* TestClock.adjust("2 minutes");
      yield* service.runDue;
      for (const champion of [slow, quick]) {
        const read = yield* service.get({ id: champion.id });
        assert.isNull(read.champion.outstandingCheckId);
        assert.equal((yield* service.history({ id: champion.id })).samples[0]?.value, 1);
      }
      assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
    }),
  ),
);

it.effect(
  "asks the agent only for metrics no command reads, refuses its value for a collected one and stores both kinds",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* accepted(service, [metric, collectedMetric(node("console.log(7)"), "disk")]);
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().launches, 1);
        const context = yield* service.checkContext(f.caller());
        assert.deepEqual(
          context.metrics.map((m) => m.id),
          ["errors"],
        );
        assert.deepEqual(
          context.collected?.map((s) => s.metricId),
          ["disk"],
        );
        const agentSample = { ...sample, value: 1 };
        yield* refusedWith(
          service.report(f.caller(), {
            samples: [agentSample, { ...sample, metricId: "disk", value: 1 }],
            findings: [],
            summary: "Tried to report a collected metric",
          }),
          "reads disk by command",
        );
        yield* service.report(f.caller(), {
          samples: [agentSample],
          findings: [],
          summary: "Reported the rest",
        });
        assert.deepEqual(
          (yield* service.history({ id: config.id })).samples.map((s) => [
            s.metricId,
            s.value,
            s.provenance,
          ]),
          [
            ["disk", 7, "server-collected"],
            ["errors", 1, "agent-reported"],
          ],
        );
      }),
    ),
);

it.effect(
  "reports a check with nothing for the agent to measure from a summary alone or with findings",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* accepted(service, [
          { ...metric, required: false },
          collectedMetric(node("console.log(7)"), "disk"),
        ]);
        yield* service.runCheck({ id: config.id });
        const first = yield* f.reportThroughTool(service, { summary: "Server metrics only" });
        assert.isFalse(first.at(-1)!.isFailure);
        assert.isNull((yield* service.get({ id: config.id })).champion.outstandingCheckId);
        yield* service.runCheck({ id: config.id });
        const second = yield* f.reportThroughTool(service, {
          findings: [{ title: "Slow page", evidence: "Seen in the browser" }],
          summary: "One finding",
        });
        assert.isFalse(second.at(-1)!.isFailure);
        assert.include(
          (yield* service.get({ id: config.id })).findings.map((finding) => finding.title),
          "Slow page",
        );
      }),
    ),
);

it.effect("refuses a check report with no samples while a required metric is unmeasured", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      const result = yield* f.reportThroughTool(service, { summary: "Nothing measured" });
      assert.isTrue(result.at(-1)!.isFailure);
      assert.equal((yield* service.history({ id: config.id })).samples.length, 0);
    }),
  ),
);

it.effect("installs a new version when a proposal changes only a metric's command", () =>
  withFixture((_f, service) =>
    Effect.gen(function* () {
      const first = yield* accepted(service, [collectedMetric(node("console.log(1)"))]);
      const second = yield* accepted(service, [collectedMetric(node("console.log(2)"))]);
      assert.deepEqual([first.metrics[0]!.version, second.metrics[0]!.version], [1, 2]);
      assert.deepEqual(second.metrics[0]!.collect, node("console.log(2)"));
      assert.equal(
        (yield* accepted(service, [collectedMetric(node("console.log(2)"))])).metrics[0]!.version,
        2,
      );
    }),
  ),
);

it.effect(
  "finishes a readings run with only scripted metrics server-side, waking no model, even with a breach, an error or an open finding",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const reading = NodePath.join(f.realProjectRoot(), "reading");
        NodeFS.writeFileSync(reading, "5");
        yield* accepted(service, [collectedMetric(printsFile(reading))]);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const breached = yield* service.runCheck({ id: config.id });
        const finding = breached.findings[0]!;
        assert.equal(finding.status, "open");
        assert.equal(
          finding.evidence,
          "errors read 5 count, outside its target of at most 2 count. The server's command printed: 5",
        );
        assert.isNull(breached.champion.outstandingCheckId);
        // The first-ever readings run opens no case, even for a breach.
        assert.isNull(finding.escalationThreadId ?? null);
        NodeFS.writeFileSync(reading, "not a number");
        yield* TestClock.adjust("1 second");
        const errored = yield* service.runCheck({ id: config.id });
        assert.isNull(errored.champion.outstandingCheckId);
        assert.equal(errored.findings[0]!.status, "open");
        assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
        assert.deepEqual(f.escalationLaunches, []);
      }),
    ),
);

/** A scripted metric in target on its first run, then breached: the breach opens an idle case. */
const breachWithCase = Effect.fn("test.championBreachWithCase")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
  metricInput: Partial<ChampionMetricInput> = {},
) {
  const reading = NodePath.join(f.realProjectRoot(), "reading");
  NodeFS.writeFileSync(reading, "1");
  yield* accepted(service, [{ ...collectedMetric(printsFile(reading)), ...metricInput }]);
  yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  yield* service.runCheck({ id: config.id });
  NodeFS.writeFileSync(reading, "5");
  yield* TestClock.adjust("1 second");
  const breached = yield* service.runCheck({ id: config.id });
  const finding = breached.findings[0]!;
  assert.isString(finding.escalationThreadId);
  return { reading, finding, caseThread: finding.escalationThreadId! };
});

it.effect(
  "closes the finding and settles its case when a reading recovers before the case ever ran",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const { reading, finding, caseThread } = yield* breachWithCase(f, service);
        assert.isFalse(f.escalationLaunches[0]!.started);
        NodeFS.writeFileSync(reading, "1");
        yield* TestClock.adjust("1 second");
        const recovered = yield* service.runCheck({ id: config.id });
        assert.equal(recovered.findings.find((x) => x.id === finding.id)!.status, "dismissed");
        assert.isTrue(
          f.commands.some(
            (command) => command.type === "thread.settle" && command.threadId === caseThread,
          ),
        );
        assert.isTrue(
          (yield* service.history({ id: config.id })).activity.some(
            (entry) => entry.kind === "finding-recovered",
          ),
        );
      }),
    ),
);

it.effect("leaves a worked case and its finding open when a reading recovers", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const { reading, finding, caseThread } = yield* breachWithCase(f, service);
      // Henry starts the case with a reply.
      f.updateCase(caseThread, { latestRunId: RunId.make("run:case") } as never);
      NodeFS.writeFileSync(reading, "1");
      yield* TestClock.adjust("1 second");
      const recovered = yield* service.runCheck({ id: config.id });
      assert.equal(recovered.findings.find((x) => x.id === finding.id)!.status, "open");
      assert.isFalse(
        f.commands.some(
          (command) => command.type === "thread.settle" && command.threadId === caseThread,
        ),
      );
    }),
  ),
);

it.effect("leaves a finding open when a reading recovers but its case can't be read", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const { reading, finding, caseThread } = yield* breachWithCase(f, service);
      f.breakShell(caseThread);
      NodeFS.writeFileSync(reading, "1");
      yield* TestClock.adjust("1 second");
      const recovered = yield* service.runCheck({ id: config.id });
      assert.equal(recovered.findings.find((x) => x.id === finding.id)!.status, "open");
      assert.isFalse(
        f.commands.some(
          (command) => command.type === "thread.settle" && command.threadId === caseThread,
        ),
      );
    }),
  ),
);

it.effect("records a breach the open-finding limit refuses as activity and attention", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const reading = NodePath.join(f.realProjectRoot(), "reading");
      NodeFS.writeFileSync(reading, "5");
      const ids = Array.from({ length: 11 }, (_, i) => `errors${i}`);
      yield* accepted(
        service,
        ids.map((id) => collectedMetric(printsFile(reading), id)),
      );
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      const checked = yield* service.runCheck({ id: config.id });
      assert.equal(checked.findings.length, 10);
      assert.isFalse(checked.findings.some((x) => x.metricId === "errors10"));
      assert.isTrue(
        checked.champion.attention.some((a) => a.includes("Open finding limit reached")),
      );
      const limited = (yield* service.history({ id: config.id })).activity.filter(
        (a) => a.kind === "finding-limited",
      );
      assert.equal(limited.length, 1);
      assert.include(limited[0]!.text, "errors10");
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
      const selection = { ...routineSelection, model: "strong" };
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
      f.restartRun({ selection: routineSelection });
      yield* service.report(f.caller(), input);
      assert.deepEqual((yield* service.runtimeState({ id: config.id })).attempts, attempts);
      assert.equal((yield* service.history({ id: config.id })).samples.length, 1);
      assert.deepEqual(f.counts(), { launches: 1, sends: 0 });
    }),
  ),
);

it.effect("keeps one claim across the server's account failover and reports it once", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      const first = yield* service.checkContext(f.caller());
      yield* f.failoverRun();
      yield* service.runDue;
      const live = yield* service.get({ id: config.id });
      assert.equal(live.champion.outstandingCheckId, first.checkId);
      assert.isFalse(live.champion.attention.some((a) => a.includes("ended without")));
      assert.equal((yield* service.checkContext(f.caller())).checkId, first.checkId);
      yield* service.report(f.caller(), {
        samples: [sample],
        findings: [],
        summary: "On account B",
      });
      const done = yield* service.get({ id: config.id });
      assert.isNull(done.champion.outstandingCheckId);
      assert.equal((yield* service.history({ id: config.id })).samples.length, 1);
      assert.deepEqual(f.counts(), { launches: 1, sends: 0 });
    }),
  ),
);

it.effect.each(["another message", "another thread"] as const)(
  "refuses a failover-shaped run with %s",
  (breach) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* f.failoverRun(
          breach === "another message"
            ? { message: "limit-pool-switch:other-thread:run:elsewhere" }
            : { thread: ThreadId.make("other-thread") },
        );
        yield* refused(service.checkContext(f.caller()));
        yield* runDueThroughReprompt(f, service);
        assert.isTrue(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("ended without"),
          ),
        );
      }),
    ),
);

it.effect(
  "skips a check that hit a usage limit when its retries are spent, and starts the next on time",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setModels({
          checks: { model: routineSelection, backup: setupSelection },
          advice: { model: setupSelection },
        });
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const claim = (yield* service.runCheck({ id: config.id })).champion.outstandingCheckId;
        for (let retry = 1; retry <= 3; retry++) {
          f.overloadRun();
          yield* service.runDue;
          assert.equal(f.sent.length, retry);
        }
        // start() refuses a fourth retry and hands back the same claim: that is not a retry on the backup.
        f.limitRun("1970-01-01T00:30:00.000Z");
        yield* service.runDue;
        assert.equal(f.sent.length, 3);
        const skipped = yield* service.get({ id: config.id });
        assert.isNull(skipped.champion.outstandingCheckId);
        assert.isTrue(
          skipped.champion.attention.some((line) => line.startsWith("Skipped this check")),
        );
        yield* TestClock.adjust("1 minute");
        yield* service.runDue;
        const next = (yield* service.get({ id: config.id })).champion.outstandingCheckId;
        assert.isNotNull(next);
        assert.notEqual(next, claim);
      }),
    ),
);

it.effect("releases a check whose run ended without a report, and starts the next on time", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      const claim = (yield* service.runCheck({ id: config.id })).champion.outstandingCheckId;
      f.endRun();
      yield* runDueThroughReprompt(f, service);
      // Before its next check is due, Check now still retries the claim in place.
      assert.equal((yield* service.get({ id: config.id })).champion.outstandingCheckId, claim);
      yield* TestClock.adjust("2 days");
      yield* service.runDue;
      const ended = (yield* service.get({ id: config.id })).champion;
      assert.isNull(ended.outstandingCheckId);
      assert.isTrue(
        ended.attention.some((line) => line.startsWith("Check run ended without an authenticated")),
      );
      yield* TestClock.adjust("1 minute");
      yield* service.runDue;
      const next = (yield* service.get({ id: config.id })).champion.outstandingCheckId;
      assert.isNotNull(next);
      assert.notEqual(next, claim);
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
      yield* runDueThroughReprompt(f, service);
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
        yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Change later checks",
        });
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
        assert.equal(history.samples[0]!.modelSelection?.model, "cheap");
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
              role: "implementer",
              taskClass: "non-ui",
              workId: finding.id,
              attemptId: "1",
              workspacePath: "/isolated",
              workspaceAssignment: "isolated",
            },
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: () => assert.fail("Expected a Champion's thread to refuse a repair."),
            }),
          );
        // The agent reads this message, so it names where the work goes instead.
        assert.include(pausedRefusal, Champions.CASE_FLOW_REFUSAL);
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

it.effect(
  "dismisses a metric's open finding when its series rotates or the metric is retired",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const reading = NodePath.join(f.realProjectRoot(), "reading");
        NodeFS.writeFileSync(reading, "5");
        yield* accepted(service, [collectedMetric(printsFile(reading))]);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const open = (yield* service.runCheck({ id: config.id })).findings[0]!;
        assert.equal(open.status, "open");
        const rotated = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...collectedMetric(printsFile(reading)), source: "other logs" }],
          reason: "New source",
        });
        assert.notEqual(rotated.metrics[0]!.seriesId, open.seriesId);
        assert.equal(rotated.findings.find((x) => x.id === open.id)!.status, "dismissed");
        assert.equal(rotated.champion.openFindingCount, 0);
        const retired = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, id: "other", name: "Other" }],
          retires: ["errors"],
          reason: "Gone",
        });
        assert.equal(retired.champion.openFindingCount, 0);
      }),
    ),
);

it.effect("dismisses a retired Champion's open findings and caps open findings at 10", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const reading = NodePath.join(f.realProjectRoot(), "reading");
      NodeFS.writeFileSync(reading, "5");
      const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
      yield* accepted(
        service,
        ids.map((id) => collectedMetric(printsFile(reading), id)),
      );
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      const checked = yield* service.runCheck({ id: config.id });
      assert.equal(checked.champion.openFindingCount, 10);
      const retired = yield* service.setLifecycle({ id: config.id, lifecycle: "retired" });
      assert.equal(retired.champion.openFindingCount, 0);
      assert.isTrue(retired.findings.every((x) => x.status === "dismissed"));
    }),
  ),
);

it.effect("tells each rhythm the universal operating rules", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.runCheck({ id: config.id });
      const readings = f.launchRequests[0]!.text;
      assert.include(readings, "not a progress journal");
      assert.include(readings, "not metric gaming");
      yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
      yield* service.runReview({ id: config.id });
      const review = f.sent.at(-1)!.text;
      assert.include(review, "short and operational");
      assert.include(review, "not metric gaming");
    }),
  ),
);

// Skipped runs: a check whose models cannot run is said plainly, never passed, and the next one starts on time.
const UNTIL = "1970-01-01T00:30:00.000Z";
const modelProvider = (id: string, model: string, window?: { resetsAt?: string }) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: model, name: model }],
    ...(window === undefined
      ? {}
      : { usageLimits: { windows: [{ id: "w", label: "w", usedPercent: 100, ...window }] } }),
  }) as unknown as ServerProvider;
const limitedProvider = (id: string, model: string, resetsAt?: string) =>
  modelProvider(id, model, resetsAt === undefined ? {} : { resetsAt });

it.effect.each([
  {
    reset: UNTIL as string | undefined,
    said: `limited-main is at its limit until ${ChampionModels.formatLondon(UNTIL)}, and the backup limited-backup is at its limit until ${ChampionModels.formatLondon(UNTIL)}`,
  },
  {
    reset: undefined as string | undefined,
    said: `limited-main is at its limit until a time the provider did not give, and the backup limited-backup is at its limit until a time the provider did not give`,
  },
])(
  "skips a scheduled check whose models are both at their limit ($reset), then starts the next on time",
  ({ reset, said }) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const main = { instanceId: ProviderInstanceId.make("main"), model: "limited-main" };
        const backup = { instanceId: ProviderInstanceId.make("backup"), model: "limited-backup" };
        f.setProviders([
          modelProvider("main", "limited-main"),
          modelProvider("backup", "limited-backup"),
        ]);
        yield* service.setModels({ checks: { model: main, backup }, advice: { model: main } });
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        f.setProviders([
          limitedProvider("main", "limited-main", reset),
          limitedProvider("backup", "limited-backup", reset),
        ]);
        yield* TestClock.adjust("1 minute");
        yield* service.runDue;
        const skipped = yield* service.get({ id: config.id });
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
        assert.equal((yield* sql`SELECT id FROM champion_checks`.pipe(Effect.orDie)).length, 0);
        assert.isNull(skipped.champion.outstandingCheckId);
        assert.isNotNull(skipped.champion.nextCheckAt);
        assert.deepEqual(skipped.champion.attention, [
          `Skipped this check: ${said}. Next check ${ChampionModels.formatLondon(skipped.champion.nextCheckAt!)}.`,
        ]);
        assert.isTrue(
          (yield* service.history({ id: config.id })).activity.some(
            (entry) => entry.kind === "check-skipped",
          ),
        );
        // The next scheduled check starts at its time once a model can run.
        f.setProviders([
          modelProvider("main", "limited-main"),
          modelProvider("backup", "limited-backup"),
        ]);
        yield* TestClock.adjust("1 minute");
        yield* service.runDue;
        const next = yield* service.get({ id: config.id });
        assert.isNotNull(next.champion.outstandingCheckId);
        assert.isTrue(next.champion.attention.every((line) => !line.startsWith("Skipped this ")));
      }),
    ),
);

it.effect("skips a claimed check whose models are not on this machine, and a setup likewise", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.setModels({
        checks: { model: routineSelection, backup: setupSelection },
        advice: { model: setupSelection },
      });
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      f.available(false);
      yield* refused(service.runCheck({ id: config.id }));
      const skipped = yield* service.get({ id: config.id });
      assert.equal(f.counts().launches, 0);
      assert.isNull(skipped.champion.outstandingCheckId);
      assert.isTrue(
        skipped.champion.attention[0]!.startsWith(
          "Skipped this check: cheap is not available on this machine, and the backup strong is not available on this machine.",
        ),
      );
      yield* refused(service.setup({ id: config.id }));
      assert.isNull((yield* service.get({ id: config.id })).champion.outstandingSetupId);
      // Once a model is back the same check starts as an ordinary claim and clears its own note.
      f.available(true);
      yield* service.runCheck({ id: config.id });
      const started = yield* service.get({ id: config.id });
      assert.isNotNull(started.champion.outstandingCheckId);
      assert.isTrue(
        started.champion.attention.every((line) => !line.startsWith("Skipped this check")),
      );
      assert.equal(f.counts().launches, 1);
    }),
  ),
);

it.effect(
  "retries a check once on the backup when its main model hits a usage limit, then skips it",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setModels({
          checks: { model: routineSelection, backup: setupSelection },
          advice: { model: setupSelection },
        });
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const claim = (yield* service.runCheck({ id: config.id })).champion.outstandingCheckId;
        const attempts = Effect.map(service.runtimeState({ id: config.id }), (state) =>
          state.attempts.map((a) => ({ slot: a.slot, model: a.resolvedSelection.model })),
        );
        assert.deepEqual(yield* attempts, [{ slot: "main", model: "cheap" }]);

        const resetAt = "1970-01-01T00:30:00.000Z";
        f.limitRun(resetAt);
        yield* service.runDue;
        // The same claim, once, on the backup: a send with a different model goes through.
        assert.deepEqual(
          (yield* attempts).toSorted((a, b) => String(a.slot).localeCompare(String(b.slot))),
          [
            { slot: "backup", model: "strong" },
            { slot: "main", model: "cheap" },
          ],
        );
        assert.equal((yield* service.get({ id: config.id })).champion.outstandingCheckId, claim);
        assert.deepEqual(
          f.sent.map((entry) => entry.model),
          ["strong"],
        );

        // A run already on the backup is not retried again: the check ends as skipped.
        f.limitRun(resetAt);
        yield* service.runDue;
        assert.equal(f.sent.length, 1);
        assert.equal((yield* attempts).length, 2);
        const skipped = yield* service.get({ id: config.id });
        assert.isNull(skipped.champion.outstandingCheckId);
        assert.isTrue(
          skipped.champion.attention.some((line) => line.startsWith("Skipped this check")),
        );
        const history = yield* service.history({ id: config.id });
        assert.equal(history.activity.filter((entry) => entry.kind === "check-skipped").length, 1);
        assert.equal(history.samples.length, 0);
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_checks WHERE id = ${claim}`.pipe(Effect.orDie);
        const stored = JSON.parse(row!.document_json);
        assert.isTrue(stored.cancelled);
        assert.include(stored.skipped, "Skipped this check");
        // The thread is settled so a usage-limit auto-resume leaves it alone.
        assert.include(f.dispatches, "thread.settle");

        // The next scheduled check still starts at its time.
        yield* TestClock.adjust("1 minute");
        yield* service.runDue;
        const next = yield* service.get({ id: config.id });
        assert.isNotNull(next.champion.outstandingCheckId);
        assert.notEqual(next.champion.outstandingCheckId, claim);
        assert.isTrue(next.champion.attention.every((line) => !line.startsWith("Skipped this ")));
      }),
    ),
);

const rateLimited = { errorClass: "provider_error", message: "rate limit exceeded" };

it.effect.each([
  { name: "classed usage limit", failure: undefined },
  { name: "provider error worded as a rate limit", failure: rateLimited },
])("ends a setup that hits a usage limit with no backup as skipped: $name", ({ failure }) =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* service.upsert(config);
      yield* service.setup({ id: config.id });
      const claim = (yield* service.get({ id: config.id })).champion.outstandingSetupId;
      assert.isNotNull(claim);
      f.limitRun("1970-01-02T00:00:00.000Z", failure);
      yield* service.runDue;
      const skipped = (yield* service.get({ id: config.id })).champion;
      assert.isNull(skipped.outstandingSetupId);
      assert.isTrue(skipped.attention.some((line) => line.startsWith("Skipped this setup")));
      assert.equal(f.sent.length, 0);
      assert.include(f.dispatches, "thread.settle");
    }),
  ),
);

it.effect(
  "treats a provider error worded as a rate limit as a usage limit and retries on the backup",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setModels({
          checks: { model: routineSelection, backup: setupSelection },
          advice: { model: setupSelection },
        });
        yield* service.runCheck({ id: config.id });
        // The prompt tells the agent how its own models work, not the old delegation-role wording.
        const prompt = f.launchRequests[0]!.text;
        assert.include(prompt, "Champion models checks model");
        assert.include(prompt, "backup");
        assert.include(prompt, "skipped");
        assert.notInclude(prompt, "never run it on another model");
        f.limitRun("1970-01-01T00:30:00.000Z", rateLimited);
        yield* service.runDue;
        const attempts = (yield* service.runtimeState({ id: config.id })).attempts;
        assert.deepEqual(attempts.map((a) => a.slot).toSorted(), ["backup", "main"]);
        assert.deepEqual(
          f.sent.map((entry) => entry.model),
          ["strong"],
        );
      }),
    ),
);

describe("a pooled main model", () => {
  const MODEL = "claude-opus-5-5";
  const accountOf = (id: string, window?: { resetsAt?: string }) =>
    modelProvider(id, MODEL, window);
  const pooled = (id: string) => ({ instanceId: ProviderInstanceId.make(id), model: MODEL });
  const blockUntil = (
    availability: AccountAvailability.AccountAvailability["Service"],
    account: string,
    until: string,
  ) =>
    availability.recordFailure({
      account,
      model: MODEL,
      reason: "usage-limit",
      resetAt: until,
      attemptId: `run:${account}`,
    });

  it.effect(
    "resolves to the first account not skipped for its limit and falls to the backup only when all are",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          f.setProviders([
            accountOf("A"),
            accountOf("B"),
            accountOf("C"),
            modelProvider("backup", "backup-model"),
            modelProvider("own", "own-model"),
          ]);
          yield* f.settings.updateSettings({ pooledModelKeys: [MODEL] }).pipe(Effect.orDie);
          const backup = { instanceId: ProviderInstanceId.make("backup"), model: "backup-model" };
          yield* definitions(service);
          yield* service.setModels({
            checks: { model: pooled("A"), backup },
            advice: { model: pooled("A") },
          });
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          const seen = new Set<string>();
          const check = Effect.fn("test.pooledCheck")(function* () {
            yield* TestClock.adjust("1 second");
            yield* service.runCheck({ id: config.id });
            const attempt = (yield* service.runtimeState({ id: config.id })).attempts.find(
              (a) => !seen.has(a.id),
            )!;
            seen.add(attempt.id);
            yield* service.report(f.caller(), {
              samples: [sample],
              findings: [],
              summary: "Measured",
            });
            return { slot: attempt.slot, on: attempt.resolvedSelection.instanceId as string };
          });
          const later = "1970-01-01T00:10:00.000Z";
          assert.deepEqual(yield* check(), { slot: "main", on: "A" });
          // A spent window that governs another of the account's models does not hold this one.
          const otherSpent = {
            ...accountOf("A"),
            usageLimits: {
              windows: [
                {
                  id: "go",
                  label: "Go",
                  usedPercent: 100,
                  providerIds: ["opencode-go"],
                  resetsAt: later,
                },
              ],
            },
          } as unknown as ServerProvider;
          f.setProviders([
            otherSpent,
            accountOf("B"),
            accountOf("C"),
            modelProvider("backup", "backup-model"),
            modelProvider("own", "own-model"),
          ]);
          assert.deepEqual(yield* check(), { slot: "main", on: "A" });
          f.setProviders([
            accountOf("A"),
            accountOf("B"),
            accountOf("C"),
            modelProvider("backup", "backup-model"),
            modelProvider("own", "own-model"),
          ]);
          yield* blockUntil(f.availability, "A", later);
          assert.deepEqual(yield* check(), { slot: "main", on: "B" });
          yield* blockUntil(f.availability, "B", later);
          yield* blockUntil(f.availability, "C", later);
          assert.deepEqual(yield* check(), { slot: "backup", on: "backup" });
          // A Champion's own main model replaces the default's; the default's backup still catches it.
          yield* service.upsert({
            ...config,
            models: { checks: { instanceId: ProviderInstanceId.make("own"), model: "own-model" } },
          });
          assert.deepEqual(yield* check(), { slot: "main", on: "own" });
          f.setProviders([
            accountOf("A"),
            accountOf("B"),
            accountOf("C"),
            modelProvider("backup", "backup-model"),
            modelProvider("own", "own-model", { resetsAt: "1970-01-01T00:20:00.000Z" }),
          ]);
          assert.deepEqual(yield* check(), { slot: "backup", on: "backup" });
          // Skips lift at their reset: the main model returns.
          yield* TestClock.adjust("11 minutes");
          yield* service.upsert({ ...config, models: {} });
          assert.deepEqual(yield* check(), { slot: "main", on: "A" });
        }),
      ),
  );

  it.effect(
    "waits two minutes for the server's account failover, then retries on a free account itself",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          f.setProviders([accountOf("A"), accountOf("B"), modelProvider("backup", "backup-model")]);
          yield* f.settings.updateSettings({ pooledModelKeys: [MODEL] }).pipe(Effect.orDie);
          const backup = { instanceId: ProviderInstanceId.make("backup"), model: "backup-model" };
          yield* definitions(service);
          yield* service.setModels({
            checks: { model: pooled("A"), backup },
            advice: { model: pooled("A") },
          });
          yield* service.runCheck({ id: config.id });
          const attempts = Effect.map(service.runtimeState({ id: config.id }), (state) =>
            state.attempts.map((a) => ({
              slot: a.slot,
              on: String(a.resolvedSelection.instanceId),
            })),
          );
          assert.deepEqual(yield* attempts, [{ slot: "main", on: "A" }]);
          f.limitRun("1970-01-01T00:30:00.000Z");
          // Within the grace the sweep leaves it to account failover: nothing is sent, nothing is skipped.
          yield* TestClock.adjust("1 minute");
          yield* service.runDue;
          assert.equal(f.sent.length, 0);
          assert.equal((yield* attempts).length, 1);
          assert.isTrue(
            (yield* service.get({ id: config.id })).champion.attention.every(
              (line) => !line.startsWith("Skipped this "),
            ),
          );
          // Past it, the check is retried on the free account, as a new main-slot attempt.
          yield* TestClock.adjust("2 minutes");
          yield* service.runDue;
          assert.equal(f.sent.length, 1);
          assert.deepEqual(
            (yield* attempts).filter((a) => a.on === "B"),
            [{ slot: "main", on: "B" }],
          );
          const after = (yield* service.get({ id: config.id })).champion;
          assert.isNotNull(after.outstandingCheckId);
          assert.isTrue(after.attention.every((line) => !line.startsWith("Skipped this ")));
        }),
      ),
  );
});

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
  "keeps setup separate from the routine owner and applies its change without freezing the routine check",
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
        const changed = yield* service.changeMetricsFromCheck(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "Stronger setup sets a tighter goal",
        });
        assert.isNull(changed.champion.outstandingSetupId);
        assert.equal(changed.champion.outstandingCheckId, routine.champion.outstandingCheckId);
        assert.equal(changed.metrics[0]!.maximum, 1);
        assert.equal(changed.metrics[0]!.version, 2);
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

describe("a check run that ends without a report", () => {
  it.effect("gets one pointed follow-up on the same claim before it is flagged", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const claim = (yield* service.runCheck({ id: config.id })).champion.outstandingCheckId;
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        assert.equal(f.counts().sends, 1);
        const text = f.sent[0]!.text;
        assert.include(text, `check claim ${claim}`);
        assert.include(text, "no report");
        assert.include(text, "t3_champions_check_context");
        assert.include(text, "t3_champions_report");
        const waiting = (yield* service.get({ id: config.id })).champion;
        assert.equal(waiting.outstandingCheckId, claim);
        assert.deepEqual(waiting.attention, []);
        f.completeRun(false);
        assert.equal(waiting.consecutiveCheckFailures ?? 0, 0);
        const context = yield* service.checkContext(f.caller());
        assert.equal(context.checkId, claim);
      }),
    ),
  );

  it.effect("completes normally when the follow-up reports", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        f.completeRun(false);
        yield* service.checkContext(f.caller());
        const reported = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Measured after the follow-up",
        });
        assert.isNull(reported.champion.outstandingCheckId);
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        const done = (yield* service.get({ id: config.id })).champion;
        assert.deepEqual(done.attention, []);
        assert.equal(done.consecutiveCheckFailures ?? 0, 0);
        assert.equal(f.counts().sends, 1);
      }),
    ),
  );

  it.effect("is flagged and counted as before when the follow-up also ends unreported, once", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        for (let end = 0; end < 3; end++) {
          f.completeRun(true);
          f.endRun();
          yield* service.runDue;
        }
        assert.equal(f.counts().sends, 1);
        const flagged = (yield* service.get({ id: config.id })).champion;
        assert.equal(flagged.consecutiveCheckFailures, 1);
        assert.equal(
          flagged.attention.filter((a) => a.startsWith("Check run ended without")).length,
          1,
        );
      }),
    ),
  );

  it.effect("is followed up the same way when it is a goal review", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
        const claim = (yield* service.runReview({ id: config.id })).champion.outstandingReviewId;
        assert.isString(claim);
        const before = f.sent.length;
        f.completeRun(true);
        f.endRun();
        yield* service.runDue;
        assert.equal(f.sent.length, before + 1);
        const text = f.sent.at(-1)!.text;
        assert.include(text, `review claim ${claim}`);
        assert.include(text, "t3_champions_report");
        const waiting = (yield* service.get({ id: config.id })).champion;
        assert.equal(waiting.outstandingReviewId, claim);
        assert.deepEqual(waiting.attention, []);
      }),
    ),
  );

  it.effect("is not followed up when the run ended on a usage limit", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        f.limitRun("1970-01-01T00:30:00.000Z");
        yield* service.runDue;
        assert.isFalse(f.sent.some((m) => m.text.includes("has no report")));
      }),
    ),
  );
});

/** Lets the server's one follow-up for a run that ended without a report come and go unanswered. */
const runDueThroughReprompt = Effect.fn("test.runDueThroughReprompt")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
) {
  const before = f.sent.length;
  yield* service.runDue;
  if (f.sent.length === before) return;
  f.completeRun(true);
  f.endRun();
  yield* service.runDue;
});

it.effect(
  "publishes changed definitions and reports only after committed data is visible to a real subscriber",
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
        yield* service.changeMetrics({
          id: config.id,
          metrics: [metric],
          reason: "Track these metrics",
        });
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
          findings: Array.from({ length: 10 }, (_, i) => ({
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
        for (let batch = 1; batch < 12; batch += 1) {
          yield* TestClock.adjust("1 second");
          yield* service.runCheck({ id: config.id });
          const report = yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 0 }],
            findings: Array.from({ length: 10 }, (_, i) => ({
              title: `Problem-${batch * 10 + i}`,
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
        assert.equal(old.findings?.length, 10);
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
        yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, required: false, baseline: 5, staleAfterMs: 1000 }],
          reason: "Optional goal with an explicit baseline",
        });
        assert.equal((yield* service.get({ id: config.id })).latestSamples![0]!.health, "outdated");
        yield* service.runCheck({ id: config.id });
        const optional = yield* service.report(f.caller(), {
          samples: [],
          findings: [],
          summary: "No optional observation this time",
        });
        assert.deepEqual(optional.champion.attention, []);
        assert.equal(optional.metrics[0]!.baseline, 5);
        assert.equal(optional.metrics[0]!.required, false);
        yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, maximum: null }],
          reason: "Watch without a target",
        });
        yield* service.runCheck({ id: config.id });
        const watched = yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              version: 3,
              value: 900,
              observedAt: DateTime.formatIso(yield* DateTime.now),
            },
          ],
          findings: [],
          summary: "Measured with nothing to compare against",
        });
        assert.equal(watched.latestSamples![0]!.health, "untargeted");
        assert.deepEqual(watched.findings, []);
      }),
    ),
);

it.effect(
  "completes or cancels setup without changing metrics, and a later setup changes them",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const accepted = yield* definitions(service);
        const setup = yield* service.setup({ id: config.id });
        assert.isNotNull(setup.champion.outstandingSetupId);
        const complete = yield* service.completeSetup(f.caller(), {
          summary: "Existing accepted definitions remain appropriate.",
        });
        assert.isNull(complete.champion.outstandingSetupId);
        assert.deepEqual(complete.metrics, accepted.metrics);
        yield* service.setup({ id: config.id });
        const cancelled = yield* service.cancelSetup({ id: config.id });
        assert.isNull(cancelled.champion.outstandingSetupId);
        assert.deepEqual(cancelled.metrics, accepted.metrics);
        yield* refused(
          service.changeMetricsFromCheck(f.caller(), {
            metrics: [metric],
            reason: "Old cancelled caller",
          }),
        );
        yield* service.setup({ id: config.id });
        const changed = yield* service.changeMetricsFromCheck(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "A later setup may change them again",
        });
        assert.equal(changed.metrics[0]!.maximum, 1);
        assert.equal(changed.champion.lifecycle, "paused");
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
it.effect("loads a Champion saved with delegation classes and drops them on its next save", () =>
  withFixture((_f, service) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(config);
      const [stored] = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM champions WHERE id = ${config.id}`.pipe(Effect.orDie);
      const document = JSON.parse(stored!.document_json);
      document.champion = {
        ...document.champion,
        classes: {
          setup: { role: "advisor", taskClass: "non-ui" },
          routine: { role: "implementer", taskClass: "non-ui" },
        },
        setupModelSelection: { instanceId, model: "historical-model" },
        routineModelSelection: { instanceId, model: "historical-model" },
      };
      yield* sql`UPDATE champions SET document_json = ${json(document)} WHERE id = ${config.id}`.pipe(
        Effect.orDie,
      );
      const loaded = (yield* service.get({ id: config.id })).champion;
      assert.deepEqual(
        Object.keys(loaded).filter((key) => /classes|ModelSelection/.test(key)),
        [],
      );
      assert.deepEqual(loaded.nextModels, {
        checks: { model: routineSelection, source: "default" },
        advice: { model: setupSelection, source: "default" },
      });
      yield* service.upsert({ ...config, name: "Saved again" });
      const [after] = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM champions WHERE id = ${config.id}`.pipe(Effect.orDie);
      assert.notMatch(after!.document_json, /classes|setupModelSelection|routineModelSelection/);
    }),
  ),
);

it.effect(
  "keeps the machine's models and a Champion's own overrides apart, and refuses unavailable ones",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const backup = { instanceId, model: "backup" };
        yield* refused(service.setModels({ checks: { model: routineSelection, backup } }));
        yield* refused(service.setModels({ checks: { model: { instanceId, model: "missing" } } }));
        assert.deepEqual(yield* service.modelDefaults, {
          checks: { model: routineSelection },
          advice: { model: setupSelection },
        });
        const saved = yield* service.setModels({
          checks: { model: routineSelection, backup: setupSelection },
          advice: { model: setupSelection },
        });
        assert.deepEqual(yield* service.modelDefaults, saved);
        assert.deepEqual(
          ((yield* service.list({})) as { modelDefaults?: unknown }).modelDefaults,
          saved,
        );

        yield* refused(
          service.upsert({ ...config, models: { checks: { instanceId, model: "missing" } } }),
        );
        const own = yield* service.upsert({ ...config, models: { checks: setupSelection } });
        assert.deepEqual(own.champion.models, { checks: setupSelection });
        // The override replaces the main model only: the default's backup still applies.
        const nextOwn = (yield* service.get({ id: config.id })).champion.nextModels;
        assert.deepEqual(nextOwn, {
          checks: { model: setupSelection, backup: setupSelection, source: "champion" },
          advice: { model: setupSelection, source: "default" },
        });
        assert.deepEqual(
          (yield* service.list({})).champions[0]!.nextModels?.checks?.source,
          "champion",
        );
        // Leaving the field out keeps the override; an empty object (or one with neither key) clears it.
        const kept = yield* service.upsert(config);
        assert.deepEqual(kept.champion.models, { checks: setupSelection });
        assert.equal(
          (yield* service.get({ id: config.id })).champion.nextModels?.checks?.source,
          "champion",
        );
        const cleared = yield* service.upsert({ ...config, models: {} });
        assert.isUndefined(cleared.champion.models);
        assert.equal(
          (yield* service.get({ id: config.id })).champion.nextModels?.checks?.source,
          "default",
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
      const advice = { instanceId: codex.instanceId, model: "gpt-astra-test" };
      yield* service.setModels({
        checks: { model: { instanceId: codex.instanceId, model: codexModel } },
        advice: { model: advice },
      });
      yield* service.upsert(config);
      const [lead] = yield* managed.ranked({
        role: "lead",
        projectId,
        providers: [codex],
        ceiling: "full-access",
        request: { taskClass: "non-ui", runtimeMode: "full-access" },
      });
      assert.isDefined(lead);
      const { threadId } = yield* service.startMetricsLead({ id: config.id });
      assert.equal(f.counts().launches, 1);
      assert.equal(f.launchRequests[0]!.model, lead.model);
      const history = yield* service.history({ id: config.id });
      const started = history.activity.find((entry) => entry.kind === "metrics-lead");
      assert.equal(started?.threadId, threadId);
      // The brief is the server's words under a reserved id, so the lead can never quote it.
      assert.match(f.launchRequests[0]!.messageId, /^champion-metrics-lead:/);
      yield* service.changeMetrics(
        { id: config.id, metrics: [metric], reason: "Lead's fix" },
        threadId,
      );

      // Agents start a lead with t3_thread_launch now, so the launch goes through the
      // same service method the page's button uses.
      yield* service.startMetricsLead({ id: config.id });
      assert.equal(f.counts().launches, 2);
      assert.equal(f.launchRequests[1]!.model, lead.model);
      assert.equal(
        (yield* service.history({ id: config.id })).activity.filter(
          (entry) => entry.kind === "metrics-lead",
        ).length,
        2,
      );

      // A case runs on the lead role's model, the strong interactive one, never the checks model.
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      yield* service.runCheck({ id: config.id });
      yield* service.report(f.caller(), {
        samples: [{ ...sample, value: 1 }],
        findings: [{ title: "Slow saves", evidence: "Saves take five seconds." }],
        summary: "A slow path",
      });
      assert.deepEqual(
        f.escalationLaunches.map(({ model, started }) => ({ model, started })),
        [{ model: lead.model, started: false }],
      );
      const launched = f.counts().launches;

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
      assert.equal(f.counts().launches, launched);
    }).pipe(
      Effect.provide(f.layer),
      Effect.provideService(Managed.ManagedAgentService, managed),
      Effect.provideService(HostProcess.Environment, { T3CODE_AGENT_POLICY_ROOT: root }),
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
        yield* service.report(f.caller(), {
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
        assert.deepEqual(empty.revisions, []);
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
        assert.isTrue([...page.revisions, ...next.revisions].some((r) => r.id === first.id));
      }),
    ),
);

it.effect(
  "records human learning activity atomically and once and expands its exact historical revision",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
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
        const dueOnly = yield* service.learningQuery({
          id: config.id,
          topic: input.topic,
          due: true,
          observations: [],
        });
        assert.deepEqual(dueOnly.revisions, []);
        assert.isFalse(dueOnly.admissibleForInvestigation);
        const current = yield* service.learningQuery({
          id: config.id,
          topic: input.topic,
          observations: [],
        });
        assert.isTrue(current.admissibleForInvestigation);
        assert.deepEqual(
          current.revisions.map((revision) => revision.id),
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

const agentThread = ThreadId.make("thread:performance-pass");

it.effect("takes an approval quote only from words a person typed in the calling thread", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* service.upsert(config);
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

      yield* refusedWith(service.verifyApproval(relay(undefined)), "needs the user's approval");
      for (const quote of [
        "Accept every metric now.",
        "Approve the metrics.",
        "Accept them all.",
        "do all of th",
      ])
        yield* refusedWith(service.verifyApproval(relay(quote)), "not word for word");
      yield* refusedWith(
        service.verifyApproval({ threadId: undefined, quote: "Can you" }),
        "only from a thread the user typed in",
      );

      const proof = yield* service.verifyApproval(
        relay("can   you do all of that for me?".replace("can", "Can")),
      );
      assert.deepEqual(
        { quote: proof.quote, threadId: proof.threadId, threadTitle: proof.threadTitle },
        {
          quote: "Can   you do all of that for me?",
          threadId: agentThread,
          threadTitle: "Performance pass",
        },
      );
      assert.equal(proof.model, "agent-model");
    }),
  ),
);

/** An active Champion whose readings run raised a qualitative finding, which opened its idle case. */
const caseFinding = Effect.fn("test.championCaseFinding")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
) {
  yield* definitions(service);
  yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  yield* service.runCheck({ id: config.id });
  const report = yield* service.report(f.caller(), {
    samples: [{ ...sample, value: 1 }],
    findings: [{ title: "Database backlog", evidence: "Jobs wait an hour." }],
    summary: "A backlog",
  });
  const finding = report.findings.find((candidate) => candidate.metricId === null)!;
  assert.isString(finding.escalationThreadId);
  return finding;
});
/** A decision requested before cases replaced decision requests, as an upgrade leaves it. */
const pendingDecision = Effect.fn("test.championPendingDecision")(function* (
  findingId: string,
  question = "Ship it?",
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    document_json: string;
  }>`SELECT document_json FROM champions WHERE id = ${config.id}`.pipe(Effect.orDie);
  const doc = JSON.parse(row!.document_json);
  const decision = {
    id: `decision:${findingId}`,
    question,
    status: "requested",
    answer: null,
    requestedAt: DateTime.formatIso(yield* DateTime.now),
    resolvedAt: null,
  };
  doc.findings = doc.findings.map((finding: { id: string }) =>
    finding.id === findingId ? { ...finding, decision } : finding,
  );
  yield* sql`UPDATE champions SET document_json = ${JSON.stringify(doc)} WHERE id = ${config.id}`.pipe(
    Effect.orDie,
  );
  return decision.id;
});

it.effect("records a source-verified approval relayed from another machine on the decision", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const finding = yield* caseFinding(f, service);
      const decisionId = yield* pendingDecision(finding.id);
      f.installAgentThread(agentThread, "Source thread");
      yield* TestClock.adjust("1 minute");
      f.addMessage(agentThread, "Yes, go ahead.", { createdAt: DateTime.makeUnsafe(60_000) });
      const proof = yield* service.verifyApproval({
        threadId: agentThread,
        quote: "Yes, go ahead.",
      });
      assert.isString(proof.messageId);
      const resolved = yield* service.findingAction(
        {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision",
          decisionId,
          reason: "Ship it.",
        },
        {
          threadId: proof.threadId,
          quote: proof.quote,
          forwarded: {
            ...proof,
            sourceEnvironment: { id: EnvironmentId.make("source-machine"), label: "Mac" },
          },
        },
      );
      assert.deepEqual(
        resolved.findings.find((x) => x.id === finding.id)!.decision!.approval!.sourceEnvironment,
        { id: "source-machine", label: "Mac" },
      );
    }),
  ),
);

it.effect(
  "resolves a pending decision on its card and delivers the answer to the finding's case once, unarchiving it",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* caseFinding(f, service);
        const caseThread = finding.escalationThreadId!;
        const decisionId = yield* pendingDecision(finding.id);
        f.updateCase(caseThread, { archivedAt: DateTime.makeUnsafe(0) } as never);
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId,
          reason: "Yes, ship it.",
        };
        // The card: a person answering needs no quote.
        yield* service.findingAction(answer);
        yield* service.findingAction(answer);
        const deliveries = f.sent.filter((x) => x.commandId === `champion-decision:${decisionId}`);
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0]!.threadId, caseThread);
        assert.include(deliveries[0]!.text, "Yes, ship it.");
        assert.isTrue(
          f.commands.some(
            (command) => command.type === "thread.unarchive" && command.threadId === caseThread,
          ),
        );
        assert.equal(
          (yield* service.get({ id: config.id })).findings.find((x) => x.id === finding.id)!
            .decision!.status,
          "resolved",
        );
      }),
    ),
);

it.effect("drops an answer whose case was deleted, with an activity line", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const finding = yield* caseFinding(f, service);
      const decisionId = yield* pendingDecision(finding.id);
      f.updateCase(finding.escalationThreadId!, { deletedAt: DateTime.makeUnsafe(0) } as never);
      yield* service.findingAction({
        id: config.id,
        findingId: finding.id,
        action: "resolve_decision",
        decisionId,
        reason: "Yes.",
      });
      assert.isFalse(f.sent.some((x) => x.commandId === `champion-decision:${decisionId}`));
      const dropped = (yield* service.history({ id: config.id })).activity.find(
        (entry) => entry.kind === "decision-answer-dropped",
      );
      assert.include(dropped?.text ?? "", "Yes.");
    }),
  ),
);

it.effect(
  "lets an agent answer a decision with the person's words and tells the case once that it was relayed",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* caseFinding(f, service);
        const decisionId = yield* pendingDecision(
          finding.id,
          "Should this target include weekends?",
        );
        f.installAgentThread(agentThread, "Performance pass");
        yield* TestClock.adjust("1 minute");
        f.addMessage(agentThread, "Yes, include weekends please.", {
          createdAt: DateTime.makeUnsafe(60_000),
        });
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId,
          reason: "Include weekends.",
        };
        yield* refusedWith(
          service.findingAction(answer, { threadId: agentThread, quote: undefined }),
          "The decision waits for them on its card",
        );
        const relay = { threadId: agentThread, quote: "include weekends" };
        const resolved = yield* service.findingAction(answer, relay);
        const approval = resolved.findings.find((x) => x.id === finding.id)!.decision!.approval!;
        assert.equal(approval.quote, "include weekends");
        assert.equal(approval.threadId, agentThread);
        assert.equal(approval.model, "agent-model");
        yield* service.findingAction(answer, relay);
        // An answer already on record needs no fresh approval.
        yield* service.findingAction(answer, unquotedAgent);
        yield* refusedWith(
          service.findingAction({ ...answer, reason: "Exclude weekends." }, unquotedAgent),
          "already answered differently",
        );
        const sends = f.sent.filter((x) => x.commandId === `champion-decision:${decisionId}`);
        assert.equal(sends.length, 1);
        assert.include(sends[0]!.text, `relayed by an agent in thread ${agentThread}`);
        assert.include(sends[0]!.text, '"include weekends"');
      }),
    ),
);

it.effect(
  "lets a case, the owner conversation and the person settle a finding, but not a readings run",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* caseFinding(f, service);
        const caseThread = finding.escalationThreadId!;
        const owner = f.caller().threadId;
        const act = (action: "verify" | "reopen" | "dismiss", by?: ThreadId) =>
          service.findingAction(
            { id: config.id, findingId: finding.id, action, reason: `${action} it` },
            "user",
            by,
          );
        // The case agent is an ordinary thread in the project: its Champion tools work there.
        assert.isTrue(yield* service.hasThreadContext(caseThread));
        const verified = yield* act("verify", caseThread);
        assert.equal(verified.findings.find((x) => x.id === finding.id)!.status, "verified");
        assert.isTrue(
          f.commands.some(
            (command) => command.type === "thread.settle" && command.threadId === caseThread,
          ),
        );
        // Between runs the owner thread is a conversation with the person.
        const reopened = yield* act("reopen", owner);
        assert.equal(reopened.findings.find((x) => x.id === finding.id)!.status, "open");

        yield* service.runCheck({ id: config.id });
        yield* refusedWith(act("dismiss", owner), "only observe and score");
        assert.equal(
          (yield* service.get({ id: config.id })).findings.find((x) => x.id === finding.id)!.status,
          "open",
        );
        yield* act("dismiss", caseThread);
        yield* act("reopen", caseThread);
        const dismissed = yield* act("dismiss");
        assert.equal(dismissed.findings.find((x) => x.id === finding.id)!.status, "dismissed");
      }),
    ),
);

it.effect("lets a readings run change its metrics at once and still report", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* caseFinding(f, service);
      yield* service.runCheck({ id: config.id });
      const changed = yield* service.changeMetricsFromCheck(f.caller(), {
        metrics: [{ ...metric, name: "Errors people see" }],
        reason: "Clearer name",
      });
      assert.equal(changed.metrics[0]!.name, "Errors people see");
      assert.isNotNull(changed.champion.outstandingCheckId);
      const reported = yield* service.report(f.caller(), {
        samples: [sample],
        findings: [],
        summary: "Measured",
      });
      assert.isNull(reported.champion.outstandingCheckId);
      const entry = (yield* service.history({ id: config.id })).activity.find((event) =>
        event.text.endsWith("Clearer name"),
      );
      assert.equal(entry?.text, "Changed Errors people see. Clearer name");
      assert.equal(entry?.threadId, f.caller().threadId);
    }),
  ),
);

it.effect("marks the messages the server writes so they can never be quoted as the person's", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const finding = yield* caseFinding(f, service);
      const decisionId = yield* pendingDecision(finding.id);
      yield* service.findingAction({
        id: config.id,
        findingId: finding.id,
        action: "resolve_decision",
        decisionId,
        reason: "Yes, ship it.",
      });
      const delivery = f.sent.find((x) => x.commandId === `champion-decision:${decisionId}`)!;
      f.installAgentThread(agentThread, "Fix metrics: Quality");
      f.addMessage(agentThread, delivery.text, {
        id: MessageId.make(delivery.messageId),
        creationSource: "web",
      });
      f.addMessage(agentThread, "Accept the proposal.", {
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* refusedWith(
        service.verifyApproval({ threadId: agentThread, quote: "Yes, ship it." }),
        "not word for word",
      );
      yield* refusedWith(
        service.verifyApproval({ threadId: agentThread, quote: "Accept the proposal." }),
        "not word for word",
      );
    }),
  ),
);

it.effect(
  "refuses every repair delegation from a check or review thread, naming the case flow",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* caseFinding(f, service);
        yield* service.runReview({ id: config.id });
        const ownerThreadId = f.caller().threadId;
        for (const role of ["advisor", "implementer", "reviewer", "lead", "scout"] as const)
          yield* refusedWith(
            service.guardDelegation({
              ownerThreadId,
              request: {
                role,
                taskClass: "non-ui",
                workId: finding.id,
                attemptId: "1",
                workspacePath: "/project/root",
                ...(role === "implementer" ? {} : { readOnly: true }),
              },
              clientRequestId: role,
            }),
            "opens a case for it in Henry's Inbox",
          );
        yield* refusedWith(
          service.admitDelegation({
            ownerThreadId,
            parentRunId: RunId.make("run:check"),
            binding: {
              role: "advisor",
              taskClass: "non-ui",
              workId: finding.id,
              attemptId: "1",
              workspacePath: "/project/root",
              readOnly: true,
              sourceAccess: "read-only",
              executionBoundary: "read-only",
            } as unknown as AgentTaskBinding,
            projectId,
            workspacePath: "/project/root",
            selection: setupSelection,
            commandId: CommandId.make("command:advisor"),
            taskId: NodeId.make("task:advisor"),
            childThreadId: ThreadId.make("child:advisor"),
            messageId: MessageId.make("message:advisor"),
            clientRequestId: "advisor-admit",
            followup: false,
          }),
          "opens a case for it in Henry's Inbox",
        );
        // An ordinary thread is not a Champion's: nothing is guarded there.
        f.installAgentThread(agentThread, "Case work");
        assert.isUndefined(
          yield* service.guardDelegation({
            ownerThreadId: agentThread,
            request: {
              role: "implementer",
              taskClass: "non-ui",
              workId: finding.id,
              attemptId: "1",
              workspacePath: "/isolated",
            },
            clientRequestId: "case-implementer",
          }),
        );
      }),
    ),
);

const screenAndToolOutcome = (viaTool: boolean) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    return yield* Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      yield* service.setModels(defaultModels);
      yield* caseFinding(f, service);
      const steps = [
        ["t3_champions_control", { id: config.id, action: "pause" }],
        ["t3_champions_control", { id: config.id, action: "resume" }],
        ["t3_champions_control", { id: config.id, action: "run_check" }],
      ] as const;
      for (const [tool, input] of steps) {
        if (viaTool) assert.isFalse((yield* f.callTool(service, tool, input)).at(-1)!.isFailure);
        else if (input.action === "run_check") yield* service.runCheck({ id: input.id });
        else
          yield* service.setLifecycle({
            id: input.id,
            lifecycle: input.action === "pause" ? "paused" : "active",
          });
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

it.effect("refuses an approval typed before its decision was requested", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const finding = yield* caseFinding(f, service);
      f.installAgentThread(agentThread, "Performance pass");
      f.addMessage(agentThread, "Yes, go ahead.");
      yield* TestClock.adjust("1 minute");
      const decisionId = yield* pendingDecision(finding.id);
      const answer = {
        id: config.id,
        findingId: finding.id,
        action: "resolve_decision" as const,
        decisionId,
        reason: "Ship it.",
      };
      const relay = { threadId: agentThread, quote: "Yes, go ahead." };
      yield* refusedWith(service.findingAction(answer, relay), "before this request was filed");
      f.addMessage(agentThread, "Yes, go ahead.", { createdAt: DateTime.makeUnsafe(120_000) });
      yield* service.findingAction(answer, relay);
    }),
  ),
);

describe("a journey check", () => {
  const journeysConfig = (
    directory: string,
    overrides: Partial<NonNullable<ChampionConfig["journeys"]>> = {},
  ): ChampionConfig => ({
    ...config,
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
    yield* service.changeMetrics({ id: config.id, metrics: [metric], reason: "Measure errors" });
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

  it.effect("falls back to passwordless sudo docker when plain docker hits permission denied", () =>
    withFixture((f, service) =>
      withTarget([manifest("dddddddd", "commit-sudo")], (directory) =>
        Effect.gen(function* () {
          const realDocker = NodeFS.readFileSync(NodePath.join(directory, "docker"), "utf8");
          NodeFS.writeFileSync(NodePath.join(directory, "docker-real"), realDocker, {
            mode: 0o755,
          });
          NodeFS.writeFileSync(
            NodePath.join(directory, "docker"),
            `#!/bin/sh\necho "permission denied while trying to connect to the Docker daemon socket" >&2\nexit 1\n`,
            { mode: 0o755 },
          );
          NodeFS.writeFileSync(
            NodePath.join(directory, "sudo"),
            `#!/bin/sh\nif [ "$1" = "-n" ] && [ "$2" = "docker" ]; then shift 2; exec "${directory}/docker-real" "$@"; fi\nexit 1\n`,
            { mode: 0o755 },
          );
          yield* activate(service, journeysConfig(directory));
          yield* service.runCheck({ id: config.id });
          const plan = yield* service.journeysStart(f.caller());
          assert.equal(plan.journeyLimit, 8);
        }),
      ),
    ),
  );

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
    "rejects a reproducing candidate its replay puts down to a declared missing service",
    () =>
      withFixture((f, service) =>
        withTarget(
          [
            manifest("aaaaaaaa", "commit-1", {
              missingServices: [{ name: "optimiser", what: "plan generation cannot run" }],
              shards: [
                {
                  id: "s1",
                  origin: "http://localhost:1",
                  signInPath: "/dev/agent-login?as=admin&next=/",
                  database: "scratch_0123abcd",
                  container: "shard",
                  locale: "pt-BR",
                  workPaths: ["/board"],
                },
              ],
            }),
            manifest("bbbbbbbb", "commit-1"),
          ],
          (directory) =>
            Effect.gen(function* () {
              yield* activate(service, journeysConfig(directory));
              yield* service.runCheck({ id: config.id });
              const plan = yield* service.journeysStart(f.caller());
              assert.deepEqual(plan.missingServices, [
                { name: "optimiser", what: "plan generation cannot run" },
              ]);
              assert.equal(plan.shards[0]?.locale, "pt-BR");
              assert.deepEqual(plan.shards[0]?.workPaths, ["/board"]);
              const policy = yield* JourneyBrowserPolicy.JourneyBrowserPolicy;
              const owner = f.caller().threadId;
              const grant = (yield* policy.forThread(owner))!;
              const admitted = yield* policy.admitTask({ grant, tabId: "tab-one" });
              assert.equal(admitted._tag, "admitted");
              yield* policy.recordTask({
                grant,
                tabId: "tab-one",
                goal: "Generate a plan",
                startedAt: "2026-11-08T00:00:00.000Z",
                endedAt: "2026-11-08T00:00:01.000Z",
                result: {
                  status: "failed",
                  decisions: 2,
                  usage: { usd: 0.01, unreportedCalls: 0 },
                  evidence: { url: `http://localhost:${shardPort}/board` },
                  viewport: { width: 390, height: 844 },
                } as unknown as PreviewTaskResult,
                steps: [
                  {
                    id: "move",
                    kind: "action",
                    operation: "drag",
                    target: { role: "button", name: "Job 1" },
                    from: { role: "button", name: "Job 1" },
                    to: { role: "region", name: "Done" },
                    description: null,
                    option: null,
                    value: null,
                    url: `http://localhost:${shardPort}/board`,
                    state: "completed",
                    at: "2026-11-08T00:00:00.500Z" as never,
                    ms: 40,
                  },
                ],
              });
              yield* policy.recordTask({
                grant,
                tabId: "tab-one",
                goal: null,
                startedAt: "2026-11-08T00:00:01.000Z",
                endedAt: "2026-11-08T00:00:02.000Z",
                result: {
                  status: "passed",
                  decisions: 1,
                  usage: { usd: 0.01, unreportedCalls: 0 },
                  evidence: { url: `http://localhost:${shardPort}/board` },
                } as unknown as PreviewTaskResult,
                steps: [],
              });
              const candidate = yield* service.journeyCandidate(f.caller(), {
                tabId: "tab-one",
                title: "Plan generation fails",
                expected: "It produces a candidate",
                observed: "It errors",
              });
              const replay = yield* service.candidateReplay(f.caller(), {
                candidateId: candidate.candidateId,
              });
              assert.include(replay.brief, "390x844");
              assert.include(replay.brief, "pt-BR");
              assert.include(replay.brief, "optimiser");
              assert.include(
                replay.brief,
                'drag the button named "Job 1" to the region named "Done"',
              );
              f.installReplay(
                replay.workId,
                replay.attemptId,
                `${verdict("reproduced", "Generate plan can't finish.")}\nMISSING: optimiser`,
                "strong",
              );
              const settled = yield* service.candidateSettle(f.caller(), {
                candidateId: candidate.candidateId,
              });
              assert.equal(settled.status, "rejected");
              assert.include(settled.reason, "optimiser");
              assert.equal((yield* service.get({ id: config.id })).findings.length, 0);
              assert.equal((yield* service.get({ id: config.id })).champion.openFindingCount, 0);
              yield* service.report(f.caller(), {
                samples: [quietSample],
                findings: [],
                summary: "One journey, one missing-service rejection.",
                journeys: { started: 1, passed: 0, failed: 1, stopped: 0 },
              });
              const { record } = yield* service.journeyRecord({ checkId: plan.checkId });
              assert.equal(record.candidates.rejected, 1);
              assert.include(record.candidates.rejectionReasons.join(" "), "optimiser");
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

  it.effect("starts a new check rather than blending a retry into a finished record", () =>
    withFixture((f, service) =>
      withTarget(
        [manifest("aaaaaaaa", "commit-1"), manifest("bbbbbbbb", "commit-1")],
        (directory) =>
          Effect.gen(function* () {
            yield* activate(service, journeysConfig(directory));
            yield* service.runCheck({ id: config.id });
            const first = yield* service.journeysStart(f.caller());
            f.endRun();
            yield* TestClock.adjust("6 minutes");
            yield* service.runDue;
            f.wakeOwner();
            f.endRun();
            yield* service.runCheck({ id: config.id });
            const second = yield* service.journeysStart(f.caller());
            assert.notEqual(second.checkId, first.checkId);
          }),
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
          yield* runDueThroughReprompt(f, service);
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

  it.effect(
    "confirms on the first browser model the check does not use itself, else its own",
    () => {
      const ranked: Array<{ instanceId: typeof instanceId; model: string }> = [];
      const managed = {
        ranked: () => Effect.succeed(ranked),
      } as unknown as Managed.ManagedAgentService["Service"];
      return withFixture((f, service) =>
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
              const guard = service.guardDelegation({
                ownerThreadId: owner,
                clientRequestId: "replay",
                task: replay.brief,
                request: {
                  role: "browser",
                  taskClass: "non-ui",
                  workId: replay.workId,
                  attemptId: replay.attemptId,
                  workspacePath: "/repo",
                  readOnly: true,
                },
              });
              yield* refusedWith(guard, "No model on the browser list");
              // In delegation order: the check's own model, then Jev and Luna. With nothing else
              // able to run, the replay runs on the first of them and settles as not independent.
              ranked.push(
                { instanceId, model: routineSelection.model },
                { instanceId, model: decisionEngines.jev.model },
                { instanceId, model: decisionEngines.luna.model },
              );
              assert.deepEqual(yield* guard, {
                instanceId,
                model: routineSelection.model,
              });
              ranked.push({ instanceId, model: "confirmer" }, { instanceId, model: "later" });
              assert.deepEqual(yield* guard, { instanceId, model: "confirmer" });
            }).pipe(withPolicy),
        ),
      ).pipe(Effect.provideService(Managed.ManagedAgentService, managed));
    },
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

  it.effect("records a verdict from the check's own model as not independent", () =>
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
              routineSelection.model,
            );
            const settled = yield* service.candidateSettle(f.caller(), { candidateId });
            assert.equal(settled.status, "confirmed");
            const [finding] = (yield* service.get({ id: config.id })).findings;
            assert.include(finding?.evidence, "not independently");
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
                `${verdict("reproduced", "Seen.")}\nSTEPS: Typed "draft 55", left and came back.`,
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
              assert.include(
                finding.evidence,
                'Steps the replay followed: Typed "draft 55", left and came back.',
              );

              // A confirmed bug is a finding that needs work, so it opens its case; the re-test settles it.
              assert.isString(finding.escalationThreadId);

              f.endRun();
              yield* service.runCheck({ id: config.id });
              const second = yield* service.journeysStart(f.caller());
              assert.deepEqual(second.retests, [{ findingId: finding.id, title: "Broken" }]);
              assert.deepEqual(second.covered[0]?.urls, ["/tasks"]);
              yield* walk(policy, owner, "tab-two", "/books");
              const retest = yield* service.candidateReplay(f.caller(), { findingId: finding.id });
              assert.deepEqual(
                yield* service.candidateReplay(f.caller(), { findingId: finding.id }),
                retest,
              );
              assert.include(
                retest.brief,
                'could not run, which does not show the confirmed bug is fixed: say "blocked"',
              );
              assert.include(
                retest.brief,
                'The replay that confirmed this bug did: Typed "draft 55", left and came back.',
              );
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
          assert.include(text, "OBSERVE ONLY");
          assert.notInclude(text, "Own bounded improvements");
          assert.notInclude(text, "Bounded repair");
        }),
      ),
    ),
  );
});

describe("owner measurement on a live check", () => {
  const revision = "a".repeat(40);
  const otherRevision = "b".repeat(40);
  const coverage: ChampionMetricInput = { ...metric, id: "coverage", name: "Coverage" };
  const makeWorld = Effect.fn("test.championMeasurementWorld")(function* (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
  ) {
    f.realProjectRoot();
    yield* accepted(service, [collectedMetric(node("console.log(1)"), "collected"), coverage]);
    yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
    yield* service.runCheck({ id: config.id });
    const context = yield* service.checkContext(f.caller());
    const checkId = context.checkId;
    const ownerThreadId = f.caller().threadId;
    const sql = yield* SqlClient.SqlClient;
    const start = (over: Partial<Parameters<typeof service.startMeasurementFromOwner>[1]> = {}) =>
      service.startMeasurementFromOwner(f.caller(), {
        id: config.id,
        checkId,
        measurementId: "browser-1",
        role: "browser",
        sourceRevision: revision,
        metrics: [{ metricId: "coverage", version: 1 }],
        observedRuntime: "combined preview 1c0947",
        ...over,
      });
    const requestOf = (m: ChampionMeasurement) => ({
      role: m.role,
      taskClass: "ui" as const,
      workId: m.workId,
      attemptId: m.attemptId,
      workspacePath: "/project/root",
      readOnly: true,
      sourceRevision: m.sourceRevision,
    });
    const proofOf = (
      m: ChampionMeasurement,
      requestId: string,
      selection: ModelSelection,
      over: Record<string, unknown> = {},
    ) => {
      const binding = decodeBinding({
        ...requestOf(m),
        executionBoundary: "read-only",
        executionRequirement: "sandbox-required",
        sourceAccess: "read-only",
        toolProfile: m.role === "browser" ? "phi" : "source-reader",
        requestFingerprint: "c".repeat(64),
        policyHash: "a".repeat(64),
        policyRevision: "policy-one",
        briefHash: "b".repeat(64),
        requested: selection,
        assigned: null,
        effective: selection,
        ...over,
      });
      return {
        ownerThreadId,
        parentRunId: RunId.make("run:check"),
        binding,
        projectId,
        workspacePath: binding.workspacePath,
        selection,
        commandId: CommandId.make(`command:${requestId}`),
        taskId: NodeId.make(`task:${requestId}`),
        childThreadId: ThreadId.make(`child:${requestId}`),
        messageId: MessageId.make(`message:${requestId}`),
        clientRequestId: requestId,
        followup: false,
      };
    };
    /** What the managed delegate_task path does, in order: guard, final admission, started. */
    const launch = Effect.fn("test.launchMeasurement")(function* (
      m: ChampionMeasurement,
      requestId: string,
    ) {
      const guarded = yield* service.guardDelegation({
        ownerThreadId,
        request: requestOf(m),
        clientRequestId: requestId,
      });
      const proof = proofOf(m, requestId, guarded!);
      yield* service.admitDelegation(proof);
      yield* service.delegationOutcome({
        ownerThreadId,
        request: requestOf(m),
        clientRequestId: requestId,
        state: "started",
        commandId: proof.commandId,
      });
      return { selection: guarded!, proof };
    });
    const measurements = () =>
      service.runtimeState({ id: config.id }).pipe(Effect.map((state) => state.measurements!));
    const settle = Effect.fn("test.settleMeasurement")(function* (
      id: string,
      status: "running" | "completed" | "failed" | "cancelled" = "completed",
    ) {
      const current = (yield* measurements()).find((m) => m.measurementId === id)!;
      f.installMeasurement(current, status);
      yield* service.runDue;
      return (yield* measurements()).find((m) => m.measurementId === id)!;
    });
    const count = (table: string) =>
      sql.unsafe<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
        Effect.orDie,
        Effect.map((rows) => rows[0]!.n),
      );
    return {
      f,
      service,
      sql,
      checkId,
      ownerThreadId,
      start,
      requestOf,
      proofOf,
      launch,
      measurements,
      settle,
      count,
    };
  });
  type World = Effect.Success<ReturnType<typeof makeWorld>>;
  const withWorld = (
    body: (world: World) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
    eligible = new Set(["cheap", "strong"]),
  ) => {
    const managed = {
      ranked: () => Effect.succeed(eligible.has("cheap") ? [{ instanceId, model: "cheap" }] : []),
      roles: (input: {
        readonly request: { readonly role?: string };
        readonly selection?: { readonly model?: string };
      }) =>
        Effect.sync(() => {
          const model = input.selection?.model ?? "cheap";
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
    return Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const service = yield* Champions.ChampionService;
        yield* service.setModels(defaultModels);
        yield* body(yield* makeWorld(f, service));
      }).pipe(Effect.provide(f.layer), Effect.provideService(Managed.ManagedAgentService, managed));
    }).pipe(Effect.provide(Sqlite.layerMemory));
  };

  it.effect(
    "admits a source-pinned browser audit and an independent reviewer on a live check with no finding",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const doc = yield* w.service.get({ id: config.id });
          assert.equal(doc.findings.length, 0);
          const browser = yield* w.start();
          assert.equal(browser.state, "planned");
          assert.equal(browser.workId, "champion-measurement:browser-1");
          assert.equal(browser.sourceRevision, revision);
          assert.equal(browser.observedRuntime, "combined preview 1c0947");
          // A reviewer confirms a completed browser audit, not a planned one.
          yield* refusedWith(
            w.start({
              measurementId: "review-1",
              role: "reviewer",
              browserMeasurementId: "browser-1",
            }),
            "has not completed",
          );
          const first = yield* w.launch(browser, "launch-browser");
          assert.equal(first.selection.model, "cheap");
          // Until the launch is confirmed it holds capacity as unknown, as an investigation branch does.
          assert.equal((yield* w.measurements())[0]!.state, "unknown");
          yield* w.settle("browser-1");
          const review = yield* w.start({
            measurementId: "review-1",
            role: "reviewer",
            browserMeasurementId: "browser-1",
          });
          const reviewer = yield* w.launch(review, "launch-review");
          // Role policy offered cheap first; the reviewer skips the browser audit's model.
          assert.equal(reviewer.selection.model, "strong");
          const states = yield* w.measurements();
          const stored = states.find((m) => m.measurementId === "browser-1")!;
          assert.equal(stored.admission!.binding.sourceAccess, "read-only");
          assert.equal(stored.admission!.binding.executionBoundary, "read-only");
          assert.equal(stored.admission!.actualSelection?.model, "cheap");
          assert.equal(stored.admission!.result, "Observed rendered evidence");
          assert.equal(stored.checkId, w.checkId);
          assert.equal(
            states.find((m) => m.measurementId === "review-1")!.admission!.resolvedSelection.model,
            "strong",
          );
          // Evidence of a measurement is never a finding.
          assert.equal((yield* w.service.get({ id: config.id })).findings.length, 0);
        }),
      ),
  );

  it.effect(
    "refuses measurements whose check, metrics, source, role or reviewer reference are not exact",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          yield* refusedWith(w.start({ checkId: "another-check" }), "current check");
          yield* refusedWith(
            w.start({ metrics: [{ metricId: "coverage", version: 2 }] }),
            "not a distinct frozen metric",
          );
          yield* refusedWith(
            w.start({
              metrics: [
                { metricId: "coverage", version: 1 },
                { metricId: "coverage", version: 1 },
              ],
            }),
            "not a distinct frozen metric",
          );
          yield* refusedWith(
            w.start({ metrics: [{ metricId: "collected", version: 1 }] }),
            "by command",
          );
          yield* refusedWith(w.start({ browserMeasurementId: "x" }), "Only a reviewer");
          yield* refusedWith(
            w.start({ role: "reviewer", measurementId: "review-0" }),
            "names the completed browser audit",
          );
          yield* refusedWith(
            w.start({ role: "reviewer", measurementId: "review-0", browserMeasurementId: "ghost" }),
            "does not exist",
          );
          const browser = yield* w.start();
          // The same id with other content is a conflict; the same content replays.
          assert.deepEqual(yield* w.start(), browser);
          yield* refusedWith(w.start({ sourceRevision: otherRevision }), "different measurement");
          yield* w.launch(browser, "launch-browser");
          yield* w.settle("browser-1");
          yield* refusedWith(
            w.start({
              measurementId: "review-other-source",
              role: "reviewer",
              browserMeasurementId: "browser-1",
              sourceRevision: otherRevision,
            }),
            "exactly the same full source revision",
          );
          // Guard: the request must be the plan's role, attempt, source and read-only.
          const planned = yield* w.start({ measurementId: "browser-2" });
          const request = w.requestOf(planned);
          const ask = (over: Record<string, unknown>, id = "guard") =>
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request: { ...request, ...over } as typeof request,
              clientRequestId: id,
            });
          yield* refusedWith(ask({ readOnly: false }), "read-only");
          yield* refusedWith(ask({ sourceRevision: otherRevision }), "read-only");
          yield* refusedWith(ask({ sourceRevision: "abc123" }), "read-only");
          yield* refusedWith(ask({ role: "implementer" }), "is a browser task");
          yield* refusedWith(ask({ attemptId: "browser-2:2" }), "attemptId");
          yield* refusedWith(
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request: { ...request, workId: "champion-measurement:ghost" },
              clientRequestId: "ghost",
            }),
            "names no measurement",
          );
          yield* refusedWith(
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request,
              clientRequestId: "followup",
              followup: true,
            }),
            "no follow-up",
          );
          yield* refusedWith(
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request,
              clientRequestId: "remote",
              remote: true,
            }),
            "",
          );
          // Final admission re-checks the task actually bound, not what was asked.
          const selection = { instanceId, model: "cheap" };
          yield* refused(
            w.service.admitDelegation(
              w.proofOf(planned, "writer", selection, { sourceAccess: "scoped-write" }),
            ),
          );
          yield* refused(
            w.service.admitDelegation(
              w.proofOf(planned, "editable", selection, { readOnly: false }),
            ),
          );
          yield* refusedWith(
            w.service.admitDelegation(
              w.proofOf(planned, "other-source", selection, { sourceRevision: otherRevision }),
            ),
            "full source revision",
          );
          yield* refused(
            w.service.admitDelegation({
              ...w.proofOf(planned, "wrong-run", selection),
              parentRunId: RunId.make("run:not-active"),
            }),
          );
          yield* refused(
            w.service.admitDelegation({
              ...w.proofOf(planned, "wrong-project", selection),
              projectId: ProjectId.make("foreign-project"),
            }),
          );
          assert.equal((yield* w.measurements()).filter((m) => m.admission !== null).length, 1);
        }),
      ),
  );

  it.effect(
    "needs a reviewer model other than its browser audit's, without overriding role policy",
    () => {
      const eligible = new Set(["cheap"]);
      return withWorld(
        (w) =>
          Effect.gen(function* () {
            yield* w.start();
            const browser = (yield* w.measurements())[0]!;
            yield* w.launch(browser, "launch-browser");
            yield* w.settle("browser-1");
            const review = yield* w.start({
              measurementId: "review-1",
              role: "reviewer",
              browserMeasurementId: "browser-1",
            });
            const ask = () =>
              w.service.guardDelegation({
                ownerThreadId: w.ownerThreadId,
                request: w.requestOf(review),
                clientRequestId: "launch-review",
              });
            // Only the browser audit's own model is eligible: explicit, and nothing was admitted.
            yield* refusedWith(ask(), "No eligible model other than");
            // Final admission refuses the same model even if a caller names it.
            yield* refusedWith(
              w.service.admitDelegation(
                w.proofOf(review, "launch-review", { instanceId, model: "cheap" }),
              ),
              "not an independent confirmation",
            );
            // A provider prefix does not make it another model.
            yield* refusedWith(
              w.service.admitDelegation(
                w.proofOf(review, "launch-review", { instanceId, model: "vendor/cheap" }),
              ),
              "not an independent confirmation",
            );
            eligible.add("strong");
            assert.equal((yield* ask())?.model, "strong");
            assert.isNull((yield* w.measurements()).find((m) => m.role === "reviewer")!.admission);
          }),
        eligible,
      );
    },
  );

  it.effect(
    "shares the two-active and six-a-day capacity with diagnostics, replays without charge and holds unknown launches",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const a = yield* w.start({ measurementId: "m-a" });
          const b = yield* w.start({ measurementId: "m-b" });
          const c = yield* w.start({ measurementId: "m-c" });
          const launched = yield* Effect.all([w.launch(a, "req-a"), w.launch(b, "req-b")], {
            concurrency: "unbounded",
          });
          assert.equal(launched.length, 2);
          yield* refusedWith(w.launch(c, "req-c"), "read-only attempts running");
          // Replay: the same request is not charged again; any other identity conflicts.
          const replay = yield* w.launch(a, "req-a");
          assert.deepEqual(replay.selection, launched[0]!.selection);
          assert.equal((yield* w.measurements()).filter((m) => m.admission !== null).length, 2);
          yield* refusedWith(
            w.service.admitDelegation({
              ...w.proofOf(a, "req-a", launched[0]!.selection),
              commandId: CommandId.make("command:other"),
            }),
            "already admitted by another request",
          );
          yield* refusedWith(
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request: w.requestOf(a),
              clientRequestId: "req-other",
            }),
            "already admitted as clientRequestId req-a",
          );
          // A launch whose outcome is unknown keeps holding capacity until reconciled.
          yield* w.service.delegationOutcome({
            ownerThreadId: w.ownerThreadId,
            request: w.requestOf(a),
            clientRequestId: "req-a",
            state: "failed",
          });
          yield* w.service.runDue;
          const held = yield* w.measurements();
          assert.equal(held.find((m) => m.measurementId === "m-a")!.state, "unknown");
          yield* refusedWith(w.launch(c, "req-c"), "read-only attempts running");
          // Receipt-rejected launches fail and free the slot, but still count against the day.
          w.f.setReceipt(
            held.find((m) => m.measurementId === "m-a")!.admission!.commandId,
            "rejected",
          );
          yield* w.service.runDue;
          assert.equal(
            (yield* w.measurements()).find((m) => m.measurementId === "m-a")!.state,
            "failed",
          );
          yield* w.launch(c, "req-c");
          yield* w.settle("m-b");
          yield* w.settle("m-c");
          for (const id of ["m-d", "m-e", "m-f"]) {
            yield* w.launch(yield* w.start({ measurementId: id }), `req-${id}`);
            yield* w.settle(id);
          }
          assert.equal((yield* w.measurements()).filter((m) => m.admission !== null).length, 6);
          // Plans beyond what a check could ever be admitted are refused too.
          yield* refusedWith(w.start({ measurementId: "m-g" }), "most measurements");
        }),
      ),
  );

  it.effect(
    "closes admission when the check reports and keeps late outcomes to their own record",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const admitted = yield* w.start({ measurementId: "m-admitted" });
          const waiting = yield* w.start({ measurementId: "m-waiting" });
          yield* w.launch(admitted, "req-admitted");
          const report = yield* w.service.report(w.f.caller(), {
            samples: [{ ...sample, metricId: "coverage", value: 1, evidence: "Reviewed screens" }],
            findings: [],
            summary: "Coverage reported",
          });
          const reported = report.champion.latestSamples;
          // Report won: nothing new is planned or admitted for that check.
          yield* refused(w.start({ measurementId: "m-late" }));
          yield* refused(w.launch(waiting, "req-waiting"));
          yield* refused(
            w.service.admitDelegation(
              w.proofOf(waiting, "req-waiting", { instanceId, model: "cheap" }),
            ),
          );
          // The task admitted before still settles, and only its own record changes.
          const done = yield* w.settle("m-admitted");
          assert.equal(done.state, "completed");
          assert.deepEqual(
            (yield* w.service.get({ id: config.id })).champion.latestSamples,
            reported,
          );
          assert.equal(
            (yield* w.measurements()).find((m) => m.measurementId === "m-waiting")!.state,
            "planned",
          );
          // A newer check is its own anchor: the old plan cannot be admitted into it.
          yield* w.service.runCheck({ id: config.id });
          const newer = (yield* w.service.checkContext(w.f.caller())).checkId;
          assert.notEqual(newer, w.checkId);
          yield* refused(w.launch(waiting, "req-waiting"));
          yield* refused(w.start({ measurementId: "m-stale", checkId: w.checkId }));
          yield* w.settle("m-admitted", "failed");
          assert.equal(
            (yield* w.sql<{
              status: string;
            }>`SELECT status FROM champion_checks WHERE id = ${newer}`.pipe(Effect.orDie))[0]!
              .status,
            "pending",
          );
          assert.equal(
            (yield* w.measurements()).find((m) => m.measurementId === "m-admitted")!.state,
            "completed",
          );
        }),
      ),
  );

  /** The refusal's message; an unexpected success fails the test rather than leaking into the error channel. */
  const refusalOf = <A>(effect: Effect.Effect<A, ChampionError>) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) => error.message,
        onSuccess: () => "Expected the admission to refuse, but it was admitted.",
      }),
    );
  const coverageReport = {
    samples: [{ ...sample, metricId: "coverage", value: 1, evidence: "Reviewed screens" }],
    findings: [],
    summary: "Coverage reported",
  };
  const checkStatus = (w: World, id: string) =>
    w.sql<{ status: string }>`SELECT status FROM champion_checks WHERE id = ${id}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]!.status),
    );

  it.effect(
    "lets a report that commits while an admission is in flight win, leaving the plan unadmitted and the samples as reported",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const plan = yield* w.start();
          const request = w.requestOf(plan);
          const selection = (yield* w.service.guardDelegation({
            ownerThreadId: w.ownerThreadId,
            request,
            clientRequestId: "race",
          }))!;
          // The admission passes its pre-launch checks, then waits just before its transaction.
          const gate = yield* w.f.holdOwnerRead(
            (kinds) => kinds.length === 1 && kinds[0] === "runs",
          );
          const admitting = yield* Effect.forkChild(
            refusalOf(w.service.admitDelegation(w.proofOf(plan, "race", selection))),
          );
          yield* Deferred.await(gate.reached);
          const reported = yield* w.service.report(w.f.caller(), coverageReport);
          assert.equal(yield* checkStatus(w, w.checkId), "reported");
          yield* Deferred.succeed(gate.release, undefined);
          assert.include(yield* Fiber.join(admitting), "current check");
          const [stored] = yield* w.measurements();
          assert.equal(stored!.state, "planned");
          assert.isNull(stored!.admission);
          assert.deepEqual(
            (yield* w.service.get({ id: config.id })).champion.latestSamples,
            reported.champion.latestSamples,
          );
          assert.equal(yield* checkStatus(w, w.checkId), "reported");
        }),
      ),
  );

  it.effect(
    "lets an admission that commits while a report is in flight win, and its late outcome never reopens the check or touches the samples",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const plan = yield* w.start();
          // The report is authenticated and held before it can commit anything.
          const gate = yield* w.f.holdOwnerRead((kinds) => kinds.includes("providerThreads"));
          const reporting = yield* Effect.forkChild(w.service.report(w.f.caller(), coverageReport));
          yield* Deferred.await(gate.reached);
          yield* w.launch(plan, "race-admit");
          assert.equal(yield* checkStatus(w, w.checkId), "pending");
          yield* Deferred.succeed(gate.release, undefined);
          const reported = yield* Fiber.join(reporting);
          assert.equal(yield* checkStatus(w, w.checkId), "reported");
          const admitted = (yield* w.measurements())[0]!;
          assert.equal(admitted.state, "unknown");
          assert.equal(admitted.admission!.clientRequestId, "race-admit");
          // The admitted task still settles on its own record only.
          const done = yield* w.settle(plan.measurementId);
          assert.equal(done.state, "completed");
          assert.equal(yield* checkStatus(w, w.checkId), "reported");
          assert.deepEqual(
            (yield* w.service.get({ id: config.id })).champion.latestSamples,
            reported.champion.latestSamples,
          );
          yield* refused(w.start({ measurementId: "after-report" }));
        }),
      ),
  );

  it.effect(
    "refuses an in-flight admission once a newer definition cancels its check, and leaves the newer check alone",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const plan = yield* w.start();
          const selection = (yield* w.service.guardDelegation({
            ownerThreadId: w.ownerThreadId,
            request: w.requestOf(plan),
            clientRequestId: "race",
          }))!;
          const gate = yield* w.f.holdOwnerRead(
            (kinds) => kinds.length === 1 && kinds[0] === "runs",
          );
          const admitting = yield* Effect.forkChild(
            refusalOf(w.service.admitDelegation(w.proofOf(plan, "race", selection))),
          );
          yield* Deferred.await(gate.reached);
          // The real cancellation: accepted definitions change, the run ends, the next check supersedes.
          yield* w.service.changeMetrics({
            id: config.id,
            metrics: [{ ...coverage, description: "Stricter coverage" }],
            reason: "Change",
          });
          w.f.endRun();
          yield* w.service.runCheck({ id: config.id });
          assert.equal(yield* checkStatus(w, w.checkId), "cancelled");
          const newer = (yield* w.service.checkContext(w.f.caller())).checkId;
          assert.notEqual(newer, w.checkId);
          yield* Deferred.succeed(gate.release, undefined);
          assert.include(yield* Fiber.join(admitting), "current check");
          assert.isNull((yield* w.measurements())[0]!.admission);
          assert.equal(yield* checkStatus(w, w.checkId), "cancelled");
          assert.equal(yield* checkStatus(w, newer), "pending");
          // The old plan cannot ride into the newer check; a plan made for it is admitted normally.
          yield* refused(w.launch(plan, "race-again"));
          const fresh = yield* w.service.startMeasurementFromOwner(w.f.caller(), {
            id: config.id,
            checkId: newer,
            measurementId: "newer",
            role: "browser",
            sourceRevision: revision,
            metrics: [{ metricId: "coverage", version: 2 }],
          });
          yield* w.launch(fresh, "newer-launch");
          assert.equal(yield* checkStatus(w, newer), "pending");
        }),
      ),
  );

  it.effect("refuses admission once the check is cancelled, even for a plan made before", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const plan = yield* w.start();
        yield* w.sql`UPDATE champion_checks SET status = 'cancelled', document_json = json_set(document_json, '$.cancelled', json('true')) WHERE id = ${w.checkId}`.pipe(
          Effect.orDie,
        );
        yield* refusedWith(
          w.service.guardDelegation({
            ownerThreadId: w.ownerThreadId,
            request: w.requestOf(plan),
            clientRequestId: "launch",
          }),
          "current check",
        );
        yield* refused(
          w.service.admitDelegation(w.proofOf(plan, "launch", { instanceId, model: "cheap" })),
        );
        yield* refused(w.start({ measurementId: "again" }));
      }),
    ),
  );

  it.effect(
    "keeps a paused champion to inline measurement and a setup check out of measurement",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const plan = yield* w.start();
          yield* w.service.setLifecycle({ id: config.id, lifecycle: "paused" });
          yield* refusedWith(w.start({ measurementId: "paused" }), "measures only inline");
          yield* refused(
            w.service.guardDelegation({
              ownerThreadId: w.ownerThreadId,
              request: w.requestOf(plan),
              clientRequestId: "launch",
            }),
          );
          yield* refused(
            w.service.admitDelegation(w.proofOf(plan, "launch", { instanceId, model: "cheap" })),
          );
          assert.equal((yield* w.measurements()).filter((m) => m.admission !== null).length, 0);
        }),
      ),
  );
});

// Champion folders in agent-config (T3-839).
const HERE = "environment:champions";
const REPOSITORY = "github.com/pechhe/yardsmith";
const FOLDER = `champions/yardsmith/${config.id}`;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
/** A bare agent-config origin, the runner's checkout, and another machine's clone that pushes edits. */
const agentConfig = () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "champion-folders-"));
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const clone = (name: string) => {
    const dir = NodePath.join(base, name);
    git(base, "clone", "-q", origin, dir);
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    return dir;
  };
  const other = clone("other");
  git(other, "checkout", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(other, "README.md"), "agent-config\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "seed");
  git(other, "push", "-q", "origin", "HEAD:main");
  const root = clone("agents");
  return {
    origin,
    root,
    /** Commits files (null deletes) from the other machine and pushes them to main. */
    push: (files: Record<string, string | null>) => {
      git(other, "pull", "-q", "--ff-only", "origin", "main");
      for (const [path, content] of Object.entries(files)) {
        const target = NodePath.join(other, path);
        if (content === null) NodeFS.rmSync(target, { force: true });
        else {
          NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
          NodeFS.writeFileSync(target, content);
        }
      }
      git(other, "add", "-A");
      git(other, "commit", "-qm", "edit");
      git(other, "push", "-q", "origin", "HEAD:main");
    },
    onMain: (path: string) => {
      try {
        return git(base, "--git-dir", origin, "show", `main:${path}`);
      } catch {
        return null;
      }
    },
    commits: () => Number(git(base, "--git-dir", origin, "rev-list", "--count", "main")),
    lastCommitPaths: () =>
      git(base, "--git-dir", origin, "diff", "--name-only", "main~1", "main").split("\n"),
  };
};
/** A project repository whose integration branch is develop, and the user's checkout of it. */
const projectRepository = () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "champion-project-"));
  const origin = NodePath.join(base, "project.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "--git-dir", origin, "config", "uploadpack.allowFilter", "true");
  git(base, "--git-dir", origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  const work = NodePath.join(base, "work");
  git(base, "clone", "-q", origin, work);
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "checkout", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(work, "slipjay.json"), '{"integrationBranch":"develop"}\n');
  git(work, "add", "-A");
  git(work, "commit", "-qm", "seed");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "checkout", "-q", "-b", "develop");
  git(work, "push", "-q", "origin", "HEAD:develop");
  const checkout = NodePath.join(base, "checkout");
  git(base, "clone", "-q", "-b", "develop", origin, checkout);
  return {
    checkout,
    /** Lands files (null deletes) on develop. */
    land: (files: Record<string, string | null>) => {
      for (const [path, content] of Object.entries(files)) {
        const target = NodePath.join(work, path);
        if (content === null) NodeFS.rmSync(target, { force: true });
        else {
          NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
          NodeFS.writeFileSync(target, content);
        }
      }
      git(work, "add", "-A");
      git(work, "commit", "-qm", "land");
      git(work, "push", "-q", "origin", "HEAD:develop");
    },
    refs: () => git(checkout, "for-each-ref"),
  };
};
const HOSTED = `.agents/champions/${config.id}`;
/** The folder's definition and learnings at its repository path; readings and findings stay in agent-config. */
const hostedFiles = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => !/\/(readings|findings)\//.test(path))
      .map(([path, content]) => [path.replace(FOLDER, HOSTED), content]),
  );
const withFolders = (
  body: (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
    world: ReturnType<typeof agentConfig>,
  ) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const world = agentConfig();
    const layer = Champions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          f.dependencies,
          Layer.succeed(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(EnvironmentId.make(HERE)),
              getDescriptor: Effect.die("unused"),
            }),
          ),
          Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            RepositoryIdentityResolver.RepositoryIdentityResolver.of({
              resolve: () => Effect.succeed({ canonicalKey: REPOSITORY } as RepositoryIdentity),
            }),
          ),
          Layer.succeed(ServerConfig.ServerConfig, {
            baseDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "champion-home-")),
          } as ServerConfig.ServerConfig["Service"]),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/project/root', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`.pipe(
        Effect.orDie,
      );
      const service = yield* Champions.ChampionService;
      yield* service.setModels(defaultModels);
      yield* body(f, service, world).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          T3CODE_AGENT_POLICY_ROOT: world.root,
        }),
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Sqlite.layerMemory));
const folderMetric = {
  ...metric,
  version: 1,
  seriesId: "series:errors",
  reason: "Measure errors",
  definedAt: "2026-11-01T00:00:00.000Z",
};
const folderLearning = {
  topic: "Why errors rise",
  plainSummary: "Errors rise after a deploy until caches warm.",
  question: "Why do errors rise?",
  conclusion: "Caches are cold after a deploy.",
  attempts: [],
  evidence: [
    {
      source: "deploy log",
      evidence: "errors fell after warming",
      observedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  components: [],
  environment: "test",
  applicability: "Every deploy",
  tradeoffs: "None",
  reviewAt: null,
  reviewConditions: ["The cache changes"],
  versionConditions: [],
  learningId: "errors-after-deploy",
  recordedAt: "2026-11-01T00:00:00.000Z",
  reason: "Learned from a deploy",
};
const reading = (value: number, observedAt: string) => ({
  metricId: metric.id,
  version: 1,
  unit: metric.unit,
  status: "measured" as const,
  value,
  observedAt,
  collectedAt: observedAt,
  source: "test",
  evidence: `read ${value}`,
  revision: null,
  provenance: "server-collected" as const,
});
const folderFiles = (folder: Partial<ChampionFolder> & { runner?: string }) =>
  Object.fromEntries(
    renderChampionFolder({
      definition: {
        id: config.id,
        name: config.name,
        purpose: config.purpose,
        repository: REPOSITORY,
        runner: { environmentId: folder.runner ?? HERE, label: folder.runner ?? "test machine" },
        lifecycle: "paused",
        schedule: config.schedule,
        charter: config.charter,
      },
      metrics: [folderMetric],
      learnings: [],
      findings: [],
      readings: [],
      ...folder,
    }).map((file) => [`${FOLDER}/${file.path}`, file.content]),
  );

describe("Champion folders in agent-config", () => {
  it.effect(
    "adopts a folder naming this machine with its learnings, carried-over findings and readings, then leaves it alone",
    () =>
      withFolders((_f, service, world) =>
        Effect.gen(function* () {
          world.push({
            ...folderFiles({
              learnings: [folderLearning],
              findings: [
                {
                  id: `${config.id}:metric:series:errors`,
                  metricId: metric.id,
                  seriesId: "series:errors",
                  title: "Errors are high",
                  evidence: "Read 9 errors.",
                  // A repair-era status, as a folder written before cases still holds it.
                  status: "working" as never,
                  revision: null,
                  updatedAt: "2026-11-01T00:00:00.000Z",
                  carriedOver: { from: "peach-box-old", at: "2026-11-21" },
                },
              ],
              readings: [
                reading(3, "2026-11-01T00:00:00.000Z"),
                reading(4, "2026-11-02T00:00:00.000Z"),
              ],
            }),
            [`${FOLDER}/notes.md`]: "The Champion's own notes.\n",
          });
          yield* service.syncFolders;
          const detail = yield* service.get({ id: config.id });
          assert.equal(detail.champion.folder?.runner.environmentId, HERE);
          assert.equal(detail.champion.folder?.path, FOLDER);
          assert.deepEqual(
            detail.metrics.map((m) => [m.id, m.version, m.seriesId]),
            [[metric.id, 1, "series:errors"]],
          );
          assert.equal(detail.findings[0]?.status, "open");
          assert.match(detail.findings[0]?.evidence ?? "", /^Carried over from peach-box-old/);
          assert.deepEqual(
            (yield* service.history({ id: config.id })).samples.map((s) => s.value).toSorted(),
            [3, 4],
          );
          const learnings = yield* service.learningSearch({ championId: config.id });
          assert.deepEqual(
            learnings.learnings.map((l) => l.revision.conclusion),
            [folderLearning.conclusion],
          );
          const settled = world.commits();
          yield* service.syncFolders;
          yield* service.syncFolders;
          assert.equal(world.commits(), settled);
          assert.equal(world.onMain(`${FOLDER}/notes.md`), "The Champion's own notes.");
        }),
      ),
  );

  it.effect(
    "activates an active-by-file Champion once a fixed metrics.json gives it its first metrics",
    () =>
      withFolders((_f, service, world) =>
        Effect.gen(function* () {
          const files = folderFiles({});
          const champion = files[`${FOLDER}/champion.md`]!.replace(
            /lifecycle: \w+/,
            "lifecycle: active",
          );
          world.push({
            ...files,
            [`${FOLDER}/champion.md`]: champion,
            [`${FOLDER}/metrics.json`]: JSON.stringify([{ id: folderMetric.id }]),
          });
          yield* service.syncFolders;
          const broken = yield* service.get({ id: config.id });
          assert.equal(broken.metrics.length, 0);
          assert.equal(broken.champion.lifecycle, "paused");
          assert.isNull(broken.champion.nextCheckAt);

          world.push({ [`${FOLDER}/metrics.json`]: files[`${FOLDER}/metrics.json`]! });
          yield* service.syncFolders;
          const fixed = yield* service.get({ id: config.id });
          assert.equal(fixed.metrics.length, 1);
          assert.equal(fixed.champion.lifecycle, "active");
          assert.isNotNull(fixed.champion.nextCheckAt);
        }),
      ),
  );

  it.effect(
    "starts no work on a machine the folder does not name, even for a Champion it holds",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          f.realProjectRoot();
          yield* definitions(service);
          world.push(folderFiles({ runner: "environment:elsewhere" }));
          yield* service.syncFolders;
          yield* refusedWith(service.runCheck({ id: config.id }), "runs on environment:elsewhere");
          yield* refusedWith(service.setup({ id: config.id }), "runs on environment:elsewhere");
          yield* refusedWith(
            service.startMetricsLead({ id: config.id }),
            "runs on environment:elsewhere",
          );
          assert.deepEqual(f.counts(), { launches: 0, sends: 0 });
          assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", "environment:elsewhere");
        }),
      ),
  );

  it.effect(
    "saves a Champion to its folder on main without touching the checkout, and applies an agent's committed edits",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          f.realProjectRoot();
          yield* definitions(service);
          const head = git(world.root, "rev-parse", "HEAD");
          NodeFS.writeFileSync(
            NodePath.join(world.root, "unsaved.txt"),
            "an agent's half-done edit",
          );
          yield* service.syncFolders;
          assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", HERE);
          assert.include(world.onMain(`${FOLDER}/metrics.json`) ?? "", metric.id);
          assert.equal(git(world.root, "rev-parse", "HEAD"), head);
          assert.equal(git(world.root, "status", "--porcelain"), "?? unsaved.txt");
          assert.isNotNull((yield* service.get({ id: config.id })).champion.folder?.savedAt);

          yield* service.upsert({ ...config, purpose: "Keep errors very low" });
          yield* service.syncFolders;
          assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", "Keep errors very low");
          assert.isTrue(world.lastCommitPaths().every((path) => path.startsWith(`${FOLDER}/`)));

          const edited = world
            .onMain(`${FOLDER}/champion.md`)!
            .replace("Keep errors very low", "Edited by an agent");
          const learningFile = Object.entries(folderFiles({ learnings: [folderLearning] })).find(
            ([path]) => path.includes("/learnings/"),
          )!;
          world.push({
            [`${FOLDER}/champion.md`]: `${edited}\n`,
            [learningFile[0]]: learningFile[1],
          });
          NodeFS.mkdirSync(NodePath.join(world.root, FOLDER), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(world.root, FOLDER, "champion.md"),
            "not yet committed",
          );
          yield* service.syncFolders;
          assert.equal(
            (yield* service.get({ id: config.id })).champion.purpose,
            "Edited by an agent",
          );
          const [learning] = (yield* service.learningSearch({ championId: config.id })).learnings;
          assert.equal(learning?.revision.contribution?.threadTitle, "File edit in agent-config");
          yield* service.syncFolders;
          const settled = world.commits();
          yield* service.syncFolders;
          assert.equal(world.commits(), settled);

          const metrics = JSON.parse(
            world.onMain(`${FOLDER}/metrics.json`)!,
          ) as Array<ChampionMetricInput>;
          world.push({
            [`${FOLDER}/metrics.json`]: JSON.stringify(
              [{ ...metrics[0], collect: node("process.exit(4)") }],
              null,
              2,
            ),
          });
          yield* service.syncFolders;
          const after = yield* service.get({ id: config.id });
          assert.isUndefined(after.metrics[0]?.collect);
          assert.isTrue(
            after.champion.attention.some((line) => line.includes("metrics.json not applied")),
          );
          yield* service.syncFolders;
          assert.include(world.onMain(`${FOLDER}/metrics.json`), "process.exit(4)");
        }),
      ),
  );

  it.effect(
    "leaves a folder with a file that does not parse as the agent wrote it, and drops only a deleted learning",
    () =>
      withFolders((_f, service, world) =>
        Effect.gen(function* () {
          const second = {
            ...folderLearning,
            learningId: "errors-on-mondays",
            topic: "Monday errors",
          };
          const files = folderFiles({ learnings: [folderLearning, second] });
          world.push(files);
          yield* service.syncFolders;
          const firstPath = Object.keys(files).find((path) =>
            path.includes("errors-after-deploy"),
          )!;
          const secondPath = Object.keys(files).find((path) => path.includes("errors-on-mondays"))!;
          world.push({ [firstPath]: "---\nnot: [valid\n---\nbroken" });
          yield* service.syncFolders;
          assert.equal(world.onMain(firstPath), "---\nnot: [valid\n---\nbroken");
          assert.isTrue(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("agent-config folder: learnings/"),
            ),
          );
          assert.isTrue(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith(
                "Not saved to agent-config: a file in its folder could not be applied",
              ),
            ),
          );
          world.push({ [firstPath]: files[firstPath]!, [secondPath]: null });
          yield* service.syncFolders;
          assert.deepEqual(
            (yield* service.learningSearch({ championId: config.id })).learnings.map(
              (l) => l.revision.learningId,
            ),
            [folderLearning.learningId],
          );
          assert.isFalse(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("agent-config folder: "),
            ),
          );
          world.push({ [`${FOLDER}/champion.md`]: "no frontmatter at all" });
          yield* service.syncFolders;
          assert.equal(world.onMain(`${FOLDER}/champion.md`), "no frontmatter at all");
          assert.isTrue(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("agent-config folder: champion.md"),
            ),
          );
        }),
      ),
  );

  it.effect(
    "writes no folder for a retired Champion, and says so when a push keeps failing until one succeeds",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          f.realProjectRoot();
          const old = { ...config, id: "champion:old", name: "Old" };
          yield* service.upsert(old);
          yield* service.changeMetrics({ id: old.id, metrics: [metric], reason: "Measure" });
          yield* service.setLifecycle({ id: old.id, lifecycle: "retired" });
          yield* definitions(service);
          const hook = NodePath.join(world.origin, "hooks", "pre-receive");
          NodeFS.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          yield* service.syncFolders;
          assert.isTrue(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("Not saved to agent-config: "),
            ),
          );
          NodeFS.rmSync(hook);
          yield* service.syncFolders;
          assert.isFalse(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("Not saved to agent-config: "),
            ),
          );
          assert.isNotNull(world.onMain(`${FOLDER}/champion.md`));
          assert.isNull(world.onMain("champions/yardsmith/champion:old/champion.md"));
        }),
      ),
  );
});

describe("Repository-hosted Champions", () => {
  it.effect(
    "reads the definition from the project's integration branch, keeps records in agent-config, and refuses writes",
    () =>
      withFolders((_f, service, world) =>
        Effect.gen(function* () {
          const project = projectRepository();
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_projects SET workspace_root = ${project.checkout}`.pipe(
            Effect.orDie,
          );
          const files = folderFiles({
            learnings: [folderLearning],
            readings: [reading(3, "2026-11-01T00:00:00.000Z")],
          });
          project.land(hostedFiles(files));
          world.push({
            ...Object.fromEntries(
              Object.entries(files).filter(([path]) => path.includes("/readings/")),
            ),
            [`${FOLDER}/metrics.json`]: files[`${FOLDER}/metrics.json`]!,
          });
          NodeFS.mkdirSync(NodePath.join(project.checkout, HOSTED), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(project.checkout, HOSTED, "champion.md"),
            "---\nnot: committed\n---\n",
          );
          const refs = project.refs();
          yield* service.syncFolders;
          const detail = yield* service.get({ id: config.id });
          assert.equal(detail.champion.folder?.definedIn, HOSTED);
          assert.equal(detail.champion.folder?.path, FOLDER);
          assert.equal(detail.champion.purpose, config.purpose);
          assert.equal(project.refs(), refs);
          assert.deepEqual(
            (yield* service.history({ id: config.id })).samples.map((sample) => sample.value),
            [3],
          );
          assert.deepEqual(
            (yield* service.learningSearch({ championId: config.id })).learnings.map(
              (learning) => learning.revision.learningId,
            ),
            [folderLearning.learningId],
          );
          const settled = world.commits();
          yield* service.syncFolders;
          assert.equal(world.commits(), settled);
          assert.isNull(world.onMain(`${FOLDER}/champion.md`));
          assert.isNotNull(world.onMain(`${FOLDER}/metrics.json`));
          assert.isNotNull(
            world.onMain(Object.keys(files).find((path) => path.includes("/readings/"))!),
          );

          yield* refusedWith(service.upsert(config), HOSTED);
          yield* refusedWith(
            service.changeMetrics({ id: config.id, metrics: [metric], reason: "Change it" }),
            HOSTED,
          );
          yield* refusedWith(
            service.contributeLearning(peachLive("thread:lead"), learning("learning:elsewhere")),
            HOSTED,
          );

          project.land({
            [`${HOSTED}/champion.md`]: files[`${FOLDER}/champion.md`]!.replace(
              `purpose: ${config.purpose}`,
              "purpose: Edited in the repository",
            ),
          });
          yield* service.syncFolders;
          assert.equal(
            (yield* service.get({ id: config.id })).champion.purpose,
            "Edited in the repository",
          );
          assert.isNull(world.onMain(`${FOLDER}/champion.md`));
        }),
      ),
  );

  it.effect(
    "reuses the last hosted read for dirty saves within the poll window and rereads after it",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          const project = projectRepository();
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_projects SET workspace_root = ${project.checkout}`.pipe(
            Effect.orDie,
          );
          const files = folderFiles({});
          project.land(hostedFiles(files));
          const tick = f.scheduled.get("champion-folders")!;
          const purpose = () =>
            service.get({ id: config.id }).pipe(Effect.map((detail) => detail.champion.purpose));
          yield* tick;
          assert.equal(yield* purpose(), config.purpose);

          project.land({
            [`${HOSTED}/champion.md`]: files[`${FOLDER}/champion.md`]!.replace(
              `purpose: ${config.purpose}`,
              "purpose: Edited in the repository",
            ),
          });
          yield* service.upsert({ ...config, id: "champion:other", name: "Other" });
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.equal(yield* purpose(), config.purpose);

          yield* service.upsert({ ...config, id: "champion:another", name: "Another" });
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.equal(yield* purpose(), config.purpose);

          yield* TestClock.adjust("5 minutes");
          yield* tick;
          assert.equal(yield* purpose(), "Edited in the repository");
          assert.isNotNull(world.onMain("README.md"));
        }),
      ),
  );

  it.effect(
    "skips the agent-config fetch for dirty saves within the poll window, pushes cleanly, and refetches after it",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          f.realProjectRoot();
          yield* definitions(service);
          const tick = f.scheduled.get("champion-folders")!;
          const purpose = () =>
            service.get({ id: config.id }).pipe(Effect.map((detail) => detail.champion.purpose));
          yield* tick;
          assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", config.purpose);

          yield* service.upsert({ ...config, purpose: "Keep errors very low" });
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", "Keep errors very low");
          assert.equal(
            git(world.root, "rev-parse", "origin/main"),
            git(world.root, "--git-dir", world.origin, "rev-parse", "main"),
          );

          const edited = world
            .onMain(`${FOLDER}/champion.md`)!
            .replace("Keep errors very low", "Edited by an agent");
          world.push({ [`${FOLDER}/champion.md`]: `${edited}\n` });
          const external = git(world.root, "--git-dir", world.origin, "rev-parse", "main");
          yield* service.upsert({ ...config, purpose: "Keep errors very low" });
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.notEqual(git(world.root, "rev-parse", "origin/main"), external);
          assert.equal(yield* purpose(), "Keep errors very low");
          const settled = world.commits();

          yield* service.upsert({ ...config, purpose: "Keep errors very low" });
          yield* TestClock.adjust("20 seconds");
          yield* tick;
          assert.equal(world.commits(), settled);

          yield* TestClock.adjust("5 minutes");
          yield* tick;
          assert.equal(git(world.root, "rev-parse", "origin/main"), external);
          assert.equal(yield* purpose(), "Edited by an agent");
        }),
      ),
  );

  it.effect("saves a dirty Champion over another machine's push inside the poll window", () =>
    withFolders((f, service, world) =>
      Effect.gen(function* () {
        f.realProjectRoot();
        yield* definitions(service);
        const tick = f.scheduled.get("champion-folders")!;
        yield* tick;

        world.push({ "notes/other.md": "from another machine\n" });
        yield* service.upsert({ ...config, purpose: "Keep errors very low" });
        yield* TestClock.adjust("20 seconds");
        yield* tick;
        assert.include(world.onMain(`${FOLDER}/champion.md`) ?? "", "Keep errors very low");
        assert.equal(world.onMain("notes/other.md"), "from another machine");
        assert.equal(
          git(world.root, "rev-parse", "origin/main"),
          git(world.root, "--git-dir", world.origin, "rev-parse", "main"),
        );
        const settled = world.commits();

        yield* service.upsert({ ...config, purpose: "Keep errors very low" });
        yield* TestClock.adjust("20 seconds");
        yield* tick;
        assert.equal(world.commits(), settled);
      }),
    ),
  );

  it.effect("does not re-arm the dirty save when a sync finds nothing to change", () =>
    withFolders((f, service, world) =>
      Effect.gen(function* () {
        world.push(folderFiles({}));
        const tick = f.scheduled.get("champion-folders")!;
        yield* tick;
        const sql = yield* SqlClient.SqlClient;
        const stored = sql<{
          document_json: string;
        }>`SELECT document_json FROM champions ORDER BY id`.pipe(Effect.orDie);
        const settled = world.commits();
        const before = yield* stored;
        yield* TestClock.adjust("20 seconds");
        yield* tick;
        yield* TestClock.adjust("20 seconds");
        yield* tick;
        assert.equal(world.commits(), settled);
        assert.deepEqual(yield* stored, before);
      }),
    ),
  );

  it.effect("runs a Champion defined both in a repository and in agent-config nowhere", () =>
    withFolders((_f, service, world) =>
      Effect.gen(function* () {
        const project = projectRepository();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_root = ${project.checkout}`.pipe(
          Effect.orDie,
        );
        const files = folderFiles({});
        project.land(hostedFiles(files));
        yield* service.syncFolders;
        world.push(files);
        yield* service.syncFolders;
        const held = yield* service.get({ id: config.id });
        assert.isTrue(held.champion.attention.some((line) => line.startsWith("Defined twice: ")));
        yield* refusedWith(service.runCheck({ id: config.id }), "runs on no machine");
        world.push({ [`${FOLDER}/champion.md`]: null, [`${FOLDER}/metrics.json`]: null });
        yield* service.syncFolders;
        assert.isFalse(
          (yield* service.get({ id: config.id })).champion.attention.some((line) =>
            line.startsWith("Defined twice: "),
          ),
        );
      }),
    ),
  );
});

describe("escalation threads", () => {
  const shellOf = Effect.fn("test.escalationShell")(function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* readChampionShellRows(sql, json([threadId])).pipe(Effect.orDie);
    return withChampions(rows)({ id: threadId } as OrchestrationV2ThreadShell).champion;
  });
  const openedFinding = Effect.fn("test.openedQualitativeFinding")(function* (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
  ) {
    yield* definitions(service);
    yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
    yield* service.runCheck({ id: config.id });
    const report = yield* service.report(f.caller(), {
      samples: [{ ...sample, value: 1 }],
      findings: [{ title: "Checkout fails", evidence: "The pay button does nothing" }],
      summary: "One bug",
    });
    return report.findings.find((x) => x.title === "Checkout fails")!;
  });

  it.effect("opens an idle case on the escalation model for a new qualitative finding", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* openedFinding(f, service);
        assert.equal(f.escalationLaunches.length, 1);
        const [thread] = f.escalationLaunches;
        // Only the check's own thread was sent a message; while attended the case starts no turn.
        assert.equal(f.launchRequests.length, 1);
        assert.isFalse(thread!.started);
        assert.equal(thread!.threadId, finding.escalationThreadId);
        assert.equal(thread!.title, "Checkout fails");
        assert.equal(thread!.model, "strong");
        assert.deepEqual(yield* shellOf(thread!.threadId), {
          id: config.id,
          attention: true,
          kind: "escalation",
          name: "Quality",
          findingId: finding.id,
          severity: "incident",
          trigger: "New finding",
          resolved: false,
        });
        // The same finding on the next check opens no second thread.
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [{ title: "Checkout fails", evidence: "Still broken" }],
          summary: "Still there",
        });
        assert.equal(f.escalationLaunches.length, 1);
      }),
    ),
  );

  it.effect("settles a dismissed finding's thread and keeps its metadata once archived", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* openedFinding(f, service);
        const threadId = finding.escalationThreadId!;
        const dismissed = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "dismiss",
          reason: "Not a bug",
        });
        assert.deepEqual(
          f.commands
            .filter((c) => c.threadId === threadId && c.type !== "thread.metadata.update")
            .map((c) => c.type),
          ["thread.settle"],
        );
        const sql = yield* SqlClient.SqlClient;
        const settled = dismissed.findings.find((x) => x.id === finding.id)!;
        yield* sql`INSERT INTO champion_finding_archive (id,champion_id,at,document_json) VALUES (${settled.id},${config.id},${settled.updatedAt},${json(settled)})`.pipe(
          Effect.orDie,
        );
        yield* sql`UPDATE champions SET document_json = json_set(document_json, '$.findings', json('[]')) WHERE id = ${config.id}`.pipe(
          Effect.orDie,
        );
        const archived = yield* shellOf(threadId);
        assert.equal(archived?.kind, "escalation");
        assert.equal(archived?.resolved, true);
        assert.equal(archived?.attention, false);
        assert.equal(archived?.findingId, finding.id);
      }),
    ),
  );

  it.effect(
    "escalates a Champion only on its third failed readings run, once, and settles on recovery",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          const failCheck = Effect.gen(function* () {
            yield* service.runCheck({ id: config.id });
            f.completeRun(true);
            f.endRun();
            yield* runDueThroughReprompt(f, service);
            return (yield* service.get({ id: config.id })).champion;
          });
          const first = yield* failCheck;
          assert.equal(first.consecutiveCheckFailures, 1);
          const second = yield* failCheck;
          assert.equal(second.consecutiveCheckFailures, 2);
          assert.equal(f.escalationLaunches.length, 0);
          const third = yield* failCheck;
          assert.equal(third.consecutiveCheckFailures, 3);
          assert.equal(f.escalationLaunches.length, 1);
          const threadId = third.stuckEscalationThreadId!;
          assert.equal(f.escalationLaunches[0]!.title, "Quality: failed 3 readings runs in a row");
          assert.equal(f.escalationLaunches[0]!.model, "strong");
          const sql = yield* SqlClient.SqlClient;
          const seeded = JSON.stringify({
            id: "f04b42fb-0000",
            championId: config.id,
            startedAt: "2030-01-01T00:00:00.000Z",
            cancelled: true,
            reported: false,
            failureCounted: true,
            skipped: "ended without a report",
          });
          yield* sql`INSERT INTO champion_checks (id, champion_id, thread_id, message_id, started_at, status, document_json) VALUES ('f04b42fb-0000', ${config.id}, ${third.ownerThreadId}, 'message:seeded', '2030-01-01T00:00:00.000Z', 'cancelled', ${seeded})`.pipe(
            Effect.orDie,
          );
          yield* sql`INSERT INTO champion_checks (id, champion_id, thread_id, message_id, started_at, status, document_json) VALUES ('f04b42fc-0000', ${config.id}, ${third.ownerThreadId}, 'message:seeded2', '2029-01-01T00:00:00.000Z', 'cancelled', ${seeded.replace("f04b42fb", "f04b42fc").replace("2030", "2029")})`.pipe(
            Effect.orDie,
          );
          yield* sql`INSERT INTO champion_checks (id, champion_id, thread_id, message_id, started_at, status, document_json) VALUES ('0ldstreak-0000', ${config.id}, ${third.ownerThreadId}, 'message:old', '1969-12-31T00:00:00.000Z', 'cancelled', ${JSON.stringify({ id: "0ldstreak-0000", championId: config.id, startedAt: "1969-12-31T00:00:00.000Z", cancelled: true, reported: false, failureCounted: true })})`.pipe(
            Effect.orDie,
          );
          const stuckBrief = yield* readEscalationBrief(sql, threadId).pipe(Effect.orDie);
          for (const part of [
            `Its readings and goal reviews run in thread ${third.ownerThreadId}`,
            "- 2030-01-01T00:00:00.000Z readings run f04b42fb (cancelled): ended without a report",
            "T3 Peach (pechhe/t3code)",
            "Never edit a shared main checkout",
          ])
            assert.include(stuckBrief, part);
          assert.notInclude(stuckBrief, "0ldstrea");
          assert.isTrue(yield* service.hasThreadContext(threadId as ThreadId));
          assert.isFalse(yield* service.hasThreadContext("thread:unrelated" as ThreadId));
          assert.deepEqual(yield* shellOf(threadId), {
            id: config.id,
            attention: true,
            kind: "escalation",
            name: "Quality",
            findingId: null,
            severity: "stuck",
            trigger: "Failed 3 readings runs in a row",
            resolved: false,
          });
          const fourth = yield* failCheck;
          assert.equal(fourth.consecutiveCheckFailures, 4);
          assert.equal(f.escalationLaunches.length, 1);
          assert.equal(fourth.stuckEscalationThreadId, threadId);
          yield* service.runCheck({ id: config.id });
          f.completeRun(false);
          yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 1 }],
            findings: [],
            summary: "Healthy again",
          });
          assert.equal(
            (yield* service.get({ id: config.id })).champion.consecutiveCheckFailures,
            0,
          );
          assert.deepEqual(
            f.commands
              .filter((c) => c.threadId === threadId && c.type !== "thread.metadata.update")
              .map((c) => c.type),
            ["thread.settle"],
          );
          assert.equal((yield* shellOf(threadId))?.resolved, true);
        }),
      ),
  );

  it.effect(
    "briefs a case with its readings history, the latest score, its times, the alarm flag, the owner thread and the workspace rule",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          const { caseThread, finding } = yield* breachWithCase(f, service);
          yield* service.runReview({ id: config.id });
          yield* service.report(f.caller(), {
            samples: [],
            findings: [],
            summary: "Angles: reliability, tests.",
            goalScore: { score: 5, reasons: "Errors keep breaching.", change: "First score." },
          });
          const sql = yield* SqlClient.SqlClient;
          // The upgrade released a repair child this finding had (migration 158).
          yield* sql`INSERT INTO champion_activity (id, champion_id, document_json) VALUES ('released-1', ${config.id}, ${JSON.stringify(
            {
              id: "released-1",
              championId: config.id,
              at: "1970-01-01T00:00:02.000Z",
              kind: "repair-released",
              text: "Released.",
              findingId: finding.id,
              threadId: "repair-child-1",
              revision: null,
              specUrl: null,
            },
          )})`.pipe(Effect.orDie);
          const brief = yield* readEscalationBrief(sql, caseThread).pipe(Effect.orDie);
          const owner = (yield* service.get({ id: config.id })).champion.ownerThreadId;
          for (const part of [
            "- 1970-01-01T00:00:01.000Z 5 count",
            "- 1970-01-01T00:00:00.000Z 1 count",
            "Latest goal score: 5/10 (target 7)",
            "Why not higher: Errors keep breaching.",
            `First seen ${finding.firstSeenAt}; last confirmed ${finding.lastConfirmedAt}.`,
            "This is not an alarm.",
            `run in thread ${owner}`,
            "An earlier repair attempt ran in thread repair-child-1",
            CASE_WORKSPACE_RULE,
            config.id,
            finding.id,
          ])
            assert.include(brief, part);
          assert.equal(yield* readEscalationBrief(sql, "thread:unrelated").pipe(Effect.orDie), "");
          assert.isTrue(yield* service.hasThreadContext(caseThread));
        }),
      ),
  );
});

describe("observe and score (T3-928)", () => {
  const goal = (score: number, reasons = "Errors keep breaching.") => ({
    samples: [],
    findings: [],
    summary: "Angles: reliability, tests, operations.",
    goalScore: { score, reasons, change: "Compared with the last readings." },
  });
  const decodeReport = Schema.decodeUnknownExit(ChampionReportInput);

  it.effect(
    "gives both rhythms the observe-only rules over default and custom instructions, and asks a review for angles and the code",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          yield* service.runCheck({ id: config.id });
          const readings = f.launchRequests.at(-1)!.text;
          yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
          yield* service.runReview({ id: config.id });
          const review = f.sent.at(-1)!.text;
          for (const text of [readings, review]) {
            assert.include(text, "OBSERVE ONLY");
            assert.include(text, Champions.CASE_FLOW_REFUSAL);
            assert.include(text, "Watch the error budget closely.");
            assert.notInclude(text, "Delegate bounded repairs");
          }
          assert.include(readings, "READINGS");
          assert.include(readings, "Do not score the goal");
          assert.include(review, "GOAL REVIEW");
          assert.include(review, "Name the angles you considered");
          assert.include(review, "read the relevant code and docs");
          // A Champion on the default instructions gets the new default under the same rules.
          yield* service.report(f.caller(), goal(8));
          yield* service.upsert({ ...config, charter: {} as never });
          yield* service.runReview({ id: config.id });
          const defaulted = f.sent.at(-1)!.text;
          assert.include(defaulted, "OBSERVE ONLY");
          assert.include(defaulted, DEFAULT_CHAMPION_INSTRUCTIONS);
        }),
      ),
  );

  it.effect("passes freshContext to every readings run and review after the first launch", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().launches, 1);
        assert.deepEqual(f.sent, []);
        yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
        yield* service.runReview({ id: config.id });
        assert.deepEqual(
          f.sent.map((message) => message.freshContext),
          [true, true],
        );
      }),
    ),
  );

  it.effect(
    "keeps a review and a readings run outstanding together, each completing, the review on the advice model",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          const checked = yield* service.runCheck({ id: config.id });
          const checkMessage = f.launchRequests.at(-1)!.messageId;
          const both = yield* service.runReview({ id: config.id });
          assert.isNotNull(both.champion.outstandingCheckId);
          assert.isNotNull(both.champion.outstandingReviewId);
          assert.equal(checked.champion.outstandingCheckId, both.champion.outstandingCheckId);
          // Every reading is in target, and the review still wakes the advice model.
          assert.equal(f.sent.at(-1)!.model, "strong");
          const context = yield* service.checkContext(f.caller());
          assert.equal(context.rhythm, "review");
          assert.deepEqual(context.metrics, []);
          const reviewed = yield* service.report(f.caller(), goal(8));
          assert.isNull(reviewed.champion.outstandingReviewId ?? null);
          assert.isNotNull(reviewed.champion.outstandingCheckId);
          f.runMessage(checkMessage);
          const read = yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 1 }],
            findings: [],
            summary: "In target",
          });
          assert.isNull(read.champion.outstandingCheckId);
        }),
      ),
  );

  it.effect(
    "schedules each review weekly on Mondays at a spread time, and an upgrade schedules rather than runs it",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          const first = yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          // The clock starts on Thursday 1 January 1970: the first Monday is the 5th.
          assert.equal(first.champion.reviewTime, "06:00");
          assert.equal(first.champion.nextReviewAt, "1970-01-05T06:00:00.000Z");
          const other = { ...config, id: "champion:other", name: "Other" };
          yield* accepted(service, [metric], other);
          const second = yield* service.setLifecycle({ id: other.id, lifecycle: "active" });
          assert.equal(second.champion.reviewTime, "06:10");
          assert.equal(second.champion.nextReviewAt, "1970-01-05T06:10:00.000Z");
          // A Champion from before reviews gets its first one scheduled, never started at once.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE champions SET document_json = json_remove(document_json, '$.champion.nextReviewAt', '$.champion.reviewTime') WHERE id = ${other.id}`.pipe(
            Effect.orDie,
          );
          yield* service.runDue;
          const upgraded = (yield* service.get({ id: other.id })).champion;
          assert.equal(upgraded.nextReviewAt, "1970-01-05T06:10:00.000Z");
          assert.isNull(upgraded.outstandingReviewId ?? null);
          assert.equal(f.counts().launches + f.counts().sends, 0);
          // A set schedule wins.
          const set = yield* service.upsert({
            ...config,
            goalReview: { schedule: { type: "interval", everyMs: 86_400_000 }, target: 9 },
          });
          assert.equal(set.champion.nextReviewAt, "1970-01-02T00:00:00.000Z");
        }),
      ),
  );

  it.effect("gives a review three hours before it is overdue", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runReview({ id: config.id });
        const overdue = Effect.gen(function* () {
          yield* service.runDue;
          return (yield* service.get({ id: config.id })).champion.attention.some((line) =>
            line.startsWith("Review report overdue"),
          );
        });
        yield* TestClock.adjust("2 hours");
        assert.isFalse(yield* overdue);
        yield* TestClock.adjust("61 minutes");
        assert.isTrue(yield* overdue);
        assert.isTrue(f.launchRequests.length > 0);
      }),
    ),
  );

  it.effect(
    "makes a Champion stuck after three failed reviews even while its readings succeed",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          for (let round = 1; round <= 3; round += 1) {
            yield* service.runReview({ id: config.id });
            f.completeRun(true);
            f.endRun();
            yield* runDueThroughReprompt(f, service);
            f.completeRun(false);
            yield* service.runCheck({ id: config.id });
            yield* service.report(f.caller(), {
              samples: [{ ...sample, value: 1 }],
              findings: [],
              summary: "In target",
            });
            const champion = (yield* service.get({ id: config.id })).champion;
            assert.equal(champion.consecutiveReviewFailures, round);
            assert.equal(champion.consecutiveCheckFailures, 0);
            f.endRun();
          }
          const stuck = (yield* service.get({ id: config.id })).champion;
          assert.isString(stuck.stuckEscalationThreadId);
          assert.equal(
            f.escalationLaunches.at(-1)!.title,
            "Quality: failed 3 goal reviews in a row",
          );
        }),
      ),
  );

  it.effect(
    "requires a whole 0-10 goal score with reasons and a change on a review, refuses one on readings, and keeps the series",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          for (const goalScore of [
            { score: 7.5, reasons: "r", change: "c" },
            { score: 11, reasons: "r", change: "c" },
            { score: -1, reasons: "r", change: "c" },
            { score: 6, reasons: "", change: "c" },
            { score: 6, reasons: "r" },
          ])
            assert.isTrue(
              Exit.isFailure(decodeReport({ samples: [], findings: [], summary: "s", goalScore })),
              JSON.stringify(goalScore),
            );
          yield* definitions(service);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          yield* service.runCheck({ id: config.id });
          yield* refusedWith(
            service.report(f.caller(), { ...goal(5), samples: [sample] }),
            "A readings run does not score the goal",
          );
          yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
          yield* service.runReview({ id: config.id });
          yield* refusedWith(
            service.report(f.caller(), { samples: [], findings: [], summary: "No score" }),
            "A goal review reports goalScore",
          );
          yield* service.report(f.caller(), goal(8, "Coverage is thin."));
          const detail = yield* service.get({ id: config.id });
          assert.deepEqual(
            detail.goalScores?.map(({ score, target, reasons }) => ({ score, target, reasons })),
            [{ score: 8, target: 7, reasons: "Coverage is thin." }],
          );
          assert.equal(detail.champion.goalScore?.score, 8);
          assert.isTrue(
            (yield* service.history({ id: config.id })).samples.some(
              (entry) => entry.seriesId === "goal-score" && entry.value === 8,
            ),
          );
        }),
      ),
  );

  it.effect("accepts a goal review's score sent through submitReport and returns it", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
        yield* service.runReview({ id: config.id });
        yield* service.submitReport(f.caller(), goal(8, "Coverage is thin."));
        const detail = yield* service.get({ id: config.id });
        assert.deepEqual(
          detail.goalScores?.map(({ score, reasons }) => ({ score, reasons })),
          [{ score: 8, reasons: "Coverage is thin." }],
        );
      }),
    ),
  );

  it.effect(
    "opens one goal finding below target, keeps it on a lower score, and closes it back at target while its case never ran",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* definitions(service);
          yield* service.upsert({ ...config, goalReview: { target: 9 } });
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          yield* service.runReview({ id: config.id });
          const below = yield* service.report(f.caller(), goal(8));
          const finding = below.findings.find((x) => x.id.endsWith(":goal"))!;
          assert.equal(finding.status, "open");
          assert.equal(f.escalationLaunches.length, 1);
          yield* service.runReview({ id: config.id });
          yield* service.report(f.caller(), goal(6));
          assert.equal(f.escalationLaunches.length, 1);
          yield* service.runReview({ id: config.id });
          const recovered = yield* service.report(f.caller(), goal(9));
          assert.equal(recovered.findings.find((x) => x.id === finding.id)!.status, "dismissed");
          assert.isTrue(
            f.commands.some(
              (command) =>
                command.type === "thread.settle" && command.threadId === finding.escalationThreadId,
            ),
          );
        }),
      ),
  );

  it.effect("starts an alarm case at once while attended, flagged as an alarm", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const reading = NodePath.join(f.realProjectRoot(), "reading");
        NodeFS.writeFileSync(reading, "50");
        yield* accepted(service, [{ ...collectedMetric(printsFile(reading)), alarm: 20 }]);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        // Even the first-ever readings run: an alarm never waits.
        const alarmed = yield* service.runCheck({ id: config.id });
        const finding = alarmed.findings[0]!;
        assert.isTrue(finding.alarm);
        assert.deepEqual(
          f.escalationLaunches.map(({ started, model }) => ({ started, model })),
          [{ started: true, model: "strong" }],
        );
        assert.include(f.escalationLaunches[0]!.text!, "reached an alarm");
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* readChampionShellRows(sql, json([finding.escalationThreadId])).pipe(
          Effect.orDie,
        );
        const shell = withChampions(rows)({
          id: finding.escalationThreadId,
        } as OrchestrationV2ThreadShell).champion;
        assert.include(shell, { severity: "incident", trigger: "Alarm reached", alarm: true });
      }),
    ),
  );

  it.effect("raises an alarm on two errored readings of an alarm metric in a row", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const reading = NodePath.join(f.realProjectRoot(), "reading");
        NodeFS.writeFileSync(reading, "not a number");
        yield* accepted(service, [{ ...collectedMetric(printsFile(reading)), alarm: 20 }]);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const once = yield* service.runCheck({ id: config.id });
        assert.deepEqual(once.findings, []);
        yield* TestClock.adjust("1 second");
        const twice = yield* service.runCheck({ id: config.id });
        assert.isTrue(twice.findings[0]!.alarm);
        assert.include(twice.findings[0]!.evidence, "could not be read twice in a row");
        assert.isTrue(f.escalationLaunches[0]!.started);
      }),
    ),
  );

  it.effect(
    "upgrades an open finding with an idle case that worsens past its alarm, starting the case",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          const { reading, finding, caseThread } = yield* breachWithCase(f, service, { alarm: 20 });
          assert.isUndefined(finding.alarm);
          assert.isFalse(f.escalationLaunches[0]!.started);
          NodeFS.writeFileSync(reading, "30");
          yield* TestClock.adjust("1 second");
          const worse = yield* service.runCheck({ id: config.id });
          const upgraded = worse.findings.find((x) => x.id === finding.id)!;
          assert.isTrue(upgraded.alarm);
          assert.equal(upgraded.escalationThreadId, caseThread);
          assert.equal(f.escalationLaunches.length, 1);
          assert.isTrue(
            f.sent.some(
              (message) =>
                message.threadId === caseThread && message.commandId.startsWith("champion-case:"),
            ),
          );
        }),
      ),
  );

  it.effect("keeps a metric's version when only its alarm value changes", () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const changed = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, alarm: 10 }],
          reason: "Alarm",
        });
        assert.equal(changed.metrics[0]!.version, 1);
        assert.equal(changed.metrics[0]!.alarm, 10);
        const again = yield* service.changeMetrics({
          id: config.id,
          metrics: [{ ...metric, alarm: 15 }],
          reason: "Alarm later",
        });
        assert.equal(again.metrics[0]!.version, 1);
        assert.equal(again.metrics[0]!.alarm, 15);
      }),
    ),
  );

  it.effect(
    "opens one case for a first-reading breach after a finished readings run, and never replaces an archived case while its finding stays open",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          const reading = NodePath.join(f.realProjectRoot(), "reading");
          NodeFS.writeFileSync(reading, "1");
          yield* accepted(service, [collectedMetric(printsFile(reading))]);
          yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
          yield* service.runCheck({ id: config.id });
          // A metric added later breaches on its very first reading: a case opens.
          const late = NodePath.join(f.realProjectRoot(), "late");
          NodeFS.writeFileSync(late, "9");
          yield* service.changeMetrics(
            {
              id: config.id,
              metrics: [
                collectedMetric(printsFile(reading)),
                collectedMetric(printsFile(late), "latency"),
              ],
              reason: "Measure latency",
            },
            undefined,
            { prove: false },
          );
          yield* TestClock.adjust("1 second");
          const breached = yield* service.runCheck({ id: config.id });
          const finding = breached.findings.find((x) => x.metricId === "latency")!;
          assert.equal(f.escalationLaunches.length, 1);
          f.updateCase(finding.escalationThreadId!, {
            archivedAt: DateTime.makeUnsafe(0),
          } as never);
          yield* TestClock.adjust("1 second");
          yield* service.runCheck({ id: config.id });
          assert.equal(f.escalationLaunches.length, 1);
          const still = (yield* service.get({ id: config.id })).findings.find(
            (x) => x.id === finding.id,
          )!;
          assert.equal(still.escalationThreadId, finding.escalationThreadId);
        }),
      ),
  );

  it.effect(
    "starts a case opened while Away with its first message on the escalation model, and switching to Away starts a never-run case",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          const attended = yield* caseFinding(f, service);
          assert.isFalse(f.escalationLaunches[0]!.started);
          assert.isFalse(
            f.sent.some((message) => message.threadId === attended.escalationThreadId),
          );
          yield* f.settings.setAway(true).pipe(Effect.orDie);
          // A case that never ran starts on the next pass.
          yield* service.runDue;
          const started = f.sent.filter(
            (message) => message.threadId === attended.escalationThreadId,
          );
          assert.equal(started.length, 1);
          assert.include(started[0]!.text, "Henry is away");
          yield* service.runDue;
          assert.equal(
            f.sent.filter((message) => message.threadId === attended.escalationThreadId).length,
            1,
          );
          // A case opened while away starts in the same launch.
          yield* service.runCheck({ id: config.id });
          yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 1 }],
            findings: [{ title: "Search is slow", evidence: "Ten seconds." }],
            summary: "Another",
          });
          assert.deepEqual(
            f.escalationLaunches.map(({ started, model }) => ({ started, model })),
            [
              { started: false, model: "strong" },
              { started: true, model: "strong" },
            ],
          );
        }),
      ),
  );

  it.effect("opens an upgraded finding's case once and lets it be dismissed", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        // The first-ever run's breach has no case, as a repair-era finding had none.
        const finding = (yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Breached",
        })).findings[0]!;
        assert.equal(f.escalationLaunches.length, 0);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO champion_case_backfill (champion_id, finding_id) VALUES (${config.id}, ${finding.id})`.pipe(
          Effect.orDie,
        );
        yield* service.runDue;
        yield* service.runDue;
        assert.equal(f.escalationLaunches.length, 1);
        const cased = (yield* service.get({ id: config.id })).findings[0]!;
        assert.equal(cased.escalationThreadId, f.escalationLaunches[0]!.threadId);
        const dismissed = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "dismiss",
          reason: "Released at upgrade; no longer relevant.",
        });
        assert.equal(dismissed.findings[0]!.status, "dismissed");
      }),
    ),
  );
});

describe("learnings reach their home (T3-937)", () => {
  const candidate = (n: number, extra: Record<string, unknown> = {}) => ({
    statement: `Trap ${n}`,
    evidence: `Seen ${n} times`,
    home: "doc" as const,
    ...extra,
  });
  const goal = (extra: Record<string, unknown> = {}) => ({
    samples: [],
    findings: [],
    summary: "Angles: reliability, tests.",
    goalScore: { score: 9, reasons: "Mostly fine.", change: "No change." },
    ...extra,
  });
  const review = Effect.fn("test.learningReview")(function* (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
    extra: Record<string, unknown> = {},
  ) {
    yield* service.runReview({ id: config.id });
    return yield* service.report(f.caller(), goal(extra) as never);
  });
  const activeChampion = Effect.fn("test.learningChampion")(function* (
    service: Champions.ChampionService["Service"],
  ) {
    yield* definitions(service);
    yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  });
  const stored = Effect.fn("test.storedCandidates")(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ statement: string; carried_by: string | null }>`
      SELECT statement, carried_by FROM champion_learning_candidates ORDER BY rowid`.pipe(
      Effect.orDie,
    );
  });
  const tidy = (detail: { readonly findings: ReadonlyArray<ChampionFinding> }) =>
    detail.findings.find((finding) => finding.id === `${config.id}:tidy-up`);
  const briefOf = Effect.fn("test.learningBrief")(function* (threadId: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* readEscalationBrief(sql, threadId).pipe(Effect.orDie);
  });
  const decodeReport = Schema.decodeUnknownExit(ChampionReportInput);
  const shellOfCase = Effect.fn("test.learningCaseShell")(function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* readChampionShellRows(sql, json([threadId])).pipe(Effect.orDie);
    return withChampions(rows)({ id: threadId } as OrchestrationV2ThreadShell).champion;
  });

  it.effect(
    "tells a goal review to read its knowledge home first, and a readings run nothing of it",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          yield* service.runCheck({ id: config.id });
          const readings = f.launchRequests.at(-1)!.text;
          yield* service.report(f.caller(), { samples: [sample], findings: [], summary: "x" });
          yield* service.runReview({ id: config.id });
          const text = f.sent.at(-1)!.text;
          for (const part of [
            "Before judging, read the area's knowledge home",
            "Known traps & rejected approaches",
            "the Decisions that govern it",
            `t3_champions_learning_search with championId ${config.id}`,
            "Never raise a known trap or a rejected approach as a new finding",
            "Nothing new is the normal result",
            "point-in-time status, counts, changelogs and one-off forensics are never learnings".replace(
              "point",
              "Point",
            ),
            "LEARNING REVIEW",
          ])
            assert.include(text, part);
          assert.notInclude(text, "durable product or engineering knowledge belongs in");
          for (const part of ["Known traps", "learningCandidates", "Nothing new", "WHAT YOU LEARN"])
            assert.notInclude(readings, part);
        }),
      ),
  );

  it.effect(
    "caps learnings and candidates, checks their fields, and refuses them on a readings run",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          const learning = { statement: "A trap", evidence: "Seen", home: "doc" };
          const finding = (learnings: unknown) => ({ title: "T", evidence: "E", learnings });
          const accepts = (input: object) =>
            Exit.isSuccess(decodeReport({ samples: [], findings: [], summary: "s", ...input }));
          assert.isTrue(accepts({ findings: [finding([learning, learning, learning])] }));
          assert.isFalse(
            accepts({ findings: [finding([learning, learning, learning, learning])] }),
          );
          assert.isFalse(accepts({ findings: [finding([{ ...learning, statement: "" }])] }));
          assert.isFalse(accepts({ findings: [finding([{ ...learning, evidence: " " }])] }));
          assert.isFalse(accepts({ findings: [finding([{ ...learning, home: "wiki" }])] }));
          assert.isFalse(
            accepts({ findings: [finding([{ ...learning, statement: "x".repeat(401) }])] }),
          );
          for (const home of [
            "decision",
            "doc",
            "glossary",
            "research",
            "agents",
            "champion",
            "check",
          ])
            assert.isTrue(accepts({ learningCandidates: [{ ...learning, home, urgent: true }] }));
          assert.isFalse(
            accepts({ learningCandidates: Array.from({ length: 6 }, () => learning) }),
          );
          assert.isFalse(accepts({ learningCandidates: [{ ...learning, urgent: "yes" }] }));

          yield* activeChampion(service);
          yield* service.runCheck({ id: config.id });
          yield* refusedWith(
            service.report(f.caller(), {
              samples: [sample],
              findings: [],
              summary: "x",
              learningCandidates: [candidate(1)],
            }),
            "A readings run reports no learnings",
          );
          yield* refusedWith(
            service.report(f.caller(), {
              samples: [sample],
              findings: [{ title: "T", evidence: "E", learnings: [learning as never] }],
              summary: "x",
            }),
            "A readings run reports no learnings",
          );
          assert.deepEqual(yield* stored(), []);
        }),
      ),
  );

  it.effect("lists a finding's learnings in its case brief, and nothing when it has none", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        const reported = yield* review(f, service, {
          findings: [
            {
              title: "Search is slow",
              evidence: "Ten seconds.",
              learnings: [
                { statement: "The index is rebuilt on boot", evidence: "boot log", home: "doc" },
                { statement: "Pick lists never page", evidence: "ui test", home: "glossary" },
              ],
            },
            { title: "Checkout fails", evidence: "The button does nothing." },
          ],
        });
        const withLearnings = reported.findings.find((x) => x.title === "Search is slow")!;
        const without = reported.findings.find((x) => x.title === "Checkout fails")!;
        assert.lengthOf(withLearnings.learnings ?? [], 2);
        const brief = yield* briefOf(withLearnings.escalationThreadId!);
        for (const part of [
          "Learnings to record",
          "1. [doc] The index is rebuilt on boot Evidence: boot log",
          "2. [glossary] Pick lists never page Evidence: ui test",
          "Verify each against the code",
          "same change as the fix",
          "Delete any Champion copy you promote in the same change",
          "Say what you did with each",
        ])
          assert.include(brief, part);
        assert.notInclude(yield* briefOf(without.escalationThreadId!), "Learnings to record");
      }),
    ),
  );

  it.effect(
    "batches candidates into one tidy-up finding at three or one urgent, joins it until its case runs, and reopens it for a later batch",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const two = yield* review(f, service, {
            learningCandidates: [candidate(1), candidate(2)],
          });
          assert.isUndefined(tidy(two));
          assert.lengthOf(f.escalationLaunches, 0);
          const opened = tidy(yield* review(f, service, { learningCandidates: [candidate(3)] }))!;
          assert.equal(opened.status, "open");
          assert.lengthOf(f.escalationLaunches, 1);
          assert.equal(f.escalationLaunches[0]!.threadId, opened.escalationThreadId);
          const caseThread = opened.escalationThreadId!;
          const brief = yield* briefOf(caseThread);
          for (const n of [1, 2, 3])
            assert.include(brief, `[doc] Trap ${n} Evidence: Seen ${n} times`);
          assert.deepEqual((yield* shellOfCase(caseThread))?.trigger, "Learnings to record");

          // Joins while its case has not run, with no second finding or case.
          const joined = yield* review(f, service, { learningCandidates: [candidate(4)] });
          assert.lengthOf(
            joined.findings.filter((x) => x.id.endsWith(":tidy-up")),
            1,
          );
          assert.lengthOf(f.escalationLaunches, 1);
          assert.include(yield* briefOf(caseThread), "4. [doc] Trap 4");

          // Once its case has run, a new candidate waits.
          f.updateCase(caseThread, { latestRunId: RunId.make("run:case") } as never);
          yield* review(f, service, { learningCandidates: [candidate(5)] });
          assert.notInclude(yield* briefOf(caseThread), "Trap 5");
          assert.deepEqual(
            (yield* stored()).map((row) => [row.statement, row.carried_by]),
            [
              ["Trap 1", opened.id],
              ["Trap 2", opened.id],
              ["Trap 3", opened.id],
              ["Trap 4", opened.id],
              ["Trap 5", null],
            ],
          );

          // Closing it after it ran clears only what it carried.
          const closed = yield* service.findingAction({
            id: config.id,
            findingId: opened.id,
            action: "verify",
            reason: "Recorded.",
          });
          assert.equal(tidy(closed)!.status, "verified");
          assert.deepEqual(
            (yield* stored()).map((row) => [row.statement, row.carried_by]),
            [["Trap 5", null]],
          );

          // Two more make three waiting: the same finding reopens with a fresh case.
          const again = tidy(
            yield* review(f, service, { learningCandidates: [candidate(6), candidate(7)] }),
          )!;
          assert.equal(again.id, opened.id);
          assert.equal(again.status, "open");
          // Its first case already took its brief, so the reopened finding gets a fresh one (Attended: idle).
          assert.lengthOf(f.escalationLaunches, 2);
          assert.notEqual(again.escalationThreadId, caseThread);
          assert.equal(f.escalationLaunches[1]!.threadId, again.escalationThreadId);
          assert.isFalse(f.escalationLaunches[1]!.started);
          const second = yield* briefOf(again.escalationThreadId!);
          for (const n of [5, 6, 7]) assert.include(second, `Trap ${n}`);
          assert.notInclude(second, "Trap 4");
        }),
      ),
  );

  it.effect(
    "returns the candidates to waiting when a tidy-up case closes before it ran, and dismiss after it ran clears them",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const opened = tidy(
            yield* review(f, service, {
              learningCandidates: [candidate(1), candidate(2), candidate(3)],
            }),
          )!;
          const early = yield* service.findingAction({
            id: config.id,
            findingId: opened.id,
            action: "dismiss",
            reason: "Not now.",
          });
          assert.equal(tidy(early)!.status, "dismissed");
          assert.deepEqual(
            (yield* stored()).map((row) => row.carried_by),
            [null, null, null],
          );
          // The next review finds three waiting and reopens the same finding.
          const reopened = tidy(yield* review(f, service))!;
          assert.equal(reopened.id, opened.id);
          assert.equal(reopened.status, "open");
          f.updateCase(reopened.escalationThreadId!, {
            latestRunId: RunId.make("run:case"),
          } as never);
          yield* service.findingAction({
            id: config.id,
            findingId: opened.id,
            action: "dismiss",
            reason: "None hold.",
          });
          assert.deepEqual(yield* stored(), []);
        }),
      ),
  );

  it.effect("starts a fresh tidy-up case while Away when a closed one that ran is reopened", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        yield* f.settings.setAway(true).pipe(Effect.orDie);
        const first = tidy(
          yield* review(f, service, {
            learningCandidates: [candidate(1), candidate(2), candidate(3)],
          }),
        )!;
        assert.isTrue(f.escalationLaunches[0]!.started);
        yield* service.findingAction({
          id: config.id,
          findingId: first.id,
          action: "verify",
          reason: "Recorded.",
        });
        const again = tidy(
          yield* review(f, service, {
            learningCandidates: [candidate(4), candidate(5), candidate(6)],
          }),
        )!;
        assert.equal(again.id, first.id);
        assert.notEqual(again.escalationThreadId, first.escalationThreadId);
        assert.lengthOf(f.escalationLaunches, 2);
        assert.isTrue(f.escalationLaunches[1]!.started);
        assert.equal(f.escalationLaunches[1]!.threadId, again.escalationThreadId);
        const brief = yield* briefOf(again.escalationThreadId!);
        for (const n of [4, 5, 6]) assert.include(brief, `Trap ${n}`);
        assert.notInclude(brief, "Trap 1");
      }),
    ),
  );

  it.effect("lets a candidate join only while its case has no message and no run", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        const opened = tidy(
          yield* review(f, service, {
            learningCandidates: [candidate(1), candidate(2), candidate(3)],
          }),
        )!;
        // The first message exists but its run row does not yet.
        f.addMessage(opened.escalationThreadId as ThreadId, "Start this case.");
        yield* review(f, service, { learningCandidates: [candidate(4)] });
        assert.notInclude(yield* briefOf(opened.escalationThreadId!), "Trap 4");
        assert.deepEqual(
          (yield* stored()).map((row) => row.carried_by),
          [opened.id, opened.id, opened.id, null],
        );
      }),
    ),
  );

  it.effect(
    "turns learnings added to a finding whose case already took its brief into waiting candidates",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const learning = (statement: string) => ({
            statement,
            evidence: "Seen",
            home: "doc" as const,
          });
          const raised = yield* review(f, service, {
            findings: [
              { title: "Search is slow", evidence: "Ten seconds." },
              { title: "Checkout fails", evidence: "The button does nothing." },
            ],
          });
          const ran = raised.findings.find((x) => x.title === "Search is slow")!;
          const idle = raised.findings.find((x) => x.title === "Checkout fails")!;
          f.updateCase(
            ran.escalationThreadId as ThreadId,
            { latestRunId: RunId.make("run:case") } as never,
          );
          const next = yield* review(f, service, {
            findings: [
              {
                existingFindingId: ran.id,
                title: ran.title,
                evidence: "Still",
                learnings: [learning("Late one")],
              },
              {
                existingFindingId: idle.id,
                title: idle.title,
                evidence: "Still",
                learnings: [learning("Early one")],
              },
            ],
          });
          assert.isUndefined(next.findings.find((x) => x.id === ran.id)!.learnings);
          assert.deepEqual(next.findings.find((x) => x.id === idle.id)!.learnings, [
            learning("Early one"),
          ]);
          assert.deepEqual(
            (yield* stored()).map((row) => [row.statement, row.carried_by]),
            [["Late one", null]],
          );
          assert.notInclude(yield* briefOf(ran.escalationThreadId!), "Late one");
          assert.include(yield* briefOf(idle.escalationThreadId!), "Early one");
          // Two more reach three waiting and the tidy-up case delivers all of them.
          const tidied = tidy(
            yield* review(f, service, { learningCandidates: [candidate(1), candidate(2)] }),
          )!;
          assert.include(yield* briefOf(tidied.escalationThreadId!), "Late one");
        }),
      ),
  );

  it.effect(
    "counts only waiting candidates toward the cap of 20 and tells the review what it dropped",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const opened = tidy(
            yield* review(f, service, {
              learningCandidates: [candidate(1), candidate(2), candidate(3)],
            }),
          )!;
          f.updateCase(
            opened.escalationThreadId as ThreadId,
            {
              latestRunId: RunId.make("run:case"),
            } as never,
          );
          for (let batch = 0; batch < 4; batch += 1)
            yield* review(f, service, {
              learningCandidates: Array.from({ length: 5 }, (_, n) =>
                candidate(10 + batch * 5 + n),
              ),
            });
          const rows = yield* stored();
          // Three carried plus twenty waiting: the carried ones do not count.
          assert.lengthOf(rows, 23);
          assert.isFalse(
            (yield* service.get({ id: config.id })).champion.attention.some((line) =>
              line.startsWith("Review dropped"),
            ),
          );
          const full = yield* review(f, service, {
            learningCandidates: [candidate(90), candidate(91)],
          });
          assert.lengthOf(yield* stored(), 23);
          assert.isTrue(
            full.champion.attention.includes(
              "Review dropped 2 learning candidates: 20 already wait to be recorded.",
            ),
          );
          // The next review that drops nothing clears the note.
          const quiet = yield* review(f, service);
          assert.isFalse(
            quiet.champion.attention.some((line) => line.startsWith("Review dropped")),
          );
        }),
      ),
  );

  it.effect("returns carried candidates to waiting when retiring closes the tidy-up finding", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        yield* review(f, service, {
          learningCandidates: [candidate(1), candidate(2), candidate(3)],
        });
        yield* service.setLifecycle({ id: config.id, lifecycle: "retired" });
        assert.deepEqual(
          (yield* stored()).map((row) => row.carried_by),
          [null, null, null],
        );
      }),
    ),
  );

  it.effect(
    "opens the tidy-up finding at once for an urgent candidate, even at the open-findings limit",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const full = yield* review(f, service, {
            findings: Array.from({ length: 12 }, (_, n) => ({
              title: `Weakness number ${n}`,
              evidence: "Weak.",
            })),
          });
          assert.equal(full.findings.filter((x) => x.status === "open").length, 10);
          const urgent = tidy(
            yield* review(f, service, { learningCandidates: [candidate(1, { urgent: true })] }),
          )!;
          assert.equal(urgent.status, "open");
          assert.equal(urgent.escalationThreadId, f.escalationLaunches.at(-1)!.threadId);
          assert.include(yield* briefOf(urgent.escalationThreadId!), "Trap 1");
        }),
      ),
  );

  it.effect("opens a third waiting candidate's tidy-up finding at the open-findings limit", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        yield* review(f, service, {
          findings: Array.from({ length: 12 }, (_, n) => ({
            title: `Weakness number ${n}`,
            evidence: "Weak.",
          })),
        });
        yield* review(f, service, { learningCandidates: [candidate(1), candidate(2)] });
        const third = tidy(yield* review(f, service, { learningCandidates: [candidate(3)] }))!;
        assert.equal(third.status, "open");
        const brief = yield* briefOf(third.escalationThreadId!);
        for (const n of [1, 2, 3]) assert.include(brief, `Trap ${n}`);
      }),
    ),
  );

  it.effect(
    "starts the tidy-up case at once while Away, with the workspace rule and every learnings route",
    () =>
      withFixture((f, service) =>
        Effect.gen(function* () {
          yield* activeChampion(service);
          const attended = tidy(
            yield* review(f, service, {
              learningCandidates: [candidate(1), candidate(2), candidate(3)],
            }),
          )!;
          assert.isFalse(f.escalationLaunches[0]!.started);
          yield* f.settings.setAway(true).pipe(Effect.orDie);
          yield* service.runDue;
          assert.equal(
            f.sent.filter((message) => message.threadId === attended.escalationThreadId).length,
            1,
          );
          const brief = yield* briefOf(attended.escalationThreadId!);
          for (const part of [
            CASE_WORKSPACE_RULE,
            "decision: a product or architectural rule becomes a Decision proposal",
            "agents: a tool or harness behaviour goes in ~/.agents, which is plain git",
            `.agents/champions/<id>/learnings/ by landing`,
            "check: a rule a test or check can enforce",
            "~/.agents/references/learnings.md",
          ])
            assert.include(brief, part);
        }),
      ),
  );

  it.effect("starts a tidy-up case opened while Away in its launch", () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* activeChampion(service);
        yield* f.settings.setAway(true).pipe(Effect.orDie);
        yield* review(f, service, {
          learningCandidates: [candidate(1), candidate(2), candidate(3)],
        });
        assert.isTrue(f.escalationLaunches.at(-1)!.started);
      }),
    ),
  );

  it.effect(
    "keeps a hosted Champion's candidates through a folder re-import and batches them",
    () =>
      withFolders((f, service, world) =>
        Effect.gen(function* () {
          const files = folderFiles({});
          world.push({
            ...files,
            [`${FOLDER}/champion.md`]: files[`${FOLDER}/champion.md`]!.replace(
              /lifecycle: \w+/,
              "lifecycle: active",
            ),
          });
          yield* service.syncFolders;
          assert.isDefined((yield* service.get({ id: config.id })).champion.folder);
          yield* review(f, service, { learningCandidates: [candidate(1), candidate(2)] });
          assert.lengthOf(yield* stored(), 2);
          // The folder changes and is read again.
          world.push({ [`${FOLDER}/notes.md`]: "Edited notes.\n" });
          yield* service.syncFolders;
          yield* service.syncFolders;
          assert.deepEqual(
            (yield* stored()).map((row) => [row.statement, row.carried_by]),
            [
              ["Trap 1", null],
              ["Trap 2", null],
            ],
          );
          assert.isUndefined(tidy(yield* service.get({ id: config.id })));
          const opened = tidy(yield* review(f, service, { learningCandidates: [candidate(3)] }))!;
          assert.equal(opened.status, "open");
          const brief = yield* briefOf(opened.escalationThreadId!);
          for (const n of [1, 2, 3]) assert.include(brief, `Trap ${n}`);
          yield* service.syncFolders;
          assert.lengthOf(yield* stored(), 3);
        }),
      ),
  );
});
