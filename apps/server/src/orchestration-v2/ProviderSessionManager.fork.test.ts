import * as NetAddress from "effect/net/NetAddress";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerFailingReleaseEventSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(layerTestEventSink));

interface FlakyReleaseWrites {
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  readonly failures: Queue.Queue<void>;
  readonly pauseRequestWrites?: {
    readonly paused: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            const pause = flaky.pauseRequestWrites;
            if (
              pause !== undefined &&
              input.events.some((event) => event.type === "runtime-request.updated")
            ) {
              yield* Deferred.succeed(pause.paused, undefined);
              yield* Deferred.await(pause.resume);
            }
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerReleaseRecordedEventSink = (recorded: Deferred.Deferred<void>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          delegate
            .write(input)
            .pipe(
              Effect.tap(() =>
                input.events.some(
                  (event) =>
                    event.type === "provider-session.updated" &&
                    (event.payload.status === "stopped" || event.payload.status === "error"),
                )
                  ? Deferred.succeed(recorded, undefined)
                  : Effect.void,
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerBeforeUnchangedWriteEventSink = (
  before: Ref.Ref<Effect.Effect<void>>,
  // One effect runs before each turn-item write, in order.
  beforeTurnItems: Ref.Ref<ReadonlyArray<Effect.Effect<void>>> | undefined,
) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        writeIfProviderThreadUnchanged: (input) =>
          Ref.getAndSet(before, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(delegate.writeIfProviderThreadUnchanged(input)),
          ),
        writeIfTurnItemUnchanged: (input) =>
          (beforeTurnItems === undefined
            ? Effect.void
            : Ref.modify(beforeTurnItems, ([next, ...rest]) => [next ?? Effect.void, rest]).pipe(
                Effect.flatten,
              )
          ).pipe(Effect.andThen(delegate.writeIfTurnItemUnchanged(input))),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly eventQueues: ReadonlyMap<
    string,
    Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>
  >;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  unloadedNativeThreadIds: [],
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
  readonly managedBrowser?: boolean;
  readonly delegatedBy?: ThreadId;
  readonly agentTask?: Partial<NonNullable<OrchestrationV2AppThread["agentTask"]>>;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage:
        input.delegatedBy === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
          : {
              parentThreadId: input.delegatedBy,
              relationshipToParent: "subagent",
              rootThreadId: input.delegatedBy,
            },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...(input.managedBrowser || input.agentTask !== undefined
        ? {
            agentTask: {
              role: "browser" as const,
              taskClass: "ui" as const,
              browser: { backend: "phi" as const },
              workId: "browser-work",
              attemptId: "1",
              workspacePath: "/fixture/browser",
              sourceRevision: "revision-one",
              requestFingerprint: "a".repeat(64),
              policyHash: "b".repeat(64),
              policyRevision: "test",
              briefHash: "c".repeat(64),
              sourceAccess: "read-only" as const,
              toolProfile: "phi" as const,
              requested: modelSelection,
              assigned: null,
              effective: modelSelection,
              ...input.agentTask,
            },
          }
        : {}),
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}

const makeProviderAdapter = Effect.fnUntraced(function* (
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly failEventStream?: boolean;
    readonly normalizeThreadLoadModelSelection?: (selection: ModelSelection) => ModelSelection;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly extensionStatuses?: OrchestrationV2ProviderSession["extensionStatuses"];
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly backgroundTasksEndWithProcess?: boolean;
    readonly hangSessionScopeClose?: boolean;
    readonly startTurn?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
    readonly interruptTurn?: Effect.Effect<void>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly unloads?: Queue.Queue<string>;
    readonly archive?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
    readonly spawnBeforeOpen?: boolean;
    readonly scopeCloseReached?: Deferred.Deferred<void>;
    readonly eventStreamsEnded?: Queue.Queue<ProviderSessionId>;
  } = {},
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const countClose = Effect.addFinalizer(() =>
    Ref.update(state, (current) => ({
      ...current,
      closeCount: current.closeCount + 1,
    })).pipe(
      Effect.andThen(
        options.unloads === undefined ? Effect.void : Queue.offer(options.unloads, "close"),
      ),
    ),
  );
  // Register after countClose to wedge teardown before its finalizer, matching a provider stream that never yields.
  const hangClose = Effect.addFinalizer(() =>
    (options.scopeCloseReached === undefined
      ? Effect.void
      : Deferred.succeed(options.scopeCloseReached, undefined)
    ).pipe(Effect.andThen(Effect.never)),
  );
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.spawnBeforeOpen === true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen === true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen !== true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        let session: OrchestrationV2ProviderSession = {
          ...makeProviderSession({
            providerSessionId: input.providerSessionId,
            now,
            ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
          }),
          ...(options.extensionStatuses === undefined
            ? {}
            : { extensionStatuses: options.extensionStatuses }),
        };
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        if (options.spawnBeforeOpen !== true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }

        return {
          instanceId: ProviderInstanceId.make("codex"),
          driver: CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          ...(options.normalizeThreadLoadModelSelection === undefined
            ? {}
            : { normalizeThreadLoadModelSelection: options.normalizeThreadLoadModelSelection }),
          get providerSession() {
            return session;
          },
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events).pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event.type === "provider_session.updated") session = event.providerSession;
                  }),
                ),
                Stream.ensuring(
                  options.eventStreamsEnded === undefined
                    ? Effect.void
                    : Queue.offer(options.eventStreamsEnded, input.providerSessionId),
                ),
              ),
          ...(options.backgroundTasksEndWithProcess === false
            ? {}
            : { backgroundTasksEndWithProcess: true as const }),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: () => options.hasPendingBackgroundWorkForThread!,
              }),
          ensureThread: () => unimplemented("ensureThread unused in test"),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(Effect.as(threadInput.providerThread)),
          startTurn: () => options.startTurn ?? Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })).pipe(Effect.andThen(options.interruptTurn ?? Effect.void)),
          unloadThread: ({ providerThread, archive }) =>
            (options.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  unloadedNativeThreadIds: [
                    ...current.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
              Effect.andThen(
                options.unloads === undefined
                  ? Effect.void
                  : Queue.offer(
                      options.unloads,
                      `${archive === true ? "archive" : "unload"}:${providerThread.nativeThreadRef?.nativeId}`,
                    ),
              ),
              Effect.andThen(archive === true ? (options.archive ?? Effect.void) : Effect.void),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});

