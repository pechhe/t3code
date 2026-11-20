import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { piModelFailure } from "./modelFailure.ts";

describe("piModelFailure", () => {
  it.effect("classes Command Code's weekly quota as a usage limit with its reset time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-20T12:00:00Z"));
      const failure = yield* piModelFailure(
        "All 1 Command Code keys are quota-limited (weekly; next reset Nov 24, 08:53)",
      );
      assert.strictEqual(failure.class, "usage_limit");
      const reset = Date.parse(failure.resetAt ?? "");
      assert.isAbove(reset, Date.parse("2026-11-23T00:00:00Z"));
      assert.isBelow(reset, Date.parse("2026-11-25T23:59:59Z"));
    }),
  );

  it.effect("leaves an unrelated provider error as one", () =>
    Effect.gen(function* () {
      const failure = yield* piModelFailure("connection reset by peer");
      assert.strictEqual(failure.class, "provider_error");
      assert.isUndefined(failure.resetAt);
    }),
  );
});
