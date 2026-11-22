import type {
  AccountBlock,
  AccountBlockReason,
  AccountId,
  AccountRoutingClearInput,
  AccountRoutingState,
  PooledModelKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/** The backoff after each failed attempt with no reported reset, capped at the last. */
export const ACCOUNT_BACKOFF_MS = [2, 10, 30].map((minutes) => minutes * 60_000);

/** Entries with no block in force, untouched this long, are forgotten with their counted runs. */
const FORGET_AFTER_MS = 24 * 60 * 60_000;

/** Runs remembered per account and model, so a run's retries count once however they interleave. */
const ATTEMPTS_REMEMBERED = 32;

interface Entry {
  /** Absent once recovery, success or Try now ended it; the counted runs outlive it. */
  readonly block: AccountBlock | undefined;
  /** The runs already counted, kept past the block so a late retry of one never holds again. */
  readonly attemptIds: ReadonlyArray<string>;
  readonly touchedMs: number;
}

export interface AccountFailureInput {
  readonly account: AccountId;
  readonly model: PooledModelKey;
  readonly reason: AccountBlockReason;
  /** The reset the provider reported, if any. */
  readonly resetAt?: string | null | undefined;
  /** The failed run: one run's own retries are one attempt. */
  readonly attemptId: string;
  /** A usage reading newer than the last block showed room, so the backoff starts over. */
  readonly recovered?: boolean | undefined;
  /** The usage windows governing the model now, which a reading must show to clear the block. */
  readonly windowIds?: ReadonlyArray<string> | undefined;
}

/**
 * The server's memory of runs failing on an account, by account and model (fork/differences.md
 * `account-pools`). In memory only: a restart forgets every block, and the next failure on an
 * account learns it again.
 */
export class AccountAvailability extends Context.Service<
  AccountAvailability,
  {
    /** The block in force after the failure; none when the run was counted before and its hold ended. */
    readonly recordFailure: (input: AccountFailureInput) => Effect.Effect<AccountBlock | undefined>;
    /** A turn completed on the account, so its block and backoff for the model end. */
    readonly recordSuccess: (input: {
      readonly account: AccountId;
      readonly model: PooledModelKey;
    }) => Effect.Effect<void>;
    /** Try now: clears an account's blocks for one model, or for all. */
    readonly clear: (input: AccountRoutingClearInput) => Effect.Effect<AccountRoutingState>;
    /** Blocks in force now. */
    readonly state: Effect.Effect<AccountRoutingState>;
    /** Whether any account has a failure on record, its block in force or not. */
    readonly remembersFailures: Effect.Effect<boolean>;
    /** The state now, then after each change. */
    readonly changes: Stream.Stream<AccountRoutingState>;
  }
>()("t3/provider/AccountAvailability") {}

const keyOf = (account: AccountId, model: PooledModelKey) => `${account}\u0000${model}`;
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const layer = Layer.effect(
  AccountAvailability,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map());
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<AccountRoutingState>(),
      PubSub.shutdown,
    );
    const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
    const stateAt = (map: ReadonlyMap<string, Entry>, now: number): AccountRoutingState => ({
      blocks: [...map.values()].flatMap(({ block }) =>
        block !== undefined && Date.parse(block.until) > now ? [block] : [],
      ),
    });
    const state = Effect.gen(function* () {
      return stateAt(yield* Ref.get(entries), yield* nowMs);
    });
    const publish = Effect.gen(function* () {
      const current = yield* state;
      yield* PubSub.publish(pubsub, current);
      return current;
    });

    const recordFailure = Effect.fn("AccountAvailability.recordFailure")(function* (
      input: AccountFailureInput,
    ) {
      const now = yield* nowMs;
      const key = keyOf(input.account, input.model);
      const result = yield* Ref.modify(
        entries,
        (
          map,
        ): readonly [
          { readonly block: AccountBlock | undefined; readonly changed: boolean },
          ReadonlyMap<string, Entry>,
        ] => {
          const kept = new Map(
            [...map].filter(
              ([, entry]) =>
                entry.touchedMs > now - FORGET_AFTER_MS ||
                (entry.block !== undefined && Date.parse(entry.block.until) > now),
            ),
          );
          const entry = kept.get(key);
          const counted = entry?.attemptIds.includes(input.attemptId) === true;
          // A newer reading with room starts the backoff over; the counted runs stay counted.
          const previous = input.recovered === true ? undefined : entry?.block;
          const holding = previous !== undefined && Date.parse(previous.until) > now;
          if (counted && !holding) return [{ block: undefined, changed: false }, map];
          const resetMs = input.resetAt == null ? Number.NaN : Date.parse(input.resetAt);
          const reported = Number.isFinite(resetMs) && resetMs > now;
          const attempts = counted ? previous!.attempts : (previous?.attempts ?? 0) + 1;
          const backoffMs = ACCOUNT_BACKOFF_MS[Math.min(attempts, ACCOUNT_BACKOFF_MS.length) - 1]!;
          const untilMs = reported
            ? Math.max(resetMs, counted ? Date.parse(previous!.until) : 0)
            : counted
              ? Date.parse(previous!.until)
              : now + backoffMs;
          const windowIds = [
            ...new Set([...(previous?.windowIds ?? []), ...(input.windowIds ?? [])]),
          ];
          const next: AccountBlock = {
            account: input.account,
            model: input.model,
            reason: input.reason,
            since: isoOf(now),
            until: isoOf(untilMs),
            reportedReset: reported || (counted && previous!.reportedReset),
            attempts,
            ...(windowIds.length === 0 ? {} : { windowIds }),
          };
          const attemptIds = counted
            ? entry!.attemptIds
            : [...(entry?.attemptIds ?? []), input.attemptId].slice(-ATTEMPTS_REMEMBERED);
          kept.set(key, { block: next, attemptIds, touchedMs: now });
          return [{ block: next, changed: true }, kept];
        },
      );
      if (result.changed) yield* publish;
      return result.block;
    });

    /** Ends the matching blocks, keeping which runs were counted. */
    const remove = (match: (block: AccountBlock) => boolean) =>
      Ref.modify(entries, (map) => {
        let removed = false;
        const next = new Map(
          [...map].map(([key, entry]) => {
            if (entry.block === undefined || !match(entry.block)) return [key, entry] as const;
            removed = true;
            return [key, { ...entry, block: undefined }] as const;
          }),
        );
        return [removed, next];
      });

    return AccountAvailability.of({
      recordFailure,
      recordSuccess: Effect.fn("AccountAvailability.recordSuccess")(function* (input) {
        const removed = yield* remove(
          (block) => block.account === input.account && block.model === input.model,
        );
        if (removed) yield* publish;
      }),
      clear: Effect.fn("AccountAvailability.clear")(function* (input) {
        yield* remove(
          (block) =>
            block.account === input.account &&
            (input.model === undefined || block.model === input.model),
        );
        return yield* publish;
      }),
      state,
      remembersFailures: Effect.map(Ref.get(entries), (map) =>
        [...map.values()].some((entry) => entry.block !== undefined),
      ),
      changes: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          return Stream.concat(Stream.make(yield* state), Stream.fromSubscription(subscription));
        }),
      ),
    });
  }),
);
