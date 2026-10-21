import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import { ProviderDriverKind, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          getThreadShell: () => Effect.succeed(null),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

/** Sends a pooled model change and follow-up to a thread on `claude_later`, returning the accounts each was routed to. */
const routePooledThread = (input: {
  readonly hasRun: boolean;
  readonly preferredMember?: ProviderInstanceId;
}) => {
  const projectId = ProjectId.make("project:thread-management:pool");
  const threadId = ThreadId.make("thread:thread-management:pool");
  const pool = ProviderInstanceId.make("claude_pool");
  const later = ProviderInstanceId.make("claude_later");
  const sooner = ProviderInstanceId.make("claude_sooner");
  const member = (instanceId: ProviderInstanceId, resetsAt: string): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-10-15T00:00:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 50, resetsAt }],
    },
  });
  const providers: ReadonlyArray<ServerProvider> = [
    member(later, "2026-10-15T04:00:00.000Z"),
    member(sooner, "2026-10-15T02:00:00.000Z"),
    {
      ...member(sooner, "2026-10-15T02:00:00.000Z"),
      instanceId: pool,
      poolMembers: [later, sooner],
      ...(input.preferredMember ? { poolPreferredMember: input.preferredMember } : {}),
    },
  ];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { id: threadId, projectId, deletedAt: null },
          } as unknown as OrchestrationV2ThreadProjection),
        getThreadShell: () =>
          Effect.succeed({
            modelSelection: { instanceId: later, model: "claude-test" },
            latestRunId: input.hasRun ? "run:thread-management:pool" : null,
          } as unknown as OrchestrationV2ThreadShell),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(ProviderRegistryMock.layer(providers)),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [later]: { driver: ProviderDriverKind.make("claudeAgent") },
          [sooner]: { driver: ProviderDriverKind.make("claudeAgent") },
        },
      }),
    ),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:thread-management:pool-new"),
      threadId,
      modelSelection: { instanceId: pool, model: "claude-test" },
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:thread-management:pool-follow-up"),
      threadId,
      messageId: MessageId.make("message:thread-management:pool-follow-up"),
      text: "Carry on.",
      attachments: [],
      modelSelection: { instanceId: pool, model: "claude-test" },
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    return dispatched.map((command) =>
      "modelSelection" in command ? command.modelSelection?.instanceId : undefined,
    );
  }).pipe(Effect.provide(layerTest));
};

it.effect("routes a pooled selection to a member account before the orchestrator sees it", () =>
  Effect.gen(function* () {
    // Both keep the thread on its member, which still has allowance.
    expect(yield* routePooledThread({ hasRun: true })).toEqual(["claude_later", "claude_later"]);
  }),
);

it.effect("places a thread that has not run like a new one", () =>
  Effect.gen(function* () {
    // The allowance that resets sooner is spent first.
    expect(yield* routePooledThread({ hasRun: false })).toEqual(["claude_sooner", "claude_sooner"]);
    expect(
      yield* routePooledThread({
        hasRun: false,
        preferredMember: ProviderInstanceId.make("claude_later"),
      }),
    ).toEqual(["claude_later", "claude_later"]);
  }),
);

