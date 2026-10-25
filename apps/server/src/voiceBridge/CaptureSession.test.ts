import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
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

it.effect("posts the toggle without taking a new image when status is unreadable", () =>
  Effect.gen(function* () {
    const captures = yield* Ref.make(0);
    const toggles = yield* Ref.make(0);
    const session = yield* CaptureSession.make(() =>
      Ref.update(captures, (n) => n + 1).pipe(Effect.as(initial)),
    );
    yield* session
      .invoke({
        isRecording: Effect.fail("Accessibility unavailable"),
        toggle: Ref.update(toggles, (n) => n + 1),
      })
      .pipe(Effect.result);
    assert.strictEqual(yield* Ref.get(toggles), 1);
    assert.strictEqual(yield* Ref.get(captures), 0);
  }),
);

it.effect("keeps the initial image when a stop status is unreadable", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.invoke({ isRecording: Effect.succeed(false), toggle: Effect.void });
    yield* Ref.set(current, later);
    yield* session
      .invoke({ isRecording: Effect.fail("Locked"), toggle: Effect.void })
      .pipe(Effect.result);
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
  }),
);

it.effect("keeps the image if posting a stop fails", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.stage();
    yield* Ref.set(current, later);
    yield* session
      .invoke({ isRecording: Effect.succeed(true), toggle: Effect.fail("Post failed") })
      .pipe(Effect.result);
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
  }),
);

it.effect("ignores an overlapping press and accepts the next press after completion", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const posts = yield* Ref.make(0);
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    const first = yield* session
      .invoke({
        isRecording: Effect.succeed(false),
        toggle: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const control = { isRecording: Effect.succeed(true), toggle: Ref.update(posts, (n) => n + 1) };
    yield* session.invoke(control);
    assert.strictEqual(yield* Ref.get(posts), 0);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(first);
    yield* session.invoke(control);
    assert.strictEqual(yield* Ref.get(posts), 1);
  }),
);

it.effect("times out pending native work, discards its capture and accepts a later press", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finished = yield* Ref.make(false);
    const interrupted = yield* Ref.make(false);
    const posts = yield* Ref.make(0);
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    const first = yield* session
      .invoke({
        isRecording: Effect.succeed(false),
        toggle: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Ref.set(interrupted, true)),
        ),
      })
      .pipe(Effect.result, Effect.ensuring(Ref.set(finished, true)), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("30 seconds");
    assert.strictEqual(yield* Ref.get(finished), true);
    const result = yield* Fiber.join(first);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(yield* Ref.get(interrupted), true);
    assert.strictEqual(yield* session.pending(), false);
    yield* session.invoke({
      isRecording: Effect.succeed(false),
      toggle: Ref.update(posts, (n) => n + 1),
    });
    assert.strictEqual(yield* Ref.get(posts), 1);
  }),
);

it.effect("keeps the initial image if a stop invocation times out", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const current = yield* Ref.make(initial);
    const session = yield* CaptureSession.make(() => Ref.get(current));
    yield* session.stage();
    yield* Ref.set(current, later);
    const stop = yield* session
      .invoke({
        isRecording: Effect.succeed(true),
        toggle: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(stop);
    assert.strictEqual((yield* session.take())?.name, "Initial.png");
  }),
);

it.effect("a cancelled press completes successfully for its caller", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const session = yield* CaptureSession.make(() => Effect.succeed(initial));
    const completion = yield* session
      .invoke({
        isRecording: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        toggle: Effect.void,
      })
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* session.clear();
    assert.strictEqual(Exit.isSuccess(yield* Fiber.join(completion)), true);
  }),
);