function layerTest(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs?: number;
  readonly failEventStream?: boolean;
  readonly normalizeThreadLoadModelSelection?: (selection: ModelSelection) => ModelSelection;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly extensionStatuses?: OrchestrationV2ProviderSession["extensionStatuses"];
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly flakyReleaseWrites?: FlakyReleaseWrites;
  readonly pauseAttachWrite?: Parameters<typeof layerPausingAttachEventSink>[0];
  readonly beforeUnchangedWrite?: Ref.Ref<Effect.Effect<void>>;
  readonly beforeTurnItemsWrite?: Ref.Ref<ReadonlyArray<Effect.Effect<void>>>;
  readonly pauseResolve?: {
    readonly armed: Ref.Ref<boolean>;
    readonly paused: Deferred.Deferred<void>;
  };
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
  readonly backgroundTasksEndWithProcess?: boolean;
  readonly hangSessionScopeClose?: boolean;
  readonly startTurn?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly interruptTurn?: Effect.Effect<void>;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly unloads?: Queue.Queue<string>;
  readonly archive?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly spawnBeforeOpen?: boolean;
  readonly scopeCloseReached?: Deferred.Deferred<void>;
  readonly eventStreamsEnded?: Queue.Queue<ProviderSessionId>;
  readonly releaseRecorded?: Deferred.Deferred<void>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
  readonly installationGateLayer?: Layer.Layer<ProviderInstallationGate.ProviderInstallationGate>;
}) {
  const layerConfiguredEventSink =
    input.flakyReleaseWrites !== undefined
      ? layerFlakyReleaseEventSink(input.flakyReleaseWrites)
      : input.pauseAttachWrite !== undefined
        ? layerPausingAttachEventSink(input.pauseAttachWrite)
        : input.beforeUnchangedWrite !== undefined
          ? layerBeforeUnchangedWriteEventSink(
              input.beforeUnchangedWrite,
              input.beforeTurnItemsWrite,
            )
          : input.failReleaseEventWrites
            ? layerFailingReleaseEventSink
            : input.releaseRecorded !== undefined
              ? layerReleaseRecordedEventSink(input.releaseRecorded)
              : layerTestEventSink;
  const layerRegistry = Layer.unwrap(
    makeProviderAdapter(input.state, {
      failEventStream: input.failEventStream ?? false,
      ...(input.normalizeThreadLoadModelSelection === undefined
        ? {}
        : { normalizeThreadLoadModelSelection: input.normalizeThreadLoadModelSelection }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.extensionStatuses === undefined
        ? {}
        : { extensionStatuses: input.extensionStatuses }),
      ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
      ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
      ...(input.hasPendingBackgroundWork === undefined
        ? {}
        : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
      ...(input.hasPendingBackgroundWorkForThread === undefined
        ? {}
        : { hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread }),
      ...(input.backgroundTasksEndWithProcess === undefined
        ? {}
        : { backgroundTasksEndWithProcess: input.backgroundTasksEndWithProcess }),
      ...(input.hangSessionScopeClose === undefined
        ? {}
        : { hangSessionScopeClose: input.hangSessionScopeClose }),
      ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
      ...(input.interruptTurn === undefined ? {} : { interruptTurn: input.interruptTurn }),
      ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
      ...(input.unloads === undefined ? {} : { unloads: input.unloads }),
      ...(input.archive === undefined ? {} : { archive: input.archive }),
      ...(input.spawnBeforeOpen === undefined ? {} : { spawnBeforeOpen: input.spawnBeforeOpen }),
      ...(input.scopeCloseReached === undefined
        ? {}
        : { scopeCloseReached: input.scopeCloseReached }),
      ...(input.eventStreamsEnded === undefined
        ? {}
        : { eventStreamsEnded: input.eventStreamsEnded }),
    }).pipe(Effect.map(ProviderAdapterRegistry.layerSingle)),
  );
  const layerConfiguredMcpRegistry =
    input.pauseResolve === undefined
      ? layerTestMcpRegistry
      : layerPausingMcpRegistry(input.pauseResolve);
  const layerProviderEventIngestorTest = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.undefined,
        }),
        layerConfiguredEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveBranchName: () => Effect.succeed(null),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestStores,
    layerConfiguredEventSink,
    IdAllocator.layer,
    layerConfiguredMcpRegistry,
    McpProviderSessions.layer,
    ProviderSessionManager.layerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerRegistry.pipe(Layer.provideMerge(McpProviderSessions.layer)),
          CommandOutputHub.layer.pipe(
            Layer.provide(Layer.merge(layerConfiguredEventSink, layerTestStores)),
          ),
          layerConfiguredEventSink,
          IdAllocator.layer,
          layerProviderEventIngestorTest,
          layerConfiguredMcpRegistry,
          layerTestStores,
          input.installationGateLayer ?? ProviderInstallationGate.layer,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
        ),
      ),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const layerTestMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerPausingMcpRegistry = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const delegate = yield* McpSessionRegistry.McpSessionRegistry;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...delegate,
        resolve: (rawToken) =>
          Ref.getAndSet(pause.armed, false).pipe(
            Effect.flatMap((armed) =>
              armed
                ? Deferred.succeed(pause.paused, undefined).pipe(Effect.andThen(Effect.never))
                : delegate.resolve(rawToken),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestMcpRegistry));

