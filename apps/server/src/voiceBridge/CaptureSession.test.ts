import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { CapturedWindow } from "./Capture.ts";
import * as CaptureSession from "./CaptureSession.ts";

const initial: CapturedWindow = {
  png: new Uint8Array([1]),
  name: "Initial.png",
  mimeType: "image/png",
  sizeBytes: 1,
  appName: "Initial",
};
const later = { ...initial, name: "Later.png" };

it.effect("captures before starting Command Mode and preserves that image when stopping", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const session = yield* CaptureSession.make(() =>
      Ref.update(events, (values) => [...values, "capture"]).pipe(Effect.as(initial)),
    );
    const toggle = Ref.update(events, (values) => [...values, "toggle"]);
    yield* session.invoke({ isRecording: Effect.succeed(false), toggle });
    yield* session.invoke({ isRecording: Effect.succeed(true), toggle });
    assert.deepEqual(yield* Ref.get(events), ["capture", "toggle", "toggle"]);
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
  }),
);

it.effect("clears the image when FluidVoice cannot be started", () =>
  Effect.gen(function* () {
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    yield* session
      .invoke({
        isRecording: Effect.succeed(false),
        toggle: Effect.fail("permission refused"),
      })
      .pipe(Effect.result);
    assert.strictEqual(yield* session.pending(), false);
  }),
);

it.effect("does not start recording if cancellation arrives while checking the app", () =>
  Effect.gen(function* () {
    const checking = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<boolean>();
    const toggles = yield* Ref.make(0);
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    const invocation = yield* session
      .invoke({
        isRecording: Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Deferred.await(proceed)),
        ),
        toggle: Ref.update(toggles, (value) => value + 1),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(checking);
    yield* session.clear();
    yield* Deferred.succeed(proceed, false);
    yield* Fiber.await(invocation);
    assert.strictEqual(yield* Ref.get(toggles), 0);
    assert.strictEqual(yield* session.pending(), false);
  }),
);

it.effect("cancellation interrupts a native trigger before it posts the start event", () =>
  Effect.gen(function* () {
    const starting = yield* Deferred.make<void>();
    const post = yield* Deferred.make<void>();
    const nativePosts = yield* Ref.make(0);
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    const invocation = yield* session
      .invoke({
        isRecording: Effect.succeed(false),
        toggle: Deferred.succeed(starting, undefined).pipe(
          Effect.andThen(Deferred.await(post)),
          Effect.andThen(Ref.update(nativePosts, (value) => value + 1)),
        ),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(starting);
    yield* session.clear();
    yield* Deferred.succeed(post, undefined);
    yield* Fiber.await(invocation);
    assert.strictEqual(yield* Ref.get(nativePosts), 0);
    assert.strictEqual(yield* session.pending(), false);
  }),
);

it.effect("uses the initial page once even after focus changes during dictation", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.stage();
    yield* Ref.set(current, later);
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
    assert.strictEqual((yield* session.take())?.name, "Later.png");
  }),
);

it.effect("cancellation discards the initial image", () =>
  Effect.gen(function* () {
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    yield* session.stage();
    yield* session.clear();
    assert.strictEqual(yield* session.pending(), false);
  }),
);

it.effect("keeps the initial image through long dictation and transcription", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.stage();
    yield* Ref.set(current, later);
    yield* TestClock.adjust("30 minutes");
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
  }),
);

it.effect("starting again after cancellation replaces the old page", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.stage();
    yield* Ref.set(current, later);
    yield* session.stage();
    assert.strictEqual((yield* session.take())?.name, "Later.png");
  }),
);
