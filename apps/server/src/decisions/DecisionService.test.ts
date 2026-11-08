import { DECISION_LIMITS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DecisionService from "./DecisionService.ts";
import { request } from "./decisions.testkit.ts";
import responses from "./responses.test-fixture.json" with { type: "json" };

const setup = (
  options: { missing?: boolean; never?: boolean; body?: string; status?: number } = {},
) =>
  Effect.gen(function* () {
    const entered = yield* Queue.unbounded<void>();
    const aborted = yield* Deferred.make<void>();
    const calls: string[] = [];
    const http = HttpClient.make((req) =>
      Effect.gen(function* () {
        calls.push(req.url);
        yield* Queue.offer(entered, undefined);
        if (options.never)
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)),
          );
        return HttpClientResponse.fromWeb(
          req,
          new Response(
            options.body ?? JSON.stringify(responses[req.url.includes("openai") ? 1 : 0]),
            { status: options.status ?? 200 },
          ),
        );
      }),
    );
    const service = yield* DecisionService.DecisionService.pipe(
      Effect.provide(
        DecisionService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, http),
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () =>
                  options.missing
                    ? Effect.succeedNone
                    : Effect.succeedSome(new TextEncoder().encode("synthetic-test-key")),
              }),
              NodeServices.layer,
              NodeCrypto.layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            ),
          ),
        ),
      ),
    );
    return { service, calls, entered, aborted };
  });
it.effect("returns canonical full-input identity and honest metadata for both engines", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup();
    const a = yield* service.decide(request());
    const b = yield* service.decide({
      ...request(),
      evidence: { text: "Export fails; another way works." },
    });
    const c = yield* service.decide(request("luna"));
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(a.usage.inputTokens).toBe(398);
    expect(a.cost.usd).toBeCloseTo((398 * 0.042) / 1e6);
    expect(a.requestedModel).toBe("jev-1.14.0");
    expect(c.requestedModel).toBe("gpt-6-luna");
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(a)).not.toContain("synthetic-test-key");
  }),
);
it.effect.each([
  { ...request(), model: "override" },
  { ...request(), engine: "other" },
  { ...request(), questions: [...request().questions, request().questions[0]] },
  { ...request(), evidence: "x".repeat(128 * 1024) },
  { ...request(), questions: [] },
  {
    ...request(),
    questions: Array.from({ length: 33 }, (_, i) => ({ ...request().questions[0], id: `q${i}` })),
  },
  {
    ...request(),
    questions: [
      { id: "q", type: "score", instructions: "Rate", levels: [{ label: "a", description: "A" }] },
    ],
  },
  {
    ...request(),
    questions: [
      {
        id: "q",
        type: "choice",
        instructions: "Choose",
        choices: [
          { label: "a", description: "A" },
          { label: "a", description: "B" },
        ],
      },
    ],
  },
])("rejects invalid input without a paid call", (input) =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup();
    expect((yield* Effect.flip(service.decide(input))).code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  }),
);
it.effect("constructs without credentials and reports unavailable lazily", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({ missing: true });
    expect((yield* Effect.flip(service.decide(request()))).code).toBe("unavailable");
    expect(calls).toHaveLength(0);
  }),
);
it.effect.each(["jev", "luna"] as const)(
  "rejects a single-choice question before calling %s",
  (engine) =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup();
      const result = yield* Effect.flip(
        service.decide({
          ...request(engine),
          questions: [
            {
              id: "only",
              type: "choice",
              instructions: "Choose an option",
              choices: [{ label: "only", description: "The only option" }],
            },
          ],
        }),
      );
      expect(result.code).toBe("invalid-input");
      expect(calls).toHaveLength(0);
    }),
);
it.effect.each([
  { options: { body: "{}" }, code: "invalid-provider-response" },
  { options: { body: "x".repeat(1024 * 1024 + 1) }, code: "invalid-provider-response" },
  { options: { status: 429 }, code: "transport-error" },
  { options: { status: 401 }, code: "unavailable" },
] as const)("never retries or substitutes another provider on failure", ({ options, code }) =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup(options);
    expect((yield* Effect.flip(service.decide(request()))).code).toBe(code);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("typesafe");
  }),
);
it.effect("times out, aborts transport and releases capacity", () =>
  Effect.gen(function* () {
    const { service, calls, entered, aborted } = yield* setup({ never: true });
    const fiber = yield* service.decide(request()).pipe(Effect.forkChild);
    yield* Queue.take(entered);
    yield* TestClock.adjust("20 seconds");
    expect((yield* Effect.flip(Fiber.join(fiber))).code).toBe("timeout");
    yield* Deferred.await(aborted);
    expect(calls).toHaveLength(1);
  }),
);
it.effect("cancellation interrupts transport without a fallback", () =>
  Effect.gen(function* () {
    const { service, calls, entered, aborted } = yield* setup({ never: true });
    const fiber = yield* service.decide(request()).pipe(Effect.forkChild);
    yield* Queue.take(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    yield* Deferred.await(aborted);
    expect(calls).toHaveLength(1);
  }),
);
it.effect("a call over the limit waits a bounded time for room, then fails busy", () =>
  Effect.gen(function* () {
    const { service, calls, entered } = yield* setup({ never: true });
    const fibers = [];
    for (let i = 0; i < DECISION_LIMITS.concurrent; i++) {
      fibers.push(yield* service.decide(request()).pipe(Effect.forkChild));
      yield* Queue.take(entered);
    }
    const waiting = yield* service.decide(request()).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(DECISION_LIMITS.admissionWaitMs);
    expect((yield* Fiber.join(waiting)).code).toBe("busy");
    expect(calls).toHaveLength(DECISION_LIMITS.concurrent);
    // Room that opens while a call waits admits it, rather than stopping its journey.
    const admitted = yield* service.decide(request()).pipe(Effect.forkChild);
    yield* TestClock.adjust(50);
    yield* Fiber.interrupt(fibers[0]!);
    yield* TestClock.adjust(50);
    yield* Queue.take(entered);
    expect(calls).toHaveLength(DECISION_LIMITS.concurrent + 1);
    yield* Fiber.interrupt(admitted);
    for (const fiber of fibers) yield* Fiber.interrupt(fiber);
  }),
);
it.effect("bounds the environment admission rate and expires its window", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup();
    for (let i = 0; i < DECISION_LIMITS.perMinute; i++) yield* service.decide(request());
    const limited = yield* service.decide(request("luna")).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(DECISION_LIMITS.admissionWaitMs);
    expect((yield* Fiber.join(limited)).code).toBe("rate-limited");
    expect(calls).toHaveLength(DECISION_LIMITS.perMinute);
    yield* TestClock.adjust("1 minute");
    yield* service.decide(request("luna"));
    expect(calls).toHaveLength(DECISION_LIMITS.perMinute + 1);
  }),
);