function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly projectOverride?: boolean;
  readonly otherProjectOverride?: boolean;
  readonly projectServicePresent?: boolean;
  readonly agentBrowserBackends?: import("@t3tools/contracts").AgentBrowserBackends;
  readonly deviceOverride?: boolean;
  readonly managedBrowser?: boolean;
  readonly enableAgentDeviceAccess?: boolean;
  readonly enableDeviceSupport?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
  readonly projectReadFails?: boolean;
  readonly delegatedBy?: ThreadId;
  readonly agentTask?: Partial<NonNullable<OrchestrationV2AppThread["agentTask"]>>;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const layerProjectService = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        input.projectReadFails === true
          ? Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "read-project",
                projectId: requestedProjectId,
                cause: "project store unavailable",
              }),
            )
          : Effect.succeed(
              input.projectExists === false
                ? Option.none()
                : Option.some(makeBrowserAccessProject(requestedProjectId)),
            ),
    });

    const resolved = yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now,
              projectId,
              ...(input.managedBrowser ? { managedBrowser: true } : {}),
              ...(input.delegatedBy === undefined ? {} : { delegatedBy: input.delegatedBy }),
              ...(input.agentTask === undefined ? {} : { agentTask: input.agentTask }),
            }),
          ],
        });
      }
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.ignore);
      const captured = (yield* Ref.get(mcpConfigs))[0];
      if (captured !== undefined) {
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        return yield* registry.resolve(captured.authorizationHeader.replace(/^Bearer\s+/, ""));
      }
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          ...(input.projectServicePresent === false
            ? {}
            : { projectServiceLayer: layerProjectService }),
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            ...(input.agentBrowserBackends === undefined
              ? {}
              : { agentBrowserBackends: input.agentBrowserBackends }),
            ...(input.enableAgentDeviceAccess === undefined
              ? {}
              : { enableAgentDeviceAccess: input.enableAgentDeviceAccess }),
            ...(input.enableDeviceSupport === undefined
              ? {}
              : { enableDeviceSupport: input.enableDeviceSupport }),
            projectSettingsOverrides: {
              ...(input.otherProjectOverride === undefined
                ? {}
                : {
                    "other-project": { enableAgentBrowserAccess: input.otherProjectOverride },
                  }),
              [projectId]: {
                ...(input.projectOverride === undefined
                  ? {}
                  : { enableAgentBrowserAccess: input.projectOverride }),
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );

    const captured = (yield* Ref.get(mcpConfigs))[0];
    return captured === undefined
      ? undefined
      : {
          ...captured,
          browserBackends: resolved?.browserBackends,
          resolvedManagedBrowser: resolved?.managedBrowser,
          resolvedBoundedBrowser: resolved?.boundedBrowser,
          resolvedEndpointKey: resolved?.endpointKey,
        };
  });
}

