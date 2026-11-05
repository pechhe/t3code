import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  nextRecoveryCommand,
  poolFailoverCommand,
  wantsPoolSwitch,
} from "./UsageLimitRecoveryWorker.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { assert, describe, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
    modelSelection: { instanceId: ProviderInstanceId.make("a"), model: "claude-opus-5-5" },
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const hoursFromNow = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const claude = ProviderDriverKind.make("claudeAgent");

const account = (id: string, usedPercent: number, resetHours: number): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: claude,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    usageLimits: {
      checkedAt: hoursFromNow(0),
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: hoursFromNow(resetHours),
        },
      ],
    },
  }) as unknown as ServerProvider;

const pool = {
  instanceId: ProviderInstanceId.make("claude_pool"),
  driver: claude,
  poolMembers: [ProviderInstanceId.make("a"), ProviderInstanceId.make("b")],
} as unknown as ServerProvider;

const limitedThread = (
  overrides: Partial<ProjectionLimitRecoveryCandidate> = {},
): ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make("thread-1"),
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: hoursFromNow(3),
  latestRunId: RunId.make("run-1"),
  latestRunCompletedAt: DateTime.makeUnsafe(NOW - 60_000),
  updatedAt: DateTime.makeUnsafe(NOW - 60_000),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  limitRecovery: null,
  snoozedUntil: null,
  modelSelection: {
    instanceId: ProviderInstanceId.make("a"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  },
  ...overrides,
});

describe("poolFailoverCommand", () => {
  const providers = [account("a", 100, 3), account("b", 20, 5), pool];

  it("continues the failed run on the next account with the same model and options", () => {
    const command = poolFailoverCommand(limitedThread(), providers, NOW, true);
    assert.isNotNull(command);
    assert.equal(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.equal(command.threadId, "thread-1");
    assert.equal(command.manualContinuationOfRunId, "run-1");
    assert.deepEqual(command.modelSelection, {
      instanceId: ProviderInstanceId.make("b"),
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
  });

  it("identifies the switch by the failed run so a retry delivers it once", () => {
    const first = poolFailoverCommand(limitedThread(), providers, NOW, true);
    const retry = poolFailoverCommand(limitedThread(), providers, NOW + 1_000, true);
    const later = poolFailoverCommand(
      limitedThread({ latestRunId: RunId.make("run-2") }),
      providers,
      NOW,
      true,
    );
    assert.equal(first?.commandId, retry?.commandId);
    assert.notEqual(first?.commandId, later?.commandId);
  });

  it("leaves threads outside a pool, without an account to move to, or no longer limited", () => {
    const outside = limitedThread({
      modelSelection: { instanceId: ProviderInstanceId.make("elsewhere"), model: "m" },
    });
    assert.isNull(poolFailoverCommand(outside, providers, NOW, true));
    const allLimited = [account("a", 100, 3), account("b", 100, 2), pool];
    assert.isNull(poolFailoverCommand(limitedThread(), allLimited, NOW, true));
    // Once the reset has passed the account has allowance again; nothing is switched.
    assert.isNull(poolFailoverCommand(limitedThread(), providers, NOW + 4 * 3_600_000, true));
    assert.isNull(
      poolFailoverCommand(
        limitedThread({ archivedAt: DateTime.makeUnsafe(NOW) }),
        providers,
        NOW,
        true,
      ),
    );
    assert.isNull(
      poolFailoverCommand(
        limitedThread({ lastErrorClass: "provider_error" }),
        providers,
        NOW,
        true,
      ),
    );
  });
});

describe("a pool's own switch setting", () => {
  const members = [account("a", 100, 3), account("b", 20, 5)];
  const withPolicy = (switchOnLimit: boolean) => [
    ...members,
    { ...pool, poolPolicy: { switchOnLimit } },
  ];

  it("overrides the global setting in either direction", () => {
    assert.isNull(poolFailoverCommand(limitedThread(), withPolicy(false), NOW, true));
    assert.isNotNull(poolFailoverCommand(limitedThread(), withPolicy(true), NOW, false));
    assert.isNull(poolFailoverCommand(limitedThread(), [...members, pool], NOW, false));
  });

  it("makes the sweep look at pools when either setting asks for a switch", () => {
    assert.isTrue(wantsPoolSwitch(true, [pool]));
    assert.isTrue(wantsPoolSwitch(false, withPolicy(true)));
    assert.isFalse(wantsPoolSwitch(false, withPolicy(false)));
    assert.isFalse(wantsPoolSwitch(false, [...members, pool]));
  });
});

describe("nextRecoveryCommand", () => {
  const providers = [pool, account("a", 100, 3), account("b", 10, 2)];
  const recovery = (rejected: ReadonlyArray<string> = []) =>
    nextRecoveryCommand({
      thread: limitedThread(),
      providers,
      switchOnLimit: true,
      nowMs: NOW,
      autoResume: true,
      snooze: false,
      rejected: new Set(rejected),
    });

  it("moves a limited pooled thread to the next account first", () => {
    assert.strictEqual(recovery()?.commandId, "limit-pool-switch:thread-1:run-1");
  });

  it("falls back to the plain recovery once the pool switch was rejected", () => {
    const fallback = recovery(["limit-pool-switch:thread-1:run-1"]);
    assert.strictEqual(fallback?.type, "thread.metadata.update");
    assert.isTrue(fallback?.commandId.startsWith("limit-arm:"));
  });

  it("offers nothing once every command for the thread was rejected", () => {
    const armed = recovery(["limit-pool-switch:thread-1:run-1"]);
    assert.isNotNull(armed);
    assert.isNull(recovery(["limit-pool-switch:thread-1:run-1", armed?.commandId ?? ""]));
  });
});
