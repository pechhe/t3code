import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { CapturedWindow } from "./Capture.ts";

export class CaptureSession extends Context.Service<
  CaptureSession,
  {
    readonly stage: () => Effect.Effect<void>;
    readonly clear: () => Effect.Effect<void>;
    readonly pending: () => Effect.Effect<boolean>;
    readonly take: () => Effect.Effect<CapturedWindow | null>;
    readonly invoke: <E>(control: {
      readonly isRecording: Effect.Effect<boolean, E>;
      readonly toggle: Effect.Effect<void, E>;
    }) => Effect.Effect<void, E>;
  }
>()("t3/voiceBridge/CaptureSession") {}

export const make = Effect.fn("CaptureSession.make")(function* (
  capture: () => Effect.Effect<CapturedWindow | null>,
) {
  const staged = yield* Ref.make<{
    readonly captured: CapturedWindow | null;
  } | null>(null);
  const lock = yield* Semaphore.make(1);
  const generation = yield* Ref.make(0);
  const inflight = yield* Ref.make<(() => Effect.Effect<void>) | null>(null);
  const discard = () => Ref.set(staged, null).pipe(lock.withPermits(1));
  const clear = Effect.fn("CaptureSession.clear")(function* () {
    yield* Ref.update(generation, (value) => value + 1);
    const stop = yield* Ref.getAndSet(inflight, null);
    if (stop !== null) yield* stop();
    yield* discard();
  });
  const stage = Effect.fn("CaptureSession.stage")(function* () {
    yield* Ref.set(staged, null);
    const captured = yield* capture();
    yield* Ref.set(staged, { captured });
  }, lock.withPermits(1));
  const pending = Effect.fn("CaptureSession.pending")(function* () {
    const value = yield* Ref.get(staged);
    return value !== null;
  }, lock.withPermits(1));
  const take = Effect.fn("CaptureSession.take")(function* () {
    const value = yield* Ref.getAndSet(staged, null);
    return value === null ? yield* capture() : value.captured;
  }, lock.withPermits(1));
  const invoke = Effect.fn("CaptureSession.invoke")(function* <E>(control: {
    readonly isRecording: Effect.Effect<boolean, E>;
    readonly toggle: Effect.Effect<void, E>;
  }) {
    const version = yield* Ref.get(generation);
    const child = yield* Effect.gen(function* () {
      const recording = yield* control.isRecording;
      if (!recording) yield* stage();
      if ((yield* Ref.get(generation)) !== version) return;
      yield* control.toggle;
    }).pipe(Effect.forkChild);
    yield* Ref.set(inflight, () => Fiber.interrupt(child));
    if ((yield* Ref.get(generation)) !== version) yield* Fiber.interrupt(child);
    yield* Fiber.join(child).pipe(
      Effect.onError(discard),
      Effect.ensuring(Ref.set(inflight, null)),
    );
  });
  return CaptureSession.of({ stage, clear, pending, take, invoke });
});
