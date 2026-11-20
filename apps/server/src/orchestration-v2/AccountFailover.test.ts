import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { nextLocalMidnightMs } from "@t3tools/shared/accountPools";
import * as AccountFailover from "./AccountFailover.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MODEL = "claude-opus-5-5";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-19T09:00:00.000Z");
// The next midnight on the server's clock, in whatever zone the tests run.
const MIDNIGHT = nextLocalMidnightMs(NOW);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const account = (id: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(NOW),
  models: [{ slug: MODEL, name: "Claude Opus 5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const providers = [account("A"), account("B"), account("C")];
const on = (id: string, pinned?: boolean): ModelSelection => ({
  instanceId: ProviderInstanceId.make(id),
  model: MODEL,
  ...(pinned ? { pinned: true } : {}),
});

const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");

/** Threads by id: the account each last ran on, or none for a thread that has not run. */
type Threads = Readonly<Record<string, ModelSelection | undefined>>;

const makeRouter = (threads: Threads, notRun: ReadonlyArray<ThreadId> = []) =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return AccountRouting.make({
      providerRegistry: Option.some(makeProviderRegistryMock(providers)),
      serverSettings,
      getThreadShell: (threadId) =>
        Effect.succeed(
          threads[threadId] === undefined
            ? null
            : ({
                modelSelection: threads[threadId],
                latestRunId: notRun.includes(threadId) ? null : RunId.make(`run:${threadId}`),
              } as unknown as OrchestrationV2ThreadShell),
        ),
    });
  });

/** The account a new thread on the model starts on. */
const newThreadAccount = (selection: ModelSelection = on("A")) =>
  Effect.gen(function* () {
    const router = yield* makeRouter({});
    const routed = yield* router.routeCommand({
      type: "thread.create",
      threadId: ThreadId.make("thread:new"),
      modelSelection: selection,
    } as unknown as OrchestrationV2ServerCommand);
    return routed.type === "thread.create" ? routed.modelSelection.instanceId : null;
  });

/** The account a thread's next turn runs on. */
const nextTurnAccount = (
  threadId: ThreadId,
  threads: Threads,
  notRun: ReadonlyArray<ThreadId> = [],
) =>
  Effect.gen(function* () {
    const router = yield* makeRouter(threads, notRun);
    const routed = yield* router.routeCommand({
      type: "message.dispatch",
      threadId,
      modelSelection: on("A"),
    } as unknown as OrchestrationV2ServerCommand);
    return routed.type === "message.dispatch" ? routed.modelSelection?.instanceId : null;
  });

const accountOf = (command: OrchestrationV2Command) =>
  command.type === "message.dispatch" ? String(command.modelSelection?.instanceId) : null;

const failedRun = (threadId: ThreadId, selection: ModelSelection): OrchestrationV2Run =>
  ({
    id: RunId.make(`run:${threadId}`),
    threadId,
    ordinal: 1,
    status: "failed",
    rootNodeId: "node:root",
    modelSelection: selection,
  }) as unknown as OrchestrationV2Run;

/**
 * Runs the failover layer over a stream of failed runs, returning what it dispatched. Each run
 * fails with a usage limit, reporting `resetAt` when given.
 */
const withFailover = <A, E, R>(
  body: (input: {
    readonly fail: (run: OrchestrationV2Run, resetAt?: number) => Effect.Effect<void>;
    readonly dispatched: Queue.Queue<OrchestrationV2Command>;
  }) => Effect.Effect<A, E, R>,
  customProviders: ReadonlyArray<ServerProvider> = providers,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
    const failures = new Map<string, number | undefined>();
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Layer.build(
      AccountFailover.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
            Layer.succeed(
              ProviderRegistry.ProviderRegistry,
              makeProviderRegistryMock(customProviders),
            ),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: (threadId: ThreadId) =>
                Effect.succeed({
                  thread: {},
                  runs: [{ id: RunId.make(`run:${threadId}`), ordinal: 1 }],
                  turnItems: [
                    {
                      type: "error",
                      status: "failed",
                      id: "item:error",
                      ordinal: 1,
                      runId: RunId.make(`run:${threadId}`),
                      nodeId: "node:root",
                      updatedAt: DateTime.makeUnsafe(NOW),
                      failure: {
                        class: "usage_limit",
                        message: "You've hit your usage limit.",
                        retryable: false,
                        ...(failures.get(threadId) === undefined
                          ? {}
                          : { resetAt: iso(failures.get(threadId)!) }),
                      },
                    },
                  ],
                } as never),
              dispatch: ((command: OrchestrationV2Command) =>
                Queue.offer(dispatched, command).pipe(Effect.as({}))) as never,
            }),
          ),
        ),
      ),
    );
    return yield* body({
      dispatched,
      fail: (run, resetAt) =>
        Effect.gen(function* () {
          failures.set(run.threadId, resetAt);
          yield* Queue.offer(events, {
            type: "run.updated",
            payload: run,
          } as unknown as OrchestrationV2DomainEvent);
        }),
    });
  });

