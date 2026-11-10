import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderFailure,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  DELEGATED_RETRY_ATTEMPTS,
  DELEGATED_RETRY_DELAY_MS,
  isDelegatedRecoverableFailure,
  makeRecoverDelegatedRun,
  planDelegatedRecovery,
} from "./DelegatedTaskRecovery.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const claude = ProviderDriverKind.make("claudeAgent");
const model = "claude-opus-test";

const account = (id: string, usedPercent: number, models = [model]): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: claude,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-10T12:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-10T12:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: "2026-11-10T15:00:00.000Z",
      },
    ],
  },
});

const pool = (
  members: ReadonlyArray<string>,
  policy?: ServerProvider["poolPolicy"],
): ServerProvider => ({
  ...account("claude_pool", 0),
  poolMembers: members.map((member) => ProviderInstanceId.make(member)),
  ...(policy === undefined ? {} : { poolPolicy: policy }),
});

const failure = (
  failureClass: OrchestrationV2ProviderFailure["class"],
  code: string | null,
): OrchestrationV2ProviderFailure => ({
  class: failureClass,
  message: "Failed.",
  code,
  retryable: true,
  ...(failureClass === "usage_limit" ? { resetAt: "2026-11-10T15:00:00.000Z" } : {}),
});

const plan = (input: {
  readonly failure: OrchestrationV2ProviderFailure;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly priorFailures?: number;
  readonly switchOnLimit?: boolean;
  readonly otherModel?: boolean;
}) =>
  planDelegatedRecovery({
    run: { modelSelection: { instanceId: ProviderInstanceId.make("limited"), model } },
    failure: input.failure,
    priorFailures: input.priorFailures ?? 0,
    providers: input.providers ?? [
      account("limited", 40),
      account("sibling", 20),
      pool(["limited", "sibling"]),
    ],
    nowMs: NOW,
    switchOnLimit: input.switchOnLimit ?? true,
    otherModelAvailable: () => Effect.succeed(input.otherModel ?? false),
  });

describe("planDelegatedRecovery", () => {
  it.effect("moves a usage-limited task to a pool sibling offering the same model", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* plan({ failure: failure("usage_limit", null) }), {
        type: "failover",
        selection: { instanceId: ProviderInstanceId.make("sibling"), model },
      });
      // A sibling without the model, or a pool that waits for the reset, reports the limit.
      assert.deepEqual(
        yield* plan({
          failure: failure("usage_limit", null),
          providers: [
            account("limited", 100),
            account("sibling", 20, ["other-model"]),
            pool(["limited", "sibling"]),
          ],
        }),
        { type: "deliver" },
      );
      assert.deepEqual(
        yield* plan({
          failure: failure("usage_limit", null),
          providers: [
            account("limited", 100),
            account("sibling", 20),
            pool(["limited", "sibling"], { switchOnLimit: false }),
          ],
        }),
        { type: "deliver" },
      );
    }),
  );

  it.effect(
    "retries an upstream error on the same model three times when no other model can serve",
    () =>
      Effect.gen(function* () {
        for (const upstream of [
          failure("provider_error", "api_error_529"),
          failure("provider_error", "api_error_429"),
          failure("transport_error", null),
        ]) {
          assert.deepEqual(yield* plan({ failure: upstream }), { type: "retry" });
          assert.deepEqual(
            yield* plan({ failure: upstream, priorFailures: DELEGATED_RETRY_ATTEMPTS - 1 }),
            { type: "retry" },
          );
          assert.deepEqual(
            yield* plan({ failure: upstream, priorFailures: DELEGATED_RETRY_ATTEMPTS }),
            { type: "deliver" },
          );
          // A role with another model passes the failure on, so the next launch moves to it.
          assert.deepEqual(yield* plan({ failure: upstream, otherModel: true }), {
            type: "deliver",
          });
        }
      }),
  );

  it.effect("moves an upstream error on an account a usage read shows out to a sibling", () =>
    Effect.gen(function* () {
      const providers = [
        account("limited", 100),
        account("sibling", 20),
        pool(["limited", "sibling"]),
      ];
      assert.deepEqual(
        yield* plan({ failure: failure("provider_error", "api_error_429"), providers }),
        { type: "failover", selection: { instanceId: ProviderInstanceId.make("sibling"), model } },
      );
      // With no sibling to take it, the parent hears the error rather than a retry on an out account.
      assert.deepEqual(
        yield* plan({
          failure: failure("provider_error", "api_error_429"),
          providers: [
            account("limited", 100),
            account("sibling", 100),
            pool(["limited", "sibling"]),
          ],
        }),
        { type: "deliver" },
      );
    }),
  );

  it.effect("reports any other failure at once", () =>
    Effect.gen(function* () {
      const other = failure("provider_error", "invalid_request");
      assert.isFalse(isDelegatedRecoverableFailure(other));
      assert.deepEqual(yield* plan({ failure: other }), { type: "deliver" });
    }),
  );
});

describe("makeRecoverDelegatedRun", () => {
  const parentThreadId = ThreadId.make("thread:recovery-parent");
  const childThreadId = ThreadId.make("thread:recovery-child");
  const runId = RunId.make("run:recovery-child:1");
  const rootNodeId = NodeId.make("node:recovery-child-root");

  // The parent's task is open on the first read; `cancelDuringWait` ends it before the second.
  const recoverAfterUpstreamError = (cancelDuringWait: boolean) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const parentReads = yield* Ref.make(0);
      const firstRead = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make(0);
      const threads = {
        getThreadRecords: (threadId: ThreadId) =>
          threadId === parentThreadId
            ? Effect.gen(function* () {
                const reads = yield* Ref.getAndUpdate(parentReads, (count) => count + 1);
                yield* Deferred.succeed(firstRead, undefined);
                const status = cancelDuringWait && reads > 0 ? "failed" : "running";
                return { subagents: [{ childThreadId, status }] };
              })
            : Effect.succeed({
                thread: { lineage: { parentThreadId }, runtimeMode: "full-access" },
                runs: [
                  {
                    id: runId,
                    ordinal: 1,
                    status: "failed",
                    rootNodeId,
                    modelSelection: { instanceId: ProviderInstanceId.make("limited"), model },
                  },
                ],
                turnItems: [
                  {
                    id: "turn-item:recovery-child-error",
                    type: "error",
                    status: "failed",
                    runId,
                    nodeId: rootNodeId,
                    ordinal: 1,
                    updatedAt: now,
                    failure: failure("transport_error", null),
                  },
                ],
              }),
        dispatch: () => Ref.update(dispatched, (count) => count + 1),
        recoverDelegatedTask: () => Effect.void,
      };
      const settings = { getSettings: Effect.succeed({ switchPooledAccountOnLimit: true }) };
      const recover = yield* makeRecoverDelegatedRun;
      const fiber = yield* recover(threads as never, settings as never, {
        threadId: childThreadId,
        sourceRunId: runId,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(firstRead);
      yield* TestClock.adjust(DELEGATED_RETRY_DELAY_MS);
      yield* Fiber.join(fiber);
      return yield* Ref.get(dispatched);
    });

  it.effect("retries after the wait, unless the parent cancelled the task meanwhile", () =>
    Effect.gen(function* () {
      assert.equal(yield* recoverAfterUpstreamError(false), 1);
      assert.equal(yield* recoverAfterUpstreamError(true), 0);
    }),
  );
});
