import * as Cause from "effect/Cause";
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
    }) => Effect.Effect<void, E | Cause.TimeoutError>;
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
  const busy = yield* Ref.make(false);
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
    if (yield* Ref.getAndSet(busy, true)) {
      yield* Effect.logInfo("Right Option ignored: the previous press is still working.");
      return;
    }
    yield* Effect.gen(function* () {
      const version = yield* Ref.get(generation);
      const starting = yield* Ref.make(false);
      const child = yield* Effect.gen(function* () {
        const recording = yield* control.isRecording.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Right Option: status unavailable; posting the Command toggle without a new screenshot.",
              error,
            ).pipe(Effect.as(null)),
          ),
        );
        if (recording !== null) {
          yield* Effect.logInfo(
            recording
              ? "Right Option: stopping FluidVoice."
              : "Right Option: capturing the page, then starting FluidVoice.",
          );
        }
        if (recording === false) {
          yield* Ref.set(starting, true);
          yield* stage();
        }
        if ((yield* Ref.get(generation)) !== version) return;
        yield* control.toggle.pipe(
          Effect.onError(recording === false ? discard : () => Effect.void),
        );
      }).pipe(Effect.forkChild);
      yield* Ref.set(inflight, () => Fiber.interrupt(child));
      if ((yield* Ref.get(generation)) !== version) yield* Fiber.interrupt(child);
      yield* Fiber.join(child).pipe(
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
        Effect.ensuring(Fiber.interrupt(child)),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Ref.get(starting).pipe(
              Effect.flatMap((wasStarting) => (wasStarting ? discard() : Effect.void)),
              Effect.andThen(
                Effect.fail(new Cause.TimeoutError("Right Option timed out after 30 seconds.")),
              ),
            ),
        }),
        Effect.ensuring(Ref.set(inflight, null)),
      );
    }).pipe(Effect.ensuring(Ref.set(busy, false)));
  });
  return CaptureSession.of({ stage, clear, pending, take, invoke });
});