describe("pooled routing refreshes the chosen member's usage near its limit", () => {
  const projectId = ProjectId.make("project:thread-management:pool-refresh");
  const threadId = ThreadId.make("thread:thread-management:pool-refresh");
  const pool = ProviderInstanceId.make("claude_pool");
  const current = ProviderInstanceId.make("claude_current");
  const other = ProviderInstanceId.make("claude_other");
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  const iso = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offsetMs));
  const member = (
    instanceId: ProviderInstanceId,
    usedPercent: number,
    readAgoMs: number,
  ): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(-readAgoMs),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(-readAgoMs),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: iso(3_600_000),
        },
      ],
    },
  });

  // Routes one message on `current` and reports the member it landed on and how many
  // refreshes the registry was asked for. `refreshedUsedPercent` is what a refresh finds.
  const route = (input: {
    readonly usedPercent: number;
    readonly readAgoMs: number;
    readonly refreshedUsedPercent: number;
    /** The other member's reading, by default fresh and well within allowance. */
    readonly other?: { readonly usedPercent: number; readonly readAgoMs: number };
  }) => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const refreshed: Array<ProviderInstanceId> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        member(current, input.usedPercent, input.readAgoMs),
        member(other, input.other?.usedPercent ?? 10, input.other?.readAgoMs ?? 0),
        { ...member(other, 10, 0), instanceId: pool, poolMembers: [current, other] },
      ]);
      const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Ref.get(providers),
        refreshInstanceUsage: (instanceId) =>
          Effect.sync(() => refreshed.push(instanceId)).pipe(
            Effect.andThen(
              Ref.updateAndGet(providers, (all) =>
                all.map((provider) =>
                  provider.instanceId === instanceId
                    ? member(instanceId, input.refreshedUsedPercent, 0)
                    : provider,
                ),
              ),
            ),
          ),
      });
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { id: threadId, projectId, deletedAt: null },
              } as unknown as OrchestrationV2ThreadProjection),
            getThreadShell: () =>
              Effect.succeed({
                modelSelection: { instanceId: current, model: "claude-test" },
              } as unknown as OrchestrationV2ThreadShell),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
        ),
        Layer.provide(registry),
        Layer.provide(
          ServerSettings.layerTest({
            providerInstances: {
              [current]: { driver: ProviderDriverKind.make("claudeAgent") },
              [other]: { driver: ProviderDriverKind.make("claudeAgent") },
            },
          }),
        ),
        Layer.provide(layerReceiptsTest),
      );
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:thread-management:pool-refresh"),
          threadId,
          messageId: MessageId.make("message:thread-management:pool-refresh"),
          text: "Carry on.",
          attachments: [],
          modelSelection: { instanceId: pool, model: "claude-test" },
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }).pipe(Effect.provide(layerTest));
      const [command] = dispatched;
      return {
        member: command && "modelSelection" in command ? command.modelSelection?.instanceId : null,
        refreshed,
      };
    });
  };

  it.effect("refreshes a stale reading at 95% and moves off a member it finds exhausted", () =>
    Effect.gen(function* () {
      const result = yield* route({
        usedPercent: 96,
        readAgoMs: 120_000,
        refreshedUsedPercent: 100,
      });
      expect(result).toEqual({ member: other, refreshed: [current] });
    }),
  );

  it.effect("keeps the member when the refresh finds allowance left", () =>
    Effect.gen(function* () {
      const result = yield* route({
        usedPercent: 96,
        readAgoMs: 120_000,
        refreshedUsedPercent: 97,
      });
      expect(result).toEqual({ member: current, refreshed: [current] });
    }),
  );

  it.effect("refreshes the member a refresh moves it to, each member at most once", () =>
    Effect.gen(function* () {
      const result = yield* route({
        usedPercent: 96,
        readAgoMs: 120_000,
        refreshedUsedPercent: 100,
        other: { usedPercent: 97, readAgoMs: 120_000 },
      });
      expect(result.refreshed).toEqual([current, other]);
    }),
  );

  it.effect("does not refresh a stale reading below 95%", () =>
    Effect.gen(function* () {
      const result = yield* route({
        usedPercent: 94,
        readAgoMs: 120_000,
        refreshedUsedPercent: 100,
      });
      expect(result).toEqual({ member: current, refreshed: [] });
    }),
  );

  it.effect("does not refresh a reading under a minute old", () =>
    Effect.gen(function* () {
      const result = yield* route({
        usedPercent: 99,
        readAgoMs: 30_000,
        refreshedUsedPercent: 100,
      });
      expect(result).toEqual({ member: current, refreshed: [] });
    }),
  );
});

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("blocks agent messages to external work backing threads before dispatch", () => {
  const projectId = ProjectId.make("project:thread-management:external-owner");
  const externalThreadId = ThreadId.make("thread:thread-management:external-owner");
  const ordinaryThreadId = ThreadId.make("thread:thread-management:ordinary");
  const instanceId = ProviderInstanceId.make("codex");
  const environmentId = EnvironmentId.make("environment:thread-management:external-owner");
  const externalOwner = {
    environmentId,
    clientSessionId: "external-client",
    externalSessionKey: "a".repeat(64),
    projectId,
    ceiling: "full-access" as const,
  };
  const dispatched: Array<
    Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>
  > = [];
  let projection = {
    thread: {
      id: externalThreadId,
      projectId,
      deletedAt: null,
      archivedAt: null,
      modelSelection: { instanceId, model: "test-model" },
    },
    runs: [],
    providerTurns: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () => Effect.succeed(projection),
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === externalThreadId
              ? ({
                  id: externalThreadId,
                  agentTask: { externalOwner },
                } as never)
              : null,
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch") dispatched.push(command);
            if (
              command.type === "message.dispatch" &&
              command.threadId === externalThreadId &&
              command.createdBy === "agent"
            ) {
              const runId = RunId.make("run:owned-external-followup");
              projection = {
                ...projection,
                messages: [
                  { id: command.messageId, runId } as (typeof projection.messages)[number],
                ],
                runs: [{ id: runId, status: "queued" } as (typeof projection.runs)[number]],
              };
            }
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      }),
    ),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const message = (threadId: ThreadId, createdBy: "agent" | "user", suffix: string) => ({
      type: "message.dispatch" as const,
      commandId: CommandId.make(`command:thread-management:external-owner:${suffix}`),
      threadId,
      messageId: MessageId.make(`message:thread-management:external-owner:${suffix}`),
      text: "A message",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      createdBy,
      creationSource: createdBy === "agent" ? ("mcp" as const) : ("web" as const),
    });

    const sendError = yield* Effect.flip(
      threads.sendToThread({
        projectId,
        commandId: CommandId.make("command:thread-management:external-owner:send"),
        threadId: externalThreadId,
        messageId: MessageId.make("message:thread-management:external-owner:send"),
        text: "Try to continue through the raw backing thread",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      }),
    );
    expect(sendError).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });

    const directError = yield* Effect.flip(
      threads.dispatch(message(externalThreadId, "agent", "direct")),
    );
    expect(directError).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);

    const followup = {
      projectId,
      threadId: externalThreadId,
      commandId: CommandId.make("command:owned-external-followup"),
      messageId: MessageId.make("message:owned-external-followup"),
      text: "Continue the owned task",
      attachments: [],
      mode: "queue" as const,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      followupSourceRevision: "current-source",
      externalWorkOwner: externalOwner,
    };
    const foreign = yield* threads
      .sendToThread({
        ...followup,
        externalWorkOwner: { ...externalOwner, externalSessionKey: "foreign-owner" },
      })
      .pipe(Effect.flip);
    expect(foreign).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);
    expect((yield* threads.sendToThread(followup)).delivery).toBe("queued");
    expect(dispatched).toHaveLength(1);
    dispatched.length = 0;

    // A task launched without a source revision continues without one, still as its owner.
    const { followupSourceRevision: _stated, ...unpinned } = followup;
    const foreignUnpinned = yield* threads
      .sendToThread({
        ...unpinned,
        commandId: CommandId.make("command:owned-external-unpinned-foreign"),
        externalWorkOwner: { ...externalOwner, externalSessionKey: "foreign-owner" },
      })
      .pipe(Effect.flip);
    expect(foreignUnpinned).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);
    expect(
      (yield* threads.sendToThread({
        ...unpinned,
        commandId: CommandId.make("command:owned-external-unpinned"),
        messageId: MessageId.make("message:owned-external-unpinned"),
      })).delivery,
    ).toBe("queued");
    expect(dispatched).toHaveLength(1);
    dispatched.length = 0;

    yield* threads.dispatch(message(externalThreadId, "user", "human"));
    yield* threads.dispatch(message(ordinaryThreadId, "agent", "ordinary-agent"));
    // The launch of the work itself delivers its first message through `defer_start`.
    yield* threads.dispatch({
      ...message(externalThreadId, "agent", "launch"),
      dispatchMode: { type: "defer_start" as const, workspaceStrategy: { type: "root" as const } },
    });
    expect(dispatched.map((command) => [command.threadId, command.createdBy])).toEqual([
      [externalThreadId, "user"],
      [ordinaryThreadId, "agent"],
      [externalThreadId, "agent"],
    ]);
  }).pipe(Effect.provide(layerTest));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed(
              settleAfterRunState({
                projectId,
                threadId,
                runs: [settleAfterRunRun(runId, 1, status)],
              }),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect("settleAfterRun waits for the turn's background work and the turn it wakes", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-work");
    const threadId = ThreadId.make("thread:thread-management:settle-after-work");
    const runId = RunId.make("run:thread-management:settle-after-work");
    const wokenRunId = RunId.make("run:thread-management:settle-after-work:woken");
    const dispatched: Array<string> = [];
    const pending = [{ taskId: "b7", description: "Wait 240 seconds", kind: "command" as const }];
    let state = settleAfterRunState({
      projectId,
      threadId,
      runs: [settleAfterRunRun(runId, 1, "completed")],
      pendingBackgroundTasks: pending,
    });
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const subscribed = yield* Deferred.make<void>();
    const changed = (next: typeof state) =>
      Effect.gen(function* () {
        state = next;
        yield* Queue.offer(events, {
          sequence: 1,
          event: { type: "provider-thread.updated" },
        } as unknown as OrchestrationV2StoredEvent);
      });
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () => Effect.sync(() => state),
          streamStoredEventsFrom: () =>
            Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    const settling = yield* service
      .settleAfterRun({ projectId, threadId, runId })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    expect(dispatched).toEqual([]);

    // The command finished and woke the agent: its new turn is still the thread's work.
    yield* changed(
      settleAfterRunState({
        projectId,
        threadId,
        runs: [
          settleAfterRunRun(runId, 1, "completed"),
          settleAfterRunRun(wokenRunId, 2, "running"),
        ],
      }),
    );
    yield* changed(
      settleAfterRunState({
        projectId,
        threadId,
        runs: [
          settleAfterRunRun(runId, 1, "completed"),
          settleAfterRunRun(wokenRunId, 2, "completed"),
        ],
      }),
    );
    yield* Fiber.join(settling);
    expect(dispatched).toEqual(["thread.settle"]);
  }),
);

function settleAfterRunRun(id: RunId, ordinal: number, status: OrchestrationV2Run["status"]) {
  const at = DateTime.makeUnsafe(`2026-10-17T09:0${ordinal}:00.000Z`);
  return {
    id,
    ordinal,
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: status === "running" ? null : at,
  };
}

function settleAfterRunState(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<ReturnType<typeof settleAfterRunRun>>;
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}) {
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      deletedAt: null,
      archivedAt: null,
      activeProviderThreadId: null,
    },
    runs: input.runs,
    messages: [],
    subagents: [],
    turnItems: [],
    runtimeRequests: [],
    providerThreads: [
      {
        id: "provider-thread:settle-after-work",
        pendingBackgroundTasks: input.pendingBackgroundTasks ?? [],
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}