it.effect("ProviderSessionManagerV2 gives a Spec lead a top-level thread's MCP listing", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const parentThreadId = ThreadId.make("thread-provider-session-manager-arc-lead");
      const leadThreadId = ThreadId.make("thread-provider-session-manager-spec-lead");
      const parent = yield* makeThreadCreatedEvent({ idAllocator, threadId: parentThreadId, now });
      const lead = yield* makeThreadCreatedEvent({ idAllocator, threadId: leadThreadId, now });
      yield* eventSink.write({
        events: [
          parent,
          {
            ...lead,
            payload: {
              ...lead.payload,
              lineage: {
                parentThreadId,
                relationshipToParent: "subagent",
                rootThreadId: parentThreadId,
              },
              agentTask: {
                role: "lead" as const,
                taskClass: "non-ui" as const,
                workId: "spec-lead-work",
                attemptId: "1",
                workspacePath: "/fixture/spec-lead",
                requestFingerprint: "a".repeat(64),
                policyHash: "b".repeat(64),
                policyRevision: "test",
                briefHash: "c".repeat(64),
                sourceAccess: "scoped-write" as const,
                toolProfile: "implementation" as const,
                requested: modelSelection,
                assigned: null,
                effective: modelSelection,
              },
            },
          },
        ],
      });
      const listings = [];
      for (const threadId of [parentThreadId, leadThreadId]) {
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        const config = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(config);
        const resolved = yield* registry.resolve(
          config!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        const {
          threadId: _threadId,
          providerSessionId: _providerSessionId,
          authorizationHeader: _authorizationHeader,
          hasPendingWake,
          ...listing
        } = config!;
        listings.push({
          listing,
          capabilities: resolved?.capabilities,
          hasPendingWake: hasPendingWake === undefined ? undefined : yield* hasPendingWake,
        });
        yield* manager.close(providerSessionId);
      }
      assert.deepEqual(listings[1], listings[0]);
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

it.effect(
  "gives a granted implementer bounded tasks and never Phi, whatever its project allows",
  () =>
    Effect.gen(function* () {
      const parent = ThreadId.make("thread-bounded-ui-parent");
      const uiWorker = {
        role: "implementer" as const,
        sourceAccess: "scoped-write" as const,
        toolProfile: "implementation" as const,
        browserTasks: true as const,
      };
      for (const agentBrowserBackends of [
        { enabled: ["integrated"], default: "integrated" },
        { enabled: ["phi", "integrated"], default: "phi" },
      ] as const) {
        const captured = yield* runBrowserAccessScenario({
          enableAgentBrowserAccess: true,
          agentBrowserBackends,
          delegatedBy: parent,
          agentTask: uiWorker,
        });
        assert.isTrue(captured?.boundedBrowser);
        assert.isUndefined(captured?.resolvedManagedBrowser);
        assert.match(captured?.endpoint ?? "", /\/mcp\/editor$/);
      }
    }),
);
