import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";

import { nextRecoveryCommand, poolFailoverCommand } from "./UsageLimitRecoveryWorker.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";

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
    const command = poolFailoverCommand(limitedThread(), providers, NOW);
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
    const first = poolFailoverCommand(limitedThread(), providers, NOW);
    const retry = poolFailoverCommand(limitedThread(), providers, NOW + 1_000);
    const later = poolFailoverCommand(
      limitedThread({ latestRunId: RunId.make("run-2") }),
      providers,
      NOW,
    );
    assert.equal(first?.commandId, retry?.commandId);
    assert.notEqual(first?.commandId, later?.commandId);
  });

  it("leaves threads outside a pool, without an account to move to, or no longer limited", () => {
    const outside = limitedThread({
      modelSelection: { instanceId: ProviderInstanceId.make("elsewhere"), model: "m" },
    });
    assert.isNull(poolFailoverCommand(outside, providers, NOW));
    const allLimited = [account("a", 100, 3), account("b", 100, 2), pool];
    assert.isNull(poolFailoverCommand(limitedThread(), allLimited, NOW));
    // Once the reset has passed the account has allowance again; nothing is switched.
    assert.isNull(poolFailoverCommand(limitedThread(), providers, NOW + 4 * 3_600_000));
    assert.isNull(
      poolFailoverCommand(limitedThread({ archivedAt: DateTime.makeUnsafe(NOW) }), providers, NOW),
    );
    assert.isNull(
      poolFailoverCommand(limitedThread({ lastErrorClass: "provider_error" }), providers, NOW),
    );
  });
});

describe("nextRecoveryCommand", () => {
  const providers = [pool, account("a", 100, 3), account("b", 10, 2)];
  const recovery = (rejected: ReadonlyArray<string> = []) =>
    nextRecoveryCommand({
      thread: limitedThread(),
      providers,
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
