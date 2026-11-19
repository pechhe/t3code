import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 *
 * Records the wait for the key as `lock.wait_ms` on the caller's span, beside the SQLite
 * client's `db.lock_wait_ms`, so a slow traced request shows which lock it queued on.
 */
export const make = Effect.fn("KeyedLock.make")(function* <Key>(): Effect.fn.Return<
  KeyedLock<Key>
> {
  const locks = yield* Ref.make<ReadonlyMap<Key, LockEntry>>(new Map());

  const acquire = (key: Key) =>
    Effect.flatMap(Semaphore.make(1), (candidate) =>
      Ref.modify(locks, (current) => {
        const existing = current.get(key);
        const semaphore = existing?.semaphore ?? candidate;
        const next = new Map(current);
        next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
        return [semaphore, next] as const;
      }),
    );

  const release = (key: Key) =>
    Ref.update(locks, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (semaphore) =>
          Effect.flatMap(Clock.currentTimeNanos, (start) =>
            semaphore.withPermit(
              Clock.currentTimeNanos.pipe(
                Effect.flatMap((entered) =>
                  Effect.annotateCurrentSpan(
                    "lock.wait_ms",
                    Number((entered - start) / 1000n) / 1000,
                  ),
                ),
                Effect.andThen(effect),
              ),
            ),
          ),
        () => release(key),
      ),
    activeKeys: Effect.map(Ref.get(locks), (current) => Array.from(current.keys())),
  } satisfies KeyedLock<Key>;
});

export interface KeyedRunner<Key> {
  /** Forks `effect` to run once every effect passed earlier for `key` has finished. */
  readonly run: <R>(
    key: Key,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, R>;
}

/**
 * For a stream consumer whose handler waits on a per-key lock: a busy key delays only its own
 * later effects. The forked fiber starts immediately, so it queues on the key's FIFO semaphore
 * before `run` returns; that keeps each key's effects in `run` order.
 */
export const makeRunner = Effect.fn("KeyedLock.makeRunner")(function* <Key>(): Effect.fn.Return<
  KeyedRunner<Key>,
  never,
  Scope.Scope
> {
  const lock = yield* make<Key>();
  const fibers = yield* FiberSet.make<void, never>();
  return {
    run: (key, effect) =>
      FiberSet.run(fibers, lock.withLock(key, effect), { startImmediately: true }).pipe(
        Effect.asVoid,
      ),
  } satisfies KeyedRunner<Key>;
});