it.effect("returns explicit signal cancellation, aborting transport once", () =>
  Effect.gen(function* () {
    const { service, calls, entered, aborted } = yield* setup({ never: true });
    const cancellationScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const signal = yield* Effect.abortSignal.pipe(
      Effect.provideService(Scope.Scope, cancellationScope),
    );
    const fiber = yield* service.decide(request(), { signal: signal }).pipe(Effect.forkChild);
    yield* Queue.take(entered);
    yield* Scope.close(cancellationScope, Exit.void);
    expect((yield* Effect.flip(Fiber.join(fiber))).code).toBe("cancelled");
    yield* Deferred.await(aborted);
    yield* TestClock.adjust("20 seconds");
    expect(calls).toHaveLength(1);
  }),
);
it.effect("rejects pre-cancelled work without transport or admission", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup();
    const cancellationScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const signal = yield* Effect.abortSignal.pipe(
      Effect.provideService(Scope.Scope, cancellationScope),
    );
    yield* Scope.close(cancellationScope, Exit.void);
    expect((yield* Effect.flip(service.decide(request(), { signal: signal }))).code).toBe(
      "cancelled",
    );
    expect(calls).toHaveLength(0);
  }),
);
it.effect(
  "canonicalizes nested object order and identifies all rule/evidence/question changes",
  () =>
    Effect.gen(function* () {
      const { service } = yield* setup();
      const a = yield* service.decide({
        ...request(),
        evidence: { z: [1, { b: 2, a: 3 }], a: true },
      });
      const b = yield* service.decide({
        ...request(),
        evidence: { a: true, z: [1, { a: 3, b: 2 }] },
      });
      expect(a.digest).toBe(b.digest);
      for (const input of [
        { ...request(), evidence: { a: true, z: [2, { a: 3, b: 2 }] } },
        { ...request(), rule: { id: "synthetic", version: "2" } },
        {
          ...request(),
          questions: request().questions.map((q) => ({
            ...q,
            instructions: `${q.instructions} Updated`,
          })),
        },
      ])
        expect((yield* service.decide(input)).digest).not.toBe(a.digest);
    }),
);

it.effect("a late cancellation cannot replace a completed result or poison the next call", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup();
    const cancellationScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const signal = yield* Effect.abortSignal.pipe(
      Effect.provideService(Scope.Scope, cancellationScope),
    );
    const result = yield* service.decide(request(), { signal: signal });
    yield* Scope.close(cancellationScope, Exit.void);
    yield* TestClock.adjust("20 seconds");
    expect(result.answers).toHaveLength(3);
    yield* service.decide(request());
    expect(calls).toHaveLength(2);
  }),
);