const settingsLayer = ServerSettings.layerTest({ pooledModelKeys: [MODEL] });

describe("accounts A, B and C serving one model, in that order", () => {
  it.effect("moves a limited turn to B and back to A at midnight when no reset was reported", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      assert.strictEqual(yield* newThreadAccount(), "A");

      yield* withFailover(({ fail, dispatched }) =>
        Effect.gen(function* () {
          yield* fail(failedRun(threadA, on("A")));
          const continuation = yield* Queue.take(dispatched);
          assert.deepInclude(continuation, {
            type: "message.dispatch",
            threadId: threadA,
            commandId: CommandId.make(`limit-pool-switch:${threadA}:run:${threadA}`),
            messageId: MessageId.make(`limit-pool-switch:${threadA}:run:${threadA}`),
            manualContinuationOfRunId: RunId.make(`run:${threadA}`),
          });
          assert.strictEqual(accountOf(continuation), "B");
        }),
      );

      const settings = yield* ServerSettings.ServerSettingsService;
      assert.deepEqual((yield* settings.getSettings).accountSkips, {
        A: { [MODEL]: { until: iso(MIDNIGHT), reportedReset: false } },
      });
      assert.strictEqual(yield* newThreadAccount(), "B");

      yield* TestClock.setTime(MIDNIGHT);
      assert.strictEqual(yield* newThreadAccount(), "A");
      // The thread that moved stays on B now that A is back.
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("B") }), "B");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("skips A until its reported reset, or until Try again now clears the skip", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* withFailover(({ fail, dispatched }) =>
        fail(failedRun(threadA, on("A")), NOW + 2 * HOUR).pipe(
          Effect.andThen(Queue.take(dispatched)),
        ),
      );
      assert.strictEqual(yield* newThreadAccount(), "B");
      yield* TestClock.setTime(NOW + 2 * HOUR);
      assert.strictEqual(yield* newThreadAccount(), "A");

      yield* TestClock.setTime(NOW + 3 * HOUR);
      yield* withFailover(({ fail, dispatched }) =>
        fail(failedRun(threadB, on("A")), NOW + 8 * HOUR).pipe(
          Effect.andThen(Queue.take(dispatched)),
        ),
      );
      assert.strictEqual(yield* newThreadAccount(), "B");
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ accountSkips: { A: null } });
      assert.strictEqual(yield* newThreadAccount(), "A");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("keeps a working thread on its account through other threads' failures", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* withFailover(({ fail, dispatched }) =>
        fail(failedRun(threadB, on("A"))).pipe(Effect.andThen(Queue.take(dispatched))),
      );
      // A is skipped for new work, but threadA has not failed there, so it stays.
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("A") }), "A");
      yield* TestClock.setTime(NOW + 30 * HOUR);
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("A") }), "A");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("runs a pinned account while it is skipped and leaves its limited turn waiting", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        accountSkips: {
          A: { [MODEL]: { until: iso(NOW + HOUR), reportedReset: true } },
        },
      });
      assert.strictEqual(yield* newThreadAccount(on("A", true)), "A");
      assert.strictEqual(yield* newThreadAccount(on("A")), "B");

      yield* withFailover(({ fail, dispatched }) =>
        Effect.gen(function* () {
          yield* fail(failedRun(threadA, on("A", true)));
          // A later unpinned failure proves the pinned one dispatched nothing before it.
          yield* fail(failedRun(threadB, on("B")));
          const continuation = yield* Queue.take(dispatched);
          assert.strictEqual(
            continuation.type === "message.dispatch" && continuation.threadId,
            threadB,
          );
          assert.strictEqual(accountOf(continuation), "C");
        }),
      );
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("keeps a placed thread's account for its first turn, unless skipped or removed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      // A role placed threadA on C (A and B held back); its first message must not undo that.
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("C") }, [threadA]), "C");
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        accountSkips: { C: { [MODEL]: { until: iso(NOW + HOUR), reportedReset: true } } },
      });
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("C") }, [threadA]), "A");
      yield* settings.updateSettings({
        accountSkips: { C: null },
        modelAccounts: { [MODEL]: ["A", "C"] } as never,
      });
      assert.strictEqual(yield* nextTurnAccount(threadA, { [threadA]: on("B") }, [threadA]), "A");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect(
    "places a delegation that names only the model by the order, and a role's as resolved",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ modelAccounts: { [MODEL]: ["B", "A", "C"] } as never });
        const router = yield* makeRouter({});
        const delegate = (extra: object) =>
          router
            .routeCommand({
              type: "delegated_task.request",
              modelSelection: on("A"),
              ...extra,
            } as unknown as OrchestrationV2ServerCommand)
            .pipe(
              Effect.map((routed) =>
                routed.type === "delegated_task.request"
                  ? String(routed.modelSelection.instanceId)
                  : null,
              ),
            );
        assert.strictEqual(yield* delegate({}), "B");
        assert.strictEqual(yield* delegate({ agentTask: { role: "reviewer" } }), "A");
        yield* settings.updateSettings({ pooledModelKeys: [] });
        assert.strictEqual(yield* delegate({}), "A");
      }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("leaves a model the user did not add to the account it is picked on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const settings = yield* ServerSettings.ServerSettingsService;
      const LISTED_MODEL = "claude-sonnet-5-5";
      const bothModels = providers.map((provider) => ({
        ...provider,
        models: [
          ...provider.models,
          { slug: LISTED_MODEL, name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
        ],
      }));
      yield* settings.updateSettings({ pooledModelKeys: [LISTED_MODEL] });
      // The same model on three accounts, picked on B: it runs on B and no limit moves it.
      assert.strictEqual(yield* newThreadAccount(on("B")), "B");
      assert.strictEqual(
        AccountFailover.failoverSelection({
          selection: on("B"),
          providers,
          settings: yield* settings.getSettings,
          nowMs: NOW,
        }),
        undefined,
      );

      yield* withFailover(
        ({ fail, dispatched }) =>
          Effect.gen(function* () {
            yield* fail(failedRun(threadA, on("B")));
            // A later listed failure proves the unlisted one recorded no skip or continuation.
            yield* fail(
              failedRun(threadB, {
                instanceId: ProviderInstanceId.make("B"),
                model: LISTED_MODEL,
              }),
            );
            const continuation = yield* Queue.take(dispatched);
            assert.strictEqual(
              continuation.type === "message.dispatch" && continuation.threadId,
              threadB,
            );
          }),
        bothModels,
      );
      assert.strictEqual((yield* settings.getSettings).accountSkips["B"]?.[MODEL], undefined);
    }).pipe(Effect.provide(settingsLayer)),
  );
});

describe("isUsageLimitFailure", () => {
  it("reads a provider's own words for running out of allowance, quota-limited included", () => {
    const words = (message: string) =>
      AccountFailover.isUsageLimitFailure({ class: "provider_error", message });
    assert.isTrue(
      words("All 1 Command Code keys are quota-limited (weekly; next reset Nov 24, 08:53)"),
    );
    assert.isTrue(words("rate limit exceeded"));
    assert.isFalse(words("connection reset by peer"));
  });
});
