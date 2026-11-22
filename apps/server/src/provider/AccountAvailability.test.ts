import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as AccountAvailability from "./AccountAvailability.ts";

const NOW = Date.parse("2026-11-19T09:00:00.000Z");
const MINUTE = 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const failure = (attemptId: string, resetAt?: number) => ({
  account: "pi:openai-codex",
  model: "gpt-6-2-sol",
  reason: "rate-limit" as const,
  attemptId,
  ...(resetAt === undefined ? {} : { resetAt: iso(resetAt) }),
});

it.layer(AccountAvailability.layer)("AccountAvailability", (it) => {
  it.effect(
    "backs off 2, 10 then 30 minutes, one step per failed run however often it retries",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const memory = yield* AccountAvailability.AccountAvailability;
        const until = (attemptId: string, resetAt?: number) =>
          Effect.map(memory.recordFailure(failure(attemptId, resetAt)), (block) => [
            block?.attempts,
            block?.until,
          ]);
        assert.deepEqual(yield* until("run:1"), [1, iso(NOW + 2 * MINUTE)]);
        // The run's own retries are the same attempt.
        assert.deepEqual(yield* until("run:1"), [1, iso(NOW + 2 * MINUTE)]);
        assert.deepEqual(yield* until("run:2"), [2, iso(NOW + 10 * MINUTE)]);
        // Two runs whose retries interleave are still two attempts.
        assert.deepEqual(yield* until("run:1"), [2, iso(NOW + 10 * MINUTE)]);
        assert.deepEqual(yield* until("run:2"), [2, iso(NOW + 10 * MINUTE)]);
        assert.deepEqual(yield* until("run:3"), [3, iso(NOW + 30 * MINUTE)]);
        assert.deepEqual(yield* until("run:4"), [4, iso(NOW + 30 * MINUTE)]);
        // A reset the provider reports holds it until then, and counts as that attempt.
        const reported = yield* memory.recordFailure(failure("run:4", NOW + 90 * MINUTE));
        assert.deepInclude(reported, {
          attempts: 4,
          until: iso(NOW + 90 * MINUTE),
          reportedReset: true,
        });
        // A turn that completes ends the block and its backoff.
        yield* memory.recordSuccess({ account: "pi:openai-codex", model: "gpt-6-2-sol" });
        assert.deepEqual((yield* memory.state).blocks, []);
        assert.deepEqual(yield* until("run:5"), [1, iso(NOW + 2 * MINUTE)]);
        // A newer reading with room starts the backoff over too.
        const recovered = yield* memory.recordFailure({ ...failure("run:6"), recovered: true });
        assert.strictEqual(recovered?.attempts, 1);
        // A counted run's late retry never holds the account again once its hold has ended.
        assert.isUndefined(yield* memory.recordFailure({ ...failure("run:6"), recovered: true }));
        yield* memory.clear({ account: "pi:openai-codex" });
        assert.isUndefined(yield* memory.recordFailure(failure("run:6")));
        assert.isUndefined(yield* memory.recordFailure(failure("run:5")));
        assert.deepEqual((yield* memory.state).blocks, []);
        assert.deepEqual(yield* until("run:7"), [1, iso(NOW + 2 * MINUTE)]);
        yield* memory.clear({ account: "pi:openai-codex" });
      }),
  );

  it.effect("lists only blocks in force, and Try now clears one model or every model", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const memory = yield* AccountAvailability.AccountAvailability;
      yield* memory.recordFailure(failure("run:a"));
      yield* memory.recordFailure({ ...failure("run:b"), model: "gpt-6-luna" });
      yield* memory.recordFailure({ ...failure("run:c"), account: "pi:openai" });
      assert.strictEqual((yield* memory.state).blocks.length, 3);
      yield* memory.clear({ account: "pi:openai-codex", model: "gpt-6-luna" });
      assert.deepEqual(
        (yield* memory.state).blocks.map((block) => [block.account, block.model]),
        [
          ["pi:openai-codex", "gpt-6-2-sol"],
          ["pi:openai", "gpt-6-2-sol"],
        ],
      );
      yield* TestClock.adjust(2 * MINUTE);
      assert.deepEqual((yield* memory.state).blocks, []);
      assert.isTrue(yield* memory.remembersFailures);
      yield* memory.clear({ account: "pi:openai-codex" });
      yield* memory.clear({ account: "pi:openai" });
      assert.isFalse(yield* memory.remembersFailures);
    }),
  );

  it.effect("holds a reported reset until then, however long other accounts keep failing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const memory = yield* AccountAvailability.AccountAvailability;
      const HOUR = 60 * MINUTE;
      yield* memory.recordFailure(failure("run:weekly", NOW + 48 * HOUR));
      yield* TestClock.adjust(25 * HOUR);
      yield* memory.recordFailure({ ...failure("run:other"), account: "pi:openai" });
      assert.deepEqual(
        (yield* memory.state).blocks.map((block) => [block.account, block.until]),
        [
          ["pi:openai-codex", iso(NOW + 48 * HOUR)],
          ["pi:openai", iso(NOW + 25 * HOUR + 2 * MINUTE)],
        ],
      );
      yield* memory.clear({ account: "pi:openai-codex" });
      yield* memory.clear({ account: "pi:openai" });
    }),
  );
});
