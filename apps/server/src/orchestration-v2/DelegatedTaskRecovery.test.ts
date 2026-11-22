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
  readonly otherModel?: boolean;
  readonly pinned?: boolean;
}) =>
  planDelegatedRecovery({
    run: {
      modelSelection: {
        instanceId: ProviderInstanceId.make("limited"),
        model,
        ...(input.pinned ? { pinned: true } : {}),
      },
    },
    failure: input.failure,
    priorFailures: input.priorFailures ?? 0,
    providers: input.providers ?? [account("limited", 40), account("sibling", 20)],
    settings: { pooledModelKeys: [model], providerModelPreferences: null },
    context: { blocks: [], nowMs: NOW },
    otherModelAvailable: () => Effect.succeed(input.otherModel ?? false),
  });

describe("planDelegatedRecovery", () => {
  it.effect(
    "moves a usage-limited task to the next account serving its model, unless it was named",
    () =>
      Effect.gen(function* () {
        const limit = failure("usage_limit", null);
        assert.deepEqual(yield* plan({ failure: limit }), {
          type: "failover",
          selection: { instanceId: ProviderInstanceId.make("sibling"), model },
        });
        assert.deepEqual(yield* plan({ failure: limit, pinned: true }), { type: "deliver" });
        assert.deepEqual(yield* plan({ failure: limit, providers: [account("limited", 100)] }), {
          type: "deliver",
        });
      }),
  );

  it.effect(
    "moves an overloaded or rate-limited task to another account, else retries the same model three times",
    () =>
      Effect.gen(function* () {
        const alone = [account("limited", 40)];
        for (const upstream of [
          failure("provider_error", "api_error_529"),
          failure("provider_error", "api_error_429"),
        ])
          assert.deepEqual(yield* plan({ failure: upstream }), {
            type: "failover",
            selection: { instanceId: ProviderInstanceId.make("sibling"), model },
          });
        for (const upstream of [
          failure("provider_error", "api_error_529"),
          failure("provider_error", "api_error_429"),
          failure("transport_error", null),
        ]) {
          assert.deepEqual(yield* plan({ failure: upstream, providers: alone }), {
            type: "retry",
          });
          assert.deepEqual(
            yield* plan({
              failure: upstream,
              providers: alone,
              priorFailures: DELEGATED_RETRY_ATTEMPTS - 1,
            }),
            { type: "retry" },
          );
          assert.deepEqual(
            yield* plan({
              failure: upstream,
              providers: alone,
              priorFailures: DELEGATED_RETRY_ATTEMPTS,
            }),
            { type: "deliver" },
          );
          // A role with another model passes the failure on, so the next launch moves to it.
          assert.deepEqual(yield* plan({ failure: upstream, providers: alone, otherModel: true }), {
            type: "deliver",
          });
        }
        // A rate limit worded as one, with no other account to move to, is still retried.
        const rateLimited = {
          ...failure("provider_error", "api_error_429"),
          message: "Claude API rate limit reached. Try again later.",
        };
        assert.deepEqual(
          yield* plan({ failure: rateLimited, providers: [account("limited", 40)] }),
          {
            type: "retry",
          },
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
      const settings = {
        getSettings: Effect.succeed({ pooledModelKeys: [model] }),
      };
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
