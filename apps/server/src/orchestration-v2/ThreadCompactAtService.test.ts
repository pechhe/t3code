import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCompactAtService from "./ThreadCompactAtService.ts";

const providerThread = { id: "pt-1", providerSessionId: "session-1" };
const compactAtSet = (compactAt: number | null) =>
  ({
    type: "thread.compact-at-set",
    threadId: "thread-1",
    payload: { id: "thread-1", compactAt },
  }) as never;

const run = (input: {
  readonly events: ReadonlyArray<unknown>;
  readonly runtime: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const applied = yield* Deferred.make<void>();
    const calls: Array<unknown> = [];
    const service = yield* ThreadCompactAtService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromIterable(input.events as never[]),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { id: "thread-1", activeProviderThreadId: "pt-1" },
                providerThreads: [providerThread],
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.succeed(
                Option.some({
                  ...input.runtime,
                  setCompactAt:
                    input.runtime.setCompactAt === undefined
                      ? undefined
                      : (call: unknown) =>
                          Effect.sync(() => calls.push(call)).pipe(
                            Effect.andThen(Deferred.succeed(applied, undefined)),
                          ),
                } as never),
              ),
          }),
        ),
      ),
    );
    yield* service.start();
    return { applied, calls };
  });

it.effect("moves the live session when a thread's compact-at point changes", () =>
  Effect.gen(function* () {
    const { applied, calls } = yield* run({
      events: [compactAtSet(150_000)],
      runtime: { setCompactAt: true },
    });
    yield* Deferred.await(applied);
    assert.deepEqual(calls, [{ providerThread, compactAt: 150_000 }]);
  }).pipe(Effect.scoped),
);

it.effect("passes null so the session returns to the provider setting", () =>
  Effect.gen(function* () {
    const { applied, calls } = yield* run({
      events: [compactAtSet(null)],
      runtime: { setCompactAt: true },
    });
    yield* Deferred.await(applied);
    assert.deepEqual(calls, [{ providerThread, compactAt: null }]);
  }).pipe(Effect.scoped),
);

it.effect("leaves a session without live control to pick the point up at its next open", () =>
  Effect.gen(function* () {
    const { calls } = yield* run({ events: [compactAtSet(150_000)], runtime: {} });
    yield* Effect.yieldNow;
    assert.deepEqual(calls, []);
  }).pipe(Effect.scoped),
);
